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

import type { BoardFailureCode } from './source.js'
import type {
  SummaryBaselineWire,
  SummaryConclusionWire,
  SummaryContentValue,
  SummaryContentWire,
  SummaryViewValue,
  SummaryVersionValue,
} from './wire.js'

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
 * One selectable project (Q1=B).
 *
 * Deliberately only `projectId`/`title`/`path`: there is no field for
 * "current", "default" or "last used", so the selection UI cannot claim one.
 * `projectId` is the workspace id `readBoard` accepts; `path` disambiguates
 * projects that share a title.
 */
export interface BoardProjectChoice {
  readonly projectId: string
  /** Display title; the host falls back to the id when the workspace has none. */
  readonly title: string
  /** Workspace directory; may be empty when the host has none. */
  readonly path: string
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

/* ------------------------------------------------------------------ *
 * Management drafts (slice B): creation and field edit
 * ------------------------------------------------------------------ */

/** Why a creation cannot be submitted (F01-R02: a title is the one required field). */
export const TASK_TITLE_REQUIRED_MESSAGE = '任务标题不能为空（只有空白字符同样无效）。'

/** The same rule on the field-edit path: the title stays required (F01-R05). */
export const FIELD_TITLE_REQUIRED_MESSAGE = '任务标题不能为空（只有空白字符同样无效）。'

/** Shown when a field save would change nothing; no write is sent. */
export const NO_FIELD_CHANGE_MESSAGE = '没有需要保存的修改。'

/**
 * Shown when the task carries no `fieldsRevision`, so no SAVE-05 field baseline
 * exists. The editor must refuse locally instead of inventing a baseline.
 */
export const FIELDS_BASELINE_MISSING_MESSAGE = '无法编辑：任务缺少字段版本基线，请重新读取看板后再试。'

/** A field save the data layer reported as already applied (idempotent replay). */
export const FIELDS_ALREADY_APPLIED_TEXT = '该修改已生效（重复提交已识别）。'

/** A field save the data layer reported as changing nothing. */
export const FIELDS_NO_CHANGE_TEXT = '未做修改：数据层报告内容没有变化。'

/**
 * One creation draft: exactly the fields the form owns.
 *
 * `initialStatus` is one of the board's column ids (or `''` when the data layer
 * sent no columns, in which case the creation omits it and core applies its
 * default). The draft deliberately has no "request id": identity belongs to the
 * controller, which mints it once per intent (REC-02) — a draft object is data,
 * not an operation.
 */
export interface CreateDraft {
  readonly title: string
  readonly goal: string
  readonly initialStatus: string
  readonly blockedReason: string
}

/**
 * Validate a creation draft before any request is sent (F01-R02).
 *
 * The blocked-reason rule is the product rule, not a data-layer fallback: a
 * blank reason for the blocked column performs no write and keeps the typing.
 *
 * @param draft - the typed values.
 * @returns the first user-facing error, or `null` when the draft may be sent.
 */
export function validateCreateDraft(draft: CreateDraft): string | null {
  if (normalizeReason(draft.title).length === 0) return TASK_TITLE_REQUIRED_MESSAGE
  if (draft.initialStatus === BLOCKED_STATUS_ID && !isBlockedReasonValid(draft.blockedReason)) {
    return BLOCKED_REASON_REQUIRED_MESSAGE
  }
  return null
}

/**
 * Validate a field-edit draft before any request is sent (F01-R05).
 *
 * @param draft - the typed values.
 * @returns the user-facing error, or `null` when the draft may be sent.
 */
export function validateFieldDraft(draft: { readonly title: string }): string | null {
  return normalizeReason(draft.title).length === 0 ? FIELD_TITLE_REQUIRED_MESSAGE : null
}

/**
 * The status ids a creation may target, in the data layer's column order.
 *
 * @param view - the board on screen.
 * @returns the column choices; empty when the read carried no columns.
 */
export function creationStatusChoices(view: BoardView): readonly { readonly id: string; readonly label: string }[] {
  return view.columns.map((column) => ({ id: column.status, label: column.label }))
}

/**
 * The creation form's default initial status: the first column the data layer
 * declared (its own first status, usually `todo`), never an invented id.
 *
 * @param view - the board on screen.
 * @returns the status id, or `''` when no column was declared.
 */
export function defaultInitialStatus(view: BoardView): string {
  return view.columns[0]?.status ?? ''
}

/**
 * Restore a refused creation from the data layer's `keptInput` echo.
 *
 * The echoed `initialStatus` is a string; if the board no longer declares that
 * column (a renamed/removed status) the form falls back to its default column
 * rather than keeping an unselectable value. Nothing is invented: every restored
 * value comes from the echo.
 *
 * @param kept - the echo carried by the failure.
 * @param statuses - the status ids the form may offer, in column order.
 * @returns the draft to put back in the form.
 */
export function restoreCreateDraft(
  kept: { readonly title: string; readonly goal: string; readonly initialStatus: string; readonly blockedReason: string | null },
  statuses: readonly string[],
): CreateDraft {
  const known = kept.initialStatus.length > 0
    && (statuses.length === 0 || statuses.includes(kept.initialStatus))
  return {
    title: kept.title,
    goal: kept.goal,
    initialStatus: known ? kept.initialStatus : (statuses[0] ?? ''),
    blockedReason: kept.blockedReason ?? '',
  }
}

/**
 * Success text for a field save, naming the fields that actually changed.
 *
 * @param changed - the data layer's `changed` list.
 * @returns the sentence; never claims a field it did not change.
 */
export function fieldsSavedText(changed: readonly ('title' | 'goal')[]): string {
  if (changed.length === 0) return '已保存任务字段'
  const labels = changed.map((field) => (field === 'title' ? '任务标题' : '任务目标'))
  return `已保存：${labels.join('、')}`
}

/**
 * Success text for a creation, distinguishing a replay (REC-02).
 *
 * @param outcome - `created` or the idempotent `already-created`.
 * @param title - the task title the data layer returned.
 * @returns the sentence.
 */
export function createdTaskText(outcome: 'created' | 'already-created', title: string): string {
  return outcome === 'created'
    ? `已创建任务：「${title}」`
    : `任务已存在（重复提交已识别）：「${title}」`
}

/* ------------------------------------------------------------------ *
 * Write-landed / view-stale (REC-01/REC-05)
 * ------------------------------------------------------------------ */

/** Shown when a creation landed but the board re-read failed. Never a failure. */
export const VIEW_STALE_CREATE_TEXT = '任务已创建，但看板视图未刷新。请重新读取。'

/** The replay variant: the task already existed, the view still did not refresh. */
export const VIEW_STALE_ALREADY_CREATED_TEXT = '任务已存在（重复提交已识别），但看板视图未刷新。请重新读取。'

/**
 * Shown when a field save landed but the board re-read failed. The wording is
 * deliberately a confirmation plus a read instruction: the write is **not** a
 * failure, and resubmitting it is forbidden.
 *
 * @param changed - the fields the data layer reported as changed.
 * @returns the sentence.
 */
export function fieldsStaleViewText(changed: readonly ('title' | 'goal')[]): string {
  return `${fieldsSavedText(changed)}，但看板视图未刷新。请重新读取。`
}

/**
 * Stale-view text for a creation.
 *
 * @param outcome - `created` or `already-created`.
 * @returns the sentence.
 */
export function createdStaleViewText(outcome: 'created' | 'already-created'): string {
  return outcome === 'created' ? VIEW_STALE_CREATE_TEXT : VIEW_STALE_ALREADY_CREATED_TEXT
}

/* ------------------------------------------------------------------ *
 * Activity history (F01-R07 / SAVE-08)
 * ------------------------------------------------------------------ */

/** Heading of the task-scope activity area. */
export const ACTIVITY_TASK_TITLE = '活动历史'

/** Heading of the project-scope activity area. */
export const ACTIVITY_PROJECT_TITLE = '项目活动'

/** A legal empty history: an answer, not an error (F01-R07). */
export const ACTIVITY_EMPTY_TEXT = '暂无重要活动'

/** Loading text for an activity read. */
export const ACTIVITY_LOADING_TEXT = '正在加载活动…'

/** The retry affordance of a failed activity read. */
export const ACTIVITY_RETRY_TEXT = '重新加载活动'

/** Fallback text for a failed activity read without a message. */
export const ACTIVITY_FAILED_TEXT = '活动历史读取失败，未显示任何内容。'

/**
 * An activity entry as the panel renders it. Every field comes from the data
 * layer; nothing is synthesised (no "system note", no guessed actor).
 */
export interface ActivityEntryView {
  readonly activityId: string
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  /** ISO timestamp exactly as the data layer sent it. */
  readonly at: string
  /** Display form of `at` (derived, never a second source of truth). */
  readonly time: string
  /** Machine-readable change kind, rendered verbatim. */
  readonly code: string
  /** Display text captured by the data layer. */
  readonly summary: string
  /** Detail bag flattened to key/value pairs, sorted by key for stability. */
  readonly details: readonly { readonly key: string; readonly value: string }[]
}

/**
 * The structural shape of one activity entry (core's `ActivityEntryView`).
 *
 * Declared structurally so this module does not import the wire module (which
 * imports this one): the data layer's value is assignable without a cycle.
 */
export interface ActivityEntryLike {
  readonly activityId: string
  readonly at: string
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly code: string
  readonly summary: string
  readonly details: Readonly<Record<string, string>>
}

/**
 * Render an ISO timestamp for display. Purely cosmetic: the raw `at` stays on
 * the view model, and an unparsable value is shown unchanged rather than
 * replaced with a fabricated time.
 *
 * @param at - the data layer's timestamp.
 * @returns `YYYY-MM-DD HH:mm:ss` when it matches the ISO shape, else the input.
 */
export function formatActivityTime(at: string): string {
  const trimmed = at.trim()
  if (trimmed.length === 0) return at
  return trimmed.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '')
}

