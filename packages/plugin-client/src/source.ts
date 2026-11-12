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
 * 4. **Never turn a landed write into a failed one because the view refresh
 *    failed.** `createTask`/`updateTaskFields` return `ok: true` with
 *    `snapshot: null` when the write landed and only the re-read failed
 *    (REC-01); a refused/failed write is `ok: false` with an explicit code.
 *
 * @module @aikanban/plugin-client/source
 */

import type {
  BoardFailureCodeWire,
  ActivityEntryValue,
  FieldsBaselineWire,
  KeptFieldInputWire,
  KeptTaskInputWire,
  ProjectListItem,
  SummaryBaselineWire,
  SummaryContentWire,
  SummaryDraftSaveValue,
  SummarySaveFailureDetails,
  SummarySaveValue,
  SummaryViewValue,
  UpdateFieldsFailureDetails,
} from './wire.js'
import type { BoardCapabilities, BoardReadData, BoardTask, StatusId } from './model.js'

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
  /**
   * Version of the formal status this change was decided on (SAVE-05 baseline),
   * encoded as `ver1:<n>` from the task's `statusRevision`. Required: a write
   * without a baseline must not be sent.
   */
  readonly expectedStatusVersion: string
}

/** One manual reorder inside a column (F02-R04). */
export interface ReorderInput {
  readonly taskId: string
  readonly status: StatusId
  readonly toIndex: number
  readonly operationId: string
  /** Version of the formal status this reorder was decided on (`ver1:<n>`). */
  readonly expectedStatusVersion: string
}

/**
 * One undo of a previous status change (F02-R04).
 *
 * The two identities are distinct and both required:
 * `operationId` is this undo's own identity (fresh; reused by a retry), while
 * `appliedUpdateId` is the identity of the write being undone (core's
 * `appliedUpdateId`, taken from the task's `undoTarget`).
 */
export interface UndoInput {
  readonly taskId: string
  /** Identity of this undo intent; a retry reuses it (REC-02). */
  readonly operationId: string
  /** Version of the formal status the undo was decided on (`ver1:<n>`). */
  readonly expectedStatusVersion: string
  /** `requestId` of the write being undone (from `undoTarget`). */
  readonly appliedUpdateId: string
}

/**
 * One task creation (F01-R02/R03).
 *
 * `requestId` is this creation's identity; a retry reuses it so the data layer
 * recognises the double click instead of creating a second task (REC-02). The
 * project is the **explicitly selected** one — the source never resolves a
 * "current project".
 */
export interface CreateTaskInput {
  readonly projectId: string
  /** Identity of this creation intent; reused verbatim by a retry. */
  readonly requestId: string
  readonly title: string
  readonly goal?: string
  /** Opaque status id; absent means core's default (`todo`). */
  readonly initialStatus?: StatusId
  /** Required by the data layer when `initialStatus` is the blocked status. */
  readonly blockedReason?: string
}

/**
 * One substantive title/goal save (F01-R05/R06).
 *
 * Both baselines are required: the SAVE-05 rule is "save exactly the version the
 * user was looking at", so a missing baseline must never be sent (the host
 * refuses it; the UI must refuse earlier and re-read).
 */
export interface UpdateFieldsInput {
  readonly taskId: string
  /** Identity of this save intent; reused verbatim by a retry (REC-02). */
  readonly requestId: string
  /** Task's `fieldsRevision` at the time the editor opened, as `fver1:<n>`. */
  readonly expectedFieldsVersion: string
  /** Task's `statusRevision` at the time the editor opened, as `ver1:<n>`. */
  readonly expectedStatusVersion: string
  /** Absent means "leave the title unchanged". */
  readonly title?: string
  /** Absent means "leave the goal unchanged"; `null` clears the goal. */
  readonly goal?: string | null
}

/** One activity-history read (F01-R07/SAVE-08). */
export interface ActivityInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  /** Optional cap on the newest-first list; 0 is legal. */
  readonly limit?: number
}

/** The input a refused creation echoed back (F01-R02: never lose the typing). */
export type KeptCreateInput = KeptTaskInputWire

/** The input a refused field save echoed back (F01-R05). */
export type KeptFieldInput = KeptFieldInputWire

