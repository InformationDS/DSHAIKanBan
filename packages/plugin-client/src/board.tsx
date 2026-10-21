/**
 * The F02 board panel.
 *
 * ## Rendering rules that are not cosmetic
 *
 * - **Status and risk are text, always.** A card carries its status label and,
 *   when blocked, the reason; colour is decoration on top, never the message
 *   (REC-09).
 * - **The cancelled column is collapsed, not hidden or archived** (F02 §3.2).
 *   Its header is a real button with `aria-expanded`, so keyboard users reach it.
 * - **Status entry points exist twice and mean the same thing** (F02-R02): a
 *   native `<select>` (fully keyboard-operable, no custom key handling) and drag
 *   and drop. Both call `menuSelectStatus` / `dropTask` on the controller, which
 *   is where the guard and the single write path live.
 * - **A failure never looks like a success.** The failure banner carries the
 *   text, the code and a retry button; the success banner is a different shape
 *   and only appears when the data layer said so.
 * - **Follow-up areas are labelled placeholders.** Conversations, records and
 *   outcomes are rendered as `aria-disabled` rows naming the missing feature —
 *   never as working buttons, and never with fabricated content.
 * - **Capability gating.** When the data layer reports that it cannot serve a
 *   flow, the control is not rendered at all; a note explains why.
 *
 * Only `createElement` is used (no JSX) because the built bundle is executed
 * against the shell's frozen React module table, and the loader-protocol test
 * materializes it with a minimal React stand-in.
 *
 * @module @aikanban/plugin-client/board
 */

import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

import {
  deriveCardProgress,
  statusLabelOf,
  type BoardTask,
  type BoardView,
  type TaskDetailView,
} from './model.js'
import type { BoardController, BoardState, StatusDialogState } from './controller.js'
import { SELECTION_REQUIRED_TITLE } from './controller.js'
import { getBoardController } from './runtime.js'
import { NO_CHANNEL_MESSAGE } from './source.js'

/** Shared inline style for a card. */
const CARD_STYLE = {
  border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))',
  borderRadius: '6px',
  padding: '8px 10px',
  marginBottom: '8px',
  background: 'var(--dsw-alias-bg-elevated, transparent)',
} as const

/** Shared inline style for a column. */
const COLUMN_STYLE = {
  flex: '1 1 0',
  minWidth: '180px',
  padding: '8px',
  border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.2))',
  borderRadius: '8px',
} as const

/** Shared inline style for secondary text. */
const MUTED = {
  fontSize: '11px',
  color: 'var(--dsw-alias-label-secondary, inherit)',
} as const

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Everything the rendered tree can ask for. Passing them explicitly (rather than
 * closing over a controller) is what lets the tests render a state and inspect
 * the tree without a DOM.
 */
export interface BoardActions {
  onStatusSelect(taskId: string, statusId: string): void
  onDragStart(taskId: string): void
  onDrop(toStatus: string, toIndex: number): void
  onOpenDetail(taskId: string): void
  onCloseDetail(): void
  onToggleCollapsed(): void
  onRetry(): void
  onUndo(): void
  /** Undo one task's last status change, from that task's `undoTarget`. */
  onUndoTask(taskId: string): void
  onDialogReason(text: string): void
  onDialogConfirm(): void
  onDialogCancel(): void
  /** Explicitly select one candidate project (Q1=B: never automatic). */
  onSelectProject(projectId: string): void
  /** Re-read the candidate list after a failed/empty listing. */
  onLoadProjects(): void
  /** Leave the board and return to the selector; the selection is not kept. */
  onSwitchProject(): void
}

/** One status a menu may offer: the id that travels, the label that is shown. */
export interface StatusChoice {
  readonly id: string
  readonly label: string
}

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

/**
 * One card.
 *
 * @param task - the task to render.
 * @param actions - the panel's actions.
 * @param selectable - statuses offered by the menu; empty hides the control.
 * @param canUndo - whether the data layer can serve undo at all.
 * @returns the card node.
 */
