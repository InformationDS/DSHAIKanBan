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
 * 3. **Own no business logic.** Reads, status changes, reorders, undo, task
 *    creation, field saves, activity history and manual summaries/overviews are
 *    decided by `@aikanban/core` behind {@link HostBoardPort}; this file only
 *    names endpoints, validates input (including the `ver1:`/`fver1:` baseline
 *    grammars) and maps results.
 *
 * ## Error codes (documented in F02 implementation.md)
 *
 * | code | meaning |
 * | --- | --- |
 * | `unknown-endpoint` | endpoint not in the published set |
 * | `invalid-payload` | payload failed its guard; nothing was read or written |
 * | `invalid-input` | a management input was refused by core/data layer (blank title, unknown status, bad activity scope/limit, identity collision, …); nothing was written |
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
  parseActivityPayload,
  parseCreateTaskPayload,
  parseFieldsVersion,
  parseProjectListPayload,
  parseReadBoardPayload,
  parseReorderPayload,
  parseSetStatusPayload,
  parseStatusVersion,
  parseSummaryDraftSavePayload,
  parseSummaryReadPayload,
  parseSummarySavePayload,
  parseUndoStatusPayload,
  parseUpdateFieldsPayload,
  type ActivityEntryValue,
  type BoardFailureCodeWire,
  type BoardSnapshotValue,
  type FieldsBaselineWire,
  type FormalStatusValueWire,
  type KeptFieldInputWire,
  type KeptTaskInputWire,
  type ProjectListItem,
  type ReadBoardPayload,
  type SummaryBaselineWire,
  type SummaryContentWire,
  type SummaryDraftValue,
  type SummarySaveFailureDetails,
  type SummarySaveValue,
  type SummaryViewValue,
} from '@aikanban/plugin-client/wire'

/** One task as it travels on the wire (the pipeline member type is owned by `wire.ts`). */
type WireTask = BoardSnapshotValue['tasks'][number]

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
 * A `task/create` input after the handler validated the payload.
 *
 * `initialStatus` stays an opaque string at the boundary: the status vocabulary
 * belongs to core, which refuses an unknown one with its own echoed input. The
 * port has already resolved `projectId` through the host registry before core is
 * asked (a failed resolution is `unknown-project`, never a guessed home).
 */
export interface HostCreateTaskInput {
  readonly projectId: string
  readonly requestId: string
  readonly title: string
  readonly goal?: string
  readonly initialStatus?: string
  readonly blockedReason?: string
}

/**
 * A `task/fields.update` input after the handler decoded **both** baselines.
 *
 * The wire carries `expectedFieldsVersion: 'fver1:<n>'` and
 * `expectedStatusVersion: 'ver1:<n>'`; neither encoding crosses this port, so a
 * data layer only ever sees numbers (SAVE-05, same rule as the status writes).
 */
export interface HostUpdateFieldsInput {
  readonly taskId: string
  readonly requestId: string
  readonly expectedFieldsRevision: number
  readonly expectedStatusRevision: number
  readonly title?: string
  /** `null` explicitly clears the goal; absent leaves it unchanged. */
  readonly goal?: string | null
}

/** An `activity/read` input after the handler validated the scope and limit. */
export interface HostActivityInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly limit?: number
}

/** A creation whose result is known to the data layer. */
export interface HostCreateTaskSuccess {
  readonly ok: true
  readonly outcome: 'created' | 'already-created'
  /** The created (or already existing) task, already mapped to the wire shape. */
  readonly task: WireTask
  /**
   * The board re-read, or `null` when it failed. `null` means "the creation
   * landed, the view did not refresh", never an empty board (REC-01/REC-05).
   */
  readonly snapshot: BoardSnapshotValue | null
}

/** A creation that was refused or did not land. Nothing was created. */
export interface HostCreateTaskFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
  /** The typed input core echoed back, so the form can keep it (F01-R02). */
  readonly keptInput?: KeptTaskInputWire
  /** The deterministic id a failed creation would have produced, when core gives it. */
  readonly taskId?: string
}

/** Result of a host-side creation. */
export type HostCreateTaskOutcome = HostCreateTaskSuccess | HostCreateTaskFailure