/** One SAVE-05 field baseline in a source-level failure. */
export type FieldsBaseline = FieldsBaselineWire

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/**
 * Failure codes. Each one maps to different user-facing text; none of them may
 * be shown as a success. The vocabulary is defined once in `wire.ts` and shared
 * with the host half, so a code cannot exist on one side only.
 *
 * - `invalid-reason` — entering blocked without a reason.
 * - `invalid-input` — a management input was refused by the data layer
 *   (blank title, unknown status, invalid activity scope/limit, identity
 *   collision); nothing was written and `keptInput` may be present.
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
 * Management results (slice B): creation, field save, activity history
 * ------------------------------------------------------------------ */

/**
 * A creation whose result is **known**.
 *
 * `snapshot` is `null` exactly when the creation landed but the authoritative
 * board re-read failed. That is a stale view — the task exists — so it must not
 * be presented as either a failed creation or an empty board (REC-01/REC-05);
 * the caller keeps its old view and offers a read retry.
 */
export interface CreateTaskSuccess {
  readonly ok: true
  /** The created (or already existing) task, as the data layer returned it. */
  readonly task: BoardTask
  /** Whether this request created the task or recognised a replay (REC-02). */
  readonly outcome: 'created' | 'already-created'
  /** Board re-read, or `null` when it failed (the view was not refreshed). */
  readonly snapshot: BoardSnapshot | null
}

/**
 * A creation that did not land (or whose outcome is unknown).
 *
 * `keptInput` is present whenever the data layer echoed the typed input, so a
 * refused form can restore everything the user typed without a second source.
 */
export interface CreateTaskFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
  readonly keptInput?: KeptCreateInput
}

/** Result of creating one task. */
export type CreateTaskResult = CreateTaskSuccess | CreateTaskFailure

/**
 * A field save whose result is **known** (`saved` / `no-change` /
 * `already-applied`).
 *
 * `snapshot === null` means the save landed but the board re-read failed; the
 * task object still carries the authoritative fields, so the UI can keep the
 * user's confirmation without inventing a board.
 */
export interface UpdateFieldsSuccess {
  readonly ok: true
  readonly outcome: 'saved' | 'no-change' | 'already-applied'
  readonly task: BoardTask
  /** Which user-owned fields actually changed (empty for no-change/replay). */
  readonly changed: readonly ('title' | 'goal')[]
  /** The task's current fields revision — the next save's baseline. */
  readonly fieldsRevision: number
  /** Board re-read, or `null` when it failed (the view was not refreshed). */
  readonly snapshot: BoardSnapshot | null
}

/**
 * A field save that was refused or failed. Nothing was written.
 *
 * `stale-baseline` carries both baselines (`baseline.expected` / `baseline.actual`)
 * and the formal current status; `keptInput` carries the editor's input so a
 * failed save can leave the draft in place (F01-R05).
 */
export interface UpdateFieldsFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
  /** The formal value to display instead of the attempted one. */
  readonly current?: FormalStatusValue
  readonly keptInput?: KeptFieldInput
  readonly baseline?: UpdateFieldsFailureDetails['baseline']
}

/** Result of saving a task's title/goal. */
export type UpdateFieldsResult = UpdateFieldsSuccess | UpdateFieldsFailure

/** One important change in the activity history (newest first). */
export type ActivityEntry = ActivityEntryValue

/**
 * An activity-history read that succeeded.
 *
 * `entries: []` is a legal empty history (nothing important happened yet); it is
 * not an error and must not be replaced with fabricated entries.
 */
export interface ActivitySuccess {
  readonly ok: true
  readonly entries: readonly ActivityEntry[]
}

/** An activity-history read that failed. Never silently an empty history. */
export interface ActivityFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
}

/** Result of reading the activity history. */
export type ActivityResult = ActivitySuccess | ActivityFailure

/* ------------------------------------------------------------------ *
 * Manual summaries / project overviews (F03)
 * ------------------------------------------------------------------ */

/** Which summary scope to read or save. */
export interface SummaryScopeInput {
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
}

/** A read of one task's manual summary or one project's manual overview. */
export type ReadSummaryInput = SummaryScopeInput

/**
 * One manual summary save (F03-R02/R07).
 *
 * `expected` is the SAVE-05 baseline; the data layer refuses a stale baseline
 * instead of merging. `updateId` is the user intent id: a retry after an
 * unknown result reuses it and must not create a second version.
 */
export interface ManualSummarySaveInput extends SummaryScopeInput {
  readonly updateId: string
  readonly expected: SummaryBaselineWire
  readonly content?: SummaryContentWire
  /** `true` clears the official body (an explicit, user-confirmed clear). */
  readonly cleared?: true
  /** Draft ids this save claims as consumed after it commits (F03-R07). */
  readonly consumeDraftIds?: readonly string[]
}