/**
 * Map one data-layer entry to the render model.
 *
 * @param entry - the data layer's entry.
 * @returns the render entry (details sorted by key, order preserved otherwise).
 */
export function deriveActivityEntryView(entry: ActivityEntryLike): ActivityEntryView {
  return {
    activityId: entry.activityId,
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    at: entry.at,
    time: formatActivityTime(entry.at),
    code: entry.code,
    summary: entry.summary,
    details: Object.keys(entry.details)
      .sort()
      .map((key) => ({ key, value: entry.details[key] ?? '' })),
  }
}

/**
 * Map a history read to the render model, preserving the data layer's order
 * (newest first by contract). An empty input stays empty.
 *
 * @param entries - the data layer's entries.
 * @returns the render entries.
 */
export function deriveActivityEntries(entries: readonly ActivityEntryLike[]): ActivityEntryView[] {
  return entries.map((entry) => deriveActivityEntryView(entry))
}

/* ------------------------------------------------------------------ *
 * F03 manual summaries — editor state, preview diff and version labels
 *
 * S1 scope: one prose section per scope (task summary / project overview).
 * The official body is authoritative; a draft is *only* a draft and is never
 * rendered as an official version (F03-R02/R07). An empty official body is a
 * legal empty state, never an error and never filled with invented text.
 * ------------------------------------------------------------------ */