/** A field save whose result is known (`saved`/`no-change`/`already-applied`). */
export interface HostUpdateFieldsSuccess {
  readonly ok: true
  readonly outcome: 'saved' | 'no-change' | 'already-applied'
  readonly task: WireTask
  readonly changed: readonly ('title' | 'goal')[]
  readonly fieldsRevision: number
  /** `null` when the save landed but the board re-read failed (view stale). */
  readonly snapshot: BoardSnapshotValue | null
}

/** A field save that was refused or failed. Nothing was written. */
export interface HostUpdateFieldsFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
  readonly current?: FormalStatusValueWire
  /** The editor's input, kept for "the draft stays in place" (F01-R05). */
  readonly keptInput?: KeptFieldInputWire
  /** Expected vs actual SAVE-05 baseline (`stale-baseline` only). */
  readonly baseline?: { readonly expected: FieldsBaselineWire; readonly actual: FieldsBaselineWire }
}

/** Result of a host-side field save. */
export type HostUpdateFieldsOutcome = HostUpdateFieldsSuccess | HostUpdateFieldsFailure

/** An activity read that succeeded. An empty `entries` is a legal empty history. */
export interface HostActivitySuccess {
  readonly ok: true
  readonly entries: readonly ActivityEntryValue[]
}

/** An activity read that failed. Never an empty history standing in for a failure. */
export interface HostActivityFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of a host-side activity read. */
export type HostActivityOutcome = HostActivitySuccess | HostActivityFailure

/** A `summary/read` input after the handler validated the scope. */
export interface HostSummaryReadInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
}

/**
 * A `summary/save` input after the handler decoded the SAVE-05 baseline.
 *
 * `expected` is the baseline the editor was built against; the data layer
 * refuses a stale one instead of merging (F03-R04). The handler does not decide
 * `content`/`cleared` semantics — core owns that refusal.
 */
export interface HostSummarySaveInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly updateId: string
  readonly expected: SummaryBaselineWire
  readonly content?: SummaryContentWire
  readonly cleared?: true
  readonly consumeDraftIds?: readonly string[]
}

/** A summary read that succeeded. `summary: null` is a legal "not written yet". */
export interface HostSummaryReadSuccess {
  readonly ok: true
  readonly summary: SummaryViewValue | null
}

/** A summary read that failed. Never an empty summary standing in for a failure. */
export interface HostSummaryReadFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of a host-side summary read. */
export type HostSummaryReadOutcome = HostSummaryReadSuccess | HostSummaryReadFailure

/**
 * A summary save whose result is known.
 *
 * `value.view === null` means the save landed but the authoritative re-read
 * failed; the browser must retry the READ, never the write.
 */
export interface HostSummarySaveSuccess {
  readonly ok: true
  readonly value: SummarySaveValue
}

/** A summary save that was refused or failed. Nothing was written. */
export interface HostSummarySaveFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
  /** Expected vs actual baseline (`stale-baseline` only). */
  readonly baseline?: SummarySaveFailureDetails['baseline']
}

/** Result of a host-side summary save. */
export type HostSummarySaveOutcome = HostSummarySaveSuccess | HostSummarySaveFailure

/** A `summary/draft.save` input after the handler validated the scope and body. */
export interface HostSummaryDraftSaveInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly content: SummaryContentWire
  readonly updateId?: string
}

/** A draft save that succeeded: the stored draft, never an official version. */
export interface HostSummaryDraftSaveSuccess {
  readonly ok: true
  readonly draft: SummaryDraftValue
}

