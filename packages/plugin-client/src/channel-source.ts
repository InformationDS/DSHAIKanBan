/**
 * The browser half's data source over DSH's Connection RPC channel.
 *
 * ## The channel
 *
 * `ctx.connection` is a client service provided by `@deepseek-ai/dsh-client-connection`
 * (declared `immediately: true`, so it is composed before any page plugin runs).
 * Its `rpc.call(channel, endpoint, payload, signal)` POSTs to
 * `/<channel>/<endpoint>` and returns the host's `ConnectionRpcResult`. The
 * matching host registration is `ctx.connection.rpc.handle('/aikanban', handler)`,
 * which DSH mounts as an **authenticated** prefix route (Host/Origin checks and
 * the browser token run before our handler). See ADR-005.
 *
 * ## Honesty rules this adapter enforces
 *
 * - A read either returns a *parsed* snapshot or a failure. A malformed response
 *   is a failure (`read-failed`), never an empty board (REC-05).
 * - A write that the transport could not confirm is `unknown-result`, not
 *   "saved" and not "definitely not saved" (REC-03: verify before retrying).
 * - Failure codes are taken from the host's `error.code` when it is one of ours;
 *   anything else is reported as `save-failed` with the host's message.
 * - The project list is a **candidate set**, read fresh on every entry. A failed
 *   listing (`unavailable`/`read-failed`) is reported as a failure and never
 *   collapsed into an empty list; listing never selects anything (Q1=B).
 *
 * @module @aikanban/plugin-client/channel-source
 */

import type {
  ActivityInput,
  ActivityResult,
  BoardFailureCode,
  BoardReadResult,
  BoardSnapshot,
  BoardSource,
  CreateTaskInput,
  CreateTaskResult,
  FormalStatusValue,
  ManualSummaryDraftSaveInput,
  ManualSummarySaveInput,
  ProjectListResult,
  ReadSummaryInput,
  ReorderInput,
  StatusChangeInput,
  SummaryDraftSaveResult,
  SummaryReadResult,
  SummarySaveResult,
  UndoInput,
  UpdateFieldsInput,
  UpdateFieldsResult,
  WriteResult,
} from './source.js'
import {
  BOARD_CHANNEL,
  BOARD_ENDPOINTS,
  isBoardFailureCode,
  parseActivityValue,
  parseBoardSnapshotValue,
  parseBoardWriteValue,
  parseCreateTaskFailureDetails,
  parseCreateTaskValue,
  parseFormalStatusValue,
  parseProjectListValue,
  parseSummaryDraftSaveValue,
  parseSummaryReadValue,
  parseSummarySaveFailureDetails,
  parseSummarySaveValue,
  parseUpdateFieldsFailureDetails,
  parseUpdateFieldsValue,
  type ActivityPayload,
  type CreateTaskPayload,
  type ProjectListPayload,
  type ReadBoardPayload,
  type ReorderPayload,
  type SetStatusPayload,
  type SummaryDraftSavePayload,
  type SummaryReadPayload,
  type SummarySavePayload,
  type UndoStatusPayload,
  type UpdateFieldsPayload,
} from './wire.js'

/* ------------------------------------------------------------------ *
 * The structural view of `ctx.connection`
 * ------------------------------------------------------------------ */

/** DSH's `ConnectionRpcResult`. Mirrored structurally; no import. */
export type ConnectionRpcResultLike =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }

/** DSH's `ClientConnectionRpc`. */
export interface ConnectionRpcLike {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResultLike>
}

/** DSH's client `connection` service, as far as this plugin uses it. */
export interface ConnectionLike {
  readonly rpc: ConnectionRpcLike
}

/**
 * Tolerant probe for the connection service. Used instead of a hard `inject`
 * entry: a declared-but-absent service parks the plugin fiber forever, whereas
 * a probe lets the panel render an explicit failure (REC-05).
 *
 * @param value - a candidate service.
 * @returns whether it can serve as a Connection RPC caller.
 */
