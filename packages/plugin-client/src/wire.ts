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
 * Only plain JSON crosses: board snapshots, task cards, write results, activity
 * entries and failure codes. No drafts, no record bodies, no conversation
 * content, and no functions. The transport's own envelope carries a domain
 * failure as `{ok:false, error:{code,message,details}}`, which is exactly the
 * shape the UI needs in order to tell an unconfirmed change apart from a
 * confirmed one.
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
  type BoardProjectChoice,
  type BoardProjectView,
  type BoardTask,
  type BoardUndoTarget,
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
  /**
   * The input was refused before anything was written (blank title, unknown
   * status, missing field values, a creation whose identity collides). The
   * refusal echoes what the user typed (`keptInput`) so the form can keep it.
   * Slice B added this code; it is **not** a transport or storage failure.
   */
  'invalid-input',
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
  /**
   * The candidate project set, read fresh on every entry (Q1=B). Listing is a
   * host-registry read: it selects nothing, remembers nothing and writes nothing.
   */
  listProjects: 'project/list',
  setStatus: 'task/status.set',
  reorder: 'task/reorder',
  undoStatusChange: 'task/status.undo',
  /**
   * Idempotent task creation (F01-R02/R03). `requestId` is minted by the UI and
   * reused verbatim by a retry (REC-02); the host resolves the project through
   * its workspace registry before core creates anything.
   */
  taskCreate: 'task/create',
  /**
   * Substantive title/goal save (F01-R05/R06). Carries the SAVE-05 field and
   * status baselines; a stale baseline is refused, never overwritten.
   */
  taskFieldsUpdate: 'task/fields.update',
  /** Important-change history for one task or one project (F01-R07/SAVE-08). */
  activityRead: 'activity/read',
} as const

/** One endpoint name. */
export type BoardEndpoint = (typeof BOARD_ENDPOINTS)[keyof typeof BOARD_ENDPOINTS]

/** Every endpoint, for diagnostics and for the "unknown endpoint" error text. */
export const BOARD_ENDPOINT_LIST: readonly BoardEndpoint[] = Object.values(BOARD_ENDPOINTS)

/* ------------------------------------------------------------------ *
 * Payloads (browser half → host half)
 * ------------------------------------------------------------------ */

/**
 * `board/read` payload.
 *
 * `projectId` is **required**: there is no "current project" on the host side
 * (Q1=B — the user selects a project explicitly on every entry, in memory only).
 * A missing or empty id is refused by the host handler with `invalid-payload`;
 * the host never guesses a project.
 */
export interface ReadBoardPayload {
  /** Project key = `workspace.id` (F01). */
  readonly projectId: string
}

/**
 * `project/list` payload.
 *
 * Empty by contract. Listing is a read of the host's workspace registry; it
 * takes no selection and carries no hint of a "current" project (Q1=B). A
 * non-object payload is refused with `invalid-payload` — the host never guesses
 * a project from a listing request.
 */
export type ProjectListPayload = Readonly<Record<string, never>>

/**
 * `task/status.set` payload.
 *
 * `expectedStatusVersion` is the write baseline (SAVE-05 / F02-R04): the version
 * of the formal status the user decided on, encoded as `ver1:<n>` (see
 * {@link encodeStatusVersion}). The host handler validates the encoding before
 * the data layer is called and refuses a missing/malformed baseline with
 * `invalid-payload`; no write happens.
 */
export interface SetStatusPayload {
  readonly taskId: string
  readonly next: string
  /** Identity of this user intent; a retry reuses it (REC-02). */
  readonly operationId: string
  /** Required when `next === 'blocked'`; validated on the host side too. */
  readonly reason?: string
  readonly toIndex?: number
  /** Required write baseline, encoded by {@link encodeStatusVersion}. */
  readonly expectedStatusVersion: string
}

/** `task/reorder` payload. */
export interface ReorderPayload {
  readonly taskId: string
  readonly status: string
  readonly toIndex: number
  readonly operationId: string
  /** Required write baseline, encoded by {@link encodeStatusVersion}. */
  readonly expectedStatusVersion: string
}

/**
 * `task/status.undo` payload.
 *
 * Two identities travel and they are **not** interchangeable:
 * - `operationId` — the identity of **this undo** (minted fresh; a retry reuses
 *   it, REC-02);
 * - `appliedUpdateId` — the identity of the **write being undone** (core's
 *   `appliedUpdateId` = that write's `requestId`; taken from the task's
 *   `undoTarget`, never from this undo's operation id).
 */
