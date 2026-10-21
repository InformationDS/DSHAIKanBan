/**
 * Host half of the F02 board wire: one authenticated Connection RPC channel.
 *
 * ## Contract
 *
 * DSH's `ctx.connection.rpc.handle(channel, handler)` registers an authenticated
 * absolute channel prefix (`/aikanban`). The service itself mounts the HTTP
 * route and runs Host/Origin checks plus browser-token authentication **before**
 * our handler is called; our side only sees decoded endpoints. See ADR-005.
 *
 * Therefore this module must obey three host rules that are not obvious:
 *
 * 1. **Never throw.** A thrown handler error becomes an HTTP 500 with a text
 *    body, which the browser caller surfaces as a transport failure: the UI
 *    learns nothing. Every failure is returned as
 *    `{ok:false, error:{code, message, details}}`.
 * 2. **Validate every payload.** The wire is JSON from a browser, so each
 *    endpoint's payload is checked before it reaches the data layer. Entering
 *    `blocked` without a reason is refused here as well as in core — the wire
 *    boundary does not get to skip a product rule.
 * 3. **Own no business logic.** Reads, status changes, reorders and undo are
 *    decided by `@aikanban/core` behind {@link HostBoardPort}; this file only
 *    names endpoints, validates input and maps results.
 *
 * ## Error codes (documented in F02 implementation.md)
 *
 * | code | meaning |
 * | --- | --- |
 * | `unknown-endpoint` | endpoint not in the published set |
 * | `invalid-payload` | payload failed its guard; nothing was read or written |
 * | `invalid-reason` | entering `blocked` without a non-blank reason |
 * | `read-failed` | the board read failed |
 * | `not-found` | the task does not exist |
 * | `save-failed` | the write did not land; the formal value is unchanged |
 * | `stale-baseline` | a later change exists; the operation was refused |
 * | `unknown-result` | the write's outcome is unknown (verify first) |
 * | `unavailable` | the data layer is not bound |
 *
 * @module @aikanban/dsh-aikanban/board-channel
 */

import {
  BOARD_CHANNEL,
  BOARD_ENDPOINT_LIST,
  BOARD_ENDPOINTS,
  isBlockedReasonValid,
  parseProjectListPayload,
  parseReadBoardPayload,
  parseReorderPayload,
  parseSetStatusPayload,
  parseStatusVersion,
  parseUndoStatusPayload,
  type BoardFailureCodeWire,
  type BoardSnapshotValue,
  type FormalStatusValueWire,
  type ProjectListItem,
  type ReadBoardPayload,
} from '@aikanban/plugin-client/wire'

/* ------------------------------------------------------------------ *
 * The data-layer port
 * ------------------------------------------------------------------ */

/** A read that succeeded. */
export interface HostReadSuccess {
  readonly ok: true
  readonly snapshot: BoardSnapshotValue
}

/** A read that failed. Never an empty snapshot. */
export interface HostReadFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of a host-side read. */
export type HostReadOutcome = HostReadSuccess | HostReadFailure

/** A write that landed. */
export interface HostWriteSuccess {
  readonly ok: true
  readonly snapshot: BoardSnapshotValue
  /** The data layer's judgement on whether undo still applies (F02-R04). */
  readonly undoable: boolean
}

/** A write that did not land. */
export interface HostWriteFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
  /** The formal value to display instead of the attempted one. */
  readonly current?: FormalStatusValueWire
}

/** Result of a host-side write. */
export type HostWriteOutcome = HostWriteSuccess | HostWriteFailure

/** A `project/list` read that succeeded. The candidate set may be empty. */
export interface HostProjectListSuccess {
  readonly ok: true
  readonly projects: readonly ProjectListItem[]
}

/** A `project/list` read that failed. Never an empty list standing in for a failure. */
export interface HostProjectListFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of a host-side project listing. */
export type HostProjectListOutcome = HostProjectListSuccess | HostProjectListFailure

/**
 * A `task/status.set` input after the handler decoded the baseline.
 *
 * The wire carries `expectedStatusVersion: 'ver1:<n>'`; the handler validates
 * the grammar and **decodes it before the port**, so the data layer only ever
 * sees a number. This type is host-internal: the wire contract is unchanged.
 */
export interface HostSetStatusInput {
  readonly taskId: string
  readonly next: string
  readonly operationId: string
  readonly reason?: string
  readonly toIndex?: number
  readonly expectedStatusRevision: number
}

/** A `task/reorder` input after the handler decoded the baseline. */
export interface HostReorderInput {
  readonly taskId: string
  readonly status: string
  readonly toIndex: number
  readonly operationId: string
  readonly expectedStatusRevision: number
}

/**
 * A `task/status.undo` input after the handler decoded the baseline.
 *
 * The two identities stay distinct: `operationId` is **this undo**, and
 * `appliedUpdateId` names the write being undone.
 */