/** A draft save that failed; official content is never reported as saved. */
export interface HostSummaryDraftSaveFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of a host-side manual draft save. */
export type HostSummaryDraftSaveOutcome = HostSummaryDraftSaveSuccess | HostSummaryDraftSaveFailure

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
  /**
   * Idempotently create one task in a project that is registered (or
   * registrable) in the host's workspace registry (F01-R02/R03, REC-02).
   */
  createTask(input: HostCreateTaskInput, signal?: AbortSignal): Promise<HostCreateTaskOutcome>
  /**
   * Save a task's title/goal under both decoded baselines (F01-R05/R06,
   * SAVE-05). A stale baseline is a failure with `current` + `baseline`.
   */
  updateTaskFields(input: HostUpdateFieldsInput, signal?: AbortSignal): Promise<HostUpdateFieldsOutcome>
  /** Read the important-change history of one task or project (F01-R07). */
  readActivity(input: HostActivityInput, signal?: AbortSignal): Promise<HostActivityOutcome>
  /**
   * Read one task's manual summary or one project's manual overview (F03).
   *
   * An existing scope with no official body answers `summary: null` — an
   * explicit "not written yet" state, never a fabricated empty view.
   */
  readSummary(input: HostSummaryReadInput, signal?: AbortSignal): Promise<HostSummaryReadOutcome>
  /**
   * Save (or clear) one manual summary under its SAVE-05 baseline (F03-R02).
   *
   * A retry after an unknown result reuses `updateId` (the data layer answers
   * `already-applied`); drafts are consumed only after a commit (F03-R07).
   */
  saveSummary(input: HostSummarySaveInput, signal?: AbortSignal): Promise<HostSummarySaveOutcome>
  /**
   * Save the in-flight manual draft of one scope (F03-R07).
   *
   * A draft save never creates an official version and never confirms; the
   * draft is consumed only by a later committed save.
   */
  saveSummaryDraft(input: HostSummaryDraftSaveInput, signal?: AbortSignal): Promise<HostSummaryDraftSaveOutcome>
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
 * stays within the published browser codes, so an adapter cannot return it.
 */
const INVALID_BASELINE_MESSAGE =
  'expectedStatusVersion 必须是规范的基线编码 "ver1:<非负整数>"；本次未读取或写入任何内容。'

/**
 * Host-side reason for refusing a field save whose fields baseline is missing
 * or not the canonical `fver1:<n>` encoding. Checked before the port for the
 * same reason as the status baseline (a silent 0 would weaken SAVE-05).
 */
