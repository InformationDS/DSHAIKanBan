/**
 * F02 board controller — the only place the UI decides *when* to ask the data
 * layer for something. It holds no business rule of its own: whether a change is
 * allowed, which formal value survives a failure, and whether an undo still
 * applies are all answers the data layer supplies through {@link BoardSource}
 * (see `packages/core/README.md`).
 *
 * ## Rules this file exists to enforce
 *
 * - **A read has three outcomes, not two** (core's `readBoard`): `ok`, an
 *   unregistered project (`unknown-project` → 「项目信息不可用」, no board), and
 *   `failed` (keep the known data, offer a retry). None of them is "no tasks"
 *   (REC-05).
 * - **A late response is never shown as the current project.** The response's
 *   `projectId`/`boardToken` is compared with the selection this controller
 *   asked for; a mismatch is dropped.
 * - **Menu and drag are equivalent** (F02-R02). Both entry points funnel into
 *   {@link BoardController.requestStatusChange}; one guard, one write path, one
 *   result, so a drop cannot take a shortcut a menu cannot.
 * - **Blocked needs a reason** (F02-R02). An invalid or blank reason performs no
 *   write: the formal status and column stay as they were, the typed text is
 *   kept, and the dialog stays open with a text error.
 * - **A failure is never shown as a success** (F02-R04, REC-01). The view only
 *   changes when the data layer says `ok: true`; on failure the previous view is
 *   kept (or the actual current value is shown when it is supplied) and the
 *   feedback offers a retry that reuses the *same* operation id.
 * - **A repeated identical submission is one result** (F02 异常表, SAVE-06):
 *   while a change is in flight, a second request for the same task is ignored.
 * - **An entry point renders only when the data layer can serve it.** The
 *   capabilities travel with the read, so a flow that is not bound yet appears
 *   as an explicit note, never as a control that always fails.
 *
 * @module @aikanban/plugin-client/controller
 */

import {
  ACTIVITY_FAILED_TEXT,
  BLOCKED_REASON_KEEPS_STATUS_MESSAGE,
  BLOCKED_REASON_REQUIRED_MESSAGE,
  BLOCKED_STATUS_ID,
  buildBoardView,
  createdStaleViewText,
  createdTaskText,
  defaultInitialStatus,
  deriveActivityEntries,
  deriveTaskDetail,
  fieldsSavedText,
  fieldsStaleViewText,
  isBlockedReasonValid,
  normalizeReason,
  restoreCreateDraft,
  statusLabelOf,
  validateCreateDraft,
  validateFieldDraft,
  FIELDS_ALREADY_APPLIED_TEXT,
  FIELDS_BASELINE_MISSING_MESSAGE,
  FIELDS_NO_CHANGE_TEXT,
  NO_FIELD_CHANGE_MESSAGE,
  SUMMARY_ALREADY_APPLIED_TEXT,
  SUMMARY_BASELINE_MISSING_TEXT,
  SUMMARY_DRAFT_FAILED_TEXT,
  SUMMARY_DRAFT_SAVED_TEXT,
  SUMMARY_DRAFT_SAVING_TEXT,
  SUMMARY_NO_CHANGE_TEXT,
  SUMMARY_READ_FAILED_TEXT,
  SUMMARY_SAVED_STALE_TEXT,
  SUMMARY_SAVED_TEXT,
  SUMMARY_SAVE_UNKNOWN_TEXT,
  summaryConclusionsOf,
  summaryContentForSave,
  summaryEditorFailed,
  summaryEditorLoading,
  summaryEditorReady,
  summaryEditorText,
  summaryPatchText,
  summaryVersionLabel,
  type ActivityEntryView,
  type BoardCapabilities,
  type BoardTask,
  type BoardView,
  type StatusId,
  type SummaryEditorState,
  type SummaryScopeKind,
  type TaskDetailView,
  type TaskProgressView,
} from './model.js'
import {
  nextOperationId,
  type ActivityResult,
  type BoardFailureCode,
  type BoardReadResult,
  type BoardSnapshot,
  type BoardSource,
  type CreateTaskInput,
  type CreateTaskResult,
  type FormalStatusValue,
  type ManualSummarySaveInput,
  type ProjectChoice,
  type ReorderInput,
  type StatusChangeInput,
  type SummaryDraftSaveResult,
  type SummaryReadResult,
  type SummarySaveResult,
  type UndoInput,
  type UpdateFieldsInput,
  type UpdateFieldsResult,
  type WriteResult,
} from './source.js'
import { encodeFieldsVersion, encodeStatusVersion } from './wire.js'

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** What the panel is currently doing. */
export interface BoardBusy {
  readonly kind: 'read' | 'status' | 'reorder' | 'undo' | 'create' | 'fields' | 'summary'
  readonly taskId?: string
}

/**
 * A retryable failed intent. `read` re-reads the board; `create`/`fields` replay
 * the *same* input (same operation id) only where the data layer confirmed that
 * nothing landed (`save-failed`/`unavailable`).
 */
export type RetryIntent =
  | { readonly kind: 'read' }
  | { readonly kind: 'status'; readonly input: StatusChangeInput }
  | { readonly kind: 'reorder'; readonly input: ReorderInput }
  | { readonly kind: 'undo'; readonly input: UndoInput }
  | { readonly kind: 'create'; readonly input: CreateTaskInput }
  | { readonly kind: 'fields'; readonly input: UpdateFieldsInput }
  | { readonly kind: 'summary-read'; readonly scopeKind: SummaryScopeKind; readonly scopeId: string }
  | { readonly kind: 'summary-save'; readonly input: ManualSummarySaveInput }

/**
 * The undo affordance attached to a successful change.
 *
 * Built **only** from the post-write snapshot's `undoTarget`: `statusVersion`
 * is the baseline the undo must send, and `appliedUpdateId` identifies the write
 * being undone. The undo's own `operationId` is minted when the user presses
 * undo, never here — the two identities are not interchangeable (Q2=A).
 */
export interface UndoToken {
  readonly taskId: string
  readonly expectedStatusVersion: string
  readonly appliedUpdateId: string
}

/**
 * The read state: `selection-required` until the user picks a project, `idle`
 * before the first read of a selection, `loading` in flight, `ready` with a
 * board, and the two explicit failure shapes.
 *
 * `selection-required` is the **initial** state and the state every panel mount
 * returns to: no project is selected, so no `board/read` is sent and nothing is
 * guessed (Q1=B). It is not `failed` (nothing failed) and not `idle` (the panel
 * must say why it is empty).
 *
 * `failed` keeps the last known board (`kept`) so a transient read error does
 * not blank the panel; `unknown-project` deliberately keeps nothing, because
 * showing the previous project's cards under a new project's name is exactly the
 * cross-project leak F01-R01 forbids.
 */
export type BoardReadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'selection-required'; readonly message: string }
  | { readonly kind: 'loading'; readonly projectId: string }
  | {
      readonly kind: 'ready'
      readonly projectId: string
      readonly boardToken: string
      readonly view: BoardView
      readonly capabilities: BoardCapabilities
    }
  | {
      readonly kind: 'unknown-project'
      readonly projectId: string
      readonly message: string
    }
  | {
      readonly kind: 'failed'
      readonly projectId: string
      readonly code: BoardFailureCode
      readonly message: string
      /** Last known good board, when there was one. */
      readonly kept: BoardView | null
      readonly capabilities: BoardCapabilities
    }

/**
 * The project-list state, separate from the board read state.
 *
 * `loaded` is the candidate set the selector renders; `loaded` with an empty
 * `projects` array is the explicit "没有可用项目" answer, not an error. It is
 * never mixed into {@link BoardReadState}: a list is not a board and must not
 * make the panel look like it read one (Q1=B).
 */
export type ProjectListState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly projects: readonly ProjectChoice[] }
  | { readonly kind: 'failed'; readonly code: BoardFailureCode; readonly message: string }

/**
 * Feedback shown to the user. The `kind` is the point: a kept draft, a
 * validation refusal, a success, a refusal to undo, and a failure are five
 * different statements and are never collapsed into one "done" banner (REC-01).
 */
export type BoardFeedback =
  | { readonly kind: 'validation'; readonly text: string }
  | { readonly kind: 'success'; readonly text: string; readonly undo?: UndoToken }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'failure'; readonly text: string; readonly code: BoardFailureCode; readonly retry: RetryIntent | null }
  | { readonly kind: 'undo-blocked'; readonly text: string; readonly current: FormalStatusValue }
  /**
   * The write **landed** but the authoritative re-read failed (`snapshot: null`).
   * It is deliberately neither `success` (the view did not change) nor `failure`
   * (the write is not a failure): the only honest action is a re-read, and a
   * write replay is forbidden (REC-01/REC-05).
   */
  | { readonly kind: 'stale-view'; readonly text: string }

/** The blocked-reason dialog. */
export interface StatusDialogState {
  readonly taskId: string
  /** Status the task formally has right now. */
  readonly from: StatusId
  /** Status the user is asking for. */
  readonly next: StatusId
  /** The reason input, kept across an invalid submit and across cancel (F02-R02). */
  readonly reason: string
  /** True after a submit with an invalid reason. */
  readonly invalidReason: boolean
}

/**
 * The creation form (F01-R02/R03).
 *
 * The `requestId` is minted when the form opens and reused by every submit of
 * the same intent (a fixed typing error, a `save-failed` retry). It is never
 * minted per keystroke (REC-02: one intent, one result).
 */
