/**
 * F02 view model — pure presentation mapping from board data to what the UI may
 * show.
 *
 * ## One vocabulary, owned by `@aikanban/core`
 *
 * This module deliberately declares **no status enum, no labels and no column
 * table**. Core owns those (`TASK_STATUSES` / `TASK_STATUS_LABELS` /
 * `BOARD_COLUMNS`) and they travel over the wire: every task arrives with its
 * `status` id and its `statusLabel`, and every board arrives with its columns
 * (id, label, `collapsedByDefault`) in render order. The panel renders what it
 * is given instead of recomputing it, so a status renamed or added in core shows
 * up here without a second edit — and cannot drift.
 *
 * The only status ids this file recognises are the two the *product rules*
 * attach to a UI behaviour: entering `blocked` needs a reason (F02-R02), and
 * `done`/`cancelled` can be re-opened (F02-R03). Both lists are asserted against
 * core's vocabulary by a test in `packages/plugin` (which legitimately depends
 * on core), so an id change fails there rather than silently disabling a rule.
 *
 * ## The rule that shapes the types
 *
 * F02-R05 / OBJ-08: a card shows the title plus **one line of the official
 * summary's overall progress** (`summaryProgress.line`), falling back to the
 * task goal when there is no summary. A summary *draft*, or "the last
 * conversation record", must never impersonate overall progress. The enforcement
 * is structural: {@link BoardTask} has a field for the official summary and a
 * field for the goal, and none for a draft or for "the last record".
 *
 * @module @aikanban/plugin-client/model
 */

/* ------------------------------------------------------------------ *
 * Status ids the product rules bind to (asserted against core in tests)
 * ------------------------------------------------------------------ */

/**
 * A status identifier. Opaque to this half: core owns the vocabulary and the
 * labels travel with the data, so the panel never maps an id to a display string
 * on its own.
 */
export type StatusId = string

/** The status whose entry requires a non-blank reason (F02-R02). */
export const BLOCKED_STATUS_ID = 'blocked'

/** The status whose column starts collapsed when the data layer sends no column table (F02 §3.2). */
export const COLLAPSED_BY_DEFAULT_STATUS_ID = 'cancelled'

/** The statuses that carry 重新打开 (F02-R03). */
export const REOPENABLE_STATUS_IDS: readonly string[] = ['done', 'cancelled']

/**
 * Whether a status id may be re-opened.
 *
 * @param statusId - the status id from the data layer.
 * @returns whether a "重新打开" entry point applies.
 */
export function isReopenable(statusId: string): boolean {
  return REOPENABLE_STATUS_IDS.includes(statusId)
}

/* ------------------------------------------------------------------ *
 * Blocked reason (F02-R02)
 * ------------------------------------------------------------------ */

/** Message shown when the reason is missing or blank. Text, not colour (REC-09). */
export const BLOCKED_REASON_REQUIRED_MESSAGE = '进入「已阻塞」必须填写原因，否则状态不变。'

/** Same rule on the confirm path: the formal state stays where it was. */
export const BLOCKED_REASON_KEEPS_STATUS_MESSAGE = '原因无效：仍停留在原状态，已填内容已保留。'

/**
 * Normalise a reason for validation. Whitespace-only is not a reason.
 *
 * @param reason - raw input.
 * @returns the trimmed reason ('' when absent).
 */
export function normalizeReason(reason: string | null | undefined): string {
  return (reason ?? '').trim()
}

/**
 * Whether a reason satisfies the "required when entering blocked" rule.
 *
 * @param reason - raw input.
 * @returns true when a non-blank reason was provided.
 */
export function isBlockedReasonValid(reason: string | null | undefined): boolean {
  return normalizeReason(reason).length > 0
}

/**
 * Collapse whitespace so a multi-line body still occupies one card line.
 *
 * @param text - any text.
 * @returns the same text with runs of whitespace collapsed to single spaces.
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * Board data as the data layer supplies it
 * ------------------------------------------------------------------ */

/** The official summary's progress line (core: `TaskProgressView`). */
export interface TaskProgressView {
  readonly line: string
  readonly versionId: string
  readonly confirmedAt: string
}