/** The object a manual summary belongs to (F03 S1: task summary / project overview). */
export type SummaryScopeKind = 'task' | 'project'

/** The single section id/title S1 writes; the body is the textarea text. */
export const SUMMARY_SECTION_ID = 'manual'
export const SUMMARY_TASK_SECTION_TITLE = '任务概况'
export const SUMMARY_PROJECT_SECTION_TITLE = '项目总览'

/**
 * The section title for one scope.
 *
 * @param scopeKind - the scope.
 * @returns the title shown in the editor and stored in the section.
 */
export function summarySectionTitle(scopeKind: SummaryScopeKind): string {
  return scopeKind === 'task' ? SUMMARY_TASK_SECTION_TITLE : SUMMARY_PROJECT_SECTION_TITLE
}

/**
 * The empty-state text for one scope. An official body that is absent or blank
 * is the explicit "暂无" answer, not a failure (F03-R01).
 *
 * @param scopeKind - the scope.
 * @returns the empty-state sentence.
 */
export function summaryEmptyText(scopeKind: SummaryScopeKind): string {
  return scopeKind === 'task' ? '暂无任务概况。' : '暂无项目总览。'
}

/** Loading sentence for a summary read. */
export const SUMMARY_LOADING_TEXT = '正在读取概况…'
/** Read-failure sentence; never rendered as "暂无" (REC-05). */
export const SUMMARY_READ_FAILED_TEXT = '概况读取失败，未显示任何内容。'
/** Retry label for a failed summary read. */
export const SUMMARY_RETRY_TEXT = '重新读取概况'
/** Entry label that opens the summary editor. */
export const SUMMARY_EDIT_TEXT = '编辑概况'
/** Entry label that switches the editor to the preview (diff) state. */
export const SUMMARY_PREVIEW_TEXT = '预览修改'
/** Label of the button that commits the previewed body. */
export const SUMMARY_CONFIRM_SAVE_TEXT = '确认保存'
/** Label that leaves the preview and keeps the input. */
export const SUMMARY_BACK_TO_EDIT_TEXT = '返回编辑'
/** Label that closes the editor and discards unsaved input. */
export const SUMMARY_CANCEL_EDIT_TEXT = '取消编辑'
/** Explicit draft save (S1 has no discard endpoint; a draft may be overwritten). */
export const SUMMARY_SAVE_DRAFT_TEXT = '保存草稿'
export const SUMMARY_DRAFT_SAVING_TEXT = '正在保存草稿…'
export const SUMMARY_DRAFT_SAVED_TEXT = '草稿已保存（尚未成为正式概况）。'
export const SUMMARY_DRAFT_FAILED_TEXT = '草稿保存失败，正式内容未改变。'
/** Badge shown when the loaded editor text came from a draft. */
export const SUMMARY_DRAFT_BADGE = '草稿'
/** Preview heading: old official body vs the new input. */
export const SUMMARY_PREVIEW_TITLE = '预览修改：旧正式内容 vs 新内容'
/** Shown when the scope has no official version yet. */
export const SUMMARY_NO_OFFICIAL_TEXT = '暂无正式概况'
/** Shown when the preview has no line-level differences. */
export const SUMMARY_NO_DIFF_TEXT = '新内容与旧正式内容一致。'
/** The data layer answered `no-change`: no version was created. */
export const SUMMARY_NO_CHANGE_TEXT = '未做修改：概况内容没有变化。'
/** The data layer recognised the same update id and did not write twice. */
export const SUMMARY_ALREADY_APPLIED_TEXT = '该修改已生效（重复提交已识别）。'
/** Generic commit success sentence. */
export const SUMMARY_SAVED_TEXT = '概况已保存'
/** Commit landed but the authoritative re-read failed (`view: null`). */
export const SUMMARY_SAVED_STALE_TEXT = '概况已保存，但视图未刷新。请重新读取。'
/** Save outcome unknown: verify the current body first; never replay blindly. */
export const SUMMARY_SAVE_UNKNOWN_TEXT = '概况保存结果未知：请先核对当前概况，不要重复提交。'
/** No baseline means no editable save; re-read instead of inventing one. */
export const SUMMARY_BASELINE_MISSING_TEXT = '无法编辑：概况缺少基线，请重新读取后再试。'
/** Version line when no official version exists. */
export const SUMMARY_NO_VERSION_TEXT = '暂无正式版本'
/** The only origin S1 can produce: the user's own manual edit. */
export const SUMMARY_USER_ORIGIN_TEXT = '用户手动'