export interface UndoStatusPayload {
  readonly taskId: string
  /** Identity of this undo, not of the change being undone. */
  readonly operationId: string
  /** Required write baseline, encoded by {@link encodeStatusVersion}. */
  readonly expectedStatusVersion: string
  /** The `requestId` of the write being undone (from `undoTarget`). */
  readonly appliedUpdateId: string
}

/**
 * `task/create` payload.
 *
 * `requestId` is the identity of **this creation intent** (minted by the UI,
 * reused verbatim by a retry — REC-02). The host resolves `projectId` through
 * its workspace registry first: an unregistered project is `unknown-project`,
 * never a guessed home. The title may be blank on the wire; core refuses it with
 * `invalid-title` and the refusal echoes the typed input.
 */
export interface CreateTaskPayload {
  readonly projectId: string
  readonly requestId: string
  readonly title: string
  /** Optional goal; absent means the empty goal core stores. */
  readonly goal?: string
  /** Opaque status id; core owns the vocabulary and refuses an unknown one. */
  readonly initialStatus?: string
  /** Required by core when `initialStatus === 'blocked'` (F02-R02). */
  readonly blockedReason?: string
}

/**
 * `task/fields.update` payload.
 *
 * Two baselines travel because a title/goal save must not overwrite a status
 * change that happened meanwhile (SAVE-05): `expectedFieldsVersion` is encoded
 * as `fver1:<n>` (see {@link encodeFieldsVersion}) and `expectedStatusVersion`
 * as `ver1:<n>`. The host handler validates both grammars before the data layer
 * is called; a missing/malformed one is `invalid-payload` and nothing is written.
 *
 * `goal: null` explicitly clears the goal (core normalises it to `''`);
 * an **absent** `goal` means "leave the goal unchanged". `title` cannot be
 * cleared: a blank title is refused by core (`invalid-title`).
 */
export interface UpdateFieldsPayload {
  readonly taskId: string
  /** Identity of this save intent; reused verbatim by a retry (REC-02). */
  readonly requestId: string
  /** Required field baseline, encoded by {@link encodeFieldsVersion}. */
  readonly expectedFieldsVersion: string
  /** Required status baseline, encoded by {@link encodeStatusVersion}. */
  readonly expectedStatusVersion: string
  /** Absent means "leave the title unchanged". */
  readonly title?: string
  /** Absent means "leave the goal unchanged"; `null` clears it. */
  readonly goal?: string | null
}

/**
 * `activity/read` payload.
 *
 * `scopeKind` is restricted to the two scopes core keeps history for. An empty
 * `entries` answer is a legal empty history — never an error. `limit` is an
 * optional non-negative integer (0 is legal and returns no entries).
 */
export interface ActivityPayload {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly limit?: number
}

/* ------------------------------------------------------------------ *
 * Status version encoding (`ver1:<n>`)
 * ------------------------------------------------------------------ */

/** Prefix of the string encoding a status revision travels as. */
export const STATUS_VERSION_PREFIX = 'ver1:'

const STATUS_VERSION_PATTERN = /^ver1:(0|[1-9]\d*)$/

/**
 * Encode a status revision for the wire.
 *
 * @param revision - a non-negative integer revision from the data layer.
 * @returns the canonical `ver1:<n>` string.
 */
export function encodeStatusVersion(revision: number): string {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError(`status revision must be a non-negative integer, got ${String(revision)}`)
  }
  return `${STATUS_VERSION_PREFIX}${String(revision)}`
}

/**
 * Decode a status version read off the wire.
 *
 * The grammar is strict on purpose (`0` or a non-zero-leading decimal): a
 * malformed baseline is a caller bug and must be refused, never defaulted to 0
 * (that would silently weaken SAVE-05).
 *
 * @param value - untrusted wire value.
 * @returns the revision, or null when it is not a canonical `ver1:<n>`.
 */
export function parseStatusVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !STATUS_VERSION_PATTERN.test(value)) return null
  return Number(value.slice(STATUS_VERSION_PREFIX.length))
}

/* ------------------------------------------------------------------ *
 * Fields version encoding (`fver1:<n>`)
 * ------------------------------------------------------------------ */

