/**
 * View-model tests: the F02 presentation rules that must not be simplified.
 *
 * The important one is the card source rule (F02-R05 / OBJ-08). It is asserted
 * twice: positively (summary → goal → explicit none) and negatively, by feeding
 * the model data that *looks* like a summary draft or a last record and proving
 * neither is consulted — the type has no field for them, and these tests pin that
 * so a later "helpful fallback" cannot sneak in.
 */
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_EMPTY_TEXT,
  ACTIVITY_TASK_TITLE,
  BLOCKED_REASON_REQUIRED_MESSAGE,
  BLOCKED_STATUS_ID,
  COLLAPSED_BY_DEFAULT_STATUS_ID,
  CONVERSATION_ALREADY_LINKED_TEXT,
  CONVERSATION_CONNECTING_TEXT,
  CONVERSATION_CONNECT_FAILED_TEXT,
  CONVERSATION_LINKING_TEXT,
  CONVERSATION_LINK_FAILED_TEXT,
  CONVERSATION_OPENING_TEXT,
  CONVERSATION_OPEN_FAILED_TEXT,
  CONVERSATION_PROJECT_OPENED_TEXT,
  CONVERSATION_RETRY_CONNECT_TEXT,
  CONVERSATION_RETRY_LINK_TEXT,
  CONVERSATION_RETRY_OPEN_TEXT,
  CONVERSATION_TASK_OPENED_TEXT,
  DETAIL_PLACEHOLDERS,
  FIELD_TITLE_REQUIRED_MESSAGE,
  FIELDS_ALREADY_APPLIED_TEXT,
  FIELDS_NO_CHANGE_TEXT,
  NO_FIELD_CHANGE_MESSAGE,
  NO_SUMMARY_NO_GOAL_TEXT,
  REOPENABLE_STATUS_IDS,
  SUMMARY_RECHECK_NOTE,
  TASK_TITLE_REQUIRED_MESSAGE,
  VIEW_STALE_ALREADY_CREATED_TEXT,
  VIEW_STALE_CREATE_TEXT,
  buildBoardView,
  conversationBusy,
  conversationCanRetry,
  conversationFailureText,
  conversationOpenedText,
  conversationProgressText,
  conversationRetryText,
  createdStaleViewText,
  createdTaskText,
  creationStatusChoices,
  defaultInitialStatus,
  deriveActivityEntries,
  deriveActivityEntryView,
  deriveCardProgress,
  deriveTaskDetail,
  fieldsSavedText,
  fieldsStaleViewText,
  formatActivityTime,
  isBlockedReasonValid,
  isReopenable,
  normalizeReason,
  restoreCreateDraft,
  sortByOrder,
  statusLabelOf,
  summaryCanEdit,
  summaryCanSave,
  summaryChangeKindText,
  summaryContentForSave,
  summaryDiffHasChanges,
  summaryDiffRows,
  summaryDirty,
  summaryDraftText,
  summaryEditorFailed,
  summaryEditorLoading,
  summaryEditorReady,
  summaryEditorText,
  summaryEmptyText,
  summaryHistoryEntries,
  summaryOfficialText,
  summaryOriginText,
  summaryPatchText,
  summaryPreviewRows,
  summarySectionBody,
  summarySectionTitle,
  summaryVersionEntry,
  summaryVersionLabel,
  summaryVersionMeta,
  toSingleLine,
  validateCreateDraft,
  validateFieldDraft,
  type BoardTask,
  type ConversationEntryState,
} from '../src/model.js'
import type {
  SummaryBaselineWire,
  SummaryConclusionWire,
  SummaryContentValue,
  SummaryDraftValue,
  SummaryVersionValue,
  SummaryViewValue,
} from '../src/wire.js'

const COLUMNS = [
  { status: 'todo', label: '未开始', collapsedByDefault: false },
  { status: 'doing', label: '进行中', collapsedByDefault: false },
  { status: 'blocked', label: '已阻塞', collapsedByDefault: false },
  { status: 'done', label: '已完成', collapsedByDefault: false },
  { status: 'cancelled', label: '已取消', collapsedByDefault: true },
]

/** A task with everything the wire may carry. */
function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    taskId: 'task-1',
    projectId: 'ws-1',
    title: 'Title',
    goal: '',
    status: 'todo',
    statusLabel: '未开始',
    order: 0,
    // Required contract fields (Q2=A): the write baseline and undo credential.
    statusRevision: 0,
    undoTarget: null,
    ...overrides,
  }
}