/**
 * The body text of a summary content value.
 *
 * @param content - a wire content value, or null/undefined when absent.
 * @returns the S1 section's body, or `''` when there is no section.
 */
export function summarySectionBody(content: SummaryContentValue | null | undefined): string {
  if (content === null || content === undefined) return ''
  const section = content.sections.find((item) => item.id === SUMMARY_SECTION_ID) ?? content.sections[0]
  return section?.body ?? ''
}

/**
 * The official body text of a summary view.
 *
 * @param view - the summary view, or null before it is read.
 * @returns the official body, or `''` when there is no official version.
 */
export function summaryOfficialText(view: SummaryViewValue | null): string {
  if (view === null || view.current === null) return ''
  return summarySectionBody(view.current.content)
}

/**
 * The draft body text of a summary view.
 *
 * @param view - the summary view, or null.
 * @returns the draft body, or null when there is no draft.
 */
export function summaryDraftText(view: SummaryViewValue | null): string | null {
  if (view === null || view.draft === null) return null
  return summarySectionBody(view.draft.content)
}

/**
 * The text an editor opens with: the draft when one exists, else the official
 * body. A draft is restored so a crash/reload does not lose the input (F03-R07).
 *
 * @param view - the summary view, or null.
 * @returns the initial editor text.
 */