export interface CreateFormState {
  readonly title: string
  readonly goal: string
  /** One of the board's column ids; `''` when the read carried no columns. */
  readonly initialStatus: string
  readonly blockedReason: string
  /** In-place refusal/validation text; the typed values stay untouched. */
  readonly error: string | null
  readonly requestId: string
}

/**
 * The inline title/goal editor (F01-R05/R06).
 *
 * Both SAVE-05 baselines are captured when the editor opens, so a save always
 * writes exactly the version the user was looking at. A re-read refreshes them
 * (the user is then looking at the new version) without losing the draft.
 */
export interface FieldEditState {
  readonly taskId: string
  readonly title: string
  readonly goal: string
  /** In-place refusal/validation text; the typed values stay untouched. */
  readonly error: string | null
  readonly requestId: string
  readonly expectedFieldsVersion: string
  readonly expectedStatusVersion: string
}

/**
 * One activity-history area's state. `idle` is "not requested"; a failure is
 * visible and retryable, and an empty `ready` list is a legal empty history —
 * never a failure, never fabricated entries (F01-R07).
 */
export type ActivityState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly scopeId: string }
  | { readonly kind: 'ready'; readonly scopeId: string; readonly entries: readonly ActivityEntryView[] }
  | { readonly kind: 'failed'; readonly scopeId: string; readonly code: BoardFailureCode; readonly message: string }

/** Everything the panel renders from. Immutable: a new object on every change. */
export interface BoardState {
  readonly read: BoardReadState
  /**
   * The selectable project candidates, read fresh while the selection screen is
   * shown. Drawn from the host registry each entry; nothing here is a "current"
   * or "last used" project (Q1=B).
   */
  readonly projects: ProjectListState
  readonly transport: BoardSource['transport']
  /**
   * The project this controller is showing; `null` means nothing is selected
   * (`selection-required`, no read is sent). This is the **only** owner of the
   * selection: the runtime holds no second copy and nothing is persisted (Q1=B).
   */
  readonly selectedProjectId: string | null
  /** Cancelled column expanded? Collapsed by default (F02 §3.2). */
  readonly cancelledExpanded: boolean
  readonly openTaskId: string | null
  readonly detail: TaskDetailView | null
  readonly statusDialog: StatusDialogState | null
  /** The open creation form, or `null` when it is closed. */
  readonly createForm: CreateFormState | null
  /** The open inline field editor, or `null` when it is closed. */
  readonly fieldEdit: FieldEditState | null
  /** The activity area rendered inside the open task's detail. */
  readonly taskActivity: ActivityState
  /** The activity area rendered under the project header. */
  readonly projectActivity: ActivityState
  /** The open task's manual-summary editor, or `null` when the detail is closed. */
  readonly taskSummary: SummaryEditorState | null
  /** The project overview editor, or `null` while the area is closed. */
  readonly projectSummary: SummaryEditorState | null
  readonly feedback: BoardFeedback | null
  readonly busy: BoardBusy | null
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/**
 * Success text. Names the status so the feedback is checkable, not just green.
 *
 * @param status - the status id the data layer reported.
 * @param label - the label to show; the id is used when the data layer sent none.
 * @returns the success sentence.
 */
export function statusChangedText(status: StatusId, label?: string): string {
  return `已保存：状态为「${label !== undefined && label.length > 0 ? label : status}」`
}

/** Reorder success text. */
export const REORDER_SAVED_TEXT = '已保存列内顺序'

/** Undo success text. */
export const UNDO_DONE_TEXT = '已撤销上一次状态流转'

/** Shown for an unregistered project (core's third read state). */
export const UNKNOWN_PROJECT_MESSAGE = '项目信息不可用：该项目尚未在此工作区登记，因此不显示看板。'

/** Shown when the data layer cannot serve a flow the UI was asked to start. */
export const CAPABILITY_MISSING_MESSAGE = '该操作的数据接口尚未接入，未做任何修改。'

/** Shown when a creation is submitted but the board is not in its ready state. */
export const CREATE_FORM_NOT_READY_MESSAGE = '看板尚未就绪：未创建任何任务。'

/** Shown when the host refuses an undo because later changes exist (F02-R04). */
export function undoBlockedText(current: FormalStatusValue, label?: string): string {
  const shown = label !== undefined && label.length > 0 ? label : current.status
  return `无法直接撤销：此后已有新的修改，当前正式状态为「${shown}」（版本 ${current.statusVersion}）。`
}

/** Title of the selection-required empty state (Q1=B). Never a default project. */
export const SELECTION_REQUIRED_TITLE = '请选择项目'

/**
 * Explanation shown under the title. Deliberately says the board does not
 * remember the last project: no default, no recency, no title heuristic (Q1=B).
 */
export const SELECTION_REQUIRED_DESCRIPTION = '看板不会记住上次的项目；每次进入都需要显式选择。'

/** Shown when a write failed. */
export function writeFailedText(code: BoardFailureCode): string {
  switch (code) {
    case 'save-failed':
      return '保存失败：正式状态与顺序未改变，可重试。'
    case 'unknown-result':
      return '保存结果未知：请先核对实际状态，不要重复提交。'
    case 'stale-baseline':
      return '此前的修改已被其他操作更新，未覆盖新结果。'
    case 'not-found':
      return '任务已不存在，未做任何修改。'
    case 'invalid-reason':
      return BLOCKED_REASON_REQUIRED_MESSAGE
    case 'invalid-input':
      return '输入无效：未写入任何数据，已填内容已保留。'
    case 'unavailable':
      return '看板数据通道未接通：未读取或修改任何内容。'
    case 'read-failed':
      return '看板读取失败，未做任何修改。'
    case 'unknown-project':
      return UNKNOWN_PROJECT_MESSAGE
    default:
      return '操作失败，未改变正式状态。'
  }
}

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

/** Construction options. */
export interface BoardControllerOptions {
  readonly source: BoardSource
  /** Operation-id minter; injectable so tests are deterministic. */
  readonly newOperationId?: () => string
  /** Change listener (React `useSyncExternalStore` shape). */
  readonly onChange?: (state: BoardState) => void
}

/** The panel's only write entry point. */
export interface BoardController {
  getState(): BoardState
  subscribe(listener: () => void): () => void

  /**
   * Read the board for the currently selected project.
   *
   * Takes no argument by design: the selection lives in `state.selectedProjectId`
   * and nowhere else. With no selection this sets `selection-required` and sends
   * no request (Q1=B — the host has no "current project" and never guesses).
   */
  load(): Promise<void>
  /** Retry a failed read (same selection; no write is replayed). */
  retryRead(): Promise<void>
  /**
   * Read the selectable project candidates from the host registry.
   *
   * Called on every panel entry/reset and retried on failure; it never selects,
   * caches or persists anything (Q1=B). An empty result is a legal "no projects"
   * answer and must be rendered as such, never as an empty board.
   */
  loadProjects(): Promise<void>
  /**
   * Switch projects: clears the previous view, records the selection in state
   * and reads. `null` returns to `selection-required` without a read.
   */
  selectProject(projectId: string | null): Promise<void>
  /**
   * Reset to the selection-required state (every panel mount calls this).
   * Clears the selection, the previous view, the detail and the dialog; sends no
   * request and does not touch the source.
   */
  resetSelection(): void

  /** Expand/collapse the collapsed column (cancelled by default). */
  toggleCancelled(): void

  /** Open the detail skeleton for a task present in the current view. */
  openDetail(taskId: string): void
  /** Close the detail view; the board keeps its project and column state. */
  closeDetail(): void

  /**
   * Status entry point shared by both interactions: a menu selection, a keyboard
   * selection and a drop all call this.
   */
  requestStatusChange(input: { readonly taskId: string; readonly next: StatusId; readonly toIndex?: number }): void
  /** The menu entry point. Same behaviour as a drop by construction. */
  menuSelectStatus(taskId: string, next: StatusId): void
  /**
   * The drag entry point: a drop into another column (status change, optional
   * index) or inside the same column (reorder).
   */
  dropTask(input: { readonly taskId: string; readonly toStatus: StatusId; readonly toIndex: number }): void

  /** Edit the reason inside the dialog. */
  setDialogReason(text: string): void
  /** Submit the dialog (confirms a blocked transition, or carries a picked status). */
  confirmStatusDialog(): void
  /**
   * Dismiss the dialog. `keepInput` keeps the typed reason for the next open
   * (F02-R02: 取消保持原列原状态、输入保留); the formal state never changes here.
   */
  cancelStatusDialog(options?: { readonly keepInput?: boolean }): void

  /** Re-run the last failed intent with the *same* operation id. */
  retryPending(): void

  /** Undo the change the current success feedback refers to. */
  undoLastChange(): void

  /**
   * Undo the status change a task's `undoTarget` points at (works after a
   * refresh, because the credential comes from the read snapshot).
   */
  undoTaskChange(taskId: string): void

  /* ----- slice B: creation, field edit, activity history ----- */

  /**
   * Open the creation form on a ready board. Mints the creation's request id
   * once; a later submit of the same intent reuses it (REC-02). A board that is
   * not `ready` (selection screen, failed read) opens no form and sends nothing.
   */
  openCreateForm(): void
  /** Close the creation form. Refused while a creation is in flight. */
  closeCreateForm(): void
  setCreateTitle(text: string): void
  setCreateGoal(text: string): void
  /** Pick the initial column (one of the board's column ids). */
  setCreateStatus(status: string): void
  setCreateBlockedReason(text: string): void
  /**
   * Validate and submit the creation. A blank title, or a blocked initial status
   * without a reason, is refused locally and no request is sent (F01-R02).
   */
  submitCreateTask(): Promise<void>