/**
 * The data layer's undo credential for one task (core: `TaskView.undoTarget`).
 *
 * `statusVersion` is the formal status's version and `appliedUpdateId` is the
 * `requestId` of the write that produced it. Both are needed to undo after a
 * refresh; neither may be synthesised by the UI (F02-R04, REC-01).
 */
export interface BoardUndoTarget {
  readonly statusVersion: string
  readonly appliedUpdateId: string
}

/**
 * A task as the board renders it — the subset of core's `TaskView` the panel
 * needs, and nothing else. `status` is an opaque id and `statusLabel` is the
 * display string core supplied; the client never maps ids to labels itself.
 */
export interface BoardTask {
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  /** F01 field: the task goal. Used on the card only when there is no summary. */
  readonly goal: string
  /** Opaque status id from core (e.g. `todo`); never interpreted beyond the two rules above. */
  readonly status: string
  /** Display label from core; falls back to the raw id when absent. */
  readonly statusLabel?: string | null
  readonly blockedReason?: string | null
  /** Visibility attribute (F17 owns archive). S1 is always `false`. */
  readonly archived?: boolean
  /** Manual order inside its column; the data layer has already sorted by it. */
  readonly order: number
  readonly fieldsRevision?: number
  /**
   * Version of this task's formal status. Required: it is the write baseline
   * (SAVE-05) every status change/reorder/undo carries, so a missing value is a
   * contract violation rather than "version 0".
   */
  readonly statusRevision: number
  /**
   * What the data layer would undo for this task, or `null` when there is
   * nothing to undo. Required so "no undo" is an explicit answer, not a missing
   * field that the UI might fill in.
   */
  readonly undoTarget: BoardUndoTarget | null
  /** The official summary line, or `null` ⇒ the card uses `goal`. */
  readonly summaryProgress?: TaskProgressView | null
  readonly hasSummary?: boolean
  readonly hasRecord?: boolean
  /** SAVE-04: the summary needs re-checking; shown as text on the card. */
  readonly needsRecheck?: boolean
  /** Machine-readable re-check reasons (`goal-changed`, `draft-stale`, …). */
  readonly recheckCodes?: readonly string[]
  /** Data-layer supplied, real-only hints (F02-R06). Empty in S1. */
  readonly hints?: readonly BoardActionHint[]
}

/**
 * A data-layer supplied action hint.
 *
 * The UI never synthesises one: S1 has no conversations, records or outcomes, so
 * a hint that would need that data ("待确认记录", "对话运行中", "待生成项目记录")
 * must not appear at all. When `hints` is empty the hint area is empty.
 */
export interface BoardActionHint {
  readonly kind: 'attention' | 'info'
  /** The exact text to display. Already user-facing; the UI adds no adjective. */
  readonly text: string
}

/** Work-scope availability (F01): its own visible state, never "no scope". */
export type WorkScopeAvailability = 'ok' | 'missing-dir' | 'unknown'

/** Project as the board header needs it. The key is the workspace id, never the title. */
export interface BoardProjectView {
  readonly projectId: string
  readonly title: string
  readonly path?: string
  readonly workScopeAvailability: WorkScopeAvailability
  /** False only when a real filesystem action would be refused (F01). */
  readonly workScopeAllowed: boolean
  readonly workScopeReason?: string | null
}

/**
 * What the connected data layer can actually do. The panel renders an entry
 * point only when its capability is `true`, so a not-yet-bound flow shows an
 * explicit note instead of a control that always fails.
 */
export interface BoardCapabilities {
  readonly statusChange: boolean
  readonly reorder: boolean
  readonly undo: boolean
}

/** An empty capability set, used before the data layer has reported one. */
export const NO_CAPABILITIES: BoardCapabilities = { statusChange: false, reorder: false, undo: false }

/* ------------------------------------------------------------------ *
 * Card progress (F02-R05)
 * ------------------------------------------------------------------ */

/** Where a card's progress line came from. */
export type CardProgressSource = 'summary' | 'goal' | 'none'