export function isConnectionLike(value: unknown): value is ConnectionLike {
  if (typeof value !== 'object' || value === null) return false
  const rpc = (value as { rpc?: unknown }).rpc
  if (typeof rpc !== 'object' || rpc === null) return false
  return typeof (rpc as { call?: unknown }).call === 'function'
}

/* ------------------------------------------------------------------ *
 * Failure mapping
 * ------------------------------------------------------------------ */

/**
 * Read failures are narrowed to the three outcomes the panel can act on:
 * `unknown-project` (its own visible state), `read-failed` (keep data, retry),
 * `unavailable` (no channel). Anything else is a read failure.
 *
 * @param code - the host's code.
 * @returns the read failure code to report.
 */
function readFailureCode(code: unknown): BoardFailureCode {
  if (code === 'unknown-project' || code === 'unavailable') return code
  return 'read-failed'
}

/** Text used when a response cannot be parsed. */
export const MALFORMED_RESPONSE_MESSAGE = '宿主返回的数据格式无效，未改变任何内容。'

function currentFromDetails(details: unknown): FormalStatusValue | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const parsed = parseFormalStatusValue((details as { current?: unknown }).current)
  return parsed ?? undefined
}

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

/** Options for {@link createChannelBoardSource}. */
export interface ChannelBoardSourceOptions {
  /** Channel override; defaults to {@link BOARD_CHANNEL}. */
  readonly channel?: string
}

/**
 * Build a {@link BoardSource} that talks to this plugin's own host half.
 *
 * The source holds **no project selection**: every read carries the id the
 * caller was given, and there is no "current project" (Q1=B). The controller is
 * the only owner of the selection.
 *
 * @param connection - the injected `ctx.connection` service.
 * @param options - channel override.
 * @returns a board source whose every failure is explicit.
 */