/**
 * Prefix of the string encoding a fields revision travels as.
 *
 * Same shape as {@link STATUS_VERSION_PREFIX} on purpose: two independent
 * baselines (fields and status) travel side by side and must never be confused
 * with one another, so the two encodings use distinct prefixes.
 */
export const FIELDS_VERSION_PREFIX = 'fver1:'

const FIELDS_VERSION_PATTERN = /^fver1:(0|[1-9]\d*)$/

/**
 * Encode a fields revision for the wire.
 *
 * @param revision - a non-negative integer revision from the data layer.
 * @returns the canonical `fver1:<n>` string.
 */
export function encodeFieldsVersion(revision: number): string {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError(`fields revision must be a non-negative integer, got ${String(revision)}`)
  }
  return `${FIELDS_VERSION_PREFIX}${String(revision)}`
}

/**
 * Decode a fields revision read off the wire.
 *
 * Strict on purpose (`0` or a non-zero-leading decimal): a malformed baseline is
 * a caller bug and must be refused, never defaulted to 0 (that would silently
 * weaken SAVE-05 for title/goal edits).
 *
 * @param value - untrusted wire value.
 * @returns the revision, or null when it is not a canonical `fver1:<n>`.
 */
export function parseFieldsVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !FIELDS_VERSION_PATTERN.test(value)) return null
  return Number(value.slice(FIELDS_VERSION_PREFIX.length))
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

/**
 * One selectable project from `project/list`.
 *
 * The fields live in the view model (`BoardProjectChoice`): the wire adds no
 * "current"/"default"/"last used" flag, because every entry must be an explicit
 * user choice and the host does not remember one (Q1=B).
 */
export type ProjectListItem = BoardProjectChoice

/**
 * `project/list` success value: the candidate set, in host order.
 *
 * An empty array is a legal, explicitly rendered "no projects" answer — not an
 * error and never replaced by a fabricated/default project.
 */
export interface ProjectListValue {
  readonly projects: readonly ProjectListItem[]
}

/* ------------------------------------------------------------------ *
 * Slice-B values (management endpoints)
 * ------------------------------------------------------------------ */

/**
 * `task/create` success value.
 *
 * The creation's own result is **known** (core returned `task`, and `outcome`
 * says whether it was this request or an idempotent replay). `snapshot` is
 * `null` when the creation landed but the authoritative board re-read failed:
 * that is a stale view, not a failed creation and never an empty board.
 */
export interface CreateTaskValue {
  readonly outcome: 'created' | 'already-created'
  /** The created (or already existing) task, exactly as core returned it. */
  readonly task: BoardTask
  /** The post-write board read, or `null` when it failed (view not refreshed). */
  readonly snapshot: BoardSnapshotValue | null
}

/**
 * `task/fields.update` success value.
 *
 * `saved`/`no-change`/`already-applied` are all *known* results; only the view
 * freshness varies (`snapshot: null` ⇒ re-read failed). `changed` is empty for
 * `no-change` and `already-applied`; `fieldsRevision` is the task's current
 * fields revision, the next save's baseline.
 */
export interface UpdateFieldsValue {
  readonly outcome: 'saved' | 'no-change' | 'already-applied'
  readonly task: BoardTask
  readonly changed: readonly ('title' | 'goal')[]
  readonly fieldsRevision: number
  readonly snapshot: BoardSnapshotValue | null
}

/** One important change in the activity history. */
export interface ActivityEntryValue {
  readonly activityId: string
  readonly at: string
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  /** Machine-readable change kind; core owns the vocabulary. */
  readonly code: string
  /** Display text captured at the moment of the change. */
  readonly summary: string
  /** Machine-readable detail bag; every value is a string (JSON-safe). */
  readonly details: Readonly<Record<string, string>>
}

/**
 * `activity/read` success value, newest first.
 *
 * An empty array is a legal empty history (a task/project with no important
 * changes yet) and must never be turned into an error.
 */
export interface ActivityValue {
  readonly entries: readonly ActivityEntryValue[]
}

/** The input a refused creation echoed back (F01-R02: never lose the typing). */
export interface KeptTaskInputWire {
  readonly title: string
  readonly goal: string
  readonly initialStatus: string
  readonly blockedReason: string | null
}

/** The input a refused field save echoed back (F01-R05). */
export interface KeptFieldInputWire {
  readonly title: string | null
  readonly goal: string | null
}

/** One SAVE-05 field baseline as it travels in a failure's `details`. */
export interface FieldsBaselineWire {
  readonly fieldsVersion: string
  readonly statusVersion: string
}