function renderCard(
  task: BoardTask,
  actions: BoardActions,
  selectable: readonly StatusChoice[],
  canUndo: boolean,
): ReactNode {
  const progress = deriveCardProgress(task)
  const children: ReactNode[] = [
    createElement('div', { key: 'title', style: { fontWeight: 600 } }, task.title),
    createElement('div', { key: 'status', style: MUTED }, `状态：${statusLabelOf(task)}`),
    createElement('div', { key: 'progress', style: { fontSize: '12px', marginTop: '2px' } }, progress.text),
  ]

  if (progress.note !== undefined) {
    children.push(createElement('div', { key: 'progress-note', style: MUTED }, progress.note))
  }
  if (task.status === 'blocked' && (task.blockedReason ?? '').trim().length > 0) {
    children.push(createElement('div', { key: 'blocked', style: { fontSize: '12px', marginTop: '2px' } }, `阻塞原因：${task.blockedReason}`))
  }
  for (const [index, hint] of (task.hints ?? []).entries()) {
    children.push(createElement('div', { key: `hint-${String(index)}`, style: { fontSize: '12px', marginTop: '2px' } }, hint.text))
  }

  if (selectable.length > 0) {
    children.push(createElement(
      'label',
      { key: 'status-control', style: { display: 'block', marginTop: '6px', fontSize: '11px' } },
      '修改状态（键盘可用）',
      createElement(
        'select',
        {
          'aria-label': `修改任务状态：${task.title}`,
          'data-aikanban-status-select': task.taskId,
          value: task.status,
          onChange: (event: { target: { value: string } }) => { actions.onStatusSelect(task.taskId, event.target.value) },
        },
        selectable.map((choice) => createElement('option', { key: choice.id, value: choice.id }, choice.label)),
      ),
    ))
  }

  // Undo is offered only when the data layer's snapshot carries a credential
  // (`undoTarget !== null`): this is what makes undo work after a refresh, and
  // it never appears just because "a change happened".
  if (canUndo && task.undoTarget !== null) {
    children.push(createElement(
      'button',
      {
        key: 'undo-task',
        type: 'button',
        'data-aikanban-undo-task': task.taskId,
        onClick: () => { actions.onUndoTask(task.taskId) },
        style: { marginTop: '6px' },
      },
      '撤销该状态修改',
    ))
  }

  children.push(createElement(
    'button',
    {
      key: 'detail',
      type: 'button',
      'data-aikanban-open-detail': task.taskId,
      onClick: () => { actions.onOpenDetail(task.taskId) },
    },
    '查看详情',
  ))

  return createElement(
    'div',
    {
      key: task.taskId,
      'data-aikanban-card': task.taskId,
      role: 'listitem',
      tabIndex: 0,
      draggable: true,
      style: CARD_STYLE,
      onDragStart: () => { actions.onDragStart(task.taskId) },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') actions.onOpenDetail(task.taskId)
      },
    },
    children,
  )
}

/**
 * One column.
 *
 * @param column - the rendered column.
 * @param actions - the panel's actions.
 * @param selectable - statuses offered by the card menus.
 * @param collapsed - whether the column body is collapsed.
 * @param onToggle - called by the header button.
 * @param canUndo - whether the data layer can serve undo at all.
 * @returns the column node.
 */