const INVALID_FIELDS_BASELINE_MESSAGE =
  'expectedFieldsVersion 必须是规范的基线编码 "fver1:<非负整数>"；本次未读取或写入任何内容。'

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

    if (endpoint === BOARD_ENDPOINTS.taskCreate) {
      const input = parseCreateTaskPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'task/create payload must carry a non-empty projectId and requestId and a string title; nothing was created.')
      }
      try {
        const outcome = await port.createTask(
          {
            projectId: input.projectId,
            requestId: input.requestId,
            title: input.title,
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(input.initialStatus === undefined ? {} : { initialStatus: input.initialStatus }),
            ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
          },
          signal,
        )
        if (!outcome.ok) {
          return failure(outcome.code, outcome.message, {
            ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
            ...(outcome.keptInput === undefined ? {} : { keptInput: outcome.keptInput }),
          })
        }
        // The success value keeps "known result" and "view refreshed" apart:
        // `snapshot: null` means the creation landed but the re-read failed.
        return success({ outcome: outcome.outcome, task: outcome.task, snapshot: outcome.snapshot })
      } catch (error) {
        return failure('unknown-result', `创建结果未知：${messageOf(error)}；请先核对当前正式状态，不要重复提交。`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.taskFieldsUpdate) {
      const input = parseUpdateFieldsPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'task/fields.update payload must carry a non-empty taskId, requestId, both field/status baselines and only string fields (goal may be null to clear it).')
      }
      // SAVE-05: both baseline grammars are protocol rules checked before the
      // port; the data layer only ever receives decoded revisions.
      const expectedFieldsRevision = parseFieldsVersion(input.expectedFieldsVersion)
      if (expectedFieldsRevision === null) {
        return failure('invalid-payload', INVALID_FIELDS_BASELINE_MESSAGE)
      }
      const expectedStatusRevision = parseStatusVersion(input.expectedStatusVersion)
      if (expectedStatusRevision === null) {
        return failure('invalid-payload', INVALID_BASELINE_MESSAGE)
      }
      try {
        const outcome = await port.updateTaskFields(
          {
            taskId: input.taskId,
            requestId: input.requestId,
            expectedFieldsRevision,
            expectedStatusRevision,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.goal === undefined ? {} : { goal: input.goal }),
          },
          signal,
        )
        if (!outcome.ok) {
          return failure(outcome.code, outcome.message, {
            ...(outcome.current === undefined ? {} : { current: outcome.current }),
            ...(outcome.keptInput === undefined ? {} : { keptInput: outcome.keptInput }),
            ...(outcome.baseline === undefined ? {} : { baseline: outcome.baseline }),
          })
        }
        return success({
          outcome: outcome.outcome,
          task: outcome.task,
          changed: outcome.changed,
          fieldsRevision: outcome.fieldsRevision,
          snapshot: outcome.snapshot,
        })
      } catch (error) {
        return failure('unknown-result', `保存结果未知：${messageOf(error)}；请先核对当前正式状态，不要重复提交。`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.activityRead) {
      const input = parseActivityPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'activity/read payload must carry scopeKind "task" or "project", a non-empty scopeId and an optional non-negative integer limit.')
      }
      try {
        const outcome = await port.readActivity(
          {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          signal,
        )
        // Success value is exactly `{ entries }`: details are passed through
        // verbatim (the wire parser validates that every value is a string).
        return outcome.ok ? success({ entries: outcome.entries }) : failure(outcome.code, outcome.message)
      } catch (error) {
        return failure('read-failed', `读取活动历史失败：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.summaryRead) {
      const input = parseSummaryReadPayload(payload)
      if (input === null) {
        return failure('invalid-payload', 'summary/read payload must carry scopeKind "task" or "project" and a non-empty scopeId.')
      }
      try {
        const outcome = await port.readSummary({ scopeKind: input.scopeKind, scopeId: input.scopeId }, signal)
        // `summary: null` is a legal "not written yet" answer; a failed read is
        // an explicit failure and is never turned into that empty state.
        return outcome.ok ? success({ summary: outcome.summary }) : failure(outcome.code, outcome.message)
      } catch (error) {
        return failure('read-failed', `读取概况失败：${messageOf(error)}`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.summarySave) {
      const input = parseSummarySavePayload(payload)
      if (input === null) {
        return failure(
          'invalid-payload',
          'summary/save payload must carry a valid scope, a non-empty updateId, non-negative expected revisions, an optional version id, and a structurally valid content/cleared/consumeDraftIds.',
        )
      }
      // Shape is protocol; "content XOR cleared" is core's product rule and is
      // deliberately left to core so its refusal message stays authoritative.
      try {
        const outcome = await port.saveSummary(
          {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            updateId: input.updateId,
            expected: {
              revision: input.expectedRevision,
              applicabilityRevision: input.expectedApplicabilityRevision,
              summaryVersionId: input.expectedSummaryVersionId,
            },
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.cleared === undefined ? {} : { cleared: true as const }),
            ...(input.consumeDraftIds === undefined ? {} : { consumeDraftIds: input.consumeDraftIds }),
          },
          signal,
        )
        if (!outcome.ok) {
          return failure(outcome.code, outcome.message, {
            ...(outcome.baseline === undefined ? {} : { baseline: outcome.baseline }),
          })
        }
        return success(outcome.value)
      } catch (error) {
        return failure('unknown-result', `概况保存结果未知：${messageOf(error)}；请先核对当前概况，不要重复提交。`)
      }
    }

    if (endpoint === BOARD_ENDPOINTS.summaryDraftSave) {
      const input = parseSummaryDraftSavePayload(payload)
      if (input === null) {
        return failure(
          'invalid-payload',
          'summary/draft.save payload must carry scopeKind "task" or "project", a non-empty scopeId, a structurally valid content body and an optional non-empty updateId.',
        )
      }
      try {
        const outcome = await port.saveSummaryDraft(
          {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            content: input.content,
            ...(input.updateId === undefined ? {} : { updateId: input.updateId }),
          },
          signal,
        )
        return outcome.ok ? success({ draft: outcome.draft }) : failure(outcome.code, outcome.message)
      } catch (error) {
        return failure('unknown-result', `概况草稿保存结果未知：${messageOf(error)}；请先核对当前草稿，不要重复提交。`)
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
