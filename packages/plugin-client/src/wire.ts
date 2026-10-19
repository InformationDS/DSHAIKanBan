/**
 * The F02 board wire: the one channel both halves agree on.
 *
 * ## Why this file exists in the browser-half package
 *
 * The `wire` entry is deliberately **React-free and implementation-free**: it
 * holds the channel name, the endpoint names, the JSON payload/value shapes and
 * the boundary guards. Both halves import it (the host half bundles it in), so a
 * name or shape change cannot land on one side only. The protocol itself is
 * DSH's `ctx.connection.rpc` (`dsh-client-connection`): the host half registers
 * an authenticated absolute channel prefix with `rpc.handle(channel, handler)`,
 * the browser half calls `rpc.call(channel, endpoint, payload)`. See ADR-005.
 *
 * ## What travels, and what must not
 *
 * Only plain JSON crosses: board snapshots, task cards, write results and
 * failure codes. No drafts, no records, no history text, and no functions. The
 * transport's own envelope carries a domain failure as `{ok:false,
 * error:{code,message,details}}`, which is exactly the shape the UI needs in
 * order to tell an unconfirmed change apart from a confirmed one.
 *
 * ## Guards, not trust
 *
 * Every value read off the wire is validated here before it can reach the UI.
 * A response that does not match is a **failure** (`read-failed` /
 * `invalid-response`), never a silently empty or partially populated board
 * (REC-05).
 *
 * @module @aikanban/plugin-client/wire
 */

import {
  type BoardActionHint,
  type BoardCapabilities,
  type BoardColumnInput,
  type BoardProjectView,
  type BoardTask,
  type TaskProgressView,
} from './model.js'

/**
 * Re-exported so the host half enforces the blocked-reason rule with the very
 * same predicate the browser half uses — the rule is part of the contract.
 */
export { isBlockedReasonValid, normalizeReason } from './model.js'

/* ------------------------------------------------------------------ *
 * Failure codes — the shared vocabulary
 * ------------------------------------------------------------------ */

/**
 * Every failure a board endpoint may report. The code travels in DSH's
 * `error.code` field and is what lets the UI tell an unsaved change apart from a
 * confirmed one, and a refusal apart from an unknown outcome. A code outside
 * this list is a protocol violation and is reported as `save-failed` (writes)
 * or `read-failed` (reads).
 */
export const BOARD_FAILURE_CODES = [
  'invalid-reason',
  'not-found',
  'save-failed',
  'stale-baseline',
  'unknown-result',
  'read-failed',
  'unknown-project',
  'unavailable',
] as const

/** One failure code. */
export type BoardFailureCodeWire = (typeof BOARD_FAILURE_CODES)[number]

/**
 * Narrow an untrusted code to the vocabulary.
 *
 * @param value - code read off the wire.
 * @returns the code, or null when it is not one of ours.
 */