export function summaryEditorText(view: SummaryViewValue | null): string {
  const draft = summaryDraftText(view)
  return draft ?? summaryOfficialText(view)
}

/**
 * The conclusions that must survive a manual body save (F03-R05: a prose edit
 * never silently drops the existing conclusion fragments).
 *
 * @param view - the summary view, or null.
 * @returns the conclusions to carry into the saved content.
 */
export function summaryConclusionsOf(view: SummaryViewValue | null): readonly SummaryConclusionWire[] {
  if (view === null) return []
  if (view.current !== null) return view.current.conclusions
  if (view.draft !== null) return view.draft.content.conclusions
  return []
}

/**
 * Build the S1 single-section content for a save/draft.
 *
 * @param scopeKind - which scope the body belongs to (decides the section title).
 * @param text - the textarea text (kept verbatim; empty is legal and clears).
 * @param conclusions - conclusions to preserve; empty means "omit".
 * @returns the wire content value.
 */
export function summaryContentForSave(
  scopeKind: SummaryScopeKind,
  text: string,
  conclusions: readonly SummaryConclusionWire[] | null | undefined,
): SummaryContentWire {
  const kept = conclusions ?? []
  return {
    sections: [{ id: SUMMARY_SECTION_ID, title: summarySectionTitle(scopeKind), body: text }],
    ...(kept.length === 0 ? {} : { conclusions: kept }),
  }
}

/** Editor lifecycle: loading → ready | failed; saving is a transient ready state. */
export type SummaryEditorStatus = 'loading' | 'ready' | 'failed' | 'saving'

/** Draft-save lifecycle, independent of the official version (F03-R07). */
export type SummaryDraftStatus = 'none' | 'saving' | 'saved' | 'failed'

/**
 * One scope's summary editor state.
 *
 * `text` is the only editable value. `baseline` is captured from the read
 * (SAVE-05) and never invented; `updateId` is minted when the editor opens and
 * reused by a retry so a double submit cannot create two versions (F03-R07).
 */
export interface SummaryEditorState {
  readonly scopeKind: SummaryScopeKind
  readonly scopeId: string
  readonly status: SummaryEditorStatus
  readonly view: SummaryViewValue | null
  readonly text: string
  readonly baseline: SummaryBaselineWire | null
  readonly editing: boolean
  readonly previewing: boolean
  readonly dirty: boolean
  readonly error: string | null
  readonly notice: string | null
  readonly updateId: string | null
  readonly draftStatus: SummaryDraftStatus
  readonly draftError: string | null
}

/**
 * Build the loading state for one scope.
 *
 * @param scopeKind - the scope kind.
 * @param scopeId - the scope id.
 * @returns the loading editor state.
 */
export function summaryEditorLoading(scopeKind: SummaryScopeKind, scopeId: string): SummaryEditorState {
  return {
    scopeKind,
    scopeId,
    status: 'loading',
    view: null,
    text: '',
    baseline: null,
    editing: false,
    previewing: false,
    dirty: false,
    error: null,
    notice: null,
    updateId: null,
    draftStatus: 'none',
    draftError: null,
  }
}

/**
 * Build the failed state for one scope. No baseline is fabricated; the only
 * offered action is a re-read (REC-05).
 *
 * @param scopeKind - the scope kind.
 * @param scopeId - the scope id.
 * @param message - the failure sentence.
 * @returns the failed editor state.
 */
export function summaryEditorFailed(
  scopeKind: SummaryScopeKind,
  scopeId: string,
  message: string,
): SummaryEditorState {
  return {
    scopeKind,
    scopeId,
    status: 'failed',
    view: null,
    text: '',
    baseline: null,
    editing: false,
    previewing: false,
    dirty: false,
    error: message,
    notice: null,
    updateId: null,
    draftStatus: 'none',
    draftError: null,
  }
}