function renderColumn(
  column: BoardView['columns'][number],
  actions: BoardActions,
  selectable: readonly StatusChoice[],
  collapsed: boolean,
  onToggle: () => void,
  canUndo: boolean,
): ReactNode {
  const header = createElement(
    'div',
    { key: 'header', style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
    createElement('span', { style: { fontWeight: 600, fontSize: '12px' } }, `${column.label}`),
    createElement('span', { style: MUTED }, `${String(column.tasks.length)} 项`),
    column.collapsedByDefault
      ? createElement(
        'button',
        {
          key: 'toggle',
          type: 'button',
          'data-aikanban-toggle': column.status,
          'aria-expanded': !collapsed,
          onClick: onToggle,
          style: { fontSize: '11px' },
        },
        collapsed ? '展开' : '收起',
      )
      : null,
  )

  const body = collapsed
    ? createElement('div', { key: 'body', style: MUTED }, `已收起（${String(column.tasks.length)} 项，状态为「${column.label}」的任务仍在看板中）`)
    : createElement(
      'div',
      {
        key: 'body',
        'data-aikanban-column-body': column.status,
        role: 'list',
        onDragOver: (event: { preventDefault?: () => void }) => { event.preventDefault?.() },
        onDrop: () => { actions.onDrop(column.status, column.tasks.length) },
      },
      column.tasks.map((task) => renderCard(task, actions, selectable, canUndo)),
    )

  return createElement(
    'section',
    { key: column.status, 'data-aikanban-column': column.status, style: COLUMN_STYLE, 'aria-label': column.label },
    header,
    body,
  )
}

/**
 * The blocked-reason dialog (F02-R02).
 *
 * @param dialog - the dialog state.
 * @param actions - the panel's actions.
 * @returns the dialog node.
 */
function renderStatusDialog(dialog: StatusDialogState, actions: BoardActions): ReactNode {
  return createElement(
    'div',
    {
      key: 'dialog',
      role: 'dialog',
      'aria-modal': false,
      'data-aikanban-blocked-dialog': dialog.taskId,
      style: { ...CARD_STYLE, marginTop: '10px' },
    },
    createElement('div', { key: 'title', style: { fontWeight: 600 } }, '进入「已阻塞」需要原因'),
    createElement(
      'label',
      { key: 'field', style: { display: 'block', marginTop: '6px', fontSize: '12px' } },
      '原因（必填）',
      createElement('input', {
        'aria-label': '阻塞原因',
        'data-aikanban-reason-input': dialog.taskId,
        value: dialog.reason,
        onChange: (event: { target: { value: string } }) => { actions.onDialogReason(event.target.value) },
        style: { display: 'block', width: '100%' },
      }),
    ),
    dialog.invalidReason
      ? createElement('div', { key: 'error', role: 'alert', style: { color: 'var(--dsw-alias-label-error, #c00)', fontSize: '12px' } }, '原因不能为空，状态未改变。')
      : null,
    createElement(
      'div',
      { key: 'buttons', style: { marginTop: '8px', display: 'flex', gap: '6px' } },
      createElement('button', { key: 'confirm', type: 'button', 'data-aikanban-confirm-block': dialog.taskId, onClick: actions.onDialogConfirm }, '确认进入已阻塞'),
      createElement('button', { key: 'cancel', type: 'button', 'data-aikanban-cancel-block': dialog.taskId, onClick: actions.onDialogCancel }, '取消（保持原状态）'),
    ),
  )
}

/**
 * The task detail skeleton (F02-R07).
 *
 * @param detail - the detail view.
 * @param actions - the panel's actions.
 * @param selectable - statuses offered by the menu.
 * @param status - the live status id (the detail may be a snapshot).
 * @param canUndo - whether the data layer can serve undo at all.
 * @returns the detail node.
 */
function renderDetail(
  detail: TaskDetailView,
  actions: BoardActions,
  selectable: readonly StatusChoice[],
  status: string,
  canUndo: boolean,
): ReactNode {
  return createElement(
    'section',
    { key: 'detail', 'data-aikanban-detail': detail.taskId, style: { ...CARD_STYLE, marginTop: '10px' } },
    createElement('div', { key: 'title', style: { fontWeight: 600, fontSize: '14px' } }, detail.title),
    createElement('div', { key: 'goal', style: { fontSize: '12px', marginTop: '4px' } }, `当前目标：${detail.goal ?? '暂无目标'}`),
    createElement('div', { key: 'status', style: { fontSize: '12px' } }, `手动状态：${detail.statusLabel}`),
    createElement('div', { key: 'summary', style: { fontSize: '12px' } }, `正式概况整体进展：${detail.summaryProgress?.line ?? '暂无任务概况'}`),
    detail.summaryProgress !== null
      ? createElement('div', { key: 'version', style: MUTED }, `当前版本：${detail.summaryProgress.versionId}（${detail.summaryProgress.confirmedAt}）`)
      : null,
    detail.needsRecheck
      ? createElement('div', { key: 'recheck', style: { fontSize: '12px' } }, '概况待核对：请核对概况适用范围。')
      : null,
    detail.blockedReason !== null
      ? createElement('div', { key: 'blocked', style: { fontSize: '12px' } }, `阻塞原因：${detail.blockedReason}`)
      : null,
    selectable.length > 0
      ? createElement(
        'label',
        { key: 'status-control', style: { display: 'block', marginTop: '6px', fontSize: '12px' } },
        '手动状态（键盘可用）',
        createElement(
          'select',
          {
            'aria-label': '修改任务状态',
            'data-aikanban-detail-status-select': detail.taskId,
            value: status,
            onChange: (event: { target: { value: string } }) => { actions.onStatusSelect(detail.taskId, event.target.value) },
          },
          selectable.map((choice) => createElement('option', { key: choice.id, value: choice.id }, choice.label)),
        ),
      )
      : createElement('div', { key: 'status-note', style: MUTED }, '状态修改入口尚未接入（只读呈现）。'),
    createElement(
      'div',
      { key: 'placeholders', style: { marginTop: '8px' } },
      createElement('div', { key: 'ph-title', style: { fontWeight: 600, fontSize: '12px' } }, '后续入口（尚未实现）'),
      detail.placeholders.map((entry) => createElement(
        'div',
        {
          key: entry.feature,
          'data-aikanban-placeholder': entry.feature,
          'aria-disabled': 'true',
          style: { ...MUTED, padding: '2px 0' },
        },
        `${entry.label}：${entry.reason}`,
      )),
    ),
    // Same rule as the card: the detail offers undo only when the snapshot's
    // undoTarget says there is something to undo.
    canUndo && detail.undoAvailable
      ? createElement('button', {
        key: 'undo-detail',
        type: 'button',
        'data-aikanban-undo-task': detail.taskId,
        onClick: () => { actions.onUndoTask(detail.taskId) },
        style: { marginTop: '8px' },
      }, '撤销该状态修改')
      : null,
    createElement('button', { key: 'close', type: 'button', 'data-aikanban-close-detail': detail.taskId, onClick: actions.onCloseDetail }, '返回看板'),
  )
}

/**
 * The project selector (Q1=B).
 *
 * The list is the host's candidate set, read fresh on every entry. The panel
 * must never imply a default, a most-recent, or a recommendation: there is no
 * selected/pressed/current marker on any entry, and the same constant
 * explanation is shown regardless of which projects exist. Same-title projects
 * are told apart by their path.
 *
 * @param message - the selection explanation (from the read state).
 * @param projects - the project-list state.
 * @param actions - the panel's actions.
 * @returns the selector node.
 */
function renderProjectSelector(
  message: string,
  projects: BoardState['projects'],
  actions: BoardActions,
): ReactNode {
  const children: ReactNode[] = [
    createElement('div', { key: 'title', style: { fontWeight: 600 } }, SELECTION_REQUIRED_TITLE),
    createElement('div', { key: 'description', style: { fontSize: '12px', marginTop: '4px' } }, message),
  ]

  if (projects.kind === 'idle' || projects.kind === 'loading') {
    children.push(createElement(
      'div',
      { key: 'projects-loading', 'data-aikanban-projects-loading': 'true', style: { ...MUTED, marginTop: '8px' } },
      '正在加载项目…',
    ))
  } else if (projects.kind === 'failed') {
    // REC-05: a failed listing is stated and retryable; it is never shown as an
    // empty list, and no project is selected to "help".
    children.push(createElement(
      'div',
      {
        key: 'projects-failed',
        role: 'alert',
        'data-aikanban-projects-failed': projects.code,
        style: { fontSize: '12px', marginTop: '8px' },
      },
      projects.message,
    ))
    children.push(createElement(
      'button',
      {
        key: 'projects-retry',
        type: 'button',
        'data-aikanban-projects-retry': 'true',
        onClick: actions.onLoadProjects,
        style: { marginTop: '6px' },
      },
      '重新加载项目',
    ))
  } else if (projects.projects.length === 0) {
    children.push(createElement(
      'div',
      { key: 'projects-empty', role: 'status', 'data-aikanban-projects-empty': 'true', style: { fontSize: '12px', marginTop: '8px' } },
      '没有可用项目。',
    ))
    children.push(createElement(
      'button',
      {
        key: 'projects-refresh',
        type: 'button',
        'data-aikanban-projects-refresh': 'true',
        onClick: actions.onLoadProjects,
        style: { marginTop: '6px' },
      },
      '刷新项目列表',
    ))
  } else {
    children.push(createElement(
      'div',
      {
        key: 'projects',
        role: 'list',
        'data-aikanban-project-list': 'true',
        style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' },
      },
      projects.projects.map((project) => createElement(
        'div',
        { key: project.projectId, role: 'listitem' },
        createElement(
          'button',
          {
            type: 'button',
            'data-aikanban-project': project.projectId,
            // The accessible name carries id/title/path; no "default"/"recent"
            // wording is allowed here (Q1=B).
            'aria-label': `选择项目：${project.title}（${project.path.length > 0 ? project.path : '路径未提供'}）`,
            onClick: () => { actions.onSelectProject(project.projectId) },
            style: { textAlign: 'left' },
          },
          createElement('span', { style: { fontWeight: 600 } }, project.title),
          createElement('span', { style: MUTED }, `（${project.path.length > 0 ? project.path : '路径未提供'}）`),
        ),
      )),
    ))
  }

  return createElement(
    'section',
    {
      key: 'selection-required',
      role: 'status',
      'data-aikanban-selection-required': 'true',
      style: { ...CARD_STYLE, marginTop: '8px' },
    },
    children,
  )
}

/**
 * The feedback banner (REC-01).
 *
 * @param state - the current panel state.
 * @param actions - the panel's actions.
 * @returns the banner node, or null when there is nothing to say.
 */
function renderFeedback(state: BoardState, actions: BoardActions): ReactNode {
  const feedback = state.feedback
  if (feedback === null) return null

  if (feedback.kind === 'success') {
    return createElement(
      'div',
      { key: 'feedback', role: 'status', 'data-aikanban-feedback': 'success', style: { ...CARD_STYLE } },
      createElement('span', { key: 'text' }, feedback.text),
      feedback.undo !== undefined
        ? createElement('button', { key: 'undo', type: 'button', 'data-aikanban-undo': feedback.undo.taskId, onClick: actions.onUndo, style: { marginLeft: '8px' } }, '撤销')
        : null,
    )
  }

  if (feedback.kind === 'undo-blocked') {
    return createElement(
      'div',
      { key: 'feedback', role: 'status', 'data-aikanban-feedback': 'undo-blocked', style: CARD_STYLE },
      feedback.text,
    )
  }

  if (feedback.kind === 'failure') {
    // F9/F10: when the only allowed retry is a re-read (unknown write result or
    // a read-after-write failure), say exactly that instead of the generic
    // 「重试」, which could read as "resubmit the write".
    const retryLabel = feedback.retry?.kind === 'read' ? '重新读取' : '重试'
    return createElement(
      'div',
      { key: 'feedback', role: 'status', 'data-aikanban-feedback': 'failure', style: CARD_STYLE },
      createElement('span', { key: 'text' }, feedback.text),
      feedback.retry !== null
        ? createElement('button', { key: 'retry', type: 'button', 'data-aikanban-retry': feedback.code, onClick: actions.onRetry, style: { marginLeft: '8px' } }, retryLabel)
        : null,
    )
  }

  return createElement(
    'div',
    { key: 'feedback', role: 'status', 'data-aikanban-feedback': feedback.kind, style: CARD_STYLE },
    feedback.text,
  )
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/**
 * Render the whole panel from a state. Pure: no hooks, no controller — which is
 * what makes the tree assertable in tests without a DOM.
 *
 * @param state - the controller state.
 * @param actions - the panel's actions.
 * @returns the panel node.
 */
export function renderBoard(state: BoardState, actions: BoardActions): ReactNode {
  const children: ReactNode[] = []
  const transportUnavailable = state.transport.kind === 'unavailable'

  children.push(createElement(
    'header',
    { key: 'header', style: { marginBottom: '8px' } },
    createElement('div', { key: 'brand', style: { fontSize: '15px', fontWeight: 600 } }, 'AIKanBan'),
    createElement('div', { key: 'transport', style: MUTED, 'data-aikanban-transport': state.transport.kind }, `数据通道：${state.transport.detail}`),
  ))

  if (transportUnavailable) {
    children.push(createElement(
      'div',
      { key: 'no-channel', role: 'status', 'data-aikanban-feedback': 'unavailable', style: CARD_STYLE },
      NO_CHANNEL_MESSAGE,
    ))
  }

  // Q1=B: a selection may be revisited but is never persisted. The entry point
  // is only rendered once a project was explicitly chosen in this panel session.
  if (state.selectedProjectId !== null) {
    children.push(createElement(
      'button',
      {
        key: 'switch-project',
        type: 'button',
        'data-aikanban-switch-project': 'true',
        onClick: actions.onSwitchProject,
        style: { marginBottom: '8px' },
      },
      '切换项目',
    ))
  }

  const read = state.read
  if (read.kind === 'loading') {
    children.push(createElement('div', { key: 'loading', style: MUTED }, '正在读取看板…'))
  }
  if (read.kind === 'selection-required') {
    // Q1=B: the explicit selection screen. The candidate set is read fresh and
    // the panel must never imply a default/recent/first project.
    children.push(renderProjectSelector(read.message, state.projects, actions))
  }
  if (read.kind === 'unknown-project') {
    children.push(createElement(
      'div',
      { key: 'unknown-project', role: 'status', 'data-aikanban-feedback': 'unknown-project', style: CARD_STYLE },
      read.message,
    ))
  }
  if (read.kind === 'failed') {
    children.push(createElement(
      'div',
      { key: 'read-failed', role: 'status', 'data-aikanban-feedback': 'failure', style: CARD_STYLE },
      read.message,
    ))
  }

  const view = read.kind === 'ready' ? read.view : read.kind === 'failed' ? read.kept : null
  if (view !== null) {
    const selectable: StatusChoice[] = view.capabilities.statusChange
      ? view.columns.map((column) => ({ id: column.status, label: column.label }))
      : []
    const canUndo = view.capabilities.undo

    children.push(createElement(
      'div',
      { key: 'project', style: { fontSize: '12px', marginBottom: '6px' } },
      `项目：${view.project.title}`,
      createElement('span', { key: 'id', style: MUTED }, `（${view.project.projectId}）`),
      view.project.workScopeAvailability === 'ok'
        ? null
        : createElement('div', { key: 'scope', 'data-aikanban-workscope': view.project.workScopeAvailability, style: { fontSize: '12px' } },
          view.project.workScopeAvailability === 'missing-dir'
            ? '工作范围不可用（目录不存在）：管理数据仍可读写，真实文件动作会被拒绝。'
            : '工作范围尚未观测：不视为无范围。'),
    ))

    children.push(createElement(
      'div',
      { key: 'columns', style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
      view.columns.map((column) => renderColumn(
        column,
        actions,
        selectable,
        column.collapsedByDefault && !state.cancelledExpanded,
        actions.onToggleCollapsed,
        canUndo,
      )),
    ))
  }

  if (state.statusDialog !== null) children.push(renderStatusDialog(state.statusDialog, actions))
  if (state.detail !== null) {
    const selectable: StatusChoice[] = view?.capabilities.statusChange === true
      ? view.columns.map((column) => ({ id: column.status, label: column.label }))
      : []
    children.push(renderDetail(state.detail, actions, selectable, state.detail.status, view?.capabilities.undo === true))
  }
  // On the selection screen the selector renders the (only possible) listing
  // failure and its retry inline; echoing it in a second banner would duplicate
  // the same sentence and action.
  if (read.kind !== 'selection-required') children.push(renderFeedback(state, actions))

  return createElement('div', { 'data-aikanban-panel': 'aikanban', style: { padding: '12px 16px', fontSize: '13px', lineHeight: 1.6 } }, children)
}

/**
 * The panel bound to a controller: the only part that uses hooks.
 *
 * @param props - `controller` is injected by {@link boardPanel}; tests render
 *   {@link renderBoard} directly instead.
 * @returns the panel node.
 */
export function BoardPanel(props: { readonly controller: BoardController }): ReactNode {
  const { controller } = props
  const state = useSyncExternalStore(
    useMemo(() => (listener: () => void) => controller.subscribe(listener), [controller]),
    () => controller.getState(),
  )
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)

  // Q1=B: every mount resets to the explicit selection state and re-reads the
  // candidate list. A cached controller must not carry the previous project,
  // view or dialog into this entry, and nothing is read until a project is
  // explicitly selected. The list is fetched fresh, never from a cache.
  useEffect(() => {
    controller.resetSelection()
    void controller.loadProjects()
  }, [controller])

  const actions: BoardActions = {
    onStatusSelect: (taskId, statusId) => { controller.menuSelectStatus(taskId, statusId) },
    onDragStart: (taskId) => { setDraggedTaskId(taskId) },
    onDrop: (toStatus, toIndex) => {
      if (draggedTaskId === null) return
      // Drag and menu share the controller's single guard and write path.
      controller.dropTask({ taskId: draggedTaskId, toStatus, toIndex })
      setDraggedTaskId(null)
    },
    onOpenDetail: (taskId) => { controller.openDetail(taskId) },
    onCloseDetail: () => { controller.closeDetail() },
    onToggleCollapsed: () => { controller.toggleCancelled() },
    onRetry: () => { controller.retryPending() },
    onUndo: () => { controller.undoLastChange() },
    onUndoTask: (taskId) => { controller.undoTaskChange(taskId) },
    onDialogReason: (text) => { controller.setDialogReason(text) },
    onDialogConfirm: () => { controller.confirmStatusDialog() },
    onDialogCancel: () => { controller.cancelStatusDialog() },
    onSelectProject: (projectId) => { void controller.selectProject(projectId) },
    onLoadProjects: () => { void controller.loadProjects() },
    onSwitchProject: () => {
      // Back to the selector: the selection is dropped, not remembered, and the
      // candidate list is fetched again (Q1=B).
      controller.resetSelection()
      void controller.loadProjects()
    },
  }
  return renderBoard(state, actions)
}

/**
 * The zero-argument slot component the seat registry mounts.
 *
 * It performs no hook call itself — it only builds the element — so the
 * loader-protocol test can invoke it against a minimal React stand-in, and the
 * real shell renders {@link BoardPanel} as a proper function component.
 *
 * @returns the panel element.
 */
export function boardPanel(): ReactNode {
  return createElement(BoardPanel, { controller: getBoardController() })
}