  /**
   * Open the inline title/goal editor for the task currently in the detail. The
   * SAVE-05 baselines are captured here; a task without a `fieldsRevision` is
   * refused with a re-read (never a fabricated baseline).
   */
  openFieldEdit(): void
  /** Close the inline editor. Refused while a field save is in flight. */
  closeFieldEdit(): void
  setEditTitle(text: string): void
  setEditGoal(text: string): void
  /**
   * Save the changed title/goal (absent field = unchanged; empty goal = clear).
   * No request is sent when nothing changed.
   */
  saveFieldEdit(): Promise<void>

  /**
   * Load the open task's important-change history (scopeKind `task`). Explicit
   * only: nothing loads automatically, and a second call while one is in flight
   * is ignored.
   */
  loadTaskActivity(): Promise<void>
  /** Hide the task activity area (resets it to idle; no request). */
  closeTaskActivity(): void
  /** Load the selected project's activity history (scopeKind `project`). */
  loadProjectActivity(): Promise<void>
  /** Hide the project activity area (resets it to idle; no request). */
  closeProjectActivity(): void

  /* ----- slice F03: manual summaries / project overview ----- */

  /**
   * Re-read the open task's manual summary (scopeKind `task`). Opening a detail
   * also triggers this automatically; a failed read stays visible and retryable.
   */
  loadTaskSummary(): Promise<void>
  /** Re-read the selected project's overview (scopeKind `project`). */
  loadProjectSummary(): Promise<void>
  /** Close the project overview area (no request). */
  closeProjectSummary(): void

  /**
   * Open one scope's summary editor. Refused when the read is not ready or has
   * no baseline: a baseline is never invented (SAVE-05).
   */
  openSummaryEditor(scopeKind: SummaryScopeKind): void
  /** Close the editor and discard the unsaved input (a saved draft survives). */
  closeSummaryEditor(scopeKind: SummaryScopeKind): void
  /** Patch the textarea; typing mints no identity (F03-R07). */
  setSummaryText(scopeKind: SummaryScopeKind, text: string): void
  /** Upsert the core draft slot; never creates an official version. */
  saveSummaryDraft(scopeKind: SummaryScopeKind): Promise<void>
  /** Show the old-official vs new-input diff; the input is kept. */
  previewSummary(scopeKind: SummaryScopeKind): void
  /** Leave the preview and keep the input (draft semantics). */
  cancelSummaryPreview(scopeKind: SummaryScopeKind): void
  /**
   * Commit the previewed body. The same update id is reused by every attempt of
   * this intent, so a double click or retry cannot create two versions.
   */
  saveSummary(scopeKind: SummaryScopeKind): Promise<void>
}

/**
 * Create the board controller.
 *
 * @param options - the data port plus optional seams for deterministic tests.
 * @returns the controller.
 */
export function createBoardController(options: BoardControllerOptions): BoardController {
  const source = options.source
  const mintOperationId = options.newOperationId ?? nextOperationId
  const listeners = new Set<() => void>()
  /** Monotone read generation: an answer may only land for the newest read. */
  let readSeq = 0

  /** Per-task kept reason input, so a cancelled or invalid dialog loses nothing. */
  const keptReasons = new Map<string, string>()

  let state: BoardState = {
    // Q1=B: a fresh board never assumes a project; the panel opens on the
    // explicit selection empty state and sends no read.
    read: { kind: 'selection-required', message: SELECTION_REQUIRED_DESCRIPTION },
    projects: { kind: 'idle' },
    transport: source.transport,
    selectedProjectId: null,
    cancelledExpanded: false,
    openTaskId: null,
    detail: null,
    statusDialog: null,
    createForm: null,
    fieldEdit: null,
    taskActivity: { kind: 'idle' },
    projectActivity: { kind: 'idle' },
    taskSummary: null,
    projectSummary: null,
    feedback: null,
    busy: null,
  }

  const emit = (): void => {
    options.onChange?.(state)
    for (const listener of [...listeners]) listener()
  }

  /** Apply a patch, dropping `undefined` values (exactOptionalPropertyTypes). */
  const setState = (patch: Partial<BoardState>): void => {
    const next: Record<string, unknown> = { ...state }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    state = next as unknown as BoardState
    emit()
  }

  /** The explicit "no project selected" read state (Q1=B). */
  const selectionRequired = (): BoardReadState => ({
    kind: 'selection-required',
    message: SELECTION_REQUIRED_DESCRIPTION,
  })

  /**
   * Clear the selection and everything derived from it, without touching the
   * source. Every panel mount calls this, so a cached controller can never carry
   * a previous project's cards into a new entry (Q1=B).
   */
  const resetSelectionState = (): void => {
    keptReasons.clear()
    setState({
      selectedProjectId: null,
      read: selectionRequired(),
      // The candidate set is re-read on the next entry; it is not a cache of
      // "the projects I saw last time" (Q1=B).
      projects: { kind: 'idle' },
      openTaskId: null,
      detail: null,
      statusDialog: null,
      createForm: null,
      fieldEdit: null,
      taskActivity: { kind: 'idle' },
      projectActivity: { kind: 'idle' },
      taskSummary: null,
      projectSummary: null,
      feedback: null,
      busy: null,
    })
  }

  /**
   * Build the undo affordance from the authoritative post-write snapshot.
   *
   * Never from the input or the pre-write view: only the data layer knows which
   * write is still undoable (F02-R04). `null`/absent `undoTarget` → no undo.
   *
   * @param snapshot - the snapshot the write returned.
   * @param taskId - the task the write targeted.
   * @returns the undo token, or undefined when there is nothing to undo.
   */
  const undoTokenFrom = (snapshot: BoardSnapshot, taskId: string): UndoToken | undefined => {
    const task = snapshot.tasks.find((item) => item.taskId === taskId)
    if (task === undefined || task.undoTarget === null) return undefined
    return {
      taskId,
      expectedStatusVersion: task.undoTarget.statusVersion,
      appliedUpdateId: task.undoTarget.appliedUpdateId,
    }
  }

  /** The board currently on screen, whatever the read state is. */
  const currentView = (): BoardView | null => {
    const read = state.read
    if (read.kind === 'ready') return read.view
    if (read.kind === 'failed') return read.kept
    return null
  }

  const currentCapabilities = (): BoardCapabilities => {
    const read = state.read
    if (read.kind === 'ready') return read.capabilities
    if (read.kind === 'failed') return read.capabilities
    return { statusChange: false, reorder: false, undo: false }
  }

  const applySnapshot = (snapshot: BoardSnapshot): void => {
    const view = buildBoardView(snapshot)
    const openTaskId = state.openTaskId
    const task = openTaskId === null ? undefined : snapshot.tasks.find((item) => item.taskId === openTaskId)
    // A reopened/refreshed read is a new version of the task: the editor's
    // SAVE-05 baselines move to it, while the user's draft is left untouched. A
    // task that disappeared takes its editor with it.
    const edit = state.fieldEdit
    let nextEdit = edit
    if (edit !== null) {
      const editTask = snapshot.tasks.find((item) => item.taskId === edit.taskId)
      if (editTask === undefined) {
        nextEdit = null
      } else if (editTask.fieldsRevision !== undefined) {
        nextEdit = {
          ...edit,
          expectedFieldsVersion: encodeFieldsVersion(editTask.fieldsRevision),
          expectedStatusVersion: encodeStatusVersion(editTask.statusRevision),
        }
      }
    }
    // The activity areas belong to exactly one scope: losing that scope (the
    // detail closed, its task gone) resets the area instead of showing another
    // task's entries under it.
    const activityOwner = task === undefined ? null : openTaskId
    const taskActivityReset = state.taskActivity.kind !== 'idle'
      && (activityOwner === null || state.taskActivity.scopeId !== activityOwner)
    // The summary editor belongs to exactly one open task: losing the task closes
    // it instead of showing the previous task's overview under a new detail.
    const taskSummaryReset = state.taskSummary !== null
      && (task === undefined || state.taskSummary.scopeId !== openTaskId)
    setState({
      read: {
        kind: 'ready',
        projectId: snapshot.project.projectId,
        boardToken: snapshot.boardToken,
        view,
        capabilities: snapshot.capabilities,
      },
      // A task that is no longer in the data closes the detail view rather than
      // showing a stale copy of it.
      openTaskId: task === undefined ? null : openTaskId,
      detail: task === undefined ? null : deriveTaskDetail(task),
      ...(nextEdit === edit ? {} : { fieldEdit: nextEdit }),
      ...(taskActivityReset ? { taskActivity: { kind: 'idle' as const } } : {}),
      ...(taskSummaryReset ? { taskSummary: null } : {}),
    })
  }

  const taskById = (taskId: string): BoardTask | undefined => {
    const view = currentView()
    if (view === null) return undefined
    for (const column of view.columns) {
      const found = column.tasks.find((task) => task.taskId === taskId)
      if (found !== undefined) return found
    }
    return undefined
  }

  const runWrite = async (
    kind: 'status' | 'reorder' | 'undo',
    taskId: string,
    retry: RetryIntent,
    attempt: () => Promise<WriteResult>,
  ): Promise<void> => {
    setState({ busy: { kind, taskId } })
    let result: WriteResult
    try {
      result = await attempt()
    } catch (error) {
      // A transport that throws is an unconfirmed write, not a crash of the panel.
      // F9/F10: an unknown outcome must not keep a write-retry intent — only a
      // re-read, after which the user decides again.
      const message = error instanceof Error ? error.message : String(error)
      setState({
        busy: null,
        feedback: {
          kind: 'failure',
          text: `${writeFailedText('unknown-result')}（${message}）`,
          code: 'unknown-result',
          retry: { kind: 'read' },
        },
      })
      return
    }

    if (result.ok) {
      applySnapshot(result.snapshot)
      const undo = undoTokenFrom(result.snapshot, taskId)
      const text = kind === 'reorder' ? REORDER_SAVED_TEXT : kind === 'undo' ? UNDO_DONE_TEXT : statusTextOf(retry)
      setState({
        busy: null,
        feedback: undo === undefined ? { kind: 'success', text } : { kind: 'success', text, undo },
      })
      return
    }

    if (result.code === 'stale-baseline' && kind === 'undo' && result.current !== undefined) {
      // F02-R04: an undo must not overwrite later changes. Show the actual value.
      const current = result.current
      refreshFromHostValue(taskId, current)
      setState({
        busy: null,
        feedback: {
          kind: 'undo-blocked',
          text: undoBlockedText(current, labelForStatusId(current.status)),
          current,
        },
      })
      return
    }

    // Failure: keep the previous authoritative view. When the data layer told us
    // the real current value, reflect that — never the attempted value.
    if (result.current !== undefined) refreshFromHostValue(taskId, result.current)
    // F9/F10/D6: an unknown outcome, or a write whose re-read failed, must not
    // offer a write retry — the write may already have landed, and reorder has no
    // order-level baseline. The only honest retry is a fresh read.
    const readOnlyRetry = result.code === 'unknown-result' || result.code === 'read-failed'
    setState({
      busy: null,
      feedback: {
        kind: 'failure',
        text: result.message.length > 0 ? result.message : writeFailedText(result.code),
        code: result.code,
        retry: readOnlyRetry ? { kind: 'read' } : retry,
      },
    })
  }

  const refreshFromHostValue = (taskId: string, current: FormalStatusValue): void => {
    const view = currentView()
    if (view === null) return
    const tasks = view.columns.flatMap((column) => column.tasks).map((item) =>
      item.taskId === taskId ? { ...item, status: current.status } : item,
    )
    const snapshot: BoardSnapshot = {
      project: view.project,
      tasks,
      boardToken: view.boardToken,
      capabilities: view.capabilities,
    }
    applySnapshot(snapshot)
  }

  /** The label to show for a status id: any task already carrying it knows it. */
  const labelForStatusId = (statusId: StatusId): string => {
    const view = currentView()
    if (view !== null) {
      for (const column of view.columns) {
        const task = column.tasks.find((item) => item.status === statusId)
        if (task !== undefined) return statusLabelOf(task)
      }
    }
    return statusId
  }

  const statusTextOf = (retry: RetryIntent): string =>
    retry.kind === 'status' ? statusChangedText(retry.input.next, labelForStatusId(retry.input.next)) : '已保存'

  /** One explicit refusal for a flow the data layer cannot serve. */
  const refuseMissingCapability = (): void => {
    setState({ feedback: { kind: 'failure', text: CAPABILITY_MISSING_MESSAGE, code: 'unavailable', retry: null } })
  }

  /** The single guard + single write path behind menu, keyboard and drag. */
  const requestStatusChange = (input: {
    readonly taskId: string
    readonly next: StatusId
    readonly toIndex?: number
  }): void => {
    const task = taskById(input.taskId)
    if (task === undefined) {
      setState({ feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null } })
      return
    }

    if (state.busy !== null && state.busy.taskId === input.taskId) {
      // Repeated submission of the same intent: one result only (SAVE-06).
      return
    }

    const reason = keptReasons.get(input.taskId) ?? ''

    // The blocked rule is checked *before* the capability gate on purpose: the
    // rule is the user's problem to fix, and reporting "not connected" instead
    // would hide the real reason the change cannot proceed.
    if (input.next === 'blocked' && !isBlockedReasonValid(reason)) {
      setState({
        statusDialog: {
          taskId: input.taskId,
          from: task.status,
          next: input.next,
          reason,
          invalidReason: true,
        },
        feedback: { kind: 'validation', text: BLOCKED_REASON_REQUIRED_MESSAGE },
      })
      return
    }

    if (!currentCapabilities().statusChange) {
      // No write is attempted and no optimistic move happens.
      setState({ statusDialog: null })
      refuseMissingCapability()
      return
    }

    if (input.next === 'blocked') {
      setState({ statusDialog: { taskId: input.taskId, from: task.status, next: input.next, reason, invalidReason: false } })
      return
    }

    const change: StatusChangeInput = {
      taskId: input.taskId,
      next: input.next,
      operationId: mintOperationId(),
      reason: state.statusDialog?.reason ?? reason,
      // Q2=A: every write carries the baseline it was decided on (SAVE-05).
      expectedStatusVersion: encodeStatusVersion(task.statusRevision),
      ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
    }
    setState({ statusDialog: null })
    void runWrite('status', input.taskId, { kind: 'status', input: change }, () => source.setStatus(change))
  }