/** The card's one-line progress plus its provenance. */
export interface CardProgress {
  readonly source: CardProgressSource
  /** Already single-line; empty only when `source === 'none'`. */
  readonly text: string
  /** Extra explanation; never a substitute for content. */
  readonly note?: string
}

/** Shown when neither a summary nor a goal exists. */
export const NO_SUMMARY_NO_GOAL_TEXT = '暂无任务概况（也没有任务目标）'

/** Shown when the official summary needs re-checking (SAVE-04). */
export const SUMMARY_RECHECK_NOTE = '概况待核对：请核对概况适用范围。'

/**
 * Derive the card's progress line (F02-R05, OBJ-08).
 *
 * Order is fixed and not configurable:
 * 1. the official summary's progress line, when present and non-blank;
 * 2. otherwise the task goal;
 * 3. otherwise an explicit "none" text.
 *
 * A summary draft or a "last record" is never consulted: neither exists in this
 * model, which is what makes the rule enforceable rather than merely intended.
 *
 * @param task - the data layer's task.
 * @returns the progress line and its provenance.
 */
export function deriveCardProgress(task: BoardTask): CardProgress {
  const line = toSingleLine(task.summaryProgress?.line ?? '')
  if (line.length > 0) {
    return task.needsRecheck === true
      ? { source: 'summary', text: line, note: SUMMARY_RECHECK_NOTE }
      : { source: 'summary', text: line }
  }
  const goal = toSingleLine(task.goal)
  if (goal.length > 0) {
    return { source: 'goal', text: goal, note: '尚未保存任务概况，显示任务目标。' }
  }
  return { source: 'none', text: NO_SUMMARY_NO_GOAL_TEXT }
}

/* ------------------------------------------------------------------ *
 * Columns
 * ------------------------------------------------------------------ */

/** One rendered column, exactly as the data layer declared it. */
export interface BoardColumnView {
  readonly status: string
  readonly label: string
  readonly collapsedByDefault: boolean
  /** Sorted by `order`, ascending and stable. */
  readonly tasks: readonly BoardTask[]
}

/** A column as it arrives on the wire. */
export interface BoardColumnInput {
  readonly status: string
  readonly label?: string
  readonly collapsedByDefault?: boolean
  readonly tasks?: readonly BoardTask[]
}

/** The board as the panel renders it. */
export interface BoardView {
  readonly project: BoardProjectView
  /** Columns in the data layer's order; `cancelled` arrives collapsed by default. */
  readonly columns: readonly BoardColumnView[]
  readonly capabilities: BoardCapabilities
  /** Change token from the data layer; a late response is dropped by comparing it. */
  readonly boardToken: string
}

/** A board read that succeeded, with the data layer's columns when it sent them. */
export interface BoardReadData {
  readonly project: BoardProjectView
  readonly tasks: readonly BoardTask[]
  readonly columns?: readonly BoardColumnInput[]
  readonly capabilities?: BoardCapabilities
  readonly boardToken?: string
}

/**
 * Sort a column's tasks by manual order.
 *
 * `Array.prototype.sort` is stable (ES2019+), and equal orders keep the data
 * layer's sequence, so a partially-ordered read cannot reshuffle the board.
 *
 * @param tasks - tasks of one column.
 * @returns a sorted copy.
 */
export function sortByOrder(tasks: readonly BoardTask[]): BoardTask[] {
  return [...tasks].sort((a, b) => a.order - b.order)
}

/**
 * Build the renderable columns.
 *
 * The data layer's `columns` are used verbatim (order, label and
 * `collapsedByDefault` all come from core). When a read carries no columns — a
 * leaner host — the tasks are grouped by status id in first-seen order, with the
 * raw id as the label, so the panel still renders what it actually has instead
 * of inventing a table.
 *
 * @param data - a board read.
 * @returns the renderable board.
 */