export function isBoardFailureCode(value: unknown): value is BoardFailureCodeWire {
  return typeof value === 'string' && (BOARD_FAILURE_CODES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * Channel and endpoints
 * ------------------------------------------------------------------ */

/**
 * The absolute logical RPC channel this plugin owns.
 *
 * Must match DSH's `CHANNEL_PATTERN` (`^/[A-Za-z0-9._~-]+$`) and must not be
 * the reserved `/api`. A composition-level collision throws at registration, so
 * the name is asserted in tests rather than negotiated at runtime.
 */
export const BOARD_CHANNEL = '/aikanban'

/** Endpoint names, relative to {@link BOARD_CHANNEL}. Segments must match `^[A-Za-z0-9_$.-]+$`. */
export const BOARD_ENDPOINTS = {
  readBoard: 'board/read',
  setStatus: 'task/status.set',
  reorder: 'task/reorder',
  undoStatusChange: 'task/status.undo',
} as const

/** One endpoint name. */
export type BoardEndpoint = (typeof BOARD_ENDPOINTS)[keyof typeof BOARD_ENDPOINTS]

/** Every endpoint, for diagnostics and for the "unknown endpoint" error text. */
export const BOARD_ENDPOINT_LIST: readonly BoardEndpoint[] = Object.values(BOARD_ENDPOINTS)

/* ------------------------------------------------------------------ *
 * Payloads (browser half → host half)
 * ------------------------------------------------------------------ */

/** `board/read` payload. */
export interface ReadBoardPayload {
  /** Project key = `workspace.id` (F01). Absent means "the current project". */
  readonly projectId?: string
}

/** `task/status.set` payload. */
export interface SetStatusPayload {
  readonly taskId: string
  readonly next: string
  /** Identity of this user intent; a retry reuses it (REC-02). */
  readonly operationId: string
  /** Required when `next === 'blocked'`; validated on the host side too. */
  readonly reason?: string
  readonly toIndex?: number
  readonly expectedStatusVersion?: string
}

/** `task/reorder` payload. */
export interface ReorderPayload {
  readonly taskId: string
  readonly status: string
  readonly toIndex: number
  readonly operationId: string
  readonly expectedStatusVersion?: string
}

/** `task/status.undo` payload. */
export interface UndoStatusPayload {
  readonly taskId: string
  /** The `operationId` of the change being undone. */
  readonly operationId: string
  readonly expectedStatusVersion?: string
}

/* ------------------------------------------------------------------ *
 * Values (host half → browser half)
 * ------------------------------------------------------------------ */

/** One board read as JSON. A failed or unregistered project is an error, not this. */
export interface BoardSnapshotValue {
  readonly project: BoardProjectView
  readonly tasks: readonly BoardTask[]
  /** Columns in render order, exactly as core declared them. */
  readonly columns: readonly BoardColumnInput[]
  /** Change token from the data layer; a late response is dropped by comparing it. */
  readonly boardToken: string
  /** What the connected data layer can do; entries render only when `true`. */
  readonly capabilities: BoardCapabilities
}

/**
 * A successful write.
 *
 * `snapshot` is `null` when the write landed but the authoritative re-read did
 * not: the caller then keeps the view it has and says so, instead of showing
 * either a fabricated board or a false failure (REC-01).
 */
export interface BoardWriteValue {
  readonly snapshot: BoardSnapshotValue | null
  readonly undoable: boolean
}

/** The formal value carried by a failure's `details`. */
export interface FormalStatusValueWire {
  readonly status: string
  readonly statusVersion: string
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'

/**
 * A status id is opaque on this side of the wire: core owns the vocabulary, so
 * the wire only requires a non-empty identifier. An id core does not know is
 * refused by core itself, with its own error code.
 *
 * @param value - untrusted value.
 * @returns whether it is a usable status id.
 */
const isStatusId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * Parse a formal status value out of failure details.
 *
 * @param value - untrusted value.
 * @returns the value, or null when malformed.
 */
export function parseFormalStatusValue(value: unknown): FormalStatusValueWire | null {
  if (!isRecord(value)) return null
  if (!isStatusId(value['status'])) return null
  if (!isString(value['statusVersion'])) return null
  return { status: value['status'], statusVersion: value['statusVersion'] }
}

/**
 * Sentinel for "present but malformed".
 *
 * `undefined` means the field was absent and `null` is core's own "no official
 * summary" value — neither is an error, so a third, distinct outcome is needed.
 * Conflating them rejected every card that had no summary, which is exactly the
 * S1 case.
 */
const MALFORMED = Symbol('malformed')

/**
 * Parse the official summary progress.
 *
 * @param value - untrusted value.
 * @returns the value, `null` when core said there is none, `undefined` when
 *   absent, or {@link MALFORMED}.
 */
function parseSummaryProgress(value: unknown): TaskProgressView | null | undefined | typeof MALFORMED {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRecord(value)) return MALFORMED
  if (!isString(value['line']) || !isString(value['versionId']) || !isString(value['confirmedAt'])) return MALFORMED
  return { line: value['line'], versionId: value['versionId'], confirmedAt: value['confirmedAt'] }
}

function parseHints(value: unknown): readonly BoardActionHint[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const hints: BoardActionHint[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const kind = entry['kind']
    if (kind !== 'attention' && kind !== 'info') return undefined
    if (!isString(entry['text'])) return undefined
    hints.push({ kind, text: entry['text'] })
  }
  return hints
}

function parseRecheckCodes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined
  return value as readonly string[]
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return null
  return value
}

function optionalFiniteNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Parse one task card. Only the fields the board actually renders are required;
 * the rest are optional so a leaner host response is still legal.
 *
 * @param value - untrusted value.
 * @returns the task, or null when malformed.
 */
export function parseBoardTask(value: unknown): BoardTask | null {
  if (!isRecord(value)) return null
  const { taskId, projectId, title, goal, status, order } = value
  if (!isString(taskId) || !isString(projectId) || !isString(title) || !isString(goal)) return null
  if (!isStatusId(status)) return null
  if (typeof order !== 'number' || !Number.isFinite(order)) return null
  if (!isOptionalString(value['statusLabel'])) return null
  if (!isOptionalString(value['blockedReason'])) return null

  const archived = optionalBoolean(value['archived'])
  if (archived === null) return null
  const fieldsRevision = optionalFiniteNumber(value['fieldsRevision'])
  if (fieldsRevision === null) return null
  const statusRevision = optionalFiniteNumber(value['statusRevision'])
  if (statusRevision === null) return null
  const hasSummary = optionalBoolean(value['hasSummary'])
  if (hasSummary === null) return null
  const hasRecord = optionalBoolean(value['hasRecord'])
  if (hasRecord === null) return null
  const needsRecheck = optionalBoolean(value['needsRecheck'])
  if (needsRecheck === null) return null

  const summaryProgress = parseSummaryProgress(value['summaryProgress'])
  if (summaryProgress === MALFORMED) return null
  const hints = parseHints(value['hints'])
  if (value['hints'] !== undefined && hints === undefined) return null
  const recheckCodes = parseRecheckCodes(value['recheckCodes'])
  if (value['recheckCodes'] !== undefined && recheckCodes === undefined) return null

  const statusLabel = value['statusLabel']
  const blockedReason = value['blockedReason']

  return {
    taskId,
    projectId,
    title,
    goal,
    status,
    order,
    ...(statusLabel === undefined ? {} : { statusLabel }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(archived === undefined ? {} : { archived }),
    ...(fieldsRevision === undefined ? {} : { fieldsRevision }),
    ...(statusRevision === undefined ? {} : { statusRevision }),
    ...(summaryProgress === undefined ? {} : { summaryProgress }),
    ...(hasSummary === undefined ? {} : { hasSummary }),
    ...(hasRecord === undefined ? {} : { hasRecord }),
    ...(needsRecheck === undefined ? {} : { needsRecheck }),
    ...(recheckCodes === undefined ? {} : { recheckCodes }),
    ...(hints === undefined ? {} : { hints }),
  }
}

function parseCapabilities(value: unknown): BoardCapabilities | null {
  if (!isRecord(value)) return null
  const statusChange = value['statusChange']
  const reorder = value['reorder']
  const undo = value['undo']
  if (typeof statusChange !== 'boolean' || typeof reorder !== 'boolean' || typeof undo !== 'boolean') return null
  return { statusChange, reorder, undo }
}

function parseColumn(value: unknown): BoardColumnInput | null {
  if (!isRecord(value)) return null
  if (!isStatusId(value['status'])) return null
  if (!isOptionalString(value['label'])) return null
  const collapsedByDefault = optionalBoolean(value['collapsedByDefault'])
  if (collapsedByDefault === null) return null

  let tasks: BoardTask[] | undefined
  if (value['tasks'] !== undefined) {
    if (!Array.isArray(value['tasks'])) return null
    tasks = []
    for (const entry of value['tasks']) {
      const task = parseBoardTask(entry)
      if (task === null) return null
      tasks.push(task)
    }
  }

  const label = value['label']
  return {
    status: value['status'],
    ...(label === undefined ? {} : { label }),
    ...(collapsedByDefault === undefined ? {} : { collapsedByDefault }),
    ...(tasks === undefined ? {} : { tasks }),
  }
}

/**
 * Parse a whole board snapshot.
 *
 * @param value - untrusted value.
 * @returns the snapshot, or null when malformed (the caller reports a failure).
 */
export function parseBoardSnapshotValue(value: unknown): BoardSnapshotValue | null {
  if (!isRecord(value)) return null
  const project = value['project']
  if (!isRecord(project)) return null
  if (!isString(project['projectId']) || !isString(project['title'])) return null
  const availability = project['workScopeAvailability']
  if (availability !== 'ok' && availability !== 'missing-dir' && availability !== 'unknown') return null
  if (typeof project['workScopeAllowed'] !== 'boolean') return null
  if (!isOptionalString(project['path'])) return null
  if (!isOptionalString(project['workScopeReason'])) return null

  const tasks = value['tasks']
  if (!Array.isArray(tasks)) return null
  const parsed: BoardTask[] = []
  for (const entry of tasks) {
    const task = parseBoardTask(entry)
    if (task === null) return null
    parsed.push(task)
  }

  if (!isString(value['boardToken'])) return null
  const capabilities = parseCapabilities(value['capabilities'])
  if (capabilities === null) return null

  const columns = value['columns']
  if (!Array.isArray(columns)) return null
  const parsedColumns: BoardColumnInput[] = []
  for (const entry of columns) {
    const column = parseColumn(entry)
    if (column === null) return null
    parsedColumns.push(column)
  }

  const path = project['path']
  const workScopeReason = project['workScopeReason']

  return {
    project: {
      projectId: project['projectId'],
      title: project['title'],
      workScopeAvailability: availability,
      workScopeAllowed: project['workScopeAllowed'],
      ...(path === undefined ? {} : { path }),
      ...(workScopeReason === undefined ? {} : { workScopeReason }),
    },
    tasks: parsed,
    columns: parsedColumns,
    boardToken: value['boardToken'],
    capabilities,
  }
}

/**
 * Parse a successful write value.
 *
 * @param value - untrusted value.
 * @returns the value, or null when malformed.
 */
export function parseBoardWriteValue(value: unknown): BoardWriteValue | null {
  if (!isRecord(value)) return null
  const raw = value['snapshot']
  const snapshot = raw === null ? null : parseBoardSnapshotValue(raw)
  if (snapshot === null && raw !== null) return null
  const undoable = value['undoable']
  if (typeof undoable !== 'boolean') return null
  return { snapshot, undoable }
}

/* ------------------------------------------------------------------ *
 * Payload guards (host half)
 * ------------------------------------------------------------------ */

/**
 * Parse a `board/read` payload. An omitted payload is legal (the host resolves
 * the current project).
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseReadBoardPayload(value: unknown): ReadBoardPayload | null {
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) return null
  if (!isOptionalString(value['projectId'])) return null
  const projectId = value['projectId']
  return projectId === undefined ? {} : { projectId }
}

function optionalIndex(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * Parse a `task/status.set` payload.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseSetStatusPayload(value: unknown): SetStatusPayload | null {
  if (!isRecord(value)) return null
  const { taskId, operationId, next } = value
  if (!isString(taskId) || taskId.length === 0) return null
  if (!isString(operationId) || operationId.length === 0) return null
  if (!isStatusId(next)) return null
  if (!isOptionalString(value['reason'])) return null
  if (!isOptionalString(value['expectedStatusVersion'])) return null
  const toIndex = optionalIndex(value['toIndex'])
  if (toIndex === null) return null

  const reason = value['reason']
  const expectedStatusVersion = value['expectedStatusVersion']
  return {
    taskId,
    next,
    operationId,
    ...(reason === undefined ? {} : { reason }),
    ...(toIndex === undefined ? {} : { toIndex }),
    ...(expectedStatusVersion === undefined ? {} : { expectedStatusVersion }),
  }
}

/**
 * Parse a `task/reorder` payload.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseReorderPayload(value: unknown): ReorderPayload | null {
  if (!isRecord(value)) return null
  const { taskId, operationId, status } = value
  if (!isString(taskId) || taskId.length === 0) return null
  if (!isString(operationId) || operationId.length === 0) return null
  if (!isStatusId(status)) return null
  const toIndex = optionalIndex(value['toIndex'])
  if (toIndex === undefined || toIndex === null) return null
  if (!isOptionalString(value['expectedStatusVersion'])) return null
  const expectedStatusVersion = value['expectedStatusVersion']
  return {
    taskId,
    status,
    toIndex,
    operationId,
    ...(expectedStatusVersion === undefined ? {} : { expectedStatusVersion }),
  }
}

/**
 * Parse a `task/status.undo` payload.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseUndoStatusPayload(value: unknown): UndoStatusPayload | null {
  if (!isRecord(value)) return null
  const { taskId, operationId } = value
  if (!isString(taskId) || taskId.length === 0) return null
  if (!isString(operationId) || operationId.length === 0) return null
  if (!isOptionalString(value['expectedStatusVersion'])) return null
  const expectedStatusVersion = value['expectedStatusVersion']
  return {
    taskId,
    operationId,
    ...(expectedStatusVersion === undefined ? {} : { expectedStatusVersion }),
  }
}