/**
 * Build the ready state from a successful read. A restored draft is marked so
 * the UI can badge it; the official version is untouched.
 *
 * @param scopeKind - the scope kind.
 * @param scopeId - the scope id.
 * @param view - the read summary view.
 * @param updateId - the save identity for this editing session.
 * @returns the ready editor state.
 */
export function summaryEditorReady(
  scopeKind: SummaryScopeKind,
  scopeId: string,
  view: SummaryViewValue,
  updateId: string,
): SummaryEditorState {
  return {
    scopeKind,
    scopeId,
    status: 'ready',
    view,
    text: summaryEditorText(view),
    baseline: view.baseline,
    editing: false,
    previewing: false,
    dirty: false,
    error: null,
    notice: view.draft === null ? null : '已恢复未保存的草稿（尚未成为正式概况）。',
    updateId,
    draftStatus: 'none',
    draftError: null,
  }
}

/**
 * Whether the editor text differs from what it was loaded with (draft or
 * official). Used to decide whether a draft save is meaningful.
 *
 * @param state - the editor state.
 * @returns true when the text is dirty.
 */
export function summaryDirty(state: SummaryEditorState): boolean {
  return state.text !== summaryEditorText(state.view)
}

/**
 * Whether the editor may open. A missing baseline is a re-read, not an editable
 * empty state (SAVE-05).
 *
 * @param state - the editor state.
 * @returns true when editing can start.
 */
export function summaryCanEdit(state: SummaryEditorState): boolean {
  return state.status === 'ready' && state.baseline !== null && !state.editing
}

/**
 * Whether the editor may commit. Mirrors the data layer's requirements: a
 * baseline and one update id per intent (F03-R02/R07).
 *
 * @param state - the editor state.
 * @returns true when a save may be attempted.
 */
export function summaryCanSave(state: SummaryEditorState): boolean {
  return state.status === 'ready' && state.baseline !== null && state.updateId !== null && state.editing
}

/**
 * Patch the editor text and refresh the dirty flag. A typing change never mints
 * a new update id (F03-R07).
 *
 * @param state - the editor state.
 * @param text - the new textarea value.
 * @returns the patched state.
 */
export function summaryPatchText(state: SummaryEditorState, text: string): SummaryEditorState {
  return { ...state, text, dirty: text !== summaryEditorText(state.view), error: null }
}

/** One row of the plain-text preview diff. */
export type SummaryDiffKind = 'same' | 'removed' | 'added'

/** A preview diff row: one line of the old/new body. */
export interface SummaryDiffRow {
  readonly kind: SummaryDiffKind
  readonly text: string
}

/**
 * Plain line diff between the old official body and the new input.
 *
 * S1 only needs to show "what would change" in prose; this is a block diff over
 * the common prefix/suffix, so unchanged edges stay visible and the changed
 * middle is shown as removed lines followed by added lines.
 *
 * @param previous - the current official body (may be empty).
 * @param next - the editor input (may be empty).
 * @returns the diff rows; an unchanged body yields only `same` rows.
 */
export function summaryDiffRows(previous: string, next: string): SummaryDiffRow[] {
  const before = previous.length === 0 ? [] : previous.split('\n')
  const after = next.length === 0 ? [] : next.split('\n')
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const rows: SummaryDiffRow[] = []
  for (let index = 0; index < prefix; index += 1) rows.push({ kind: 'same', text: before[index] ?? '' })
  for (let index = prefix; index < before.length - suffix; index += 1) rows.push({ kind: 'removed', text: before[index] ?? '' })
  for (let index = prefix; index < after.length - suffix; index += 1) rows.push({ kind: 'added', text: after[index] ?? '' })
  for (let index = before.length - suffix; index < before.length; index += 1) rows.push({ kind: 'same', text: before[index] ?? '' })
  return rows
}

/**
 * The preview rows for one editor state: the official body (never the draft)
 * versus the input. A draft is not a version and must not be diffed as one.
 *
 * @param state - the editor state.
 * @returns the preview rows.
 */
export function summaryPreviewRows(state: SummaryEditorState): SummaryDiffRow[] {
  return summaryDiffRows(summaryOfficialText(state.view), state.text)
}