/** `details` of a `task/create` failure. */
export interface CreateTaskFailureDetails {
  /** The deterministic id the failed creation would have produced (core gives it). */
  readonly taskId?: string
  readonly keptInput?: KeptTaskInputWire
}

/**
 * `details` of a `task/fields.update` failure.
 *
 * `baseline` carries both the expected and the actual field/status baseline so
 * the editor can show what changed underneath it; `current` is the formal status
 * for the standard "someone else changed this" presentation.
 */
export interface UpdateFieldsFailureDetails {
  readonly current?: FormalStatusValueWire
  readonly keptInput?: KeptFieldInputWire
  readonly baseline?: { readonly expected: FieldsBaselineWire; readonly actual: FieldsBaselineWire }
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
 * Parse one task's undo credential.
 *
 * `undoTarget` is required (nullable): `null` is the data layer's explicit "no
 * undo available", while a missing or malformed value is a contract violation.
 *
 * @param value - untrusted value.
 * @returns the target, `null` for the explicit none, or {@link MALFORMED}.
 */
function parseUndoTarget(value: unknown): BoardUndoTarget | null | typeof MALFORMED {
  if (value === undefined) return MALFORMED
  if (value === null) return null
  if (!isRecord(value)) return MALFORMED
  const statusVersion = value['statusVersion']
  const appliedUpdateId = value['appliedUpdateId']
  if (!isString(statusVersion) || !isString(appliedUpdateId)) return MALFORMED
  if (parseStatusVersion(statusVersion) === null) return MALFORMED
  if (appliedUpdateId.length === 0) return MALFORMED
  return { statusVersion, appliedUpdateId }
}

/**
 * Parse one task card. `statusRevision` and `undoTarget` are required because
 * they are the write baseline and the undo credential; everything else the
 * board does not render is optional so a leaner host response is still legal.
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
  const statusRevision = value['statusRevision']
  if (typeof statusRevision !== 'number' || !Number.isInteger(statusRevision) || statusRevision < 0) return null
  const undoTarget = parseUndoTarget(value['undoTarget'])
  if (undoTarget === MALFORMED) return null
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
    statusRevision,
    undoTarget,
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

/**
 * Parse a `project/list` success value.
 *
 * Every item must carry a non-empty `projectId` and string `title`/`path`.
 * Unknown extra fields (including a would-be "current" flag) are ignored, never
 * interpreted: the list is a candidate set, not a statement about selection.
 *
 * @param value - untrusted value.
 * @returns the candidate set, or null when malformed (the caller reports a failure).
 */
export function parseProjectListValue(value: unknown): ProjectListValue | null {
  if (!isRecord(value)) return null
  const projects = value['projects']
  if (!Array.isArray(projects)) return null
  const parsed: ProjectListItem[] = []
  for (const entry of projects) {
    if (!isRecord(entry)) return null
    const projectId = entry['projectId']
    const title = entry['title']
    const path = entry['path']
    if (!isString(projectId) || projectId.length === 0) return null
    if (!isString(title) || !isString(path)) return null
    parsed.push({ projectId, title, path })
  }
  return { projects: parsed }
}

/* ------------------------------------------------------------------ *
 * Slice-B value guards
 * ------------------------------------------------------------------ */

function parseNullableSnapshot(value: unknown): BoardSnapshotValue | null | typeof MALFORMED {
  if (value === null) return null
  const snapshot = parseBoardSnapshotValue(value)
  return snapshot === null ? MALFORMED : snapshot
}

function parseChangedFields(value: unknown): readonly ('title' | 'goal')[] | null {
  if (!Array.isArray(value)) return null
  const changed: ('title' | 'goal')[] = []
  for (const entry of value) {
    if (entry !== 'title' && entry !== 'goal') return null
    changed.push(entry)
  }
  return changed
}

/**
 * Parse a `task/create` success value.
 *
 * `snapshot` is required but nullable: `null` is the honest "the creation
 * landed, the view did not refresh" answer. A missing/malformed snapshot or task
 * is a protocol violation (the caller reports a failure, never an empty board).
 *
 * @param value - untrusted value.
 * @returns the value, or null when malformed.
 */
export function parseCreateTaskValue(value: unknown): CreateTaskValue | null {
  if (!isRecord(value)) return null
  const outcome = value['outcome']
  if (outcome !== 'created' && outcome !== 'already-created') return null
  const task = parseBoardTask(value['task'])
  if (task === null) return null
  const snapshot = parseNullableSnapshot(value['snapshot'])
  if (snapshot === MALFORMED) return null
  return { outcome, task, snapshot }
}

/**
 * Parse a `task/fields.update` success value.
 *
 * @param value - untrusted value.
 * @returns the value, or null when malformed.
 */
export function parseUpdateFieldsValue(value: unknown): UpdateFieldsValue | null {
  if (!isRecord(value)) return null
  const outcome = value['outcome']
  if (outcome !== 'saved' && outcome !== 'no-change' && outcome !== 'already-applied') return null
  const task = parseBoardTask(value['task'])
  if (task === null) return null
  const changed = parseChangedFields(value['changed'])
  if (changed === null) return null
  const fieldsRevision = value['fieldsRevision']
  if (typeof fieldsRevision !== 'number' || !Number.isInteger(fieldsRevision) || fieldsRevision < 0) return null
  const snapshot = parseNullableSnapshot(value['snapshot'])
  if (snapshot === MALFORMED) return null
  return { outcome, task, changed, fieldsRevision, snapshot }
}

function parseActivityEntry(value: unknown): ActivityEntryValue | null {
  if (!isRecord(value)) return null
  const { activityId, at, scopeKind, scopeId, code, summary } = value
  if (!isString(activityId) || activityId.length === 0) return null
  if (!isString(at) || at.length === 0) return null
  if (scopeKind !== 'task' && scopeKind !== 'project') return null
  if (!isString(scopeId) || scopeId.length === 0) return null
  if (!isString(code) || code.length === 0) return null
  if (!isString(summary)) return null
  const rawDetails = value['details']
  if (!isRecord(rawDetails)) return null
  const details: Record<string, string> = {}
  for (const [key, entry] of Object.entries(rawDetails)) {
    if (typeof entry !== 'string') return null
    details[key] = entry
  }
  return { activityId, at, scopeKind, scopeId, code, summary, details }
}

/**
 * Parse an `activity/read` success value.
 *
 * An empty `entries` array is legal (nothing important happened yet). Detail
 * values must all be strings: the wire carries `Record<string, string>` and a
 * non-string value would be a contract violation, not something to coerce.
 *
 * @param value - untrusted value.
 * @returns the value, or null when malformed.
 */
export function parseActivityValue(value: unknown): ActivityValue | null {
  if (!isRecord(value)) return null
  const entries = value['entries']
  if (!Array.isArray(entries)) return null
  const parsed: ActivityEntryValue[] = []
  for (const entry of entries) {
    const item = parseActivityEntry(entry)
    if (item === null) return null
    parsed.push(item)
  }
  return { entries: parsed }
}

/**
 * Parse the `keptInput` of a refused creation.
 *
 * @param value - untrusted value.
 * @returns the echoed input, or null when malformed.
 */
export function parseKeptTaskInput(value: unknown): KeptTaskInputWire | null {
  if (!isRecord(value)) return null
  const title = value['title']
  const goal = value['goal']
  const initialStatus = value['initialStatus']
  const blockedReason = value['blockedReason']
  if (!isString(title) || !isString(goal)) return null
  if (!isStatusId(initialStatus)) return null
  if (blockedReason !== null && !isString(blockedReason)) return null
  return { title, goal, initialStatus, blockedReason }
}

/**
 * Parse the `keptInput` of a refused field save.
 *
 * @param value - untrusted value.
 * @returns the echoed input, or null when malformed.
 */
export function parseKeptFieldInput(value: unknown): KeptFieldInputWire | null {
  if (!isRecord(value)) return null
  const title = value['title']
  const goal = value['goal']
  if (title !== null && !isString(title)) return null
  if (goal !== null && !isString(goal)) return null
  return { title, goal }
}

/**
 * Parse one SAVE-05 baseline out of failure details.
 *
 * Both encodings are validated (`fver1:<n>` / `ver1:<n>`): a malformed baseline
 * must not be shown as if it were a version the UI could trust.
 *
 * @param value - untrusted value.
 * @returns the baseline, or null when malformed.
 */
export function parseFieldsBaselineValue(value: unknown): FieldsBaselineWire | null {
  if (!isRecord(value)) return null
  const fieldsVersion = value['fieldsVersion']
  const statusVersion = value['statusVersion']
  if (!isString(fieldsVersion) || parseFieldsVersion(fieldsVersion) === null) return null
  if (!isString(statusVersion) || parseStatusVersion(statusVersion) === null) return null
  return { fieldsVersion, statusVersion }
}

/**
 * Parse the `details` of a `task/create` failure.
 *
 * Tolerant like the existing `current` extraction: a malformed optional field is
 * dropped, because losing the echo cannot make a refusal look like a success.
 *
 * @param value - untrusted value.
 * @returns the details, or null when the container is not an object.
 */
export function parseCreateTaskFailureDetails(value: unknown): CreateTaskFailureDetails | null {
  if (!isRecord(value)) return null
  const rawKept = value['keptInput']
  const keptInput = rawKept === undefined ? undefined : (parseKeptTaskInput(rawKept) ?? undefined)
  const taskId = value['taskId']
  return {
    ...(isString(taskId) ? { taskId } : {}),
    ...(keptInput === undefined ? {} : { keptInput }),
  }
}

/**
 * Parse the `details` of a `task/fields.update` failure.
 *
 * Tolerant like {@link parseCreateTaskFailureDetails}; a malformed baseline pair
 * is dropped rather than represented with invented versions.
 *
 * @param value - untrusted value.
 * @returns the details, or null when the container is not an object.
 */
export function parseUpdateFieldsFailureDetails(value: unknown): UpdateFieldsFailureDetails | null {
  if (!isRecord(value)) return null
  const currentRaw = value['current']
  const current = currentRaw === undefined ? undefined : (parseFormalStatusValue(currentRaw) ?? undefined)
  const keptRaw = value['keptInput']
  const keptInput = keptRaw === undefined ? undefined : (parseKeptFieldInput(keptRaw) ?? undefined)
  const baselineRaw = value['baseline']
  let baseline: UpdateFieldsFailureDetails['baseline']
  if (baselineRaw !== undefined) {
    if (!isRecord(baselineRaw)) return null
    const expected = parseFieldsBaselineValue(baselineRaw['expected'])
    const actual = parseFieldsBaselineValue(baselineRaw['actual'])
    if (expected === null || actual === null) return null
    baseline = { expected, actual }
  }
  return {
    ...(current === undefined ? {} : { current }),
    ...(keptInput === undefined ? {} : { keptInput }),
    ...(baseline === undefined ? {} : { baseline }),
  }
}

/* ------------------------------------------------------------------ *
 * Payload guards (host half)
 * ------------------------------------------------------------------ */

/**
 * Parse a `board/read` payload.
 *
 * `projectId` is required and must be a non-empty string: the host has no
 * "current project" to fall back to (Q1=B). A missing or empty id returns
 * `null`, which the handler reports as `invalid-payload`; no project is guessed
 * and no read happens.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseReadBoardPayload(value: unknown): ReadBoardPayload | null {
  if (!isRecord(value)) return null
  const projectId = value['projectId']
  if (!isString(projectId) || projectId.length === 0) return null
  return { projectId }
}

/**
 * Parse a `project/list` payload.
 *
 * The payload is empty by contract; anything that is not a JSON object is
 * malformed. Fields are ignored rather than interpreted — a listing request may
 * not carry a selection or a "current project" hint (Q1=B).
 *
 * @param value - untrusted payload.
 * @returns the empty payload, or null when malformed.
 */
export function parseProjectListPayload(value: unknown): ProjectListPayload | null {
  if (!isRecord(value)) return null
  return {}
}

function optionalIndex(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * Parse a `task/status.set` payload.
 *
 * The baseline is required at the shape level; its `ver1:<n>` grammar is
 * validated by the host handler before the data layer is called (F5).
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
  const expectedStatusVersion = value['expectedStatusVersion']
  if (!isString(expectedStatusVersion) || expectedStatusVersion.length === 0) return null
  const toIndex = optionalIndex(value['toIndex'])
  if (toIndex === null) return null

  const reason = value['reason']
  return {
    taskId,
    next,
    operationId,
    expectedStatusVersion,
    ...(reason === undefined ? {} : { reason }),
    ...(toIndex === undefined ? {} : { toIndex }),
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
  const expectedStatusVersion = value['expectedStatusVersion']
  if (!isString(expectedStatusVersion) || expectedStatusVersion.length === 0) return null
  return {
    taskId,
    status,
    toIndex,
    operationId,
    expectedStatusVersion,
  }
}

/**
 * Parse a `task/status.undo` payload.
 *
 * Both identities are required: `operationId` (this undo) and `appliedUpdateId`
 * (the write being undone). They must never be conflated at the boundary.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseUndoStatusPayload(value: unknown): UndoStatusPayload | null {
  if (!isRecord(value)) return null
  const { taskId, operationId, appliedUpdateId } = value
  if (!isString(taskId) || taskId.length === 0) return null
  if (!isString(operationId) || operationId.length === 0) return null
  if (!isString(appliedUpdateId) || appliedUpdateId.length === 0) return null
  const expectedStatusVersion = value['expectedStatusVersion']
  if (!isString(expectedStatusVersion) || expectedStatusVersion.length === 0) return null
  return {
    taskId,
    operationId,
    expectedStatusVersion,
    appliedUpdateId,
  }
}

/**
 * Parse a `task/create` payload.
 *
 * Shape-level only: `title` may be blank (core owns the title rule and refuses
 * it with `invalid-title`), and `initialStatus` is an opaque id (core owns the
 * status vocabulary). What the host insists on is a usable address
 * (`projectId`, `requestId`) and a string title, so core can decide the rest
 * with its own echo of the input.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseCreateTaskPayload(value: unknown): CreateTaskPayload | null {
  if (!isRecord(value)) return null
  const projectId = value['projectId']
  const requestId = value['requestId']
  const title = value['title']
  if (!isString(projectId) || projectId.length === 0) return null
  if (!isString(requestId) || requestId.length === 0) return null
  if (!isString(title)) return null
  const goal = value['goal']
  if (goal !== undefined && !isString(goal)) return null
  const initialStatus = value['initialStatus']
  if (initialStatus !== undefined && !isStatusId(initialStatus)) return null
  const blockedReason = value['blockedReason']
  if (blockedReason !== undefined && !isString(blockedReason)) return null
  return {
    projectId,
    requestId,
    title,
    ...(goal === undefined ? {} : { goal }),
    ...(initialStatus === undefined ? {} : { initialStatus }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

/**
 * Parse a `task/fields.update` payload.
 *
 * Both baselines are required at the shape level; their `fver1:`/`ver1:`
 * grammars are validated by the host handler before the data layer is called
 * (SAVE-05). `goal: null` is meaningful (clear the goal) and is therefore kept
 * distinct from an absent `goal` (leave unchanged). At least one of
 * `title`/`goal` is not enforced here: core owns that refusal and echoes it as
 * `invalid-input` with `keptInput`.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseUpdateFieldsPayload(value: unknown): UpdateFieldsPayload | null {
  if (!isRecord(value)) return null
  const taskId = value['taskId']
  const requestId = value['requestId']
  if (!isString(taskId) || taskId.length === 0) return null
  if (!isString(requestId) || requestId.length === 0) return null
  const expectedFieldsVersion = value['expectedFieldsVersion']
  const expectedStatusVersion = value['expectedStatusVersion']
  if (!isString(expectedFieldsVersion) || expectedFieldsVersion.length === 0) return null
  if (!isString(expectedStatusVersion) || expectedStatusVersion.length === 0) return null
  const title = value['title']
  if (title !== undefined && !isString(title)) return null
  const goal = value['goal']
  if (goal !== undefined && goal !== null && !isString(goal)) return null
  return {
    taskId,
    requestId,
    expectedFieldsVersion,
    expectedStatusVersion,
    ...(title === undefined ? {} : { title }),
    ...(goal === undefined ? {} : { goal }),
  }
}

/**
 * Parse an `activity/read` payload.
 *
 * `scopeKind` is restricted to the two scopes core keeps history for (an
 * arbitrary scope id is not a place history could live); `limit` is an optional
 * non-negative integer, and 0 is legal.
 *
 * @param value - untrusted payload.
 * @returns the payload, or null when malformed.
 */
export function parseActivityPayload(value: unknown): ActivityPayload | null {
  if (!isRecord(value)) return null
  const scopeKind = value['scopeKind']
  if (scopeKind !== 'task' && scopeKind !== 'project') return null
  const scopeId = value['scopeId']
  if (!isString(scopeId) || scopeId.length === 0) return null
  const limit = optionalIndex(value['limit'])
  if (limit === null) return null
  return {
    scopeKind,
    scopeId,
    ...(limit === undefined ? {} : { limit }),
  }
}