describe('card progress source (F02-R05)', () => {
  it('uses the official summary line when there is one', () => {
    const progress = deriveCardProgress(task({
      summaryProgress: { line: '整体进展：接口已接通', versionId: 'v2', confirmedAt: '2026-10-14T00:00:00.000Z' },
      goal: 'goal text',
    }))
    expect(progress.source).toBe('summary')
    expect(progress.text).toBe('整体进展：接口已接通')
    expect(progress.note).toBeUndefined()
  })

  it('falls back to the goal when there is no summary, and says so', () => {
    const progress = deriveCardProgress(task({ goal: '把看板做出来' }))
    expect(progress.source).toBe('goal')
    expect(progress.text).toBe('把看板做出来')
    expect(progress.note).toContain('任务目标')
  })

  it('shows an explicit "none" text when neither exists', () => {
    const progress = deriveCardProgress(task())
    expect(progress.source).toBe('none')
    expect(progress.text).toBe(NO_SUMMARY_NO_GOAL_TEXT)
  })

  it('marks a summary that needs re-checking, keeping the summary text', () => {
    const progress = deriveCardProgress(task({
      summaryProgress: { line: 'line', versionId: 'v1', confirmedAt: '2026-10-14T00:00:00.000Z' },
      needsRecheck: true,
      recheckCodes: ['goal-changed'],
    }))
    expect(progress.source).toBe('summary')
    expect(progress.text).toBe('line')
    expect(progress.note).toBe(SUMMARY_RECHECK_NOTE)
  })

  it('treats a blank summary line as absent rather than as content', () => {
    const progress = deriveCardProgress(task({
      summaryProgress: { line: '   \n  ', versionId: 'v1', confirmedAt: '2026-10-14T00:00:00.000Z' },
      goal: 'goal text',
    }))
    expect(progress.source).toBe('goal')
    expect(progress.text).toBe('goal text')
  })

  it('never consults a draft or a "last record", even when one is smuggled in', () => {
    // The type has no field for these. This test pins the behaviour against a
    // future "helpful" fallback: passing them must change nothing.
    const smuggled = {
      ...task({ goal: '' }),
      draftProgress: '草稿里的进展',
      lastRecord: '最后一条对话记录',
      summaryDraft: { progress: '未确认的概况' },
    } as unknown as BoardTask

    const progress = deriveCardProgress(smuggled)
    expect(progress.source).toBe('none')
    expect(progress.text).toBe(NO_SUMMARY_NO_GOAL_TEXT)
    for (const forbidden of ['草稿里的进展', '最后一条对话记录', '未确认的概况']) {
      expect(progress.text).not.toContain(forbidden)
    }
  })

  it('collapses multi-line content into one card line', () => {
    const progress = deriveCardProgress(task({ goal: 'first\n\nsecond   third' }))
    expect(progress.text).toBe('first second third')
    expect(toSingleLine('  a \n b  ')).toBe('a b')
  })
})