/**
 * Whether a preview diff contains any change.
 *
 * @param rows - the diff rows.
 * @returns true when at least one line was removed or added.
 */
export function summaryDiffHasChanges(rows: readonly SummaryDiffRow[]): boolean {
  return rows.some((row) => row.kind !== 'same')
}

/**
 * Human label for a version's origin. S1 manual saves are always `user`.
 *
 * @param origin - the wire origin.
 * @returns the Chinese label.
 */
export function summaryOriginText(origin: SummaryVersionValue['origin']): string {
  switch (origin) {
    case 'ai': return 'AI 生成'
    case 'user': return SUMMARY_USER_ORIGIN_TEXT
    case 'ai+user': return 'AI 与用户'
    default: return origin
  }
}

/**
 * Human label for a version's change kind.
 *
 * @param changeKind - the wire change kind.
 * @returns the Chinese label.
 */
export function summaryChangeKindText(changeKind: SummaryVersionValue['changeKind']): string {
  switch (changeKind) {
    case 'created': return '新建'
    case 'modified': return '修改'
    case 'cleared': return '清空'
    default: return changeKind
  }
}

/**
 * The sequence label of one version.
 *
 * @param version - the version.
 * @returns e.g. `第 2 版`.
 */
export function summaryVersionLabel(version: SummaryVersionValue): string {
  return `第 ${String(version.seq)} 版`
}

/**
 * The metadata line of one version: confirmation time, origin and change kind.
 *
 * @param version - the version.
 * @returns the metadata sentence.
 */
export function summaryVersionMeta(version: SummaryVersionValue): string {
  return `${formatActivityTime(version.confirmedAt)} · ${summaryOriginText(version.origin)} · ${summaryChangeKindText(version.changeKind)}`
}

/** A render row for the version history list (metadata only, no body). */
export interface SummaryVersionEntry {
  readonly versionId: string
  readonly label: string
  readonly meta: string
  readonly origin: SummaryVersionValue['origin']
  readonly changeKind: SummaryVersionValue['changeKind']
  readonly confirmedAt: string
}

/**
 * Map one version to its render row.
 *
 * @param version - the version.
 * @returns the render row.
 */
export function summaryVersionEntry(version: SummaryVersionValue): SummaryVersionEntry {
  return {
    versionId: version.versionId,
    label: summaryVersionLabel(version),
    meta: summaryVersionMeta(version),
    origin: version.origin,
    changeKind: version.changeKind,
    confirmedAt: version.confirmedAt,
  }
}

/**
 * Map a summary view's history (newest first by contract) to render rows.
 *
 * @param view - the summary view, or null.
 * @returns the version rows; empty when nothing is official yet.
 */
export function summaryHistoryEntries(view: SummaryViewValue | null): SummaryVersionEntry[] {
  if (view === null) return []
  return view.history.map((version) => summaryVersionEntry(version))
}

/* ------------------------------------------------------------------ *
 * F04: conversation entry (browser-owned session, host-owned attribution)
 * ------------------------------------------------------------------ */

/** Where a conversation entry was started from. */
export type ConversationScopeKind = 'project' | 'task'

/** One step of the connect → link → open flow. */
export type ConversationEntryStep = 'connect' | 'link' | 'open'

/** The phase of one conversation entry. */
export type ConversationEntryPhase = 'connecting' | 'linking' | 'opening' | 'opened' | 'failed'

/**
 * The state of one conversation entry.
 *
 * The browser owns the session (`uiWorkspace`), the host owns the task
 * attribution (`linkConversation`). `conversationId` survives a failed link or
 * open so a retry never creates a second conversation; `requestId` is minted
 * once per entry and reused by every link attempt (idempotency).
 */
export interface ConversationEntryState {
  readonly scopeKind: ConversationScopeKind
  readonly scopeId: string
  /** The task id for a task entry; `null` for a project entry (never linked). */
  readonly taskId: string | null
  readonly phase: ConversationEntryPhase
  readonly step: ConversationEntryStep
  readonly conversationId: string | null
  readonly requestId: string
  readonly linkStatus: 'linked' | 'already-linked' | null
  readonly error: string | null
  readonly code: BoardFailureCode | null
}

/** Project entry label (unlinked conversation). */
export const CONVERSATION_PROJECT_ENTRY_TEXT = '新建对话（不关联任务）'

