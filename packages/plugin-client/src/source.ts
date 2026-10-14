/**
 * The board's data port.
 *
 * ## Why a port and not a direct call
 *
 * ADR-004 fixes *where* the board is mounted (the `main` seat) but says nothing
 * about how a browser half reads host data; ADR-005 (proposal) covers that
 * channel and is still open. Keeping every read and write behind this interface
 * means the UI layer is complete and testable independently of the transport
 * decision, and that a transport swap touches exactly one adapter file.
 *
 * ## What a transport must never do
 *
 * 1. **Never answer a read with an empty board when the read failed.** REC-05
 *    forbids presenting "could not read" as "nothing here"; {@link
 *    createUnavailableBoardSource} therefore fails the read instead of
 *    returning zero tasks. The panel renders the failure and a retry.
 * 2. **Never report success before the data layer did.** Every write result is
 *    either `ok: true` with the authoritative snapshot the host read back, or
 *    `ok: false` with a code. Optimistic UI is not permitted (F02-R04).
 * 3. **Never re-apply an operation on retry as a new operation.** `operationId`
 *    is the identity of one user intent; a retry reuses it so the data layer can
 *    deduplicate (REC-02, SAVE-06).
 *
 * @module @aikanban/plugin-client/source
 */

import type { BoardFailureCodeWire } from './wire.js'
import type { BoardCapabilities, BoardReadData, StatusId } from './model.js'

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One status change. The same shape serves the menu, the keyboard and a drop. */
export interface StatusChangeInput {
  readonly taskId: string
  /** Destination status id (opaque; core owns the vocabulary). */
  readonly next: StatusId
  /** Identity of this user intent; reused verbatim by a retry (REC-02). */
  readonly operationId: string
  /** Required when `next === 'blocked'` (F02-R02). */
  readonly reason?: string
  /**
   * Destination index when the change also moves the card (drop into another
   * column). Absent means "append at the end of the target column".
   */
  readonly toIndex?: number
  /** Version of the formal status this change was decided on (SAVE-05 baseline). */
  readonly expectedStatusVersion?: string
}

/** One manual reorder inside a column (F02-R04). */
export interface ReorderInput {
  readonly taskId: string
  readonly status: StatusId
  readonly toIndex: number
  readonly operationId: string
  readonly expectedStatusVersion?: string
}

/** One undo of a previous status change (F02-R04). */
export interface UndoInput {
  readonly taskId: string
  /** The `operationId` of the change being undone — the baseline the host checks. */
  readonly operationId: string
  readonly expectedStatusVersion?: string
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/**
 * Failure codes. Each one maps to different user-facing text; none of them may
 * be shown as a success. The vocabulary is defined once in `wire.ts` and shared
 * with the host half, so a code cannot exist on one side only.
 *
 * - `invalid-reason` — entering blocked without a reason.
 * - `not-found` — the task no longer exists.
 * - `save-failed` — the write did not land; the formal value is unchanged.
 * - `stale-baseline` — someone else changed the task first; undo cannot apply.
 * - `unknown-result` — the write's outcome is unknown (REC-03): verify first.
 * - `read-failed` — the board could not be read.
 * - `unavailable` — no data channel is connected.
 */
export type BoardFailureCode = BoardFailureCodeWire

/** The formal value a failure may carry, so the UI can show the real current state. */
export interface FormalStatusValue {
  /** Opaque status id from the data layer. */
  readonly status: StatusId
  /** Data-layer version of the formal status; never invented by the UI. */
  readonly statusVersion: string
}

/**
 * One board read, as the data layer returns it. `boardToken` and `capabilities`
 * are required: without them the panel cannot tell a stale response from a fresh
 * one, nor which entry points the data layer can actually serve.
 */
export interface BoardSnapshot extends BoardReadData {
  /** Opaque change token for this read (core: `boardToken`). */
  readonly boardToken: string
  /** What the data layer can do. */
  readonly capabilities: BoardCapabilities
}

/**
 * A failed read. Never silently converted into an empty board.
 *
 * `unknown-project` (core's own third state) means "not registered": the panel
 * says 项目信息不可用 and shows no board. `read-failed` keeps known data and
 * offers a retry. Both are failures, neither is "no tasks".
 */
export interface BoardReadFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
}

/** A read result. */
export type BoardReadResult = { readonly ok: true; readonly snapshot: BoardSnapshot } | BoardReadFailure

/** A write that landed, with the authoritative state read back. */
export interface WriteSuccess {
  readonly ok: true
  readonly snapshot: BoardSnapshot
  /**
   * Whether this change may still be undone — the host's judgement, not the
   * UI's (F02-R04: an undo is refused once later changes exist).
   */
  readonly undoable: boolean
}

/** A write that did not land. */
export interface WriteFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
  /** The formal value to display instead of the attempted one. */
  readonly current?: FormalStatusValue
}

/** Result of a status change or a reorder. */
export type WriteResult = WriteSuccess | WriteFailure

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

/** What the panel needs from whatever carries board data. */
export interface BoardSource {
  /**
   * Human-readable transport identity, shown in diagnostics. `unavailable`
   * means no channel is connected — the panel then says so explicitly instead
   * of pretending the board is empty.
   */
  readonly transport: { readonly kind: 'host' | 'unavailable'; readonly detail: string }

  /** Read the whole board for the current project. */
  readBoard(): Promise<BoardReadResult>

  /** Change one task's status (and optionally its position). */
  setStatus(input: StatusChangeInput): Promise<WriteResult>

  /** Move a card inside its column. */
  reorder(input: ReorderInput): Promise<WriteResult>

  /** Undo a status change, if the host still considers it undoable. */
  undoStatusChange(input: UndoInput): Promise<WriteResult>
}

/* ------------------------------------------------------------------ *
 * The unavailable source
 * ------------------------------------------------------------------ */

/** Text the panel shows when no data channel exists. Explicit, never "empty". */
export const NO_CHANNEL_MESSAGE = '看板数据通道未接通：无法读取任务。这不是空看板。'

/**
 * A port with no transport behind it.
 *
 * Every call fails with `unavailable`; nothing is fabricated. This exists so the
 * UI has one honest state for "no channel" (ADR-005 consequence: failure is
 * visible and is never a normal empty state) rather than a silently empty board.
 *
 * @param detail - why there is no channel, for the diagnostics line.
 * @returns a source whose every operation fails visibly.
 */
export function createUnavailableBoardSource(detail: string): BoardSource {
  const failure = (): WriteFailure => ({ ok: false, code: 'unavailable', message: NO_CHANNEL_MESSAGE })
  return {
    transport: { kind: 'unavailable', detail },
    readBoard: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_MESSAGE }),
    setStatus: () => Promise.resolve(failure()),
    reorder: () => Promise.resolve(failure()),
    undoStatusChange: () => Promise.resolve(failure()),
  }
}

/* ------------------------------------------------------------------ *
 * Operation identity
 * ------------------------------------------------------------------ */

let operationCounter = 0

/**
 * Mint an operation id. Deterministic per process and unique across processes
 * only probabilistically — the id only has to distinguish *user intents within
 * one board session*, while the host pairs it with the task identity.
 *
 * @returns a fresh operation id.
 */
export function nextOperationId(): string {
  operationCounter += 1
  return `op-${Date.now().toString(36)}-${operationCounter.toString(36)}`
}
