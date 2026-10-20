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
  BLOCKED_STATUS_ID,
  COLLAPSED_BY_DEFAULT_STATUS_ID,
  DETAIL_PLACEHOLDERS,
  NO_SUMMARY_NO_GOAL_TEXT,
  REOPENABLE_STATUS_IDS,
  SUMMARY_RECHECK_NOTE,
  buildBoardView,
  deriveCardProgress,
  deriveTaskDetail,
  isBlockedReasonValid,
  isReopenable,
  normalizeReason,
  sortByOrder,
  statusLabelOf,
  toSingleLine,
  type BoardTask,
} from '../src/model.js'

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
