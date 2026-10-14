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
  BLOCKED_REASON_KEEPS_STATUS_MESSAGE,
  BLOCKED_REASON_REQUIRED_MESSAGE,
  buildBoardView,
  deriveTaskDetail,
  isBlockedReasonValid,
  statusLabelOf,
  type BoardCapabilities,
  type BoardTask,
  type BoardView,
  type StatusId,
  type TaskDetailView,
} from './model.js'
import {
  nextOperationId,
  type BoardFailureCode,
  type BoardReadResult,
  type BoardSnapshot,
  type BoardSource,
  type FormalStatusValue,
  type ReorderInput,
  type StatusChangeInput,
  type UndoInput,
  type WriteResult,
} from './source.js'

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** What the panel is currently doing. */
export interface BoardBusy {
  readonly kind: 'read' | 'status' | 'reorder' | 'undo'
  readonly taskId?: string
}

/** A retryable failed intent. `read` re-reads the board. */
export type RetryIntent =
  | { readonly kind: 'read' }
  | { readonly kind: 'status'; readonly input: StatusChangeInput }
  | { readonly kind: 'reorder'; readonly input: ReorderInput }
  | { readonly kind: 'undo'; readonly input: UndoInput }

/** The undo affordance attached to a successful change. */
export interface UndoToken {
  readonly taskId: string
  readonly operationId: string
}

/**
 * The read state: `idle` before the first read, `loading` in flight, `ready`
 * with a board, and the two explicit failure shapes.
 *
 * `failed` keeps the last known board (`kept`) so a transient read error does
 * not blank the panel; `unknown-project` deliberately keeps nothing, because
 * showing the previous project's cards under a new project's name is exactly the
 * cross-project leak F01-R01 forbids.
 */
export type BoardReadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly projectId: string | null }
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
      readonly projectId: string | null
      readonly code: BoardFailureCode
      readonly message: string
      /** Last known good board, when there was one. */
      readonly kept: BoardView | null
      readonly capabilities: BoardCapabilities
    }

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

/** Everything the panel renders from. Immutable: a new object on every change. */
export interface BoardState {
  readonly read: BoardReadState
  readonly transport: BoardSource['transport']
  /** The project this controller is showing; `null` means "the data layer's current one". */
  readonly selectedProjectId: string | null
  /** Cancelled column expanded? Collapsed by default (F02 §3.2). */
  readonly cancelledExpanded: boolean
  readonly openTaskId: string | null
  readonly detail: TaskDetailView | null
  readonly statusDialog: StatusDialogState | null
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

/** Shown when the host refuses an undo because later changes exist (F02-R04). */
export function undoBlockedText(current: FormalStatusValue, label?: string): string {
  const shown = label !== undefined && label.length > 0 ? label : current.status
  return `无法直接撤销：此后已有新的修改，当前正式状态为「${shown}」（版本 ${current.statusVersion}）。`
}

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
  /** Project to read; `null`/absent asks the data layer for its current project. */
  readonly projectId?: string | null
  /** Operation-id minter; injectable so tests are deterministic. */
  readonly newOperationId?: () => string
  /** Change listener (React `useSyncExternalStore` shape). */
  readonly onChange?: (state: BoardState) => void
}

/** The panel's only write entry point. */
export interface BoardController {
  getState(): BoardState
  subscribe(listener: () => void): () => void

  /** Read the board for the selected project. */
  load(): Promise<void>
  /** Retry a failed read. */
  retryRead(): Promise<void>
  /** Switch projects: everything read after this belongs to the new selection. */
  selectProject(projectId: string | null): Promise<void>

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

  /** Per-task kept reason input, so a cancelled or invalid dialog loses nothing. */
  const keptReasons = new Map<string, string>()

  let state: BoardState = {
    read: { kind: 'idle' },
    transport: source.transport,
    selectedProjectId: options.projectId ?? null,
    cancelledExpanded: false,
    openTaskId: null,
    detail: null,
    statusDialog: null,
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
      const message = error instanceof Error ? error.message : String(error)
      setState({
        busy: null,
        feedback: { kind: 'failure', text: `${writeFailedText('unknown-result')}（${message}）`, code: 'unknown-result', retry },
      })
      return
    }

    if (result.ok) {
      applySnapshot(result.snapshot)
      const undo: UndoToken | undefined = result.undoable ? { taskId, operationId: operationIdOf(retry) } : undefined
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
    setState({
      busy: null,
      feedback: {
        kind: 'failure',
        text: result.message.length > 0 ? result.message : writeFailedText(result.code),
        code: result.code,
        retry,
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

  const operationIdOf = (retry: RetryIntent): string => {
    switch (retry.kind) {
      case 'status':
      case 'reorder':
      case 'undo':
        return retry.input.operationId
      default:
        return ''
    }
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
      ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
    }
    setState({ statusDialog: null })
    void runWrite('status', input.taskId, { kind: 'status', input: change }, () => source.setStatus(change))
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async load() {
      const requested = state.selectedProjectId
      // Snapshot what is on screen *before* switching to `loading`: a failure
      // must keep showing the last known board (REC-05), not blank the panel.
      const keptBefore = currentView()
      const capabilitiesBefore = currentCapabilities()
      setState({ read: { kind: 'loading', projectId: requested }, busy: { kind: 'read' } })
      const result: BoardReadResult = await source.readBoard()

      // Late-response guard: a response for another project is dropped, so a
      // switch cannot be shown under the wrong name (F01-R01).
      if (!result.ok) {
        setState({ busy: null })
        if (result.code === 'unknown-project') {
          setState({
            read: { kind: 'unknown-project', projectId: requested ?? '', message: result.message.length > 0 ? result.message : UNKNOWN_PROJECT_MESSAGE },
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

      if (requested !== null && result.snapshot.project.projectId !== requested) {
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
      // Clearing the view first is deliberate: the previous project's cards must
      // never render under the new project's header.
      setState({
        selectedProjectId: projectId,
        read: { kind: 'idle' },
        openTaskId: null,
        detail: null,
        statusDialog: null,
        feedback: null,
      })
      await this.load()
    },

    toggleCancelled() {
      setState({ cancelledExpanded: !state.cancelledExpanded })
    },

    openDetail(taskId) {
      const task = taskById(taskId)
      if (task === undefined) return
      setState({ openTaskId: taskId, detail: deriveTaskDetail(task) })
    },

    closeDetail() {
      setState({ openTaskId: null, detail: null })
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
      const change: StatusChangeInput = {
        taskId: dialog.taskId,
        next: dialog.next,
        reason: dialog.reason,
        operationId: mintOperationId(),
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
      if (feedback === null || feedback.kind !== 'failure' || feedback.retry === null) return
      const retry = feedback.retry
      switch (retry.kind) {
        case 'read':
          void this.load()
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
      const undo: UndoInput = { taskId: feedback.undo.taskId, operationId: feedback.undo.operationId }
      setState({ feedback: null })
      void runWrite('undo', undo.taskId, { kind: 'undo', input: undo }, () => source.undoStatusChange(undo))
    },
  }
}

/** The label to render for one task's status, using the data layer's own label. */
export function labelFor(task: BoardTask): string {
  return statusLabelOf(task)
}

/** Re-export for consumers that only import the controller. */
export type { BoardSnapshot, BoardSource } from './source.js'