export function createChannelBoardSource(connection: ConnectionLike, options: ChannelBoardSourceOptions = {}): BoardSource {
  const channel = options.channel ?? BOARD_CHANNEL

  const call = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResultLike> =>
    connection.rpc.call(channel, endpoint, payload)

  const readBoard = async (projectId: string): Promise<BoardReadResult> => {
    // A read without a selection is a caller bug, not a request to guess: refuse
    // locally and send nothing. Controller state is the only source of the id.
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return {
        ok: false,
        code: 'read-failed',
        message: '读取被拒绝：没有显式选择的项目 id；宿主不会猜测项目。',
      }
    }
    const payload: ReadBoardPayload = { projectId }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.readBoard, payload)
    } catch (error) {
      return { ok: false, code: 'read-failed', message: `${MALFORMED_RESPONSE_MESSAGE}（${messageOf(error)}）` }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: readFailureCode(result.error.code),
        message: result.error.message,
      }
    }
    const snapshot = parseBoardSnapshotValue(result.value)
    if (snapshot === null) return { ok: false, code: 'read-failed', message: MALFORMED_RESPONSE_MESSAGE }
    const value: BoardSnapshot = snapshot
    return { ok: true, snapshot: value }
  }

  const write = async (
    endpoint: string,
    payload: SetStatusPayload | ReorderPayload | UndoStatusPayload,
  ): Promise<WriteResult> => {    let result: ConnectionRpcResultLike
    try {
      result = await call(endpoint, payload)
    } catch (error) {
      // REC-03: an unconfirmed write is "unknown". Do not invite a resubmission —
      // the user must first establish the current formal state.
      return {
        ok: false,
        code: 'unknown-result',
        message: `写入结果未知，请先核对当前正式状态，不要重复提交。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      const current = currentFromDetails(result.error.details)
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
        ...(current === undefined ? {} : { current }),
      }
    }
    const value = parseBoardWriteValue(result.value)
    if (value === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
    }
    if (value.snapshot === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
    }
    return { ok: true, snapshot: value.snapshot, undoable: value.undoable }
  }

  /**
   * List the selectable projects (Q1=B).
   *
   * The call goes through the same authenticated channel and carries an empty
   * payload: listing never selects anything. A transport rejection means the
   * channel is not registered/connected (no host half is listening), reported as
   * `unavailable`; a malformed success value is `read-failed`. Neither is ever
   * turned into an empty candidate list.
   */
  const listProjects = async (): Promise<ProjectListResult> => {
    const payload: ProjectListPayload = {}
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.listProjects, payload)
    } catch (error) {
      return {
        ok: false,
        code: 'unavailable',
        message: `项目清单通道未接通，未读取任何项目。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: readFailureCode(result.error.code),
        message: result.error.message,
      }
    }
    const value = parseProjectListValue(result.value)
    if (value === null) return { ok: false, code: 'read-failed', message: MALFORMED_RESPONSE_MESSAGE }
    return { ok: true, projects: value.projects }
  }

  /**
   * Create one task (F01-R02/R03).
   *
   * An unconfirmed transport is `unknown-result` (REC-03: verify before
   * resubmitting). A known success value with `snapshot: null` is **not** an
   * error: the creation landed and only the view refresh failed.
   */
  const createTask = async (input: CreateTaskInput): Promise<CreateTaskResult> => {
    // A creation without a project is a caller bug, not a request to guess.
    if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '创建被拒绝：没有显式选择的项目 id；宿主不会猜测项目，未创建任何任务。' }
    }
    const payload: CreateTaskPayload = {
      projectId: input.projectId,
      requestId: input.requestId,
      title: input.title,
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.initialStatus === undefined ? {} : { initialStatus: input.initialStatus }),
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
    }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.taskCreate, payload)
    } catch (error) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `创建结果未知，请先核对当前正式状态，不要重复提交。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      const details = parseCreateTaskFailureDetails(result.error.details)
      const keptInput = details?.keptInput
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
        ...(keptInput === undefined ? {} : { keptInput }),
      }
    }
    const value = parseCreateTaskValue(result.value)
    if (value === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态，不要重复提交。` }
    }
    return { ok: true, task: value.task, outcome: value.outcome, snapshot: value.snapshot }
  }

  /**
   * Save a task's title/goal under both SAVE-05 baselines (F01-R05/R06).
   *
   * An unconfirmed transport is `unknown-result`; a known result with
   * `snapshot: null` means the save landed but the view refresh failed. A
   * `stale-baseline` failure carries the expected/actual baselines and the
   * formal current status so the editor can show what changed.
   */
  const updateTaskFields = async (input: UpdateFieldsInput): Promise<UpdateFieldsResult> => {
    if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '保存被拒绝：缺少任务 id；正式值未改变。' }
    }
    const payload: UpdateFieldsPayload = {
      taskId: input.taskId,
      requestId: input.requestId,
      expectedFieldsVersion: input.expectedFieldsVersion,
      expectedStatusVersion: input.expectedStatusVersion,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
    }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.taskFieldsUpdate, payload)
    } catch (error) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `保存结果未知，请先核对当前正式状态，不要重复提交。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      const details = parseUpdateFieldsFailureDetails(result.error.details)
      const current = details?.current
      const keptInput = details?.keptInput
      const baseline = details?.baseline
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
        ...(current === undefined ? {} : { current }),
        ...(keptInput === undefined ? {} : { keptInput }),
        ...(baseline === undefined ? {} : { baseline }),
      }
    }
    const value = parseUpdateFieldsValue(result.value)
    if (value === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态，不要重复提交。` }
    }
    return {
      ok: true,
      outcome: value.outcome,
      task: value.task,
      changed: value.changed,
      fieldsRevision: value.fieldsRevision,
      snapshot: value.snapshot,
    }
  }

  /**
   * Read the important-change history (F01-R07).
   *
   * Read failures are narrowed like every other read: `unavailable`,
   * `unknown-project` or `read-failed`. An empty `entries` array is a legal
   * empty history and is passed through unchanged.
   */
  const loadActivity = async (input: ActivityInput): Promise<ActivityResult> => {
    // The wire allows two scopes only; refuse locally so a caller bug cannot
    // reach the host with a scope core does not keep history for.
    if (input.scopeKind !== 'task' && input.scopeKind !== 'project') {
      return { ok: false, code: 'invalid-input', message: '活动历史读取被拒绝：scopeKind 只允许 task 或 project。' }
    }
    if (typeof input.scopeId !== 'string' || input.scopeId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '活动历史读取被拒绝：缺少范围 id。' }
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
      return { ok: false, code: 'invalid-input', message: '活动历史读取被拒绝：limit 必须是非负整数。' }
    }
    const payload: ActivityPayload = {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.activityRead, payload)
    } catch (error) {
      return { ok: false, code: 'read-failed', message: `${MALFORMED_RESPONSE_MESSAGE}（${messageOf(error)}）` }
    }
    if (!result.ok) {
      return { ok: false, code: readFailureCode(result.error.code), message: result.error.message }
    }
    const value = parseActivityValue(result.value)
    if (value === null) return { ok: false, code: 'read-failed', message: MALFORMED_RESPONSE_MESSAGE }
    return { ok: true, entries: value.entries }
  }

  /**
   * Read one manual summary / project overview (F03).
   *
   * Read failures are narrowed like every other read. `summary: null` is passed
   * through unchanged: an existing scope with no official body yet is a legal
   * empty state, not a failed read (F03-R01).
   */
  const readSummary = async (input: ReadSummaryInput): Promise<SummaryReadResult> => {
    if (input.scopeKind !== 'task' && input.scopeKind !== 'project') {
      return { ok: false, code: 'invalid-input', message: '概况读取被拒绝：scopeKind 只允许 task 或 project。' }
    }
    if (typeof input.scopeId !== 'string' || input.scopeId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '概况读取被拒绝：缺少范围 id。' }
    }
    const payload: SummaryReadPayload = { scopeKind: input.scopeKind, scopeId: input.scopeId }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.summaryRead, payload)
    } catch (error) {
      return { ok: false, code: 'read-failed', message: `${MALFORMED_RESPONSE_MESSAGE}（${messageOf(error)}）` }
    }
    if (!result.ok) {
      return { ok: false, code: readFailureCode(result.error.code), message: result.error.message }
    }
    const value = parseSummaryReadValue(result.value)
    if (value === null) return { ok: false, code: 'read-failed', message: MALFORMED_RESPONSE_MESSAGE }
    return { ok: true, summary: value.summary }
  }

  /**
   * Save (or clear) one manual summary under its SAVE-05 baseline (F03-R02).
   *
   * An unconfirmed transport is `unknown-result`; a known result with
   * `view: null` means the save landed but the authoritative re-read failed
   * (retry the READ, never the write). A `stale-baseline` failure carries both
   * baselines so the editor can reconcile without guessing.
   */
  const saveSummary = async (input: ManualSummarySaveInput): Promise<SummarySaveResult> => {
    if (input.scopeKind !== 'task' && input.scopeKind !== 'project') {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：scopeKind 只允许 task 或 project。' }
    }
    if (typeof input.scopeId !== 'string' || input.scopeId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：缺少范围 id。' }
    }
    if (typeof input.updateId !== 'string' || input.updateId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：缺少 updateId；未保存任何内容。' }
    }
    const expected = input.expected
    if (!Number.isInteger(expected.revision) || expected.revision < 0) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：expected.revision 必须是非负整数。' }
    }
    if (!Number.isInteger(expected.applicabilityRevision) || expected.applicabilityRevision < 0) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：expected.applicabilityRevision 必须是非负整数。' }
    }
    if (expected.summaryVersionId !== null && (typeof expected.summaryVersionId !== 'string' || expected.summaryVersionId.length === 0)) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：expected.summaryVersionId 必须是版本 id 或 null。' }
    }
    if (input.content === undefined && input.cleared !== true) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：没有要保存的内容。' }
    }
    if (input.content !== undefined && input.cleared === true) {
      return { ok: false, code: 'invalid-input', message: '概况保存被拒绝：content 与 cleared 不能同时出现。' }
    }
    const payload: SummarySavePayload = {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      updateId: input.updateId,
      expectedRevision: expected.revision,
      expectedApplicabilityRevision: expected.applicabilityRevision,
      expectedSummaryVersionId: expected.summaryVersionId,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.cleared === undefined ? {} : { cleared: true as const }),
      ...(input.consumeDraftIds === undefined ? {} : { consumeDraftIds: input.consumeDraftIds }),
    }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.summarySave, payload)
    } catch (error) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `概况保存结果未知，请先核对当前概况，不要重复提交。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      const details = parseSummarySaveFailureDetails(result.error.details)
      const baseline = details?.baseline
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
        ...(baseline === undefined ? {} : { baseline }),
      }
    }
    const value = parseSummarySaveValue(result.value)
    if (value === null) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前概况，不要重复提交。`,
      }
    }
    return { ok: true, ...value }
  }

  /**
   * Save the in-flight manual draft (F03-R07). A draft never creates a version.
   *
   * An unconfirmed transport is `unknown-result`: the editor re-reads the
   * summary/draft before any retry, because claiming success would present
   * unsaved content as saved (REC-01/F03-R07).
   */
  const saveSummaryDraft = async (input: ManualSummaryDraftSaveInput): Promise<SummaryDraftSaveResult> => {
    if (input.scopeKind !== 'task' && input.scopeKind !== 'project') {
      return { ok: false, code: 'invalid-input', message: '概况草稿保存被拒绝：scopeKind 只允许 task 或 project。' }
    }
    if (typeof input.scopeId !== 'string' || input.scopeId.length === 0) {
      return { ok: false, code: 'invalid-input', message: '概况草稿保存被拒绝：缺少范围 id。' }
    }
    if (input.updateId !== undefined && (typeof input.updateId !== 'string' || input.updateId.length === 0)) {
      return { ok: false, code: 'invalid-input', message: '概况草稿保存被拒绝：updateId 必须是非空字符串。' }
    }
    const payload: SummaryDraftSavePayload = {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      content: input.content,
      ...(input.updateId === undefined ? {} : { updateId: input.updateId }),
    }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.summaryDraftSave, payload)
    } catch (error) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `概况草稿保存结果未知，请先核对当前草稿，不要重复提交。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
      }
    }
    const value = parseSummaryDraftSaveValue(result.value)
    if (value === null) {
      return {
        ok: false,
        code: 'unknown-result',
        message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前草稿，不要重复提交。`,
      }
    }
    return { ok: true, draft: value.draft }
  }

  return {
    transport: { kind: 'host', detail: `connection rpc ${channel}` },
    readBoard,
    listProjects,
    setStatus: (input: StatusChangeInput) => {
      const payload: SetStatusPayload = {
        taskId: input.taskId,
        next: input.next,
        operationId: input.operationId,
        expectedStatusVersion: input.expectedStatusVersion,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
      }
      return write(BOARD_ENDPOINTS.setStatus, payload)
    },
    reorder: (input: ReorderInput) => {
      const payload: ReorderPayload = {
        taskId: input.taskId,
        status: input.status,
        toIndex: input.toIndex,
        operationId: input.operationId,
        expectedStatusVersion: input.expectedStatusVersion,
      }
      return write(BOARD_ENDPOINTS.reorder, payload)
    },
    undoStatusChange: (input: UndoInput) => {
      const payload: UndoStatusPayload = {
        taskId: input.taskId,
        operationId: input.operationId,
        expectedStatusVersion: input.expectedStatusVersion,
        appliedUpdateId: input.appliedUpdateId,
      }
      return write(BOARD_ENDPOINTS.undoStatusChange, payload)
    },
    createTask,
    updateTaskFields,
    loadActivity,
    readSummary,
    saveSummary,
    saveSummaryDraft,
  }
}

/**
 * Message of an unknown thrown value.
 *
 * @param error - the thrown value.
 * @returns a printable message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