export function buildBoardView(data: BoardReadData): BoardView {
  const columns: BoardColumnView[] = []

  if (data.columns !== undefined && data.columns.length > 0) {
    for (const column of data.columns) {
      const tasks = column.tasks ?? data.tasks.filter((task) => task.status === column.status)
      columns.push({
        status: column.status,
        label: column.label !== undefined && column.label.length > 0 ? column.label : column.status,
        collapsedByDefault: column.collapsedByDefault === true,
        tasks: sortByOrder(tasks),
      })
    }
  } else {
    const byStatus = new Map<string, BoardTask[]>()
    for (const task of data.tasks) {
      const bucket = byStatus.get(task.status)
      if (bucket === undefined) byStatus.set(task.status, [task])
      else bucket.push(task)
    }
    for (const [status, tasks] of byStatus) {
      columns.push({
        status,
        label: tasks[0]?.statusLabel ?? status,
        collapsedByDefault: status === COLLAPSED_BY_DEFAULT_STATUS_ID,
        tasks: sortByOrder(tasks),
      })
    }
  }

  return {
    project: data.project,
    columns,
    capabilities: data.capabilities ?? NO_CAPABILITIES,
    boardToken: data.boardToken ?? '',
  }
}

/**
 * The label to render for a status on a card.
 *
 * @param task - the task.
 * @returns the data layer's label, or the raw id when it supplied none.
 */
export function statusLabelOf(task: BoardTask): string {
  const label = task.statusLabel
  return typeof label === 'string' && label.length > 0 ? label : task.status
}

/* ------------------------------------------------------------------ *
 * Detail skeleton (F02-R07)
 * ------------------------------------------------------------------ */

/**
 * A follow-up area this milestone does not implement. It carries the feature id
 * so the placeholder names what is missing instead of looking like a working
 * entry point.
 */
export interface DetailPlaceholder {
  readonly feature: 'F04' | 'F06' | 'F13'
  readonly label: string
  readonly state: 'not-implemented'
  /** Why it is absent, in user-facing words. */
  readonly reason: string
}

/** The detail view's data. */
export interface TaskDetailView {
  readonly taskId: string
  readonly title: string
  /** F01 field, shown independently of the summary (F03-R03). */
  readonly goal: string | null
  readonly status: string
  readonly statusLabel: string
  readonly blockedReason: string | null
  readonly summaryProgress: TaskProgressView | null
  readonly progress: CardProgress
  readonly needsRecheck: boolean
  /** Whether the data layer supplied an undo credential for this task (F02-R04). */
  readonly undoAvailable: boolean
  readonly hints: readonly BoardActionHint[]
  readonly placeholders: readonly DetailPlaceholder[]
}

/** Placeholders are fixed, honest, and never clickable. */
export const DETAIL_PLACEHOLDERS: readonly DetailPlaceholder[] = [
  { feature: 'F04', label: '任务对话', state: 'not-implemented', reason: 'S1 未交付（F04 阶段实现）' },
  { feature: 'F06', label: '任务记录', state: 'not-implemented', reason: 'S1 未交付（F06 阶段实现）' },
  { feature: 'F13', label: '项目成果', state: 'not-implemented', reason: 'S1 未交付（F13 阶段实现）' },
]

/**
 * Derive the detail skeleton for one task.
 *
 * @param task - the data layer's task.
 * @returns the detail view; empty values render as 「暂无」, never as fabricated content.
 */
export function deriveTaskDetail(task: BoardTask): TaskDetailView {
  const goal = toSingleLine(task.goal)
  const blockedReason = toSingleLine(task.blockedReason ?? '')
  return {
    taskId: task.taskId,
    title: task.title,
    goal: goal.length > 0 ? goal : null,
    status: task.status,
    statusLabel: statusLabelOf(task),
    blockedReason: task.status === BLOCKED_STATUS_ID && blockedReason.length > 0 ? blockedReason : null,
    summaryProgress: task.summaryProgress ?? null,
    progress: deriveCardProgress(task),
    needsRecheck: task.needsRecheck === true,
    // Undo is offered only when the data layer's snapshot says there is
    // something to undo; the UI never infers it from "a change just happened".
    undoAvailable: task.undoTarget !== null,
    hints: task.hints ?? [],
    placeholders: DETAIL_PLACEHOLDERS,
  }
}