/** Task entry label (the conversation is attributed to the open task). */
export const CONVERSATION_TASK_ENTRY_TEXT = '新建对话（固定归属当前任务）'

/** Shown when the composition has no `uiWorkspace` service. */
export const CONVERSATION_UNAVAILABLE_TEXT = '未找到 uiWorkspace 服务：无法创建或打开工作对话，未创建任何会话。'

/** Progress texts for the three steps. */
export const CONVERSATION_CONNECTING_TEXT = '正在创建或复用空白对话…'
export const CONVERSATION_LINKING_TEXT = '对话已就绪，正在写入任务归属…'
export const CONVERSATION_OPENING_TEXT = '归属已写入，正在打开对话…'

/** Success texts. */
export const CONVERSATION_PROJECT_OPENED_TEXT = '已打开未关联任务的工作对话。'
export const CONVERSATION_TASK_OPENED_TEXT = '已创建并打开对话，并固定归属当前任务。'
export const CONVERSATION_ALREADY_LINKED_TEXT = '该对话此前已归属当前任务，已打开。'

/** Step-specific failure headlines (used when the transport sent no message). */
export const CONVERSATION_CONNECT_FAILED_TEXT = '创建或复用对话失败，未打开任何会话。'
export const CONVERSATION_LINK_FAILED_TEXT = '对话已创建，但写入任务归属失败；会话本身保留。'
export const CONVERSATION_OPEN_FAILED_TEXT = '对话已创建，但打开失败；会话本身保留。'

/** Retry labels, one per step. */
export const CONVERSATION_RETRY_CONNECT_TEXT = '重试创建对话'
export const CONVERSATION_RETRY_LINK_TEXT = '重试归属'
export const CONVERSATION_RETRY_OPEN_TEXT = '重试打开'

/** Dismiss label for the entry status area. */
export const CONVERSATION_DISMISS_TEXT = '收起'

/** Whether the entry is between steps (a second click is ignored). */
export function conversationBusy(entry: ConversationEntryState): boolean {
  return entry.phase === 'connecting' || entry.phase === 'linking' || entry.phase === 'opening'
}

/** Whether a failed entry can retry from its recorded step. */
export function conversationCanRetry(entry: ConversationEntryState): boolean {
  return entry.phase === 'failed'
}

/** The success sentence for an opened entry. */
export function conversationOpenedText(entry: ConversationEntryState): string {
  if (entry.scopeKind === 'project') return CONVERSATION_PROJECT_OPENED_TEXT
  return entry.linkStatus === 'already-linked' ? CONVERSATION_ALREADY_LINKED_TEXT : CONVERSATION_TASK_OPENED_TEXT
}

/** The failure sentence: the transport's message when present, otherwise the step headline. */
export function conversationFailureText(entry: ConversationEntryState): string {
  if (entry.error !== null && entry.error.trim().length > 0) return entry.error
  switch (entry.step) {
    case 'connect': return CONVERSATION_CONNECT_FAILED_TEXT
    case 'link': return CONVERSATION_LINK_FAILED_TEXT
    case 'open': return CONVERSATION_OPEN_FAILED_TEXT
    default: return CONVERSATION_CONNECT_FAILED_TEXT
  }
}

/** The status sentence: progress while in flight, success when opened, failure when failed. */
export function conversationProgressText(entry: ConversationEntryState): string {
  switch (entry.phase) {
    case 'connecting': return CONVERSATION_CONNECTING_TEXT
    case 'linking': return CONVERSATION_LINKING_TEXT
    case 'opening': return CONVERSATION_OPENING_TEXT
    case 'opened': return conversationOpenedText(entry)
    case 'failed': return conversationFailureText(entry)
    default: return ''
  }
}

/** The retry label for a failed entry's recorded step. */
export function conversationRetryText(entry: ConversationEntryState): string {
  switch (entry.step) {
    case 'connect': return CONVERSATION_RETRY_CONNECT_TEXT
    case 'link': return CONVERSATION_RETRY_LINK_TEXT
    case 'open': return CONVERSATION_RETRY_OPEN_TEXT
    default: return CONVERSATION_RETRY_CONNECT_TEXT
  }
}