export interface HostUndoInput {
  readonly taskId: string
  readonly operationId: string
  readonly expectedStatusRevision: number
  readonly appliedUpdateId: string
}

/**
 * What the host half needs from the data layer. The core adapter implements it;
 * the payloads arrive already validated **and with the `ver1:` baseline decoded**
 * (a malformed/missing baseline never reaches this port).
 *
 * `signal` is the HTTP request's abort signal (the browser half cancels a read
 * when the user leaves the board view). An adapter that cannot cancel may ignore
 * it; a read that was aborted must still resolve to a failure result rather than
 * throwing, because this handler may not throw.
 */
export interface HostBoardPort {
  readBoard(input: ReadBoardPayload, signal?: AbortSignal): Promise<HostReadOutcome>
  /**
   * List the projects the host offers for explicit selection (Q1=B).
   *
   * The source of truth is the host's workspace registry, not the data layer's
   * registered projects; listing selects, remembers and writes nothing. An empty
   * candidate set is a success.
   */
  listProjects(signal?: AbortSignal): Promise<HostProjectListOutcome>
  setStatus(input: HostSetStatusInput, signal?: AbortSignal): Promise<HostWriteOutcome>
  reorder(input: HostReorderInput, signal?: AbortSignal): Promise<HostWriteOutcome>
  undoStatusChange(input: HostUndoInput, signal?: AbortSignal): Promise<HostWriteOutcome>
}

/* ------------------------------------------------------------------ *
 * The RPC handler
 * ------------------------------------------------------------------ */

/** DSH's `ConnectionRpcResult`. */
export type BoardRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } }

/** DSH's `ConnectionRpcHandler`. */
export type BoardRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<BoardRpcResult>

const failure = (code: string, message: string, details: Record<string, unknown> = {}): BoardRpcResult => ({
  ok: false,
  error: { code, message, details },
})

const success = (value: unknown): BoardRpcResult => ({ ok: true, value })

function detailsOf(current: FormalStatusValueWire | undefined): Record<string, unknown> {
  return current === undefined ? {} : { current }
}

/**
 * Host-side reason for refusing a write whose baseline is missing or not the
 * canonical `ver1:<n>` encoding.
 *
 * This check runs **before** the port: a malformed baseline must never reach
 * the data layer (a silent default to 0 would weaken SAVE-05). The code is
 * `invalid-payload`, a host-only protocol code — `HostWriteFailure.code`
 * stays within the eight browser codes, so an adapter cannot return it.
 */
const INVALID_BASELINE_MESSAGE =
  'expectedStatusVersion 必须是规范的基线编码 "ver1:<非负整数>"；本次未读取或写入任何内容。'

/**
 * Build the channel handler from a data-layer port.
 *
 * @param port - the data layer (core adapter or a test double).
 * @returns a handler safe to hand to `ctx.connection.rpc.handle`.
 */