/**
 * A summary read that succeeded.
 *
 * `summary: null` means the scope exists but has no official summary yet: an
 * explicit "not written yet" empty state, not a failed read (F03-R01).
 */
export interface SummaryReadSuccess {
  readonly ok: true
  readonly summary: SummaryViewValue | null
}

/** A summary read that failed. Never silently an empty summary. */
export interface SummaryReadFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of reading a manual summary. */
export type SummaryReadResult = SummaryReadSuccess | SummaryReadFailure

/**
 * A summary save whose result is known (committed / already-applied /
 * no-change).
 *
 * `view === null` means the save landed but the authoritative re-read failed;
 * the UI says "已保存、视图未刷新" and retries the READ, never the write.
 */
export type SummarySaveSuccess = SummarySaveValue & { readonly ok: true }

/**
 * A summary save that was refused or failed. Nothing was written except, for
 * `stale-baseline`, the two baselines carried in `details`.
 */
export interface SummarySaveFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
  readonly baseline?: SummarySaveFailureDetails['baseline']
}

/** Result of saving a manual summary. */
export type SummarySaveResult = SummarySaveSuccess | SummarySaveFailure

/**
 * Save the in-flight manual draft of one scope (F03-R07).
 *
 * A draft is not an official version: it carries no baseline and confirms
 * nothing. Saving the same scope again updates the same draft slot. The draft
 * is consumed only when a later official save commits.
 */
export interface ManualSummaryDraftSaveInput extends SummaryScopeInput {
  readonly content: SummaryContentWire
  /** Optional identity of the save intent this draft belongs to. */
  readonly updateId?: string
}

/** A draft save that succeeded: the stored draft, never a version. */
export type SummaryDraftSaveSuccess = SummaryDraftSaveValue & { readonly ok: true }

/** A draft save that failed; official content is never reported as saved. */
export interface SummaryDraftSaveFailure {
  readonly ok: false
  readonly code: BoardFailureCodeWire
  readonly message: string
}

/** Result of saving a manual draft. */
export type SummaryDraftSaveResult = SummaryDraftSaveSuccess | SummaryDraftSaveFailure

/* ------------------------------------------------------------------ *
 * Project listing (Q1=B: candidate set, explicit selection)
 * ------------------------------------------------------------------ */

/**
 * One project offered for explicit selection.
 *
 * `projectId` is the workspace id the host's `board/read` accepts. There is
 * deliberately **no** current/default/last-used flag: the list is only a
 * candidate set, selection happens on every entry and lives in controller
 * memory only (Q1=B).
 */
export type ProjectChoice = ProjectListItem

/**
 * A project-list read that succeeded.
 *
 * An empty array is a legal answer ("there are no projects here"); it is not an
 * error and must never be replaced by a fabricated or default project.
 */
export interface ProjectListSuccess {
  readonly ok: true
  readonly projects: readonly ProjectChoice[]
}

/**
 * A project-list read that failed.
 *
 * The failure is explicit so the selector can say so and offer a retry; it is
 * never silently converted into an empty list (REC-05).
 */
export interface ProjectListFailure {
  readonly ok: false
  readonly code: BoardFailureCode
  readonly message: string
}