  /* ------------------------------------------------------------------ *
   * Slice B: creation, field edit and activity history
   * ------------------------------------------------------------------ */

  /** One failure sentence: the data layer's own message, or the local fallback. */
  const failureText = (code: BoardFailureCode, message: string): string =>
    message.trim().length > 0 ? message : writeFailedText(code)

  /** The status ids the board's columns offer to the creation form. */
  const creationStatuses = (): readonly string[] => {
    const read = state.read
    return read.kind === 'ready' ? read.view.columns.map((column) => column.status) : []
  }

  /**
   * Replace one task in the view currently on screen with the data layer's
   * authoritative copy.
   *
   * Used when a write landed but the board re-read failed (`snapshot: null`):
   * the board token stays, while the task's own fields are known to be new.
   */
  const applyTaskToView = (task: BoardTask): void => {
    const view = currentView()
    // Only a genuinely ready read may be refreshed in place. A kept view that
    // belongs to a failed read stays failed (the board was not re-read); only the
    // task in the open detail gets the authoritative copy.
    if (view === null || state.read.kind !== 'ready') {
      if (state.openTaskId === task.taskId) setState({ detail: deriveTaskDetail(task) })
      return
    }
    const tasks = view.columns.flatMap((column) => column.tasks).map((item) =>
      item.taskId === task.taskId ? task : item,
    )
    const snapshot: BoardSnapshot = {
      project: view.project,
      tasks,
      columns: view.columns.map((column) => ({
        status: column.status,
        label: column.label,
        collapsedByDefault: column.collapsedByDefault,
        tasks: tasks.filter((item) => item.status === column.status),
      })),
      boardToken: view.boardToken,
      capabilities: view.capabilities,
    }
    applySnapshot(snapshot)
  }

  /** Edit a creation draft field; typing clears the previous in-place error. */
  const patchCreateForm = (patch: Partial<CreateFormState>): void => {
    const form = state.createForm
    if (form === null || state.busy?.kind === 'create') return
    setState({ createForm: { ...form, error: null, ...patch } })
  }

  /** Edit a field draft; typing clears the previous in-place error. */
  const patchFieldEdit = (patch: Partial<FieldEditState>): void => {
    const edit = state.fieldEdit
    if (edit === null || state.busy?.kind === 'fields') return
    setState({ fieldEdit: { ...edit, error: null, ...patch } })
  }

  const runCreateTask = async (input: CreateTaskInput): Promise<void> => {
    if (state.busy !== null) return
    setState({ busy: { kind: 'create' }, feedback: null })
    let result: CreateTaskResult
    try {
      result = await source.createTask(input)
    } catch (error) {
      // An unconfirmed creation may have landed: only a re-read is honest.
      const message = error instanceof Error ? error.message : String(error)
      setState({
        busy: null,
        feedback: {
          kind: 'failure',
          text: `创建结果未知：${message}；请先重新读取，不要重复提交。`,
          code: 'unknown-result',
          retry: { kind: 'read' },
        },
      })
      return
    }

    if (result.ok) {
      if (result.snapshot !== null) {
        applySnapshot(result.snapshot)
        setState({
          busy: null,
          createForm: null,
          feedback: { kind: 'success', text: createdTaskText(result.outcome, result.task.title) },
        })
      } else {
        // The creation landed; only the view refresh failed (REC-01). This is a
        // confirmation, not a failure, and the write is never re-sent.
        setState({
          busy: null,
          createForm: null,
          feedback: { kind: 'stale-view', text: createdStaleViewText(result.outcome) },
        })
      }
      return
    }

    const form = state.createForm
    const inPlace = result.code === 'invalid-input' || result.code === 'invalid-reason'
    let nextForm = form
    if (form !== null) {
      const draft = result.keptInput === undefined
        ? { title: form.title, goal: form.goal, initialStatus: form.initialStatus, blockedReason: form.blockedReason }
        : restoreCreateDraft(result.keptInput, creationStatuses())
      nextForm = { ...form, ...draft, error: inPlace ? failureText(result.code, result.message) : null }
    }
    // F9/F10: an unknown outcome (or a refused write whose re-read failed) must
    // not offer a write retry — the creation may already have landed.
    const readOnlyRetry = result.code === 'unknown-result'
      || result.code === 'read-failed'
      || result.code === 'stale-baseline'
      || result.code === 'unknown-project'
    const writeRetry = result.code === 'save-failed' || result.code === 'unavailable'
    setState({
      busy: null,
      ...(nextForm === null ? {} : { createForm: nextForm }),
      feedback: {
        kind: 'failure',
        text: failureText(result.code, result.message),
        code: result.code,
        retry: readOnlyRetry ? { kind: 'read' } : writeRetry ? { kind: 'create', input } : null,
      },
    })
  }