export function createBoardChannelHandler(port: HostBoardPort): BoardRpcHandler {
  return async (endpoint, payload, signal) => {
    // The channel contract is POST + JSON; the connection service already
    // rejected anything else with 404/415/400 before reaching us.
    if (endpoint === BOARD_ENDPOINTS.readBoard) {
      const input = parseReadBoardPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'board/read payload must carry a non-empty projectId; the host never guesses a project.')
      }
      try {
        const outcome = await port.readBoard(input, signal)
        return outcome.ok ? success(outcome.snapshot) : failure(outcome.code, outcome.message)
      } catch (error) {
        return failure('read-failed', `读取失败：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.listProjects) {
      // The payload is empty by contract: listing takes no project, so a body
      // that is not a JSON object is a caller bug. Nothing is selected or written.
      if (parseProjectListPayload(payload) === null) {
        return failure('invalid-payload', 'project/list payload must be an empty JSON object; listing carries no selection.')
      }
      try {
        const outcome = await port.listProjects(signal)
        return outcome.ok ? success({ projects: outcome.projects }) : failure(outcome.code, outcome.message)
      } catch (error) {
        // The handler never throws: an exploded listing is a read failure, and
        // the browser keeps its selection state instead of fabricating candidates.
        return failure('read-failed', `读取项目清单失败：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.setStatus) {
      const input = parseSetStatusPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'task/status.set payload must carry a non-empty taskId, an operationId, a known status and a status baseline.')
      }
      // F5: the baseline grammar is a protocol rule, checked before the port.
      // The port receives the DECODED revision (`ver1:<n>` never crosses it).
      const expectedStatusRevision = parseStatusVersion(input.expectedStatusVersion)
      if (expectedStatusRevision === null) {
        return failure('invalid-payload', INVALID_BASELINE_MESSAGE)
      }
      if (input.next === 'blocked' && !isBlockedReasonValid(input.reason)) {
        // The product rule, enforced at the wire boundary as well as in core:
        // no write happens, so the formal status cannot move.
        return failure('invalid-reason', '进入「已阻塞」必须填写原因，正式状态未改变。')
      }
      try {
        const outcome = await port.setStatus(
          {
            taskId: input.taskId,
            next: input.next,
            operationId: input.operationId,
            expectedStatusRevision,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
          },
          signal,
        )
        return outcome.ok
          ? success({ snapshot: outcome.snapshot, undoable: outcome.undoable })
          : failure(outcome.code, outcome.message, detailsOf(outcome.current))
      } catch (error) {
        return failure('unknown-result', `写入结果未知：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.reorder) {
      const input = parseReorderPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'task/reorder payload must carry taskId, operationId, a known status, a non-negative integer toIndex and a status baseline.')
      }
      const expectedStatusRevision = parseStatusVersion(input.expectedStatusVersion)
      if (expectedStatusRevision === null) {
        return failure('invalid-payload', INVALID_BASELINE_MESSAGE)
      }
      try {
        const outcome = await port.reorder(
          {
            taskId: input.taskId,
            status: input.status,
            toIndex: input.toIndex,
            operationId: input.operationId,
            expectedStatusRevision,
          },
          signal,
        )
        return outcome.ok
          ? success({ snapshot: outcome.snapshot, undoable: outcome.undoable })
          : failure(outcome.code, outcome.message, detailsOf(outcome.current))
      } catch (error) {
        return failure('unknown-result', `排序结果未知：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.undoStatusChange) {
      const input = parseUndoStatusPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'task/status.undo payload must carry non-empty taskId, operationId (this undo), appliedUpdateId (the write being undone) and a status baseline.')
      }
      const expectedStatusRevision = parseStatusVersion(input.expectedStatusVersion)
      if (expectedStatusRevision === null) {
        return failure('invalid-payload', INVALID_BASELINE_MESSAGE)
      }
      try {
        const outcome = await port.undoStatusChange(
          {
            taskId: input.taskId,
            operationId: input.operationId,
            expectedStatusRevision,
            appliedUpdateId: input.appliedUpdateId,
          },
          signal,
        )
        return outcome.ok
          ? success({ snapshot: outcome.snapshot, undoable: outcome.undoable })
          : failure(outcome.code, outcome.message, detailsOf(outcome.current))
      } catch (error) {
        return failure('unknown-result', `撤销结果未知：${messageOf(error)}`)
      }
    }

    return failure('unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}; supported: ${BOARD_ENDPOINT_LIST.join(', ')}`)
  }
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** DSH's `HostConnectionRpc`, as far as this plugin uses it. */
export interface HostConnectionRpcLike {
  handle(channel: string, handler: BoardRpcHandler): unknown
}

/** DSH's host `connection` service. */
export interface HostConnectionLike {
  readonly rpc: HostConnectionRpcLike
}

/**
 * Tolerant probe for the host `connection` service. This plugin never declares
 * it in `inject`: a composition without it must still activate (the S0 lesson
 * about declared-but-absent services parking a fiber forever).
 *
 * @param value - a candidate service.
 * @returns whether it can register a channel.
 */
export function isHostConnectionLike(value: unknown): value is HostConnectionLike {
  if (typeof value !== 'object' || value === null) return false
  const rpc = (value as { rpc?: unknown }).rpc
  if (typeof rpc !== 'object' || rpc === null) return false
  return typeof (rpc as { handle?: unknown }).handle === 'function'
}

/** The outcome of a registration attempt. */
export type BoardChannelRegistration =
  | { readonly ok: true; readonly channel: string; readonly dispose: () => void }
  | { readonly ok: false; readonly reason: 'no-connection' }

/**
 * Register the board channel on `ctx.connection`.
 *
 * @param connection - the host `connection` service, or anything else.
 * @param port - the data layer.
 * @param channel - channel override; defaults to {@link BOARD_CHANNEL}.
 * @returns the registration (with a disposer) or a reason it did not happen.
 */
export function registerBoardChannel(
  connection: unknown,
  port: HostBoardPort,
  channel: string = BOARD_CHANNEL,
): BoardChannelRegistration {
  if (!isHostConnectionLike(connection)) return { ok: false, reason: 'no-connection' }
  const handler = createBoardChannelHandler(port)
  const disposer = connection.rpc.handle(channel, handler)
  return {
    ok: true,
    channel,
    dispose: () => {
      // DSH registers every channel through `owner.effect(...)`, so the
      // disposer is fiber-owned; calling it directly is only a convenience for
      // hosts that want to unregister earlier. Its async shape is ignored on
      // purpose: nothing here depends on the removal having completed.
      if (typeof disposer === 'function') void (disposer as () => unknown)()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