/** Result of listing the selectable projects. */
export type ProjectListResult = ProjectListSuccess | ProjectListFailure

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

  /**
   * List the projects the host offers for explicit selection (Q1=B).
   *
   * The list is read **fresh on every entry** and is never cached as a "current
   * project": selecting one is a separate, explicit act (`selectProject` →
   * `readBoard`). A failure is a failure — the controller may not fall back to
   * an empty list or to the first project.
   */
  listProjects(): Promise<ProjectListResult>

  /**
   * Read the whole board for the **explicitly selected** project.
   *
   * The project id is passed on every call: the source holds no selection and
   * there is no "current project" to fall back to (Q1=B). A controller must not
   * call this without a selection; the host refuses a missing id with
   * `invalid-payload` and never guesses a project.
   */
  readBoard(projectId: string): Promise<BoardReadResult>

  /** Change one task's status (and optionally its position). */
  setStatus(input: StatusChangeInput): Promise<WriteResult>

  /** Move a card inside its column. */
  reorder(input: ReorderInput): Promise<WriteResult>

  /** Undo a status change, if the host still considers it undoable. */
  undoStatusChange(input: UndoInput): Promise<WriteResult>

  /**
   * Create one task in the explicitly selected project (F01-R02/R03).
   *
   * `requestId` makes the operation idempotent: a retry reuses it and the data
   * layer answers `already-created` instead of creating a second task (REC-02).
   * A failure echoes the typed input (`keptInput`); an `ok: true` result with
   * `snapshot: null` means the creation landed but the view was not refreshed.
   */
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>

  /**
   * Save a task's title and/or goal under both SAVE-05 baselines
   * (F01-R05/R06). Never merges silently: a stale baseline is a failure with
   * the expected/actual baselines and the formal current status.
   */
  updateTaskFields(input: UpdateFieldsInput): Promise<UpdateFieldsResult>

  /**
   * Read the important-change history for one task or project (F01-R07).
   *
   * Newest first, optionally capped by `limit`. An empty array is a legal empty
   * history; a failed read is a failure and never an empty history.
   */
  loadActivity(input: ActivityInput): Promise<ActivityResult>

  /**
   * Read one task's manual summary or one project's manual overview (F03).
   *
   * `summary: null` is a legal answer for an existing scope with no official
   * body yet; a failed read is a failure and never an empty summary.
   */
  readSummary(input: ReadSummaryInput): Promise<SummaryReadResult>

  /**
   * Save (or clear) one manual summary under its SAVE-05 baseline (F03-R02).
   *
   * A retry after an unknown result reuses `updateId` so the data layer can
   * answer `already-applied`; drafts are consumed only after a commit (R07).
   */
  saveSummary(input: ManualSummarySaveInput): Promise<SummarySaveResult>

  /**
   * Save the in-flight manual draft for one scope (F03-R07).
   *
   * Draft saving never creates an official version and never confirms; the
   * editor restores it later. A failure must not be shown as "saved".
   */
  saveSummaryDraft(input: ManualSummaryDraftSaveInput): Promise<SummaryDraftSaveResult>
}

/* ------------------------------------------------------------------ *
 * The unavailable source
 * ------------------------------------------------------------------ */

/** Text the panel shows when no data channel exists. Explicit, never "empty". */
export const NO_CHANNEL_MESSAGE = '看板数据通道未接通：无法读取任务。这不是空看板。'

/** Text shown when the project list cannot be read because no channel exists. */
export const NO_CHANNEL_PROJECTS_MESSAGE = '看板数据通道未接通：无法读取项目清单。这不等于「没有可用项目」。'

/** Text shown when a creation cannot be sent because no channel exists. */
export const NO_CHANNEL_CREATE_MESSAGE = '看板数据通道未接通：无法创建任务，未创建任何任务。'

/** Text shown when a field save cannot be sent because no channel exists. */
export const NO_CHANNEL_FIELDS_MESSAGE = '看板数据通道未接通：无法保存字段，正式值未改变。'

/** Text shown when the activity history cannot be read because no channel exists. */
export const NO_CHANNEL_ACTIVITY_MESSAGE = '看板数据通道未接通：无法读取活动历史。这不等于「没有活动」。'

/** Text shown when a manual summary cannot be read because no channel exists. */
export const NO_CHANNEL_SUMMARY_READ_MESSAGE = '看板数据通道未接通：无法读取概况。这不等于「还没有概况」。'

/** Text shown when a manual summary save cannot be sent because no channel exists. */
export const NO_CHANNEL_SUMMARY_SAVE_MESSAGE = '看板数据通道未接通：无法保存概况，正式内容未改变。'

/** Text shown when a manual draft save cannot be sent because no channel exists. */
export const NO_CHANNEL_SUMMARY_DRAFT_MESSAGE = '看板数据通道未接通：无法保存概况草稿，正式内容未改变。'

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
    listProjects: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_PROJECTS_MESSAGE }),
    setStatus: () => Promise.resolve(failure()),
    reorder: () => Promise.resolve(failure()),
    undoStatusChange: () => Promise.resolve(failure()),
    createTask: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_CREATE_MESSAGE }),
    updateTaskFields: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_FIELDS_MESSAGE }),
    loadActivity: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_ACTIVITY_MESSAGE }),
    readSummary: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_SUMMARY_READ_MESSAGE }),
    saveSummary: () => Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_SUMMARY_SAVE_MESSAGE }),
    saveSummaryDraft: () =>
      Promise.resolve({ ok: false, code: 'unavailable', message: NO_CHANNEL_SUMMARY_DRAFT_MESSAGE }),
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