  /** Success text for a field save, by the outcome the data layer reported. */
  const fieldsSuccessTextOf = (
    outcome: 'saved' | 'no-change' | 'already-applied',
    changed: readonly ('title' | 'goal')[],
  ): string => {
    if (outcome === 'already-applied') return FIELDS_ALREADY_APPLIED_TEXT
    if (outcome === 'no-change') return FIELDS_NO_CHANGE_TEXT
    return fieldsSavedText(changed)
  }

  const runUpdateFields = async (input: UpdateFieldsInput): Promise<void> => {
    if (state.busy !== null) return
    setState({ busy: { kind: 'fields', taskId: input.taskId }, feedback: null })
    let result: UpdateFieldsResult
    try {
      result = await source.updateTaskFields(input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState({
        busy: null,
        feedback: {
          kind: 'failure',
          text: `保存结果未知：${message}；请先重新读取，不要重复提交。`,
          code: 'unknown-result',
          retry: { kind: 'read' },
        },
      })
      return
    }

    if (result.ok) {
      const text = fieldsSuccessTextOf(result.outcome, result.changed)
      if (result.snapshot !== null) {
        applySnapshot(result.snapshot)
        setState({ busy: null, fieldEdit: null, feedback: { kind: 'success', text } })
      } else {
        // The save landed; the task object carries the new fields, the board
        // does not. Keep the known view, update that one task, ask for a re-read.
        applyTaskToView(result.task)
        setState({
          busy: null,
          fieldEdit: null,
          feedback: { kind: 'stale-view', text: fieldsStaleViewText(result.changed) },
        })
      }
      return
    }

    // Show the real formal status when the data layer supplied it, never the
    // attempted value (same rule as the status writes).
    if (result.current !== undefined) refreshFromHostValue(input.taskId, result.current)
    const edit = state.fieldEdit
    let nextEdit = edit
    if (edit !== null) {
      const inPlace = result.code === 'invalid-input' || result.code === 'invalid-reason'
      nextEdit = {
        ...edit,
        // F01-R05: a refused save leaves the typed draft in place.
        title: result.keptInput?.title ?? edit.title,
        goal: result.keptInput?.goal ?? edit.goal,
        error: inPlace ? failureText(result.code, result.message) : null,
      }
    }
    const baselineNote = result.baseline === undefined
      ? ''
      : `（期望字段版本 ${result.baseline.expected.fieldsVersion}，实际 ${result.baseline.actual.fieldsVersion}）`
    const readOnlyRetry = result.code === 'unknown-result'
      || result.code === 'read-failed'
      || result.code === 'stale-baseline'
      || result.code === 'unknown-project'
    const writeRetry = result.code === 'save-failed' || result.code === 'unavailable'
    setState({
      busy: null,
      ...(nextEdit === null ? {} : { fieldEdit: nextEdit }),
      feedback: {
        kind: 'failure',
        text: `${failureText(result.code, result.message)}${baselineNote}`,
        code: result.code,
        retry: readOnlyRetry ? { kind: 'read' } : writeRetry ? { kind: 'fields', input } : null,
      },
    })
  }

  /** Apply one activity read, dropping a response whose scope is no longer shown. */
  const applyActivityResult = (scope: 'task' | 'project', scopeId: string, result: ActivityResult): void => {
    const failed = (): { kind: 'failed'; scopeId: string; code: BoardFailureCode; message: string } => ({
      kind: 'failed',
      scopeId,
      code: result.ok ? 'read-failed' : result.code,
      message: result.ok
        ? ACTIVITY_FAILED_TEXT
        : (result.message.trim().length > 0 ? result.message : ACTIVITY_FAILED_TEXT),
    })
    if (scope === 'task') {
      if (state.openTaskId !== scopeId) return
      // A closed/replaced area must not be reopened by a late answer.
      if (state.taskActivity.kind !== 'loading' || state.taskActivity.scopeId !== scopeId) return
      setState({
        taskActivity: result.ok
          ? { kind: 'ready', scopeId, entries: deriveActivityEntries(result.entries) }
          : failed(),
      })
      return
    }
    if (state.selectedProjectId !== scopeId) return
    // Same rule for the project area: idle/ready/failed is not "waiting".
    if (state.projectActivity.kind !== 'loading' || state.projectActivity.scopeId !== scopeId) return
    setState({
      projectActivity: result.ok
        ? { kind: 'ready', scopeId, entries: deriveActivityEntries(result.entries) }
        : failed(),
    })
  }

  const loadActivity = async (scope: 'task' | 'project'): Promise<void> => {
    const scopeId = scope === 'task' ? (state.openTaskId ?? null) : state.selectedProjectId
    if (scopeId === null) return
    const current = scope === 'task' ? state.taskActivity : state.projectActivity
    // One request per scope at a time; no automatic repetition, no polling.
    if (current.kind === 'loading' && current.scopeId === scopeId) return
    setState(scope === 'task'
      ? { taskActivity: { kind: 'loading', scopeId } }
      : { projectActivity: { kind: 'loading', scopeId } })
    let result: ActivityResult
    try {
      result = await source.loadActivity({ scopeKind: scope, scopeId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = { ok: false, code: 'read-failed', message: `活动历史读取失败：${message}` }
    }
    applyActivityResult(scope, scopeId, result)
  }

  /* ---------------------------------------------------------------- *
   * F03: manual summary / project overview
   * ---------------------------------------------------------------- */

  const summaryStateOf = (scopeKind: SummaryScopeKind): SummaryEditorState | null =>
    scopeKind === 'task' ? state.taskSummary : state.projectSummary

  const setSummaryState = (scopeKind: SummaryScopeKind, next: SummaryEditorState | null): void => {
    setState(scopeKind === 'task' ? { taskSummary: next } : { projectSummary: next })
  }

  /** Patch one summary editor, dropping `undefined` keys like {@link setState}. */
  const patchSummaryState = (scopeKind: SummaryScopeKind, patch: Partial<SummaryEditorState>): void => {
    const current = summaryStateOf(scopeKind)
    if (current === null) return
    const next: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key] = value
    }
    setSummaryState(scopeKind, next as unknown as SummaryEditorState)
  }

  /** Whether the scope a summary belongs to is still the one on screen. */
  const summaryScopeStillOpen = (scopeKind: SummaryScopeKind, scopeId: string): boolean =>
    scopeKind === 'task' ? state.openTaskId === scopeId : state.selectedProjectId === scopeId

  const loadSummaryFor = async (scopeKind: SummaryScopeKind, scopeId: string): Promise<void> => {
    // A retry after the detail/selection closed has no scope to land on.
    if (!summaryScopeStillOpen(scopeKind, scopeId)) return
    const current = summaryStateOf(scopeKind)
    // One read per scope at a time; no polling, no automatic repetition.
    if (current !== null && current.status === 'loading' && current.scopeId === scopeId) return
    // Keep an in-flight edit across an explicit re-read: the stale-baseline path
    // tells the user to re-read, and the typed input must not vanish (F03-R04).
    const prior = current !== null && current.scopeId === scopeId && current.editing ? current : null
    setSummaryState(scopeKind, summaryEditorLoading(scopeKind, scopeId))
    let result: SummaryReadResult
    try {
      result = await source.readSummary({ scopeKind, scopeId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = { ok: false, code: 'read-failed', message: `${SUMMARY_READ_FAILED_TEXT}（${message}）` }
    }
    // A late response never lands on a different task/project (F01-R01).
    if (!summaryScopeStillOpen(scopeKind, scopeId)) return
    if (!result.ok) {
      const text = result.message.trim().length > 0 ? result.message : SUMMARY_READ_FAILED_TEXT
      setSummaryState(scopeKind, summaryEditorFailed(scopeKind, scopeId, text))
      setState({
        feedback: { kind: 'failure', text, code: result.code, retry: { kind: 'summary-read', scopeKind, scopeId } },
      })
      return
    }
    if (result.summary === null) {
      // Host contract: an existing scope answers with a view whose `current` may
      // be null. A null *view* is an inconsistency, never an empty state.
      const text = '概况读取结果不一致（缺少概况视图），请重新读取。'
      setSummaryState(scopeKind, summaryEditorFailed(scopeKind, scopeId, text))
      setState({
        feedback: { kind: 'failure', text, code: 'read-failed', retry: { kind: 'summary-read', scopeKind, scopeId } },
      })
      return
    }
    const ready = summaryEditorReady(scopeKind, scopeId, result.summary, mintOperationId())
    if (prior === null) {
      setSummaryState(scopeKind, ready)
      return
    }
    // Re-read while editing: keep the typed text, move the baseline to the new
    // view, and mark the input as still unsaved.
    const kept: SummaryEditorState = {
      ...ready,
      text: prior.text,
      dirty: prior.text !== summaryEditorText(ready.view),
      editing: true,
      notice: '已重新读取概况基线，未保存的输入已保留。',
    }
    setSummaryState(scopeKind, kept)
  }

  const beginSummaryEdit = (scopeKind: SummaryScopeKind): void => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || state.busy !== null) return
    if (editor.status !== 'ready' || editor.baseline === null) {
      // SAVE-05: no baseline means no save. Never invent one; re-read instead.
      setState({
        feedback: {
          kind: 'failure',
          text: SUMMARY_BASELINE_MISSING_TEXT,
          code: 'read-failed',
          retry: { kind: 'summary-read', scopeKind, scopeId: editor.scopeId },
        },
      })
      return
    }
    patchSummaryState(scopeKind, {
      editing: true,
      previewing: false,
      error: null,
      notice: null,
      updateId: editor.updateId ?? mintOperationId(),
    })
  }

  const endSummaryEdit = (scopeKind: SummaryScopeKind): void => {
    if (state.busy?.kind === 'summary') return
    const editor = summaryStateOf(scopeKind)
    if (editor === null || !editor.editing) return
    // Closing discards the *unsaved* input only; a saved draft stays in the view
    // and is what the editor reopens with (F03-R07).
    patchSummaryState(scopeKind, {
      editing: false,
      previewing: false,
      error: null,
      notice: null,
      text: summaryEditorText(editor.view),
      dirty: false,
      draftStatus: 'none',
      draftError: null,
    })
  }

  const writeSummaryText = (scopeKind: SummaryScopeKind, text: string): void => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || editor.status !== 'ready' || !editor.editing) return
    patchSummaryState(scopeKind, summaryPatchText(editor, text))
  }

  const persistSummaryDraft = async (scopeKind: SummaryScopeKind): Promise<void> => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || editor.status !== 'ready' || !editor.editing) return
    if (editor.draftStatus === 'saving') return
    const content = summaryContentForSave(scopeKind, editor.text, summaryConclusionsOf(editor.view))
    patchSummaryState(scopeKind, {
      draftStatus: 'saving',
      draftError: null,
      notice: SUMMARY_DRAFT_SAVING_TEXT,
    })
    let result: SummaryDraftSaveResult
    try {
      result = await source.saveSummaryDraft({
        scopeKind,
        scopeId: editor.scopeId,
        content,
        ...(editor.updateId === null ? {} : { updateId: editor.updateId }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = { ok: false, code: 'save-failed', message }
    }
    const current = summaryStateOf(scopeKind)
    if (current === null || current.scopeId !== editor.scopeId || current.status !== 'ready') return
    if (!result.ok) {
      patchSummaryState(scopeKind, {
        draftStatus: 'failed',
        draftError: result.message.trim().length > 0 ? result.message : SUMMARY_DRAFT_FAILED_TEXT,
        notice: null,
      })
      return
    }
    // A draft is never a version: only the draft slot of the view changes.
    const view: SummaryEditorState['view'] = current.view === null
      ? null
      : { ...current.view, draft: result.draft }
    patchSummaryState(scopeKind, {
      view,
      draftStatus: 'saved',
      draftError: null,
      dirty: current.text !== summaryEditorText(view),
      notice: SUMMARY_DRAFT_SAVED_TEXT,
    })
  }

  const enterSummaryPreview = (scopeKind: SummaryScopeKind): void => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || editor.status !== 'ready' || !editor.editing) return
    patchSummaryState(scopeKind, { previewing: true, error: null })
  }

  const leaveSummaryPreview = (scopeKind: SummaryScopeKind): void => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || !editor.previewing) return
    patchSummaryState(scopeKind, { previewing: false })
  }

  /**
   * Reduce an authoritative summary view to the one card line core would report.
   *
   * Core's `progressLineOf` uses the first non-empty line of the first non-empty
   * section (whitespace collapsed, at most 160 characters). The save response
   * carries that same content, so the card can be updated without a second
   * `board/read` — and must be, because F03-R02 requires the saved summary to be
   * visible immediately (not only after switching projects or restarting).
   *
   * @param view - the summary re-read returned by a successful save.
   * @returns the card progress, or `null` when there is no official summary body.
   */
  function summaryProgressOf(view: SummaryEditorState['view']): TaskProgressView | null {
    const current = view?.current
    if (current === null || current === undefined) return null
    for (const section of current.content.sections) {
      for (const rawLine of section.body.split(/\r?\n/u)) {
        const line = rawLine.replace(/\s+/gu, ' ').trim()
        if (line.length === 0) continue
        return {
          line: line.length <= 160 ? line : `${line.slice(0, 159)}…`,
          versionId: current.versionId,
          confirmedAt: current.confirmedAt,
        }
      }
    }
    return null
  }

  /**
   * Write the saved summary into the board card and the open detail immediately.
   *
   * The board snapshot is the only place a card reads `summaryProgress` from
   * (`deriveCardProgress`), and the detail keeps its own copy (`TaskDetailView`);
   * both must be refreshed together. No other task field is touched, and a
   * project-scope save never changes a card.
   *
   * @param taskId - the task whose summary was saved.
   * @param view - the authoritative summary re-read returned by the save.
   */
  function applyTaskSummaryProgress(taskId: string, view: SummaryEditorState['view']): void {
    if (state.read.kind !== 'ready') return
    const sourceTask = state.read.view.columns
      .flatMap((column) => column.tasks)
      .find((task) => task.taskId === taskId)
    if (sourceTask === undefined) return
    const progress = summaryProgressOf(view)
    const updatedTask: BoardTask = {
      ...sourceTask,
      summaryProgress: progress,
      hasSummary: view !== null && view.current !== null,
      needsRecheck: view?.needsRecheck === true,
      ...(view === null ? {} : { recheckCodes: view.recheck.reasons.map((reason) => reason.code) }),
    }
    const columns = state.read.view.columns.map((column) => {
      if (!column.tasks.some((task) => task.taskId === taskId)) return column
      return {
        ...column,
        tasks: column.tasks.map((task) => (task.taskId === taskId ? updatedTask : task)),
      }
    })
    setState({
      read: { ...state.read, view: { ...state.read.view, columns } },
      ...(state.detail?.taskId === taskId ? { detail: deriveTaskDetail(updatedTask) } : {}),
    })
  }

  const runSummarySave = async (input: ManualSummarySaveInput): Promise<void> => {
    if (state.busy !== null) return
    const scopeKind = input.scopeKind
    const editor = summaryStateOf(scopeKind)
    if (editor === null || editor.scopeId !== input.scopeId || editor.status !== 'ready') return
    setState({ busy: { kind: 'summary' }, feedback: null })
    patchSummaryState(scopeKind, { status: 'saving', error: null, notice: null })
    let result: SummarySaveResult
    try {
      result = await source.saveSummary(input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = { ok: false, code: 'unknown-result', message: `${SUMMARY_SAVE_UNKNOWN_TEXT}（${message}）` }
    }
    // Late response: the detail/selection changed while the save was in flight.
    if (!summaryScopeStillOpen(scopeKind, input.scopeId)) {
      setState({ busy: null })
      return
    }
    if (result.ok) {
      const view = result.view
      if (view === null) {
        // The write landed but the authoritative re-read failed. This is neither
        // a failure nor a success: only a re-read is offered (REC-01/REC-05).
        patchSummaryState(scopeKind, {
          status: 'ready',
          editing: false,
          previewing: false,
          dirty: false,
          updateId: null,
          notice: SUMMARY_SAVED_STALE_TEXT,
          draftStatus: 'none',
          draftError: null,
        })
        setState({ busy: null, feedback: { kind: 'stale-view', text: SUMMARY_SAVED_STALE_TEXT } })
        return
      }
      setSummaryState(scopeKind, summaryEditorReady(scopeKind, input.scopeId, view, mintOperationId()))
      if (scopeKind === 'task') applyTaskSummaryProgress(input.scopeId, view)
      if (result.outcome === 'no-change') {
        setState({ busy: null, feedback: { kind: 'validation', text: SUMMARY_NO_CHANGE_TEXT } })
        return
      }
      const version = view.current
      const text = result.outcome === 'already-applied'
        ? SUMMARY_ALREADY_APPLIED_TEXT
        : version === null
          ? SUMMARY_SAVED_TEXT
          : `${SUMMARY_SAVED_TEXT}（${summaryVersionLabel(version)}）`
      setState({ busy: null, feedback: { kind: 'success', text } })
      return
    }
    // Failure: keep the typed input and the old official view. Only a
    // replay-safe code may re-send the write; everything else only re-reads.
    const message = result.message.trim().length > 0 ? result.message : SUMMARY_SAVE_UNKNOWN_TEXT
    const baseline = result.baseline
    const note = baseline === undefined
      ? ''
      : `（期望版本 ${String(baseline.expected.revision)}，实际 ${String(baseline.actual.revision)}）`
    const replayable = result.code === 'save-failed' || result.code === 'unavailable'
    const retry: RetryIntent | null = result.code === 'invalid-input'
      ? null
      : replayable
        ? { kind: 'summary-save', input }
        : { kind: 'summary-read', scopeKind, scopeId: input.scopeId }
    patchSummaryState(scopeKind, {
      status: 'ready',
      editing: true,
      previewing: false,
      error: `${message}${note}`,
      notice: null,
    })
    setState({
      busy: null,
      feedback: { kind: 'failure', text: `${message}${note}`, code: result.code, retry },
    })
  }

  const commitSummary = async (scopeKind: SummaryScopeKind): Promise<void> => {
    const editor = summaryStateOf(scopeKind)
    if (editor === null || editor.status !== 'ready' || editor.baseline === null || !editor.editing) return
    if (state.busy !== null) return
    const updateId = editor.updateId ?? mintOperationId()
    const draft = editor.view?.draft ?? null
    const input: ManualSummarySaveInput = {
      scopeKind,
      scopeId: editor.scopeId,
      updateId,
      expected: editor.baseline,
      content: summaryContentForSave(scopeKind, editor.text, summaryConclusionsOf(editor.view)),
      // The draft is consumed only after a successful commit (F03-R07).
      ...(draft === null ? {} : { consumeDraftIds: [draft.draftId] }),
    }
    await runSummarySave(input)
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async loadProjects() {
      setState({ projects: { kind: 'loading' } })
      const result = await source.listProjects()
      if (!result.ok) {
        // REC-05: a failed listing is visible and retryable. It never becomes an
        // empty candidate set and never selects a project by itself.
        setState({
          projects: { kind: 'failed', code: result.code, message: result.message },
          feedback: {
            kind: 'failure',
            text: result.message,
            code: result.code,
            retry: { kind: 'read' },
          },
        })
        return
      }
      const projects: ProjectListState = { kind: 'loaded', projects: result.projects }
      // A late listing must not clear a board read's own feedback: only the
      // selection screen owns this response.
      setState(state.read.kind === 'selection-required' ? { projects, feedback: null } : { projects })
    },

    async load() {
      const requested = state.selectedProjectId
      if (requested === null) {
        // Q1=B: there is no "current project" to read. Do not call the data
        // layer without an id; the panel shows the explicit selection state.
        setState({ read: selectionRequired(), busy: null })
        return
      }
      // Snapshot what is on screen *before* switching to `loading`: a failure
      // must keep showing the last known board (REC-05), not blank the panel.
      const keptBefore = currentView()
      const capabilitiesBefore = currentCapabilities()
      const seq = ++readSeq
      setState({ read: { kind: 'loading', projectId: requested }, busy: { kind: 'read' } })
      const result: BoardReadResult = await source.readBoard(requested)

      // Late-response guard: a reset/switch while this read was in flight must
      // drop the answer. Without this, a stale read could render a board with no
      // selection (Q1=B) and hide the "switch project" button.
      if (seq !== readSeq || state.selectedProjectId !== requested) return

      // Late-response guard: a response for another project is dropped, so a
      // switch cannot be shown under the wrong name (F01-R01).
      if (!result.ok) {
        setState({ busy: null })
        if (result.code === 'unknown-project') {
          setState({
            read: { kind: 'unknown-project', projectId: requested, message: result.message.length > 0 ? result.message : UNKNOWN_PROJECT_MESSAGE },
            openTaskId: null,
            detail: null,
            feedback: { kind: 'failure', text: result.message.length > 0 ? result.message : UNKNOWN_PROJECT_MESSAGE, code: result.code, retry: null },
          })
          return
        }
        setState({
          read: {
            kind: 'failed',
            projectId: requested,
            code: result.code,
            message: result.message,
            kept: keptBefore,
            capabilities: capabilitiesBefore,
          },
          feedback: { kind: 'failure', text: result.message, code: result.code, retry: { kind: 'read' } },
        })
        return
      }

      if (result.snapshot.project.projectId !== requested) {
        // The data layer answered for a different project than the one asked
        // for: keep it out of the view entirely.
        setState({
          busy: null,
          read: {
            kind: 'failed',
            projectId: requested,
            code: 'read-failed',
            message: '响应属于其他项目，已丢弃。',
            kept: keptBefore,
            capabilities: capabilitiesBefore,
          },
        })
        return
      }

      setState({ busy: null })
      applySnapshot(result.snapshot)
      setState({ feedback: null })
    },

    async retryRead() {
      await this.load()
    },

    async selectProject(projectId) {
      if (projectId === null || projectId.trim().length === 0) {
        resetSelectionState()
        return
      }
      // Clearing the view first is deliberate: the previous project's cards must
      // never render under the new project's header.
      keptReasons.clear()
      setState({
        selectedProjectId: projectId,
        read: { kind: 'idle' },
        openTaskId: null,
        detail: null,
        statusDialog: null,
        createForm: null,
        fieldEdit: null,
        taskActivity: { kind: 'idle' },
        projectActivity: { kind: 'idle' },
        taskSummary: null,
        projectSummary: null,
        feedback: null,
        busy: null,
      })
      await this.load()
    },

    resetSelection() {
      resetSelectionState()
    },

    toggleCancelled() {
      setState({ cancelledExpanded: !state.cancelledExpanded })
    },

    openDetail(taskId) {
      const task = taskById(taskId)
      if (task === undefined) return
      // A different task is a different scope: the previous editor and activity
      // list never carry over to it.
      const switched = state.openTaskId !== taskId
      setState({
        openTaskId: taskId,
        detail: deriveTaskDetail(task),
        ...(switched
          ? { fieldEdit: null, taskActivity: { kind: 'idle' as const }, taskSummary: null }
          : {}),
      })
      // Opening a task is the explicit moment its summary is read (F03-R01);
      // nothing is loaded while the detail is closed.
      if (switched) void loadSummaryFor('task', taskId)
    },

    closeDetail() {
      setState({
        openTaskId: null,
        detail: null,
        fieldEdit: null,
        taskActivity: { kind: 'idle' },
        taskSummary: null,
      })
    },

    requestStatusChange,

    menuSelectStatus(taskId, next) {
      requestStatusChange({ taskId, next })
    },

    dropTask(input) {
      const task = taskById(input.taskId)
      if (task === undefined) {
        setState({ feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null } })
        return
      }
      if (task.status === input.toStatus) {
        if (task.order === input.toIndex) return
        if (!currentCapabilities().reorder) {
          refuseMissingCapability()
          return
        }
        const reorder: ReorderInput = {
          taskId: input.taskId,
          status: input.toStatus,
          toIndex: input.toIndex,
          operationId: mintOperationId(),
          // Q2=A: a reorder carries the status baseline it was decided on.
          expectedStatusVersion: encodeStatusVersion(task.statusRevision),
        }
        void runWrite('reorder', input.taskId, { kind: 'reorder', input: reorder }, () => source.reorder(reorder))
        return
      }
      requestStatusChange({ taskId: input.taskId, next: input.toStatus, toIndex: input.toIndex })
    },

    setDialogReason(text) {
      const dialog = state.statusDialog
      if (dialog === null) return
      keptReasons.set(dialog.taskId, text)
      setState({ statusDialog: { ...dialog, reason: text, invalidReason: false } })
    },

    confirmStatusDialog() {
      const dialog = state.statusDialog
      if (dialog === null) return
      if (!isBlockedReasonValid(dialog.reason)) {
        setState({
          statusDialog: { ...dialog, invalidReason: true },
          feedback: { kind: 'validation', text: BLOCKED_REASON_KEEPS_STATUS_MESSAGE },
        })
        return
      }
      if (!currentCapabilities().statusChange) {
        setState({ statusDialog: null })
        refuseMissingCapability()
        return
      }
      // The baseline comes from the current view; a task that is no longer there
      // must be re-read rather than sent without one (Q2=A / SAVE-05).
      const task = taskById(dialog.taskId)
      if (task === undefined) {
        setState({
          statusDialog: null,
          feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null },
        })
        return
      }
      const change: StatusChangeInput = {
        taskId: dialog.taskId,
        next: dialog.next,
        reason: dialog.reason,
        operationId: mintOperationId(),
        expectedStatusVersion: encodeStatusVersion(task.statusRevision),
      }
      setState({ statusDialog: null })
      void runWrite('status', dialog.taskId, { kind: 'status', input: change }, () => source.setStatus(change))
    },

    cancelStatusDialog(options_) {
      const dialog = state.statusDialog
      if (dialog === null) return
      const keepInput = options_?.keepInput ?? true
      if (keepInput) keptReasons.set(dialog.taskId, dialog.reason)
      else keptReasons.delete(dialog.taskId)
      // Original status, column and order stay; the reason is kept by default.
      setState({
        statusDialog: null,
        feedback: keepInput && dialog.reason.length > 0
          ? { kind: 'draft', text: '已取消状态修改：仍未保存，原因内容已保留。' }
          : { kind: 'validation', text: '已取消状态修改：状态与列保持不变。' },
      })
    },

    retryPending() {
      const feedback = state.feedback
      if (feedback === null) return
      if (feedback.kind === 'stale-view') {
        // The write landed; only the view is stale. The one honest action is a
        // fresh read, never a replay of the write.
        void this.load()
        return
      }
      if (feedback.kind !== 'failure' || feedback.retry === null) return
      const retry = feedback.retry
      switch (retry.kind) {
        case 'read':
          // On the selection screen the failed read is the project list; reading
          // a board without a selection would only bounce back to that state
          // (Q1=B). Once a project is selected, "read" retries the board.
          if (state.read.kind === 'selection-required') void this.loadProjects()
          else void this.load()
          return
        case 'status':
          void runWrite('status', retry.input.taskId, retry, () => source.setStatus(retry.input))
          return
        case 'reorder':
          void runWrite('reorder', retry.input.taskId, retry, () => source.reorder(retry.input))
          return
        case 'undo':
          void runWrite('undo', retry.input.taskId, retry, () => source.undoStatusChange(retry.input))
          return
        case 'create':
          // Same input ⇒ same request id: one intent, one result (REC-02).
          void runCreateTask(retry.input)
          return
        case 'fields':
          void runUpdateFields(retry.input)
          return
        case 'summary-read':
          void loadSummaryFor(retry.scopeKind, retry.scopeId)
          return
        case 'summary-save':
          // Replay-safe codes only: same updateId ⇒ at most one version.
          void runSummarySave(retry.input)
          return
        default:
          return
      }
    },

    undoLastChange() {
      const feedback = state.feedback
      if (feedback === null || feedback.kind !== 'success' || feedback.undo === undefined) return
      if (!currentCapabilities().undo) {
        refuseMissingCapability()
        return
      }
      const token = feedback.undo
      // Two identities: this undo gets a fresh operation id; the write being
      // undone comes from the post-write snapshot's undoTarget (Q2=A).
      const undo: UndoInput = {
        taskId: token.taskId,
        operationId: mintOperationId(),
        expectedStatusVersion: token.expectedStatusVersion,
        appliedUpdateId: token.appliedUpdateId,
      }
      setState({ feedback: null })
      void runWrite('undo', undo.taskId, { kind: 'undo', input: undo }, () => source.undoStatusChange(undo))
    },

    undoTaskChange(taskId) {
      const task = taskById(taskId)
      if (task === undefined) {
        setState({ feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null } })
        return
      }
      if (!currentCapabilities().undo) {
        refuseMissingCapability()
        return
      }
      // `undoTarget` is the only source of the credential: it survives a refresh
      // (it comes from the read snapshot), while the success banner does not.
      if (task.undoTarget === null) return
      const undo: UndoInput = {
        taskId,
        operationId: mintOperationId(),
        expectedStatusVersion: task.undoTarget.statusVersion,
        appliedUpdateId: task.undoTarget.appliedUpdateId,
      }
      setState({ feedback: null })
      void runWrite('undo', taskId, { kind: 'undo', input: undo }, () => source.undoStatusChange(undo))
    },

    /* ---------------------------------------------------------------- *
     * Slice B: creation
     * ---------------------------------------------------------------- */

    openCreateForm() {
      // The button only renders on a ready board; refuse here as well so a
      // programmatic call can never open a form that cannot be submitted.
      if (state.read.kind !== 'ready' || state.busy !== null) return
      const view = state.read.view
      setState({
        createForm: {
          title: '',
          goal: '',
          // The first column the data layer declared — never an invented status.
          initialStatus: defaultInitialStatus(view),
          blockedReason: '',
          error: null,
          // One identity per form intent; typing mints nothing (REC-02).
          requestId: mintOperationId(),
        },
        fieldEdit: null,
        feedback: null,
      })
    },

    closeCreateForm() {
      // Closing cannot cancel a creation that is already in flight.
      if (state.busy?.kind === 'create') return
      if (state.createForm === null) return
      setState({ createForm: null })
    },

    setCreateTitle(text) {
      patchCreateForm({ title: text })
    },

    setCreateGoal(text) {
      patchCreateForm({ goal: text })
    },

    setCreateStatus(status) {
      patchCreateForm({ initialStatus: status })
    },

    setCreateBlockedReason(text) {
      patchCreateForm({ blockedReason: text })
    },

    async submitCreateTask() {
      const form = state.createForm
      if (form === null) return
      if (state.busy !== null) return
      if (state.read.kind !== 'ready') {
        setState({ createForm: { ...form, error: CREATE_FORM_NOT_READY_MESSAGE } })
        return
      }
      // F01-R02: the title is required and a blocked initial status needs a
      // reason. Both are refused here — no invalid write is sent.
      const validation = validateCreateDraft(form)
      if (validation !== null) {
        setState({ createForm: { ...form, error: validation } })
        return
      }
      const title = normalizeReason(form.title)
      const goal = form.goal.trim()
      const input: CreateTaskInput = {
        projectId: state.read.projectId,
        requestId: form.requestId,
        title,
        ...(goal.length === 0 ? {} : { goal }),
        ...(form.initialStatus.length === 0 ? {} : { initialStatus: form.initialStatus }),
        ...(form.initialStatus === BLOCKED_STATUS_ID ? { blockedReason: normalizeReason(form.blockedReason) } : {}),
      }
      await runCreateTask(input)
    },

    /* ---------------------------------------------------------------- *
     * Slice B: inline title/goal edit
     * ---------------------------------------------------------------- */

    openFieldEdit() {
      const detail = state.detail
      if (detail === null || state.busy !== null) return
      const task = taskById(detail.taskId)
      if (task === undefined) {
        setState({ feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null } })
        return
      }
      if (task.fieldsRevision === undefined) {
        // SAVE-05: no baseline means no save. Never invent one; re-read instead.
        setState({
          feedback: {
            kind: 'failure',
            text: FIELDS_BASELINE_MISSING_MESSAGE,
            code: 'read-failed',
            retry: { kind: 'read' },
          },
        })
        return
      }
      setState({
        createForm: null,
        fieldEdit: {
          taskId: task.taskId,
          title: task.title,
          goal: task.goal,
          error: null,
          // One identity per edit intent; a retry reuses it (REC-02).
          requestId: mintOperationId(),
          expectedFieldsVersion: encodeFieldsVersion(task.fieldsRevision),
          expectedStatusVersion: encodeStatusVersion(task.statusRevision),
        },
        feedback: null,
      })
    },

    closeFieldEdit() {
      if (state.busy?.kind === 'fields') return
      if (state.fieldEdit === null) return
      setState({ fieldEdit: null })
    },

    setEditTitle(text) {
      patchFieldEdit({ title: text })
    },

    setEditGoal(text) {
      patchFieldEdit({ goal: text })
    },

    async saveFieldEdit() {
      const edit = state.fieldEdit
      if (edit === null || state.busy !== null) return
      const task = taskById(edit.taskId)
      if (task === undefined) {
        setState({ feedback: { kind: 'failure', text: writeFailedText('not-found'), code: 'not-found', retry: null } })
        return
      }
      const validation = validateFieldDraft(edit)
      if (validation !== null) {
        setState({ fieldEdit: { ...edit, error: validation } })
        return
      }
      const title = edit.title.trim()
      const goal = edit.goal.trim()
      const titleChanged = title !== task.title
      const goalChanged = goal !== task.goal.trim()
      if (!titleChanged && !goalChanged) {
        // F01-R05: opening the editor and typing nothing is not a substantive
        // update; no write is sent.
        setState({
          fieldEdit: { ...edit, error: null },
          feedback: { kind: 'validation', text: NO_FIELD_CHANGE_MESSAGE },
        })
        return
      }
      const input: UpdateFieldsInput = {
        taskId: edit.taskId,
        requestId: edit.requestId,
        expectedFieldsVersion: edit.expectedFieldsVersion,
        expectedStatusVersion: edit.expectedStatusVersion,
        // Absent = leave unchanged; `null` = clear. Only what changed is sent.
        ...(titleChanged ? { title } : {}),
        ...(goalChanged ? { goal: goal.length === 0 ? null : goal } : {}),
      }
      await runUpdateFields(input)
    },

    /* ---------------------------------------------------------------- *
     * Slice B: activity history (explicit load, never automatic)
     * ---------------------------------------------------------------- */

    async loadTaskActivity() {
      await loadActivity('task')
    },

    closeTaskActivity() {
      if (state.taskActivity.kind === 'idle') return
      setState({ taskActivity: { kind: 'idle' } })
    },

    async loadProjectActivity() {
      await loadActivity('project')
    },

    closeProjectActivity() {
      if (state.projectActivity.kind === 'idle') return
      setState({ projectActivity: { kind: 'idle' } })
    },

    /* ---------------------------------------------------------------- *
     * F03: manual summary / project overview
     * ---------------------------------------------------------------- */

    async loadTaskSummary() {
      const taskId = state.openTaskId
      if (taskId === null) return
      await loadSummaryFor('task', taskId)
    },

    async loadProjectSummary() {
      const projectId = state.selectedProjectId
      if (projectId === null) return
      await loadSummaryFor('project', projectId)
    },

    closeProjectSummary() {
      // Closing is never allowed to race an in-flight save: the write owns the
      // editor until it settles (same rule as the create/field editors).
      if (state.busy?.kind === 'summary') return
      if (state.projectSummary === null) return
      setState({ projectSummary: null })
    },

    openSummaryEditor(scopeKind) {
      beginSummaryEdit(scopeKind)
    },

    closeSummaryEditor(scopeKind) {
      endSummaryEdit(scopeKind)
    },

    setSummaryText(scopeKind, text) {
      writeSummaryText(scopeKind, text)
    },

    async saveSummaryDraft(scopeKind) {
      await persistSummaryDraft(scopeKind)
    },

    previewSummary(scopeKind) {
      enterSummaryPreview(scopeKind)
    },

    cancelSummaryPreview(scopeKind) {
      leaveSummaryPreview(scopeKind)
    },

    async saveSummary(scopeKind) {
      await commitSummary(scopeKind)
    },
  }
}

/** The label to render for one task's status, using the data layer's own label. */
export function labelFor(task: BoardTask): string {
  return statusLabelOf(task)
}

/** Re-export for consumers that only import the controller. */
export type { BoardSnapshot, BoardSource } from './source.js'