describe('columns (F02-R01)', () => {
  it('renders the columns the data layer declared, in its order', () => {
    const view = buildBoardView({
      project: { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok', workScopeAllowed: true },
      tasks: [],
      columns: COLUMNS,
      boardToken: 't',
      capabilities: { statusChange: true, reorder: true, undo: true },
    })
    expect(view.columns.map((column) => column.status)).toEqual(['todo', 'doing', 'blocked', 'done', 'cancelled'])
    expect(view.columns.map((column) => column.label)).toEqual(['未开始', '进行中', '已阻塞', '已完成', '已取消'])
    // Cancelled is collapsed; the four others are not. Done stays visible.
    expect(view.columns.filter((column) => column.collapsedByDefault).map((column) => column.status)).toEqual(['cancelled'])
    expect(view.columns.find((column) => column.status === 'done')?.collapsedByDefault).toBe(false)
  })

  it('uses the data layer labels rather than recomputing them', () => {
    const view = buildBoardView({
      project: { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok', workScopeAllowed: true },
      tasks: [],
      columns: [{ status: 'todo', label: 'To do (English)', collapsedByDefault: false }],
    })
    expect(view.columns[0]?.label).toBe('To do (English)')
  })

  it('groups by status and collapses `cancelled` when no column table arrived', () => {
    const view = buildBoardView({
      project: { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok', workScopeAllowed: true },
      tasks: [
        task({ taskId: 'a', status: 'doing', statusLabel: '进行中' }),
        task({ taskId: 'b', status: 'cancelled', statusLabel: '已取消' }),
      ],
    })
    expect(view.columns.map((column) => column.status)).toEqual(['doing', 'cancelled'])
    expect(view.columns.find((column) => column.status === 'cancelled')?.collapsedByDefault).toBe(true)
    expect(view.capabilities).toEqual({ statusChange: false, reorder: false, undo: false })
  })

  it('sorts a column by manual order and keeps ties stable', () => {
    const tasks = [
      task({ taskId: 'c', order: 2 }),
      task({ taskId: 'a', order: 0 }),
      task({ taskId: 'b', order: 1 }),
    ]
    expect(sortByOrder(tasks).map((item) => item.taskId)).toEqual(['a', 'b', 'c'])
    const tied = [task({ taskId: 'x', order: 5 }), task({ taskId: 'y', order: 5 })]
    expect(sortByOrder(tied).map((item) => item.taskId)).toEqual(['x', 'y'])
  })
})

describe('status ids the UI binds to', () => {
  it('recognises only the ids the product rules attach to', () => {
    expect(BLOCKED_STATUS_ID).toBe('blocked')
    expect(COLLAPSED_BY_DEFAULT_STATUS_ID).toBe('cancelled')
    expect(REOPENABLE_STATUS_IDS).toEqual(['done', 'cancelled'])
    expect(isReopenable('done')).toBe(true)
    expect(isReopenable('cancelled')).toBe(true)
    expect(isReopenable('blocked')).toBe(false)
    expect(isReopenable('todo')).toBe(false)
  })

  it('does not turn archive into a status', () => {
    // Archive is a visibility attribute: it may appear on a task, but it is not
    // one of the ids the reopen rule or the blocked rule can match.
    expect(isReopenable('archived')).toBe(false)
    expect(BLOCKED_STATUS_ID).not.toBe('archived')
    const archived = task({ archived: true })
    expect(deriveTaskDetail(archived).status).toBe('todo')
  })

  it('prefers the data layer label and falls back to the id', () => {
    expect(statusLabelOf(task({ statusLabel: 'Doing' }))).toBe('Doing')
    expect(statusLabelOf(task({ status: 'doing', statusLabel: null }))).toBe('doing')
  })
})

describe('blocked reason rule (F02-R02)', () => {
  it('rejects blank and whitespace-only reasons', () => {
    expect(isBlockedReasonValid('')).toBe(false)
    expect(isBlockedReasonValid('   ')).toBe(false)
    expect(isBlockedReasonValid('\n\t')).toBe(false)
    expect(isBlockedReasonValid(undefined)).toBe(false)
    expect(isBlockedReasonValid(null)).toBe(false)
  })

  it('accepts a real reason and trims it', () => {
    expect(isBlockedReasonValid(' 等待上游接口 ')).toBe(true)
    expect(normalizeReason(' 等待上游接口 ')).toBe('等待上游接口')
  })
})

describe('detail skeleton (F02-R07)', () => {
  it('shows the goal independently and 「暂无」-style nulls, never fabricated content', () => {
    const detail = deriveTaskDetail(task({ goal: '', blockedReason: '', summaryProgress: null }))
    expect(detail.goal).toBeNull()
    expect(detail.blockedReason).toBeNull()
    expect(detail.summaryProgress).toBeNull()
    expect(detail.progress.source).toBe('none')
    expect(detail.placeholders).toEqual(DETAIL_PLACEHOLDERS)
    expect(detail.placeholders.every((entry) => entry.state === 'not-implemented')).toBe(true)
  })

  it('shows a blocked reason only while the task is blocked', () => {
    const blocked = deriveTaskDetail(task({ status: 'blocked', statusLabel: '已阻塞', blockedReason: '等接口' }))
    expect(blocked.blockedReason).toBe('等接口')
    // The same text on a task that is no longer blocked is not shown as a live
    // blocked state (the history keeps it; the card must not imply it).
    const moved = deriveTaskDetail(task({ status: 'doing', statusLabel: '进行中', blockedReason: '等接口' }))
    expect(moved.blockedReason).toBeNull()
  })

  it('carries hints only when the data layer supplied them', () => {
    expect(deriveTaskDetail(task()).hints).toEqual([])
    const withHint = deriveTaskDetail(task({ hints: [{ kind: 'attention', text: '需要核对' }] }))
    expect(withHint.hints).toEqual([{ kind: 'attention', text: '需要核对' }])
  })

  it('offers undo only when the data layer supplied an undoTarget (never inferred)', () => {
    expect(deriveTaskDetail(task()).undoAvailable).toBe(false)
    const undoable = deriveTaskDetail(task({
      statusRevision: 3,
      undoTarget: { statusVersion: 'ver1:2', appliedUpdateId: 'op-prev' },
    }))
    expect(undoable.undoAvailable).toBe(true)
    // The numeric baseline stays available for the write path.
    expect(task({ statusRevision: 7 }).statusRevision).toBe(7)
  })
})

/* ------------------------------------------------------------------ *
 * Management drafts and activity view models (slice B)
 * ------------------------------------------------------------------ */

/** The board the creation form reads its status choices from. */
function boardView() {
  return buildBoardView({
    project: { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok', workScopeAllowed: true },
    tasks: [],
    columns: COLUMNS,
    boardToken: 't',
    capabilities: { statusChange: true, reorder: true, undo: true },
  })
}

describe('creation draft (F01-R02: title required, blocked needs a reason)', () => {
  it('rejects a blank title and accepts a substantive one', () => {
    expect(validateCreateDraft({ title: '   ', goal: '', initialStatus: 'todo', blockedReason: '' }))
      .toBe(TASK_TITLE_REQUIRED_MESSAGE)
    expect(validateCreateDraft({ title: '写报告', goal: '', initialStatus: 'todo', blockedReason: '' }))
      .toBeNull()
    // A goal is optional; an empty one is not an error.
    expect(validateCreateDraft({ title: '写报告', goal: '', initialStatus: '', blockedReason: '' }))
      .toBeNull()
  })

  it('requires a reason only when the initial status is blocked', () => {
    expect(validateCreateDraft({ title: '任务', goal: '', initialStatus: 'blocked', blockedReason: '  ' }))
      .toBe(BLOCKED_REASON_REQUIRED_MESSAGE)
    expect(validateCreateDraft({ title: '任务', goal: '', initialStatus: 'blocked', blockedReason: '等接口' }))
      .toBeNull()
    // A rest status may carry an empty reason without complaint.
    expect(validateCreateDraft({ title: '任务', goal: '', initialStatus: 'doing', blockedReason: '' }))
      .toBeNull()
  })

  it('offers the data layer columns as status choices and defaults to the first one', () => {
    const view = boardView()
    expect(creationStatusChoices(view).map((choice) => choice.id)).toEqual(['todo', 'doing', 'blocked', 'done', 'cancelled'])
    expect(defaultInitialStatus(view)).toBe('todo')
    const empty = buildBoardView({
      project: { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok', workScopeAllowed: true },
      tasks: [],
    })
    expect(defaultInitialStatus(empty)).toBe('')
  })

  it('restores the keptInput echo verbatim and falls back only for an unknown status', () => {
    const kept = { title: '回显标题', goal: '回显目标', initialStatus: 'doing', blockedReason: '等接口' }
    expect(restoreCreateDraft(kept, ['todo', 'doing'])).toEqual({
      title: '回显标题',
      goal: '回显目标',
      initialStatus: 'doing',
      blockedReason: '等接口',
    })
    // A status the board no longer offers cannot be selected: use the default.
    expect(restoreCreateDraft(kept, ['todo', 'doing']).initialStatus).toBe('doing')
    expect(restoreCreateDraft({ ...kept, initialStatus: 'archived' }, ['todo', 'doing']).initialStatus).toBe('todo')
    // A null reason echo becomes an empty input, never the text "null".
    expect(restoreCreateDraft({ ...kept, blockedReason: null }, ['todo']).blockedReason).toBe('')
  })
})

describe('field-edit draft (F01-R05: title stays required, no write for nothing)', () => {
  it('rejects a blank title and accepts a changed one', () => {
    expect(validateFieldDraft({ title: '   ' })).toBe(FIELD_TITLE_REQUIRED_MESSAGE)
    expect(validateFieldDraft({ title: '新标题' })).toBeNull()
    expect(NO_FIELD_CHANGE_MESSAGE).toContain('没有需要保存')
  })

  it('names only the fields that actually changed', () => {
    expect(fieldsSavedText(['title'])).toBe('已保存：任务标题')
    expect(fieldsSavedText(['goal'])).toBe('已保存：任务目标')
    expect(fieldsSavedText(['title', 'goal'])).toBe('已保存：任务标题、任务目标')
    expect(fieldsSavedText([])).toBe('已保存任务字段')
    expect(FIELDS_NO_CHANGE_TEXT).toContain('没有变化')
    expect(FIELDS_ALREADY_APPLIED_TEXT).toContain('已生效')
  })

  it('states a stale view as a confirmation plus a read instruction, never as a failure', () => {
    expect(fieldsStaleViewText(['title'])).toContain('已保存')
    expect(fieldsStaleViewText(['title'])).toContain('视图未刷新')
    expect(createdStaleViewText('created')).toBe(VIEW_STALE_CREATE_TEXT)
    expect(createdStaleViewText('already-created')).toBe(VIEW_STALE_ALREADY_CREATED_TEXT)
    expect(VIEW_STALE_CREATE_TEXT).toContain('已创建')
    expect(VIEW_STALE_ALREADY_CREATED_TEXT).toContain('已存在')
  })

  it('names a creation outcome without claiming a replay was a new task', () => {
    expect(createdTaskText('created', '任务 A')).toContain('已创建')
    expect(createdTaskText('already-created', '任务 A')).toContain('已存在')
  })
})

describe('activity view mapping (F01-R07: data-layer content only)', () => {
  it('formats timestamps for display and leaves unparsable values unchanged', () => {
    expect(formatActivityTime('2026-11-11T06:00:00.000Z')).toBe('2026-11-11 06:00:00')
    expect(formatActivityTime('not-a-time')).toBe('not-a-time')
    expect(formatActivityTime('')).toBe('')
  })

  it('maps one entry verbatim: summary, code, scope, details (sorted), no fabrication', () => {
    const view = deriveActivityEntryView({
      activityId: 'a-1',
      at: '2026-11-11T06:00:00.000Z',
      scopeKind: 'task',
      scopeId: 't1',
      code: 'goal-changed',
      summary: '目标已修改',
      details: { b: '2', a: '1' },
    })
    expect(view.activityId).toBe('a-1')
    expect(view.summary).toBe('目标已修改')
    expect(view.code).toBe('goal-changed')
    expect(view.scopeKind).toBe('task')
    expect(view.time).toBe('2026-11-11 06:00:00')
    expect(view.details).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }])
    // No field exists for an invented actor/system note.
    expect(Object.keys(view).sort()).toEqual(['activityId', 'at', 'code', 'details', 'scopeId', 'scopeKind', 'summary', 'time'])
  })

  it('preserves the data layer order (newest first) and keeps an empty history empty', () => {
    const entries = deriveActivityEntries([
      { activityId: 'a2', at: '2026-11-11T06:00:00.000Z', scopeKind: 'task', scopeId: 't1', code: 'goal-changed', summary: '新', details: {} },
      { activityId: 'a1', at: '2026-11-10T06:00:00.000Z', scopeKind: 'task', scopeId: 't1', code: 'created', summary: '旧', details: {} },
    ])
    expect(entries.map((entry) => entry.activityId)).toEqual(['a2', 'a1'])
    expect(deriveActivityEntries([])).toEqual([])
    expect(ACTIVITY_EMPTY_TEXT).toBe('暂无重要活动')
    expect(ACTIVITY_TASK_TITLE).toBe('活动历史')
  })
})

/* ------------------------------------------------------------------ *
 * F03: manual summary / project overview view model
 * ------------------------------------------------------------------ */

/** A summary content payload with the single manual section S1 edits. */
function summaryContent(body: string, scopeKind: 'task' | 'project' = 'task'): SummaryContentValue {
  return {
    sections: [{ id: 'manual', title: scopeKind === 'task' ? '任务概况' : '项目总览', body }],
    conclusions: [],
  }
}

/** One official summary version as the host reports it. */
function summaryVersion(overrides: Record<string, unknown> = {}): SummaryVersionValue {
  return {
    versionId: 'v1',
    seq: 1,
    confirmedAt: '2026-11-11T06:00:00.000Z',
    origin: 'user',
    changeKind: 'created',
    previousVersionId: null,
    content: summaryContent('旧正文'),
    conclusions: [],
    readToken: 'rt-1',
    ...overrides,
  } as SummaryVersionValue
}

/** One unsaved manual draft as the host reports it. */
function summaryDraft(body: string, overrides: Record<string, unknown> = {}): SummaryDraftValue {
  return {
    draftId: 'd-1',
    state: 'draft',
    updateId: 'op-draft',
    updatedAt: '2026-11-11T06:30:00.000Z',
    base: { scopeRevision: 3, applicabilityRevision: 1 },
    content: summaryContent(body),
    ...overrides,
  } as SummaryDraftValue
}

/** A summary view as the host reports it; `current` may be null (empty scope). */
function summaryView(overrides: Record<string, unknown> = {}): SummaryViewValue {
  const current = summaryVersion()
  return {
    scopeKind: 'task',
    scopeId: 't1',
    revision: 3,
    applicabilityRevision: 1,
    baseline: { revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' } as SummaryBaselineWire,
    current,
    history: [current],
    draft: null,
    needsRecheck: false,
    recheck: { pending: false, reasons: [], markedAt: null },
    ...overrides,
  } as SummaryViewValue
}

describe('manual summary view model (F03-R01/R02/R04/R07)', () => {
  it('uses one manual section per scope and an honest empty sentence', () => {
    expect(summarySectionTitle('task')).toBe('任务概况')
    expect(summarySectionTitle('project')).toBe('项目总览')
    expect(summaryEmptyText('task')).toBe('暂无任务概况。')
    expect(summaryEmptyText('project')).toBe('暂无项目总览。')
  })

  it('reads the official body only from the current version, and shows nothing when there is none', () => {
    const view = summaryView()
    expect(summarySectionBody(view.current?.content)).toBe('旧正文')
    expect(summaryOfficialText(view)).toBe('旧正文')
    expect(summaryOfficialText(summaryView({ current: null, history: [] }))).toBe('')
    expect(summaryOfficialText(null)).toBe('')
    // A version with a differently identified first section still shows its body.
    const content: SummaryContentValue = { sections: [{ id: 'other', title: 'T', body: '正文' }], conclusions: [] }
    expect(summarySectionBody(content)).toBe('正文')
  })

  it('prefers the unsaved draft in the editor while keeping the official body distinct', () => {
    const view = summaryView({ draft: summaryDraft('草稿正文') })
    expect(summaryDraftText(view)).toBe('草稿正文')
    expect(summaryEditorText(view)).toBe('草稿正文')
    expect(summaryOfficialText(view)).toBe('旧正文')
    expect(summaryDraftText(summaryView())).toBeNull()
    expect(summaryEditorText(summaryView())).toBe('旧正文')
    expect(summaryEditorText(null)).toBe('')
  })

  it('builds exactly one manual section for a save and preserves conclusions', () => {
    const conclusions: readonly SummaryConclusionWire[] = [
      { id: 'c1', text: '结论', statedState: 'current', state: 'current', amendedBy: null },
    ]
    expect(summaryContentForSave('task', '正文', conclusions)).toEqual({
      sections: [{ id: 'manual', title: '任务概况', body: '正文' }],
      conclusions,
    })
    expect(summaryContentForSave('project', '总览', [])).toEqual({
      sections: [{ id: 'manual', title: '项目总览', body: '总览' }],
    })
    // Empty is legal: an emptied textarea clears the body rather than inventing one.
    expect(summaryContentForSave('task', '', null).sections[0]?.body).toBe('')
  })

  it('captures the read baseline and badges a restored draft without inventing one', () => {
    const ready = summaryEditorReady('task', 't1', summaryView({ draft: summaryDraft('草稿正文') }), 'op-1')
    expect(ready.status).toBe('ready')
    expect(ready.baseline).toEqual({ revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' })
    expect(ready.updateId).toBe('op-1')
    expect(ready.text).toBe('草稿正文')
    expect(ready.notice).toContain('草稿')
    expect(summaryEditorReady('task', 't1', summaryView(), 'op-1').notice).toBeNull()

    const loading = summaryEditorLoading('task', 't1')
    expect(loading.status).toBe('loading')
    expect(loading.baseline).toBeNull()
    expect(loading.text).toBe('')

    const failed = summaryEditorFailed('task', 't1', '读取失败')
    expect(failed.status).toBe('failed')
    expect(failed.baseline).toBeNull()
    expect(failed.text).toBe('')
    expect(failed.error).toBe('读取失败')
  })

  it('gates editing and saving on the baseline and the update id, and never mints one while typing', () => {
    const ready = summaryEditorReady('task', 't1', summaryView(), 'op-1')
    expect(summaryCanEdit(ready)).toBe(true)
    expect(summaryCanSave(ready)).toBe(false)

    const editing = { ...ready, editing: true }
    expect(summaryCanEdit(editing)).toBe(false)
    expect(summaryCanSave(editing)).toBe(true)
    expect(summaryCanSave({ ...editing, updateId: null })).toBe(false)
    expect(summaryCanSave({ ...editing, baseline: null })).toBe(false)

    const failed = summaryEditorFailed('task', 't1', 'x')
    expect(summaryCanEdit(failed)).toBe(false)
    expect(summaryCanSave(failed)).toBe(false)

    const patched = summaryPatchText(editing, '新正文')
    expect(patched.text).toBe('新正文')
    expect(patched.updateId).toBe('op-1')
    expect(summaryDirty(patched)).toBe(true)
    expect(summaryDirty(editing)).toBe(false)
  })

  it('shows a plain line diff against the old official body', () => {
    expect(summaryDiffRows('a', 'a')).toEqual([{ kind: 'same', text: 'a' }])
    expect(summaryDiffRows('a\nb', 'a\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'c' },
    ])
    expect(summaryDiffRows('', 'x')).toEqual([{ kind: 'added', text: 'x' }])
    expect(summaryDiffRows('x', '')).toEqual([{ kind: 'removed', text: 'x' }])
    expect(summaryDiffHasChanges(summaryDiffRows('a', 'a'))).toBe(false)
    expect(summaryDiffHasChanges(summaryDiffRows('a', 'b'))).toBe(true)
  })

  it('previews the input against the official body, never against the draft', () => {
    const state = {
      ...summaryEditorReady('task', 't1', summaryView({ draft: summaryDraft('草稿正文') }), 'op-1'),
      editing: true,
      text: '旧正文\n新增行',
    }
    expect(summaryPreviewRows(state)).toEqual([
      { kind: 'same', text: '旧正文' },
      { kind: 'added', text: '新增行' },
    ])
  })

  it('labels versions with their sequence, confirmation time, origin and change kind', () => {
    const version = summaryVersion({ seq: 2, changeKind: 'modified', previousVersionId: 'v1' })
    expect(summaryVersionLabel(version)).toBe('第 2 版')
    expect(summaryVersionMeta(version)).toBe('2026-11-11 06:00:00 · 用户手动 · 修改')
    expect(summaryOriginText('user')).toBe('用户手动')
    expect(summaryOriginText('ai')).toBe('AI 生成')
    expect(summaryOriginText('ai+user')).toBe('AI 与用户')
    expect(summaryChangeKindText('created')).toBe('新建')
    expect(summaryChangeKindText('cleared')).toBe('清空')
    const entry = summaryVersionEntry(version)
    expect(entry).toEqual({
      versionId: 'v1',
      label: '第 2 版',
      meta: '2026-11-11 06:00:00 · 用户手动 · 修改',
      origin: 'user',
      changeKind: 'modified',
      confirmedAt: '2026-11-11T06:00:00.000Z',
    })
    // History rows are metadata only: no body is smuggled into the list.
    expect('content' in entry).toBe(false)
  })

  it('keeps the history newest-first and exposes metadata only', () => {
    const newest = summaryVersion({ versionId: 'v2', seq: 2, changeKind: 'modified', previousVersionId: 'v1' })
    const oldest = summaryVersion()
    const view = summaryView({ current: newest, history: [newest, oldest] })
    const entries = summaryHistoryEntries(view)
    expect(entries.map((entry) => entry.versionId)).toEqual(['v2', 'v1'])
    expect(entries.map((entry) => entry.label)).toEqual(['第 2 版', '第 1 版'])
    expect(summaryHistoryEntries(null)).toEqual([])
  })

  it('never turns a manual view into an AI-authored summary', () => {
    const entries = summaryHistoryEntries(summaryView())
    expect(entries.every((entry) => entry.origin === 'user')).toBe(true)
    expect(entries[0]?.meta).toContain('用户手动')
    expect(entries[0]?.meta).not.toContain('AI')
  })
})

/** A conversation entry with everything the model reads. */
function conversation(overrides: Partial<ConversationEntryState> = {}): ConversationEntryState {
  return {
    scopeKind: 'project',
    scopeId: 'ws-1',
    taskId: null,
    phase: 'connecting',
    step: 'connect',
    conversationId: null,
    requestId: 'op-1',
    linkStatus: null,
    error: null,
    code: null,
    ...overrides,
  }
}

describe('conversation entry view model (F04-R01/R02/R03)', () => {
  it('treats only in-flight phases as busy', () => {
    expect(conversationBusy(conversation({ phase: 'connecting' }))).toBe(true)
    expect(conversationBusy(conversation({ phase: 'linking', step: 'link' }))).toBe(true)
    expect(conversationBusy(conversation({ phase: 'opening', step: 'open' }))).toBe(true)
    expect(conversationBusy(conversation({ phase: 'opened', step: 'open' }))).toBe(false)
    expect(conversationBusy(conversation({ phase: 'failed', step: 'link' }))).toBe(false)
  })

  it('offers a retry only after a failure', () => {
    expect(conversationCanRetry(conversation({ phase: 'failed', step: 'link' }))).toBe(true)
    expect(conversationCanRetry(conversation({ phase: 'opened', step: 'open' }))).toBe(false)
    expect(conversationCanRetry(conversation({ phase: 'connecting' }))).toBe(false)
  })

  it('names the outcome without claiming an attribution the project entry never wrote', () => {
    expect(conversationOpenedText(conversation({ scopeKind: 'project', phase: 'opened', step: 'open' })))
      .toBe(CONVERSATION_PROJECT_OPENED_TEXT)
    expect(conversationOpenedText(conversation({ scopeKind: 'task', taskId: 't1', phase: 'opened', step: 'open' })))
      .toBe(CONVERSATION_TASK_OPENED_TEXT)
    expect(conversationOpenedText(conversation({
      scopeKind: 'task',
      taskId: 't1',
      phase: 'opened',
      step: 'open',
      linkStatus: 'already-linked',
    }))).toBe(CONVERSATION_ALREADY_LINKED_TEXT)
  })

  it('shows a readable failure per step, with the data-layer message when present', () => {
    expect(conversationFailureText(conversation({ phase: 'failed', step: 'connect' })))
      .toBe(CONVERSATION_CONNECT_FAILED_TEXT)
    expect(conversationFailureText(conversation({ phase: 'failed', step: 'link' })))
      .toBe(CONVERSATION_LINK_FAILED_TEXT)
    expect(conversationFailureText(conversation({ phase: 'failed', step: 'open' })))
      .toBe(CONVERSATION_OPEN_FAILED_TEXT)
    expect(conversationFailureText(conversation({ phase: 'failed', step: 'link', error: '归属失败' })))
      .toBe('归属失败')
  })

  it('progresses from connect to link to open and reports the opened state', () => {
    expect(conversationProgressText(conversation({ phase: 'connecting', step: 'connect' })))
      .toBe(CONVERSATION_CONNECTING_TEXT)
    expect(conversationProgressText(conversation({ scopeKind: 'task', taskId: 't1', phase: 'linking', step: 'link' })))
      .toBe(CONVERSATION_LINKING_TEXT)
    expect(conversationProgressText(conversation({ phase: 'opening', step: 'open' })))
      .toBe(CONVERSATION_OPENING_TEXT)
    expect(conversationProgressText(conversation({ scopeKind: 'project', phase: 'opened', step: 'open' })))
      .toBe(CONVERSATION_PROJECT_OPENED_TEXT)
  })

  it('offers the retry that matches the failed step', () => {
    expect(conversationRetryText(conversation({ phase: 'failed', step: 'connect' })))
      .toBe(CONVERSATION_RETRY_CONNECT_TEXT)
    expect(conversationRetryText(conversation({ phase: 'failed', step: 'link' })))
      .toBe(CONVERSATION_RETRY_LINK_TEXT)
    expect(conversationRetryText(conversation({ phase: 'failed', step: 'open' })))
      .toBe(CONVERSATION_RETRY_OPEN_TEXT)
  })
})