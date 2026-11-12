/**
 * Controller tests: the F02 interaction rules.
 *
 * The controller is the only place the UI decides *when* to ask the data layer
 * for something, so these tests drive it against a scripted fake source and
 * assert what the panel would show — and, just as importantly, what it must not
 * show (a failure presented as success, an optimistic move, a fabricated empty
 * board, a second write for one intent).
 */
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_MISSING_MESSAGE,
  UNKNOWN_PROJECT_MESSAGE,
  createBoardController,
  type BoardController,
  type BoardState,
} from '../src/controller.js'
import type {
  ActivityInput,
  ActivityResult,
  BoardFailureCode,
  BoardReadResult,
  BoardSource,
  CreateTaskInput,
  CreateTaskResult,
  FormalStatusValue,
  ManualSummaryDraftSaveInput,
  ManualSummarySaveInput,
  ProjectListResult,
  ReorderInput,
  StatusChangeInput,
  SummaryDraftSaveResult,
  SummaryReadResult,
  SummarySaveResult,
  SummaryScopeInput,
  UndoInput,
  UpdateFieldsInput,
  UpdateFieldsResult,
  WriteResult,
} from '../src/source.js'
import type {
  SummaryBaselineWire,
  SummaryContentValue,
  SummaryDraftValue,
  SummaryVersionValue,
  SummaryViewValue,
} from '../src/wire.js'
import {
  BLOCKED_REASON_REQUIRED_MESSAGE,
  FIELD_TITLE_REQUIRED_MESSAGE,
  FIELDS_BASELINE_MISSING_MESSAGE,
  NO_FIELD_CHANGE_MESSAGE,
  SUMMARY_ALREADY_APPLIED_TEXT,
  SUMMARY_BASELINE_MISSING_TEXT,
  SUMMARY_DRAFT_SAVED_TEXT,
  SUMMARY_NO_CHANGE_TEXT,
  SUMMARY_SAVED_STALE_TEXT,
  SUMMARY_SAVED_TEXT,
  SUMMARY_SAVE_UNKNOWN_TEXT,
  TASK_TITLE_REQUIRED_MESSAGE,
  type TaskDetailView,
} from '../src/model.js'

const CAPABILITIES = { statusChange: true, reorder: true, undo: true }

const PROJECT = { projectId: 'ws-1', title: 'P', workScopeAvailability: 'ok' as const, workScopeAllowed: true }

const COLUMNS = [
  { status: 'todo', label: '未开始', collapsedByDefault: false },
  { status: 'doing', label: '进行中', collapsedByDefault: false },
  { status: 'blocked', label: '已阻塞', collapsedByDefault: false },
  { status: 'done', label: '已完成', collapsedByDefault: false },
  { status: 'cancelled', label: '已取消', collapsedByDefault: true },
]

function task(taskId: string, status: string, order: number, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    projectId: 'ws-1',
    title: `Task ${taskId}`,
    goal: '',
    status,
    statusLabel: status,
    order,
    // Required contract fields (Q2=A): a write baseline and an undo credential.
    statusRevision: 0,
    undoTarget: null,
    ...extra,
  }
}

/** An undo credential as the data layer reports it after a status change. */
const UNDO_TARGET = { statusVersion: 'ver1:2', appliedUpdateId: 'op-prev' }

/** A snapshot with two tasks, as the data layer would report it. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    project: PROJECT,
    tasks: [task('t1', 'todo', 0), task('t2', 'doing', 0)],
    columns: COLUMNS,
    boardToken: 'tok',
    capabilities: CAPABILITIES,
    ...overrides,
  }
}

/** A summary content payload with the single manual section S1 edits. */
function summaryContent(body: string, scopeKind: 'task' | 'project' = 'task'): SummaryContentValue {
  return {
    sections: [{ id: 'manual', title: scopeKind === 'task' ? '任务概况' : '项目总览', body }],
    conclusions: [],
  }
}

/** The baseline the host reports for the official summary version below. */
const SUMMARY_BASELINE: SummaryBaselineWire = { revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' }

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

/**
 * A summary view as the host reports it (F03): the scope always exists, so a
 * missing official summary is `current: null` with a usable baseline — never
 * a null view.
 */
function summaryView(overrides: Record<string, unknown> = {}): SummaryViewValue {
  const current = summaryVersion()
  return {
    scopeKind: 'task',
    scopeId: 't1',
    revision: 3,
    applicabilityRevision: 1,
    baseline: { ...SUMMARY_BASELINE },
    current,
    history: [current],
    draft: null,
    needsRecheck: false,
    recheck: { pending: false, reasons: [], markedAt: null },
    ...overrides,
  } as SummaryViewValue
}

interface FakeSource extends BoardSource {
  reads: number
  /** Project ids the controller asked for, in order (Q1=B: explicit per call). */
  readProjects: string[]
  /** How many times the candidate list was requested. */
  projectListCalls: number
  /** The next answer to `listProjects`. */
  nextProjectList: ProjectListResult
  statusCalls: StatusChangeInput[]
  reorderCalls: ReorderInput[]
  undoCalls: UndoInput[]
  createCalls: CreateTaskInput[]
  updateCalls: UpdateFieldsInput[]
  activityCalls: ActivityInput[]
  summaryReadCalls: SummaryScopeInput[]
  summarySaveCalls: ManualSummarySaveInput[]
  summaryDraftCalls: ManualSummaryDraftSaveInput[]
  nextRead: BoardReadResult
  nextWrite: WriteResult
  nextCreate: CreateTaskResult
  nextUpdate: UpdateFieldsResult
  nextActivity: ActivityResult
  /** The next answer to `readSummary`; `null` lets the fake derive a view. */
  nextSummaryRead: SummaryReadResult | null
  nextSummarySave: SummarySaveResult
  nextSummaryDraft: SummaryDraftSaveResult
  /** When true, `setStatus` stays pending until `release()` is called. */
  holdWrites: boolean
  release(): void
}

/**
 * A scripted board source.
 *
 * @param options - initial scripted results.
 * @returns the source plus its call log and a latch for in-flight writes.
 */
function fakeSource(options: { read?: BoardReadResult; write?: WriteResult; capabilities?: boolean } = {}): FakeSource {
  const source: FakeSource = {
    transport: { kind: 'host', detail: 'test' },
    reads: 0,
    readProjects: [],
    projectListCalls: 0,
    nextProjectList: { ok: true, projects: [] },
    statusCalls: [],
    reorderCalls: [],
    undoCalls: [],
    createCalls: [],
    updateCalls: [],
    activityCalls: [],
    summaryReadCalls: [],
    summarySaveCalls: [],
    summaryDraftCalls: [],
    nextRead: options.read ?? { ok: true, snapshot: snapshot() as never },
    nextWrite: options.write ?? { ok: true, snapshot: snapshot() as never, undoable: true },
    nextCreate: {
      ok: true,
      outcome: 'created',
      task: task('t3', 'todo', 0) as never,
      snapshot: snapshot() as never,
    },
    nextUpdate: {
      ok: true,
      outcome: 'saved',
      task: task('t1', 'todo', 0, { title: 'Edited', fieldsRevision: 1 }) as never,
      changed: ['title'],
      fieldsRevision: 1,
      snapshot: snapshot() as never,
    },
    nextActivity: { ok: true, entries: [] },
    nextSummaryRead: null,
    nextSummarySave: {
      ok: true,
      outcome: 'committed',
      revision: 4,
      applicabilityRevision: 1,
      versionId: 'v2',
      changeKind: 'modified',
      consumedDraftIds: [],
      draftUpdateFailures: [],
      needsRecheck: false,
      view: summaryView({
        revision: 4,
        baseline: { revision: 4, applicabilityRevision: 1, summaryVersionId: 'v2' },
        current: summaryVersion({
          versionId: 'v2',
          seq: 2,
          changeKind: 'modified',
          previousVersionId: 'v1',
          content: summaryContent('新正文'),
        }),
        history: [
          summaryVersion({
            versionId: 'v2',
            seq: 2,
            changeKind: 'modified',
            previousVersionId: 'v1',
            content: summaryContent('新正文'),
          }),
          summaryVersion(),
        ],
      }),
    },
    nextSummaryDraft: { ok: true, draft: summaryDraft('草稿正文') },
    holdWrites: false,
    release: () => undefined,
    async readBoard(projectId) {
      source.reads += 1
      source.readProjects.push(projectId)
      return source.nextRead
    },
    async listProjects() {
      source.projectListCalls += 1
      return source.nextProjectList
    },
    async setStatus(input) {
      source.statusCalls.push(input)
      if (source.holdWrites) await new Promise<void>((resolve) => { source.release = resolve })
      return source.nextWrite
    },
    async reorder(input) {
      source.reorderCalls.push(input)
      return source.nextWrite
    },
    async undoStatusChange(input) {
      source.undoCalls.push(input)
      return source.nextWrite
    },
    async createTask(input) {
      source.createCalls.push(input)
      return source.nextCreate
    },
    async updateTaskFields(input) {
      source.updateCalls.push(input)
      return source.nextUpdate
    },
    async loadActivity(input) {
      source.activityCalls.push(input)
      return source.nextActivity
    },
    async readSummary(input) {
      source.summaryReadCalls.push(input)
      if (source.nextSummaryRead !== null) return source.nextSummaryRead
      return {
        ok: true,
        summary: summaryView({ scopeKind: input.scopeKind, scopeId: input.scopeId }),
      }
    },
    async saveSummary(input) {
      source.summarySaveCalls.push(input)
      return source.nextSummarySave
    },
    async saveSummaryDraft(input) {
      source.summaryDraftCalls.push(input)
      return source.nextSummaryDraft
    },
  }
  void options.capabilities
  return source
}

/** A controller with deterministic operation ids, starting on `selection-required`. */
function controllerFor(source: BoardSource): BoardController {
  let counter = 0
  return createBoardController({
    source,
    newOperationId: () => `op-${++counter}`,
  })
}

/**
 * A controller whose project was explicitly selected and read (Q1=B: the panel
 * never starts with a project, so tests must select one like the UI would).
 *
 * @param source - the scripted data source.
 * @param projectId - the project to select.
 * @returns the loaded controller.
 */
async function loadedController(source: BoardSource, projectId = 'ws-1'): Promise<BoardController> {
  const controller = controllerFor(source)
  await controller.selectProject(projectId)
  return controller
}

/** The board currently on screen, whether the read succeeded or kept data. */
function viewOf(state: BoardState) {
  if (state.read.kind === 'ready') return state.read.view
  if (state.read.kind === 'failed') return state.read.kept
  return null
}

/** The status a task currently shows in the rendered board. */
function shownStatus(state: BoardState, taskId: string): string | undefined {
  const view = viewOf(state)
  if (view === null) return undefined
  for (const column of view.columns) {
    for (const item of column.tasks) if (item.taskId === taskId) return item.status
  }
  return undefined
}

/** The ids currently rendered, column by column. */
function shownTasks(state: BoardState, status: string): string[] {
  const view = viewOf(state)
  if (view === null) return []
  return (view.columns.find((column) => column.status === status)?.tasks ?? []).map((item) => item.taskId)
}

describe('read states (F01 three-state read, REC-05)', () => {
  it('shows the board after a successful read', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    const state = controller.getState()
    expect(state.read.kind).toBe('ready')
    expect(shownTasks(state, 'todo')).toEqual(['t1'])
    expect(shownTasks(state, 'doing')).toEqual(['t2'])
    expect(source.reads).toBe(1)
  })

  it('keeps known data and offers a retry when a read fails, never an empty board', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextRead = { ok: false, code: 'read-failed', message: '读取失败' }
    await controller.load()

    const state = controller.getState()
    expect(state.read.kind).toBe('failed')
    if (state.read.kind !== 'failed') throw new Error('unreachable')
    expect(state.read.kept).not.toBeNull()
    expect(shownTasks(state, 'todo')).toEqual(['t1'])
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.retry).toEqual({ kind: 'read' })
  })

  it('shows an unregistered project as its own state, with no board at all', async () => {
    const source = fakeSource({ read: { ok: false, code: 'unknown-project', message: UNKNOWN_PROJECT_MESSAGE } })
    const controller = await loadedController(source)

    const state = controller.getState()
    expect(state.read.kind).toBe('unknown-project')
    expect(shownTasks(state, 'todo')).toEqual([])
  })

  it('drops a response that belongs to another project', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    // The data layer keeps answering for ws-1 while ws-2 is selected.
    source.nextRead = { ok: true, snapshot: snapshot() as never }
    await controller.selectProject('ws-2')

    const state = controller.getState()
    expect(state.selectedProjectId).toBe('ws-2')
    expect(state.read.kind).toBe('failed')
    expect(shownTasks(state, 'todo')).toEqual([])
  })

  it('clears the previous project before the new one arrives', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextRead = { ok: true, snapshot: snapshot({ project: { ...PROJECT, projectId: 'ws-2' } }) as never }
    await controller.selectProject('ws-2')

    const state = controller.getState()
    expect(state.read.kind).toBe('ready')
    expect(state.read.kind === 'ready' ? state.read.projectId : null).toBe('ws-2')
  })
})

describe('status entry points (F02-R02: menu ≡ drag)', () => {
  it('sends the same request whether the user used the menu or dropped the card', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    const fromMenu = source.statusCalls[0]

    const other = fakeSource()
    const otherController = await loadedController(other)
    otherController.dropTask({ taskId: 't1', toStatus: 'doing', toIndex: 0 })
    await Promise.resolve()
    const fromDrop = other.statusCalls[0]

    expect(fromMenu).toBeDefined()
    expect(fromDrop).toBeDefined()
    // The guards and the write path are shared; a drop additionally carries the
    // destination index, which a menu selection has no opinion about.
    const { toIndex: dropIndex, ...dropRest } = fromDrop as StatusChangeInput
    expect({ ...fromMenu, operationId: 'x' }).toEqual({ ...dropRest, operationId: 'x' })
    expect(fromMenu?.next).toBe('doing')
    expect(dropIndex).toBe(0)
  })

  it('refuses to enter blocked without a reason: dialog opens, nothing is written', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'blocked')
    await Promise.resolve()

    const state = controller.getState()
    expect(source.statusCalls).toHaveLength(0)
    expect(state.statusDialog).not.toBeNull()
    expect(state.statusDialog?.invalidReason).toBe(true)
    expect(state.feedback).toEqual({ kind: 'validation', text: expect.stringContaining('必须填写原因') })
    // The formal status is unchanged: still in the todo column.
    expect(shownStatus(state, 't1')).toBe('todo')
  })

  it('confirms a blocked transition once a reason is typed, and keeps the reason on cancel', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'blocked')
    controller.setDialogReason('   ')
    controller.confirmStatusDialog()
    await Promise.resolve()
    expect(source.statusCalls).toHaveLength(0)

    controller.setDialogReason('等待上游接口')
    controller.confirmStatusDialog()
    await Promise.resolve()
    expect(source.statusCalls).toHaveLength(1)
    expect(source.statusCalls[0]).toMatchObject({ taskId: 't1', next: 'blocked', reason: '等待上游接口' })

    // Cancel path: input is kept, nothing is written.
    const before = source.statusCalls.length
    controller.menuSelectStatus('t2', 'blocked')
    controller.setDialogReason('等一会儿')
    controller.cancelStatusDialog()
    await Promise.resolve()
    expect(source.statusCalls).toHaveLength(before)
    expect(controller.getState().statusDialog).toBeNull()
    expect(shownStatus(controller.getState(), 't2')).toBe('doing')

    controller.menuSelectStatus('t2', 'blocked')
    expect(controller.getState().statusDialog?.reason).toBe('等一会儿')
  })

  it('refuses quietly while the same task already has a change in flight', async () => {
    const source = fakeSource()
    source.holdWrites = true
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'doing')
    controller.menuSelectStatus('t1', 'done')
    await Promise.resolve()
    expect(source.statusCalls).toHaveLength(1)

    source.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(shownStatus(controller.getState(), 't1')).toBe('todo')
  })

  it('shows the formal status again and offers a retry when the write fails', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: false, code: 'save-failed', message: '保存失败：正式状态与顺序未改变，可重试。' }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const state = controller.getState()
    // No optimistic move: the card is still in todo.
    expect(shownStatus(state, 't1')).toBe('todo')
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.code).toBe('save-failed')
    expect(state.feedback.text).toContain('保存失败')
    expect(state.busy).toBeNull()

    // The retry reuses the same operation id (one intent, one result).
    const first = source.statusCalls[0]
    source.nextWrite = { ok: true, snapshot: snapshot({ tasks: [task('t1', 'doing', 0), task('t2', 'doing', 1)] }) as never, undoable: true }
    controller.retryPending()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.statusCalls).toHaveLength(2)
    expect(source.statusCalls[1]?.operationId).toBe(first?.operationId)
    expect(shownStatus(controller.getState(), 't1')).toBe('doing')
  })

  it('keeps the order and shows the failure when a reorder fails', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: false, code: 'save-failed', message: '保存失败' }
    controller.dropTask({ taskId: 't2', toStatus: 'doing', toIndex: 3 })
    await Promise.resolve()
    await Promise.resolve()

    expect(source.reorderCalls).toHaveLength(1)
    expect(controller.getState().feedback?.kind).toBe('failure')
  })
})

describe('capability gating', () => {
  it('renders no working entry point when the data layer cannot serve the flow', async () => {
    const source = fakeSource({
      read: {
        ok: true,
        snapshot: snapshot({ capabilities: { statusChange: false, reorder: false, undo: false } }) as never,
      },
    })
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()

    expect(source.statusCalls).toHaveLength(0)
    const state = controller.getState()
    expect(shownStatus(state, 't1')).toBe('todo')
    expect(state.feedback).toEqual({ kind: 'failure', text: CAPABILITY_MISSING_MESSAGE, code: 'unavailable', retry: null })
  })

  it('still explains a missing blocked reason before blaming the missing capability', async () => {
    const source = fakeSource({
      read: { ok: true, snapshot: snapshot({ capabilities: { statusChange: false, reorder: false, undo: false } }) as never },
    })
    const controller = await loadedController(source)

    controller.menuSelectStatus('t1', 'blocked')
    expect(controller.getState().statusDialog?.invalidReason).toBe(true)
    expect(source.statusCalls).toHaveLength(0)
  })
})

describe('undo (F02-R04)', () => {
  it('offers undo after a successful change and calls the data layer', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    // The undo credential comes only from the post-write snapshot.
    source.nextWrite = {
      ok: true,
      snapshot: snapshot({
        tasks: [task('t1', 'doing', 0, { statusRevision: 3, undoTarget: UNDO_TARGET }), task('t2', 'doing', 1)],
      }) as never,
      undoable: true,
    }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const state = controller.getState()
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.undo).toEqual({
      taskId: 't1',
      expectedStatusVersion: 'ver1:2',
      appliedUpdateId: 'op-prev',
    })
    // The write carried the baseline of the task it was decided on.
    expect(source.statusCalls[0]?.expectedStatusVersion).toBe('ver1:0')

    controller.undoLastChange()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.undoCalls).toEqual([{
      taskId: 't1',
      // The undo mints its own identity; appliedUpdateId is the undone write's.
      operationId: 'op-2',
      expectedStatusVersion: 'ver1:2',
      appliedUpdateId: 'op-prev',
    }])
  })

  it('refuses to overwrite later changes and shows the actual current value', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = {
      ok: true,
      snapshot: snapshot({
        tasks: [task('t1', 'doing', 0, { statusRevision: 3, undoTarget: UNDO_TARGET }), task('t2', 'doing', 1)],
      }) as never,
      undoable: true,
    }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const current: FormalStatusValue = { status: 'blocked', statusVersion: 'sv-7' }
    source.nextWrite = { ok: false, code: 'stale-baseline', message: '基线已变', current }
    controller.undoLastChange()
    await Promise.resolve()
    await Promise.resolve()

    const state = controller.getState()
    expect(state.feedback?.kind).toBe('undo-blocked')
    if (state.feedback?.kind !== 'undo-blocked') throw new Error('unreachable')
    expect(state.feedback.text).toContain('无法直接撤销')
    expect(state.feedback.current).toEqual(current)
    // The view now shows the real current status, not the attempted one.
    expect(shownStatus(state, 't1')).toBe('blocked')
  })

  it('does not offer undo when the post-write snapshot carries no undoTarget', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: true, snapshot: snapshot() as never, undoable: false }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const state = controller.getState()
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.undo).toBeUndefined()
    controller.undoLastChange()
    expect(source.undoCalls).toHaveLength(0)
  })
})

describe('detail view and collapse state', () => {
  it('opens the detail of a rendered task and closes it without losing the board', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.openDetail('t2')
    const detail: TaskDetailView | null = controller.getState().detail
    expect(detail?.taskId).toBe('t2')
    expect(detail?.placeholders).toHaveLength(3)

    controller.closeDetail()
    expect(controller.getState().detail).toBeNull()
    expect(shownTasks(controller.getState(), 'doing')).toEqual(['t2'])
  })

  it('ignores a detail request for a task that is not rendered', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openDetail('nope')
    expect(controller.getState().detail).toBeNull()
  })

  it('keeps the collapsed column collapsed until it is expanded', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    expect(controller.getState().cancelledExpanded).toBe(false)
    controller.toggleCancelled()
    expect(controller.getState().cancelledExpanded).toBe(true)
  })
})

describe('selection state (Q1=B: explicit, in-memory, never persisted)', () => {
  it('starts on selection-required and never reads without a selection', async () => {
    const source = fakeSource()
    const controller = controllerFor(source)

    const state = controller.getState()
    expect(state.read.kind).toBe('selection-required')
    expect(state.selectedProjectId).toBeNull()
    if (state.read.kind === 'selection-required') {
      expect(state.read.message).toContain('显式选择')
    }

    // load() is selection-driven: with no selection it must not touch the source.
    await controller.load()
    expect(source.reads).toBe(0)
    expect(controller.getState().read.kind).toBe('selection-required')
  })

  it('passes the selected project id on every read', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    expect(source.readProjects).toEqual(['ws-1'])
    expect(controller.getState().selectedProjectId).toBe('ws-1')
    await controller.load()
    expect(source.readProjects).toEqual(['ws-1', 'ws-1'])
  })

  it('resetSelection returns to selection-required without a read and clears the view', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    expect(controller.getState().read.kind).toBe('ready')
    expect(viewOf(controller.getState())).not.toBeNull()

    controller.resetSelection()

    const state = controller.getState()
    expect(state.read.kind).toBe('selection-required')
    expect(state.selectedProjectId).toBeNull()
    expect(viewOf(state)).toBeNull()
    expect(state.detail).toBeNull()
    expect(source.reads).toBe(1)
    // A load after the reset still does not read.
    await controller.load()
    expect(source.reads).toBe(1)
  })

  it('selectProject(null) returns to selection-required', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    await controller.selectProject(null)

    expect(controller.getState().read.kind).toBe('selection-required')
    expect(controller.getState().selectedProjectId).toBeNull()
    expect(source.reads).toBe(1)
  })

  it('a fresh controller has no memory of a previous selection', async () => {
    const source = fakeSource()
    const first = await loadedController(source)
    expect(first.getState().selectedProjectId).toBe('ws-1')

    const second = controllerFor(source)
    expect(second.getState().selectedProjectId).toBeNull()
    expect(second.getState().read.kind).toBe('selection-required')
    expect(source.reads).toBe(1)
  })
})

describe('project list state (Q1=B: fresh candidates, explicit selection)', () => {
  it('goes idle → loading → loaded, and loading a list never selects a project', async () => {
    const source = fakeSource()
    let release: (result: ProjectListResult) => void = () => undefined
    source.listProjects = () => new Promise<ProjectListResult>((resolve) => { release = resolve })
    const controller = controllerFor(source)

    expect(controller.getState().projects.kind).toBe('idle')
    const pending = controller.loadProjects()
    expect(controller.getState().projects.kind).toBe('loading')

    release({
      ok: true,
      projects: [
        { projectId: 'ws-1', title: 'Demo', path: 'C:/demo' },
        { projectId: 'ws-2', title: 'Demo', path: 'D:/two' },
      ],
    })
    await pending

    const state = controller.getState()
    expect(state.projects).toEqual({
      kind: 'loaded',
      projects: [
        { projectId: 'ws-1', title: 'Demo', path: 'C:/demo' },
        { projectId: 'ws-2', title: 'Demo', path: 'D:/two' },
      ],
    })
    // A list is not a selection: no board read, no chosen project, no default.
    expect(state.read.kind).toBe('selection-required')
    expect(state.selectedProjectId).toBeNull()
    expect(source.reads).toBe(0)
  })

  it('keeps a failed listing retryable and never falls back to an empty list or the first project', async () => {
    const source = fakeSource()
    source.nextProjectList = { ok: false, code: 'unavailable', message: '项目清单通道未接通，未读取任何项目。' }
    const controller = controllerFor(source)

    await controller.loadProjects()

    let state = controller.getState()
    expect(state.projects).toEqual({
      kind: 'failed',
      code: 'unavailable',
      message: '项目清单通道未接通，未读取任何项目。',
    })
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    // F9/F10 shape: no new retry kind; a read retry that routes back to the list.
    expect(state.feedback.retry).toEqual({ kind: 'read' })
    // Nothing was guessed or selected by the failure.
    expect(state.selectedProjectId).toBeNull()
    expect(state.read.kind).toBe('selection-required')
    expect(source.reads).toBe(0)

    // retryPending re-reads the list (not a board) and recovers without selecting.
    source.nextProjectList = { ok: true, projects: [{ projectId: 'ws-1', title: 'Demo', path: 'C:/demo' }] }
    controller.retryPending()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    state = controller.getState()
    expect(source.projectListCalls).toBe(2)
    expect(source.reads).toBe(0)
    expect(state.projects.kind).toBe('loaded')
    expect(state.selectedProjectId).toBeNull()
    expect(state.feedback).toBeNull()
  })

  it('selectProject from the list reads exactly that project and keeps the candidates', async () => {
    const source = fakeSource()
    source.nextProjectList = { ok: true, projects: [{ projectId: 'ws-1', title: 'Demo', path: 'C:/demo' }] }
    const controller = controllerFor(source)
    await controller.loadProjects()

    await controller.selectProject('ws-1')

    const state = controller.getState()
    expect(source.readProjects).toEqual(['ws-1'])
    expect(state.read.kind).toBe('ready')
    expect(state.selectedProjectId).toBe('ws-1')
    expect(state.projects.kind).toBe('loaded')
  })

  it('resetSelection clears both the selection and the candidate list without re-reading', async () => {
    const source = fakeSource()
    source.nextProjectList = { ok: true, projects: [{ projectId: 'ws-1', title: 'Demo', path: 'C:/demo' }] }
    const controller = controllerFor(source)
    await controller.loadProjects()
    await controller.selectProject('ws-1')

    controller.resetSelection()

    const state = controller.getState()
    expect(state.selectedProjectId).toBeNull()
    expect(state.projects).toEqual({ kind: 'idle' })
    expect(state.read.kind).toBe('selection-required')
    expect(source.projectListCalls).toBe(1)
    expect(source.reads).toBe(1)
  })

  it('treats an empty candidate list as a legal answer, not a failure and not a selection', async () => {
    const source = fakeSource()
    source.nextProjectList = { ok: true, projects: [] }
    const controller = controllerFor(source)

    await controller.loadProjects()

    const state = controller.getState()
    expect(state.projects).toEqual({ kind: 'loaded', projects: [] })
    expect(state.feedback).toBeNull()
    expect(state.selectedProjectId).toBeNull()
    expect(source.reads).toBe(0)
  })
})

describe('write-failure retry policy (F9/F10/D6: no blind write replay)', () => {
  it('keeps a write retry only for a confirmed non-landing (save-failed)', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: false, code: 'save-failed', message: '保存失败' }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const feedback = controller.getState().feedback
    expect(feedback?.kind).toBe('failure')
    if (feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(feedback.retry?.kind).toBe('status')
  })

  it('offers only a re-read after an unknown write result, and retryPending never re-writes', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: false, code: 'unknown-result', message: '写入结果未知' }
    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const feedback = controller.getState().feedback
    expect(feedback?.kind).toBe('failure')
    if (feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(feedback.code).toBe('unknown-result')
    expect(feedback.retry).toEqual({ kind: 'read' })

    const readsBefore = source.reads
    controller.retryPending()
    await Promise.resolve()
    await Promise.resolve()
    // The retry is a re-read; the write is not replayed (it may already have landed).
    expect(source.reads).toBe(readsBefore + 1)
    expect(source.statusCalls).toHaveLength(1)
    expect(source.reorderCalls).toHaveLength(0)
    expect(source.undoCalls).toHaveLength(0)
  })

  it('offers only a re-read after a read-failed write outcome (no-change re-read failed)', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    source.nextWrite = { ok: false, code: 'read-failed', message: '正式值未变，但重读失败。' }
    controller.dropTask({ taskId: 't2', toStatus: 'doing', toIndex: 3 })
    await Promise.resolve()
    await Promise.resolve()

    const feedback = controller.getState().feedback
    expect(feedback?.kind).toBe('failure')
    if (feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(feedback.code).toBe('read-failed')
    expect(feedback.retry).toEqual({ kind: 'read' })

    controller.retryPending()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.reorderCalls).toHaveLength(1)
  })

  it('treats a throwing transport as unknown-result with only a re-read available', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    source.setStatus = async () => { throw new Error('socket dropped') }

    controller.menuSelectStatus('t1', 'doing')
    await Promise.resolve()
    await Promise.resolve()

    const feedback = controller.getState().feedback
    expect(feedback?.kind).toBe('failure')
    if (feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(feedback.code).toBe('unknown-result')
    expect(feedback.retry).toEqual({ kind: 'read' })
  })
})

describe('undo from the read snapshot (Q2=A: refresh-safe)', () => {
  it('undoes the task credential carried by the snapshot with a fresh operation id', async () => {
    const source = fakeSource({
      read: {
        ok: true,
        snapshot: snapshot({
          tasks: [
            task('t1', 'doing', 0, { statusRevision: 3, undoTarget: UNDO_TARGET }),
            task('t2', 'doing', 1),
          ],
        }) as never,
      },
    })
    const controller = await loadedController(source)

    controller.undoTaskChange('t1')
    await Promise.resolve()
    await Promise.resolve()

    expect(source.undoCalls).toEqual([{
      taskId: 't1',
      operationId: 'op-1',
      expectedStatusVersion: 'ver1:2',
      appliedUpdateId: 'op-prev',
    }])
  })

  it('does nothing when the task has no undoTarget', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.undoTaskChange('t1')
    await Promise.resolve()

    expect(source.undoCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Slice B: creation, field edit, activity history
 * ------------------------------------------------------------------ */

/** Let every pending microtask chain settle (source calls are promises). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** A read whose first task carries the SAVE-05 field baseline. */
function editableRead(): BoardReadResult {
  return {
    ok: true,
    snapshot: snapshot({
      tasks: [
        task('t1', 'todo', 0, { title: '标题一', goal: '旧目标', fieldsRevision: 2, statusRevision: 3 }),
        task('t2', 'doing', 0),
      ],
    }) as never,
  }
}

/** One data-layer activity entry. */
function activityEntry(overrides: Record<string, unknown> = {}) {
  return {
    activityId: 'a1',
    at: '2026-11-10T06:00:00.000Z',
    scopeKind: 'task',
    scopeId: 't1',
    code: 'created',
    summary: '任务已创建',
    details: {},
    ...overrides,
  }
}

describe('task creation (F01-R02/R04: one intent, one task)', () => {
  it('opens a form on a ready board with the first column as initial status, submits once with a minted request id and applies the snapshot', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)

    controller.openCreateForm()
    const form = controller.getState().createForm
    expect(form).not.toBeNull()
    expect(form?.initialStatus).toBe('todo')
    // One identity per form session, minted when the form opened (REC-02).
    expect(form?.requestId).toBe('op-1')

    controller.setCreateTitle('  新任务  ')
    controller.setCreateGoal(' 目标说明 ')
    source.nextCreate = {
      ok: true,
      outcome: 'created',
      task: task('t3', 'todo', 2, { title: '新任务' }) as never,
      snapshot: snapshot({
        tasks: [task('t1', 'todo', 0), task('t2', 'doing', 0), task('t3', 'todo', 2)],
      }) as never,
    }
    await controller.submitCreateTask()

    expect(source.createCalls).toEqual([{
      projectId: 'ws-1',
      requestId: 'op-1',
      title: '新任务',
      goal: '目标说明',
      initialStatus: 'todo',
    }])
    const state = controller.getState()
    expect(state.createForm).toBeNull()
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.text).toContain('已创建')
    expect(shownTasks(state, 'todo')).toEqual(['t1', 't3'])
  })

  it('names an idempotent replay instead of claiming a second creation', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('已有任务')
    source.nextCreate = {
      ok: true,
      outcome: 'already-created',
      task: task('t3', 'todo', 0, { title: '已有任务' }) as never,
      snapshot: snapshot() as never,
    }
    await controller.submitCreateTask()

    const feedback = controller.getState().feedback
    expect(feedback?.kind).toBe('success')
    if (feedback?.kind !== 'success') throw new Error('unreachable')
    expect(feedback.text).toContain('已存在')
    expect(source.createCalls).toHaveLength(1)
  })

  it('refuses a blank title locally: no request, error in place', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('   ')
    await controller.submitCreateTask()

    expect(source.createCalls).toHaveLength(0)
    expect(controller.getState().createForm?.error).toBe(TASK_TITLE_REQUIRED_MESSAGE)
    // The form stays open with the typed value.
    expect(controller.getState().createForm?.title).toBe('   ')
  })

  it('refuses a blocked initial status without a reason locally, then sends the real reason once provided', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('阻塞任务')
    controller.setCreateStatus('blocked')
    await controller.submitCreateTask()

    expect(source.createCalls).toHaveLength(0)
    expect(controller.getState().createForm?.error).toBe(BLOCKED_REASON_REQUIRED_MESSAGE)

    controller.setCreateBlockedReason('  等待上游接口  ')
    await controller.submitCreateTask()
    expect(source.createCalls).toHaveLength(1)
    expect(source.createCalls[0]).toMatchObject({
      title: '阻塞任务',
      initialStatus: 'blocked',
      blockedReason: '等待上游接口',
    })
  })

  it('restores every typed value from keptInput when the data layer refuses the input', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('原输入')
    source.nextCreate = {
      ok: false,
      code: 'invalid-input',
      message: '标题无效：未写入任何内容。',
      keptInput: { title: '保留的标题', goal: '保留的目标', initialStatus: 'doing', blockedReason: null },
    }
    await controller.submitCreateTask()

    const state = controller.getState()
    expect(state.createForm?.title).toBe('保留的标题')
    expect(state.createForm?.goal).toBe('保留的目标')
    expect(state.createForm?.initialStatus).toBe('doing')
    expect(state.createForm?.error).toContain('标题无效')
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    // A refused input is fixed by the user, not replayed by a button.
    expect(state.feedback.retry).toBeNull()
  })

  it('keeps the old view and reports "created, view not refreshed" when the re-read failed: not a failure, no replay', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('新任务')
    source.nextCreate = {
      ok: true,
      outcome: 'created',
      task: task('t3', 'todo', 0, { title: '新任务' }) as never,
      snapshot: null,
    }
    await controller.submitCreateTask()

    let state = controller.getState()
    expect(state.createForm).toBeNull()
    expect(state.feedback?.kind).toBe('stale-view')
    if (state.feedback?.kind !== 'stale-view') throw new Error('unreachable')
    expect(state.feedback.text).toContain('已创建')
    expect(state.feedback.text).toContain('视图未刷新')
    // The unrefreshed board still shows exactly what it showed before.
    expect(shownTasks(state, 'todo')).toEqual(['t1'])

    const readsBefore = source.reads
    controller.retryPending()
    await flush()
    state = controller.getState()
    expect(source.reads).toBe(readsBefore + 1)
    expect(source.createCalls).toHaveLength(1)
    expect(state.feedback).toBeNull()
  })

  it('offers only a re-read after an unknown creation result and never re-creates on retry', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('不确定的任务')
    source.nextCreate = { ok: false, code: 'unknown-result', message: '创建结果未知，请先核对。' }
    await controller.submitCreateTask()

    let state = controller.getState()
    expect(state.createForm).not.toBeNull()
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.code).toBe('unknown-result')
    expect(state.feedback.retry).toEqual({ kind: 'read' })

    controller.retryPending()
    await flush()
    state = controller.getState()
    expect(source.createCalls).toHaveLength(1)
    expect(state.createForm?.title).toBe('不确定的任务')
  })

  it('reuses the same request id when a confirmed non-landing creation is retried', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openCreateForm()
    controller.setCreateTitle('可重试任务')
    source.nextCreate = { ok: false, code: 'save-failed', message: '创建失败：未创建任何任务。' }
    await controller.submitCreateTask()

    let state = controller.getState()
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.retry?.kind).toBe('create')
    const firstId = source.createCalls[0]?.requestId

    source.nextCreate = {
      ok: true,
      outcome: 'created',
      task: task('t3', 'todo', 0, { title: '可重试任务' }) as never,
      snapshot: snapshot() as never,
    }
    controller.retryPending()
    await flush()

    expect(source.createCalls).toHaveLength(2)
    expect(source.createCalls[1]?.requestId).toBe(firstId)
    state = controller.getState()
    expect(state.createForm).toBeNull()
    expect(state.feedback?.kind).toBe('success')
  })

  it('opens no creation form and sends nothing while the board is not ready', async () => {
    const source = fakeSource()
    const controller = controllerFor(source)

    controller.openCreateForm()
    expect(controller.getState().createForm).toBeNull()
    await controller.submitCreateTask()
    expect(source.createCalls).toHaveLength(0)
    expect(source.reads).toBe(0)
  })
})

describe('task field editing (F01-R05/R06: SAVE-05 baselines, draft kept)', () => {
  it('captures both baselines, saves only the changed field and applies the snapshot', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)

    controller.openDetail('t1')
    controller.openFieldEdit()
    let state = controller.getState()
    expect(state.fieldEdit?.expectedFieldsVersion).toBe('fver1:2')
    expect(state.fieldEdit?.expectedStatusVersion).toBe('ver1:3')
    expect(state.fieldEdit?.title).toBe('标题一')
    expect(state.fieldEdit?.goal).toBe('旧目标')
    expect(state.fieldEdit?.requestId).toBe('op-1')

    controller.setEditTitle('新标题')
    source.nextUpdate = {
      ok: true,
      outcome: 'saved',
      task: task('t1', 'todo', 0, { title: '新标题', goal: '旧目标', fieldsRevision: 3, statusRevision: 3 }) as never,
      changed: ['title'],
      fieldsRevision: 3,
      snapshot: snapshot({
        tasks: [
          task('t1', 'todo', 0, { title: '新标题', goal: '旧目标', fieldsRevision: 3, statusRevision: 3 }),
          task('t2', 'doing', 0),
        ],
      }) as never,
    }
    await controller.saveFieldEdit()

    expect(source.updateCalls).toEqual([{
      taskId: 't1',
      requestId: 'op-1',
      expectedFieldsVersion: 'fver1:2',
      expectedStatusVersion: 'ver1:3',
      title: '新标题',
    }])
    state = controller.getState()
    expect(state.fieldEdit).toBeNull()
    expect(state.detail?.title).toBe('新标题')
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.text).toContain('任务标题')
  })

  it('clears the goal with null and sends no title when only the goal changed', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditGoal('   ')
    await controller.saveFieldEdit()

    expect(source.updateCalls).toEqual([{
      taskId: 't1',
      requestId: 'op-1',
      expectedFieldsVersion: 'fver1:2',
      expectedStatusVersion: 'ver1:3',
      goal: null,
    }])
  })

  it('sends no write when nothing changed and says so', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    await controller.saveFieldEdit()

    expect(source.updateCalls).toHaveLength(0)
    const state = controller.getState()
    expect(state.fieldEdit).not.toBeNull()
    expect(state.feedback).toEqual({ kind: 'validation', text: NO_FIELD_CHANGE_MESSAGE })
  })

  it('refuses a blank title locally, keeping the draft and the error in place', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditTitle('   ')
    await controller.saveFieldEdit()

    expect(source.updateCalls).toHaveLength(0)
    const state = controller.getState()
    expect(state.fieldEdit?.error).toBe(FIELD_TITLE_REQUIRED_MESSAGE)
    expect(state.fieldEdit?.title).toBe('   ')
  })

  it('updates the detail from the returned task and reports "saved, view not refreshed" when snapshot is null', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditTitle('新标题')
    source.nextUpdate = {
      ok: true,
      outcome: 'saved',
      task: task('t1', 'todo', 0, { title: '新标题', goal: '旧目标', fieldsRevision: 3, statusRevision: 3 }) as never,
      changed: ['title'],
      fieldsRevision: 3,
      snapshot: null,
    }
    await controller.saveFieldEdit()

    const state = controller.getState()
    expect(state.fieldEdit).toBeNull()
    expect(state.feedback?.kind).toBe('stale-view')
    if (state.feedback?.kind !== 'stale-view') throw new Error('unreachable')
    expect(state.feedback.text).toContain('已保存')
    expect(state.feedback.text).toContain('视图未刷新')
    // The one task is the data layer's new copy; the board token/read state is kept.
    expect(state.detail?.title).toBe('新标题')
    const view = viewOf(state)
    expect(view?.columns.find((column) => column.status === 'todo')?.tasks[0]?.title).toBe('新标题')
  })

  it('does not promote a failed read to ready when the save landed but the view stayed stale', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    // A transient read failure keeps the known board (REC-05).
    source.nextRead = { ok: false, code: 'read-failed', message: '读取失败' }
    await controller.load()
    expect(controller.getState().read.kind).toBe('failed')

    controller.openFieldEdit()
    expect(controller.getState().fieldEdit).not.toBeNull()
    controller.setEditTitle('新标题')
    source.nextUpdate = {
      ok: true,
      outcome: 'saved',
      task: task('t1', 'todo', 0, { title: '新标题', goal: '旧目标', fieldsRevision: 3, statusRevision: 3 }) as never,
      changed: ['title'],
      fieldsRevision: 3,
      snapshot: null,
    }
    await controller.saveFieldEdit()

    const state = controller.getState()
    expect(state.read.kind).toBe('failed')
    expect(state.feedback?.kind).toBe('stale-view')
    // The open detail has the authoritative copy; the board itself was not read.
    expect(state.detail?.title).toBe('新标题')
  })

  it('shows a stale baseline with both versions, keeps the draft and offers only a re-read', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditTitle('新标题')
    source.nextUpdate = {
      ok: false,
      code: 'stale-baseline',
      message: '字段保存被拒绝：任务已被其他操作更新，本次未写入。',
      current: { status: 'doing', statusVersion: 'ver1:9' },
      baseline: {
        expected: { fieldsVersion: 'fver1:2', statusVersion: 'ver1:3' },
        actual: { fieldsVersion: 'fver1:5', statusVersion: 'ver1:9' },
      },
      keptInput: { title: '新标题', goal: null },
    }
    await controller.saveFieldEdit()

    let state = controller.getState()
    expect(state.fieldEdit?.title).toBe('新标题')
    expect(state.fieldEdit?.goal).toBe('旧目标')
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.code).toBe('stale-baseline')
    expect(state.feedback.retry).toEqual({ kind: 'read' })
    expect(state.feedback.text).toContain('期望字段版本')
    expect(state.feedback.text).toContain('实际')

    const updatesBefore = source.updateCalls.length
    source.nextRead = {
      ok: true,
      snapshot: snapshot({
        tasks: [
          task('t1', 'doing', 0, { title: '标题一', goal: '旧目标', fieldsRevision: 5, statusRevision: 9 }),
          task('t2', 'doing', 0),
        ],
      }) as never,
    }
    controller.retryPending()
    await flush()
    state = controller.getState()
    expect(source.updateCalls).toHaveLength(updatesBefore)
    // The re-read rebases the editor on the new version and keeps the draft.
    expect(state.fieldEdit?.expectedFieldsVersion).toBe('fver1:5')
    expect(state.fieldEdit?.title).toBe('新标题')
  })

  it('keeps the draft on a save-failed and replays the same request id on retry', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditTitle('新标题')
    source.nextUpdate = {
      ok: false,
      code: 'save-failed',
      message: '保存失败：正式值未改变。',
      keptInput: { title: '新标题', goal: null },
    }
    await controller.saveFieldEdit()

    let state = controller.getState()
    expect(state.fieldEdit?.title).toBe('新标题')
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.retry?.kind).toBe('fields')
    const firstId = source.updateCalls[0]?.requestId

    source.nextUpdate = {
      ok: true,
      outcome: 'saved',
      task: task('t1', 'todo', 0, { title: '新标题', goal: '旧目标', fieldsRevision: 3, statusRevision: 3 }) as never,
      changed: ['title'],
      fieldsRevision: 3,
      snapshot: snapshot() as never,
    }
    controller.retryPending()
    await flush()
    expect(source.updateCalls).toHaveLength(2)
    expect(source.updateCalls[1]?.requestId).toBe(firstId)
    expect(controller.getState().fieldEdit).toBeNull()
  })

  it('offers only a re-read after an unknown field-save result and never replays the write', async () => {
    const source = fakeSource({ read: editableRead() })
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()
    controller.setEditTitle('新标题')
    source.nextUpdate = { ok: false, code: 'unknown-result', message: '保存结果未知，请先核对。' }
    await controller.saveFieldEdit()

    let state = controller.getState()
    expect(state.fieldEdit).not.toBeNull()
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.retry).toEqual({ kind: 'read' })

    controller.retryPending()
    await flush()
    state = controller.getState()
    expect(source.updateCalls).toHaveLength(1)
    expect(state.fieldEdit).not.toBeNull()
  })

  it('refuses to open the editor without a fieldsRevision baseline and asks for a re-read', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openDetail('t1')
    controller.openFieldEdit()

    const state = controller.getState()
    expect(state.fieldEdit).toBeNull()
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.text).toBe(FIELDS_BASELINE_MISSING_MESSAGE)
    expect(state.feedback.retry).toEqual({ kind: 'read' })
    expect(source.updateCalls).toHaveLength(0)
  })
})

describe('activity history (F01-R07: explicit, honest, scoped)', () => {
  it('loads the open task activity on demand and maps entries newest-first', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    const entries = [
      activityEntry({ activityId: 'a2', at: '2026-11-11T06:00:00.000Z', code: 'goal-changed', summary: '目标已修改' }),
      activityEntry(),
    ]
    source.nextActivity = { ok: true, entries }
    controller.openDetail('t1')

    await controller.loadTaskActivity()

    expect(source.activityCalls).toEqual([{ scopeKind: 'task', scopeId: 't1' }])
    const state = controller.getState()
    expect(state.taskActivity.kind).toBe('ready')
    if (state.taskActivity.kind !== 'ready') throw new Error('unreachable')
    expect(state.taskActivity.entries.map((entry) => entry.activityId)).toEqual(['a2', 'a1'])
    expect(state.taskActivity.entries[0]?.time).toBe('2026-11-11 06:00:00')
    expect(state.taskActivity.entries[1]?.summary).toBe('任务已创建')
  })

  it('renders an empty history as a legal empty state, never as a failure', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    source.nextActivity = { ok: true, entries: [] }
    controller.openDetail('t1')

    await controller.loadTaskActivity()

    const state = controller.getState()
    expect(state.taskActivity).toEqual({ kind: 'ready', scopeId: 't1', entries: [] })
    expect(state.feedback).toBeNull()
  })

  it('states a failed history with its code/message and reloads only when asked', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    source.nextActivity = { ok: false, code: 'read-failed', message: '活动历史读取失败。' }
    controller.openDetail('t1')
    await controller.loadTaskActivity()

    let state = controller.getState()
    expect(state.taskActivity.kind).toBe('failed')
    if (state.taskActivity.kind !== 'failed') throw new Error('unreachable')
    expect(state.taskActivity.code).toBe('read-failed')
    expect(state.taskActivity.message).toBe('活动历史读取失败。')
    expect(source.activityCalls).toHaveLength(1)

    source.nextActivity = { ok: true, entries: [activityEntry()] }
    await controller.loadTaskActivity()
    state = controller.getState()
    expect(state.taskActivity.kind).toBe('ready')
    expect(source.activityCalls).toHaveLength(2)
  })

  it('loads the project activity for the explicitly selected project', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    source.nextActivity = { ok: true, entries: [activityEntry({ scopeKind: 'project', scopeId: 'ws-1' })] }

    await controller.loadProjectActivity()

    expect(source.activityCalls).toEqual([{ scopeKind: 'project', scopeId: 'ws-1' }])
    const state = controller.getState()
    expect(state.projectActivity.kind).toBe('ready')
    expect(state.taskActivity).toEqual({ kind: 'idle' })
  })

  it('resets the task activity when the detail changes and the project activity when the project changes', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await controller.loadTaskActivity()
    await controller.loadProjectActivity()
    expect(controller.getState().taskActivity.kind).toBe('ready')
    expect(controller.getState().projectActivity.kind).toBe('ready')

    controller.openDetail('t2')
    expect(controller.getState().taskActivity).toEqual({ kind: 'idle' })
    expect(controller.getState().projectActivity.kind).toBe('ready')

    source.nextRead = {
      ok: true,
      snapshot: snapshot({ project: { ...PROJECT, projectId: 'ws-2' } }) as never,
    }
    await controller.selectProject('ws-2')
    expect(controller.getState().projectActivity).toEqual({ kind: 'idle' })
  })

  it('ignores a second load while one request is in flight (no automatic repetition)', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    let calls = 0
    let release: (result: ActivityResult) => void = () => undefined
    source.loadActivity = () => {
      calls += 1
      return new Promise<ActivityResult>((resolve) => { release = resolve })
    }
    controller.openDetail('t1')

    const first = controller.loadTaskActivity()
    const second = controller.loadTaskActivity()
    release({ ok: true, entries: [] })
    await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(controller.getState().taskActivity.kind).toBe('ready')
  })

  it('drops a late activity response whose detail is no longer open', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    let release: (result: ActivityResult) => void = () => undefined
    source.loadActivity = () => new Promise<ActivityResult>((resolve) => { release = resolve })
    controller.openDetail('t1')
    const pending = controller.loadTaskActivity()

    controller.openDetail('t2')
    release({ ok: true, entries: [activityEntry()] })
    await pending

    expect(controller.getState().taskActivity).toEqual({ kind: 'idle' })
  })
})

describe('late responses never resurrect closed areas or a reset selection', () => {
  it('does not reopen the task activity when it was closed before the late answer', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    let release: (result: ActivityResult) => void = () => undefined
    source.loadActivity = () => new Promise<ActivityResult>((resolve) => { release = resolve })
    controller.openDetail('t1')
    const pending = controller.loadTaskActivity()

    controller.closeTaskActivity()
    release({ ok: true, entries: [activityEntry()] })
    await pending

    expect(controller.getState().taskActivity).toEqual({ kind: 'idle' })
  })

  it('does not reopen the project activity when it was closed before the late answer', async () => {
    const source = fakeSource()
    const controller = await loadedController(source)
    let release: (result: ActivityResult) => void = () => undefined
    source.loadActivity = () => new Promise<ActivityResult>((resolve) => { release = resolve })
    const pending = controller.loadProjectActivity()

    controller.closeProjectActivity()
    release({ ok: true, entries: [activityEntry()] })
    await pending

    expect(controller.getState().projectActivity).toEqual({ kind: 'idle' })
  })

  it('drops a late board read after the selection was reset (Q1=B)', async () => {
    const source = fakeSource()
    let release: (result: BoardReadResult) => void = () => undefined
    source.readBoard = () => new Promise<BoardReadResult>((resolve) => { release = resolve })
    const controller = controllerFor(source)

    const selecting = controller.selectProject('ws-1')
    controller.resetSelection()
    release({ ok: true, snapshot: snapshot() as never })
    await selecting

    const state = controller.getState()
    expect(state.selectedProjectId).toBeNull()
    expect(state.read.kind).toBe('selection-required')
  })
})

/* ------------------------------------------------------------------ *
 * F03: manual summary and project overview
 * ------------------------------------------------------------------ */

describe('manual summary (F03-R01/R02/R04/R07: read, edit, draft, preview, save)', () => {
  it('reads the task summary when the detail opens and keeps the official body apart from the draft slot', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    const controller = await loadedController(source)

    controller.openDetail('t1')
    await flush()

    expect(source.summaryReadCalls).toEqual([{ scopeKind: 'task', scopeId: 't1' }])
    const editor = controller.getState().taskSummary
    expect(editor?.status).toBe('ready')
    expect(editor?.text).toBe('旧正文')
    expect(editor?.view?.current?.versionId).toBe('v1')
    expect(editor?.baseline).toEqual({ revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' })
    expect(editor?.editing).toBe(false)
  })

  it('treats current:null as a legal empty state: it is editable and the first save uses the reported baseline', async () => {
    const source = fakeSource()
    source.nextSummaryRead = {
      ok: true,
      summary: summaryView({
        revision: 0,
        applicabilityRevision: 0,
        baseline: { revision: 0, applicabilityRevision: 0, summaryVersionId: null },
        current: null,
        history: [],
      }),
    }
    source.nextSummarySave = {
      ok: true,
      outcome: 'committed',
      revision: 1,
      applicabilityRevision: 0,
      versionId: 'v-first',
      changeKind: 'created',
      consumedDraftIds: [],
      draftUpdateFailures: [],
      needsRecheck: false,
      view: summaryView({
        revision: 1,
        applicabilityRevision: 0,
        baseline: { revision: 1, applicabilityRevision: 0, summaryVersionId: 'v-first' },
        current: summaryVersion({
          versionId: 'v-first',
          seq: 1,
          changeKind: 'created',
          previousVersionId: null,
          content: summaryContent('首次正文'),
        }),
        history: [summaryVersion({
          versionId: 'v-first',
          seq: 1,
          changeKind: 'created',
          previousVersionId: null,
          content: summaryContent('首次正文'),
        })],
      }),
    }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()

    expect(controller.getState().taskSummary?.view?.current).toBeNull()
    expect(controller.getState().taskSummary?.text).toBe('')

    controller.openSummaryEditor('task')
    expect(controller.getState().taskSummary?.editing).toBe(true)
    controller.setSummaryText('task', '首次正文')
    controller.previewSummary('task')
    await controller.saveSummary('task')

    expect(source.summarySaveCalls).toHaveLength(1)
    const call = source.summarySaveCalls[0]
    expect(call?.expected).toEqual({ revision: 0, applicabilityRevision: 0, summaryVersionId: null })
    expect(call?.content).toEqual({ sections: [{ id: 'manual', title: '任务概况', body: '首次正文' }] })
    const state = controller.getState()
    expect(state.taskSummary?.view?.current?.versionId).toBe('v-first')
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.text).toContain(SUMMARY_SAVED_TEXT)
  })

  it('restores the stored draft and marks it unsaved while the official version stays untouched', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView({ draft: summaryDraft('草稿正文') }) }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()

    const editor = controller.getState().taskSummary
    expect(editor?.text).toBe('草稿正文')
    expect(editor?.notice).toContain('草稿')
    expect(editor?.view?.current?.content.sections[0]?.body).toBe('旧正文')
    expect(editor?.dirty).toBe(false)
  })

  it('saves a manual draft without creating an official version', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '草稿正文')

    await controller.saveSummaryDraft('task')

    expect(source.summaryDraftCalls).toHaveLength(1)
    expect(source.summaryDraftCalls[0]).toEqual({
      scopeKind: 'task',
      scopeId: 't1',
      updateId: expect.any(String),
      content: { sections: [{ id: 'manual', title: '任务概况', body: '草稿正文' }] },
    })
    const state = controller.getState()
    expect(state.taskSummary?.draftStatus).toBe('saved')
    expect(state.taskSummary?.notice).toBe(SUMMARY_DRAFT_SAVED_TEXT)
    expect(state.taskSummary?.view?.draft?.draftId).toBe('d-1')
    expect(state.taskSummary?.view?.current?.versionId).toBe('v1')
    expect(source.summarySaveCalls).toHaveLength(0)
  })

  it('keeps the input when a draft save fails and never touches the official content', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummaryDraft = { ok: false, code: 'save-failed', message: '磁盘不可写' }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '草稿正文')

    await controller.saveSummaryDraft('task')

    const editor = controller.getState().taskSummary
    expect(editor?.draftStatus).toBe('failed')
    expect(editor?.draftError).toBe('磁盘不可写')
    expect(editor?.text).toBe('草稿正文')
    expect(editor?.view?.current?.versionId).toBe('v1')
    expect(editor?.notice).toBeNull()
  })

  it('previews against the official body and goes back to editing with the input kept', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView({ draft: summaryDraft('草稿正文') }) }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '旧正文\n新增行')

    controller.previewSummary('task')
    expect(controller.getState().taskSummary?.previewing).toBe(true)

    controller.cancelSummaryPreview('task')
    const editor = controller.getState().taskSummary
    expect(editor?.previewing).toBe(false)
    expect(editor?.editing).toBe(true)
    expect(editor?.text).toBe('旧正文\n新增行')
  })

  it('commits with the read baseline, consumes the saved draft id and reports the new version', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView({ draft: summaryDraft('草稿正文') }) }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '草稿正文')
    controller.previewSummary('task')

    await controller.saveSummary('task')

    expect(source.summarySaveCalls).toHaveLength(1)
    const call = source.summarySaveCalls[0]
    expect(call?.expected).toEqual({ revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' })
    expect(call?.consumeDraftIds).toEqual(['d-1'])
    expect(call?.content).toEqual({ sections: [{ id: 'manual', title: '任务概况', body: '草稿正文' }] })

    const state = controller.getState()
    expect(state.busy).toBeNull()
    expect(state.taskSummary?.editing).toBe(false)
    expect(state.taskSummary?.previewing).toBe(false)
    expect(state.taskSummary?.view?.current?.versionId).toBe('v2')
    expect(state.taskSummary?.view?.draft).toBeNull()
    expect(state.feedback?.kind).toBe('success')
    if (state.feedback?.kind !== 'success') throw new Error('unreachable')
    expect(state.feedback.text).toContain('第 2 版')
  })

  it('reports no-change without claiming a new version', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = {
      ok: true,
      outcome: 'no-change',
      revision: 3,
      summaryVersionId: 'v1',
      view: summaryView(),
    }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '旧正文')
    await controller.saveSummary('task')

    const state = controller.getState()
    expect(state.taskSummary?.editing).toBe(false)
    expect(state.taskSummary?.view?.current?.versionId).toBe('v1')
    expect(state.feedback).toEqual({ kind: 'validation', text: SUMMARY_NO_CHANGE_TEXT })
  })

  it('names an idempotent replay instead of claiming a second save', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = {
      ok: true,
      outcome: 'already-applied',
      revision: 4,
      applicabilityRevision: 1,
      appliedRevision: 3,
      appliedAt: '2026-11-11T06:00:00.000Z',
      versionId: 'v2',
      consumedDraftIds: [],
      view: summaryView({
        revision: 4,
        baseline: { revision: 4, applicabilityRevision: 1, summaryVersionId: 'v2' },
        current: summaryVersion({ versionId: 'v2', seq: 2, changeKind: 'modified', previousVersionId: 'v1' }),
      }),
    }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '旧正文')
    await controller.saveSummary('task')

    const state = controller.getState()
    expect(state.taskSummary?.view?.current?.versionId).toBe('v2')
    expect(state.feedback).toEqual({ kind: 'success', text: SUMMARY_ALREADY_APPLIED_TEXT })
  })

  it('shows a stale view when the write landed but the re-read failed, and only re-reads on retry', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = {
      ok: true,
      outcome: 'committed',
      revision: 4,
      applicabilityRevision: 1,
      versionId: 'v2',
      changeKind: 'modified',
      consumedDraftIds: [],
      draftUpdateFailures: [],
      needsRecheck: false,
      view: null,
    }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '新正文')
    await controller.saveSummary('task')

    const state = controller.getState()
    expect(state.feedback).toEqual({ kind: 'stale-view', text: SUMMARY_SAVED_STALE_TEXT })
    expect(state.taskSummary?.editing).toBe(false)
    expect(state.taskSummary?.notice).toBe(SUMMARY_SAVED_STALE_TEXT)

    const readsBefore = source.reads
    controller.retryPending()
    await flush()
    expect(source.summarySaveCalls).toHaveLength(1)
    expect(source.reads).toBe(readsBefore + 1)
  })

  it('keeps the typed input and offers a re-read on a stale baseline, then rebases on the new baseline', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = {
      ok: false,
      code: 'stale-baseline',
      message: '概况已被其他操作更新，本次未保存；请核对最新内容后再提交。',
      baseline: {
        expected: { revision: 3, applicabilityRevision: 1, summaryVersionId: 'v1' },
        actual: { revision: 5, applicabilityRevision: 1, summaryVersionId: 'v9' },
      },
    }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '我的新正文')
    controller.previewSummary('task')
    await controller.saveSummary('task')

    const failed = controller.getState()
    expect(failed.taskSummary?.editing).toBe(true)
    expect(failed.taskSummary?.text).toBe('我的新正文')
    expect(failed.taskSummary?.error).toContain('期望版本 3')
    expect(failed.taskSummary?.error).toContain('实际 5')
    expect(failed.feedback?.kind).toBe('failure')
    if (failed.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(failed.feedback.retry).toEqual({ kind: 'summary-read', scopeKind: 'task', scopeId: 't1' })

    source.nextSummaryRead = {
      ok: true,
      summary: summaryView({
        revision: 5,
        baseline: { revision: 5, applicabilityRevision: 1, summaryVersionId: 'v9' },
        current: summaryVersion({ versionId: 'v9', seq: 5, changeKind: 'modified', previousVersionId: 'v1' }),
      }),
    }
    controller.retryPending()
    await flush()

    const rebased = controller.getState().taskSummary
    expect(rebased?.baseline).toEqual({ revision: 5, applicabilityRevision: 1, summaryVersionId: 'v9' })
    expect(rebased?.text).toBe('我的新正文')
    expect(rebased?.editing).toBe(true)
    expect(rebased?.notice).toContain('未保存的输入已保留')
  })

  it('treats an unknown save result as read-only: no automatic resend', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = { ok: false, code: 'unknown-result', message: '网络中断' }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '新正文')
    await controller.saveSummary('task')

    const state = controller.getState()
    expect(state.taskSummary?.editing).toBe(true)
    expect(state.taskSummary?.text).toBe('新正文')
    expect(state.feedback?.kind).toBe('failure')
    if (state.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(state.feedback.retry).toEqual({ kind: 'summary-read', scopeKind: 'task', scopeId: 't1' })

    controller.retryPending()
    await flush()
    expect(source.summarySaveCalls).toHaveLength(1)
  })

  it('replays a replay-safe failure with the same update id', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = { ok: false, code: 'save-failed', message: '网络中断' }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '新正文')
    await controller.saveSummary('task')

    const failed = controller.getState().feedback
    expect(failed?.kind).toBe('failure')
    if (failed?.kind !== 'failure') throw new Error('unreachable')
    expect(failed.retry?.kind).toBe('summary-save')
    const firstUpdateId = source.summarySaveCalls[0]?.updateId

    controller.retryPending()
    await flush()
    expect(source.summarySaveCalls).toHaveLength(2)
    expect(source.summarySaveCalls[1]?.updateId).toBe(firstUpdateId)
  })

  it('shows an invalid-input error in place and offers no retry', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    source.nextSummarySave = { ok: false, code: 'invalid-input', message: '概况内容无效' }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '新正文')
    await controller.saveSummary('task')

    const state = controller.getState()
    expect(state.taskSummary?.editing).toBe(true)
    expect(state.taskSummary?.text).toBe('新正文')
    expect(state.taskSummary?.error).toBe('概况内容无效')
    expect(state.feedback).toEqual({ kind: 'failure', text: '概况内容无效', code: 'invalid-input', retry: null })
  })

  it('cancels an edit by restoring the official body, keeping a saved draft', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView({ draft: summaryDraft('草稿正文') }) }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    controller.openSummaryEditor('task')
    controller.setSummaryText('task', '临时输入')

    controller.closeSummaryEditor('task')

    const editor = controller.getState().taskSummary
    expect(editor?.editing).toBe(false)
    expect(editor?.text).toBe('草稿正文')
    expect(editor?.dirty).toBe(false)
  })

  it('offers a re-read after a failed summary read and does not fabricate content', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: false, code: 'read-failed', message: '读取失败' }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()

    const failed = controller.getState()
    expect(failed.taskSummary?.status).toBe('failed')
    expect(failed.taskSummary?.text).toBe('')
    expect(failed.feedback?.kind).toBe('failure')
    if (failed.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(failed.feedback.retry).toEqual({ kind: 'summary-read', scopeKind: 'task', scopeId: 't1' })

    source.nextSummaryRead = null
    controller.retryPending()
    await flush()
    expect(controller.getState().taskSummary?.status).toBe('ready')
  })

  it('treats a null summary view as an inconsistency that can only be re-read', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: null }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()

    const failed = controller.getState()
    expect(failed.taskSummary?.status).toBe('failed')
    expect(failed.taskSummary?.baseline).toBeNull()
    expect(failed.feedback?.kind).toBe('failure')
    if (failed.feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(failed.feedback.retry).toEqual({ kind: 'summary-read', scopeKind: 'task', scopeId: 't1' })

    controller.openSummaryEditor('task')
    expect(controller.getState().taskSummary?.editing).toBe(false)
    expect(controller.getState().feedback?.kind).toBe('failure')
    if (controller.getState().feedback?.kind !== 'failure') throw new Error('unreachable')
    expect(controller.getState().feedback.text).toBe(SUMMARY_BASELINE_MISSING_TEXT)
  })

  it('loads and saves the project overview for the selected project, including an empty official body', async () => {
    const source = fakeSource()
    source.nextSummaryRead = {
      ok: true,
      summary: summaryView({
        scopeKind: 'project',
        scopeId: 'ws-1',
        revision: 0,
        applicabilityRevision: 0,
        baseline: { revision: 0, applicabilityRevision: 0, summaryVersionId: null },
        current: null,
        history: [],
      }),
    }
    source.nextSummarySave = {
      ok: true,
      outcome: 'committed',
      revision: 1,
      applicabilityRevision: 0,
      versionId: 'p1',
      changeKind: 'created',
      consumedDraftIds: [],
      draftUpdateFailures: [],
      needsRecheck: false,
      view: summaryView({
        scopeKind: 'project',
        scopeId: 'ws-1',
        revision: 1,
        applicabilityRevision: 0,
        baseline: { revision: 1, applicabilityRevision: 0, summaryVersionId: 'p1' },
        current: summaryVersion({
          versionId: 'p1',
          seq: 1,
          changeKind: 'created',
          previousVersionId: null,
          content: summaryContent('项目正文', 'project'),
        }),
        history: [summaryVersion({
          versionId: 'p1',
          seq: 1,
          changeKind: 'created',
          previousVersionId: null,
          content: summaryContent('项目正文', 'project'),
        })],
      }),
    }
    const controller = await loadedController(source)

    await controller.loadProjectSummary()
    expect(source.summaryReadCalls).toEqual([{ scopeKind: 'project', scopeId: 'ws-1' }])
    expect(controller.getState().projectSummary?.text).toBe('')

    controller.openSummaryEditor('project')
    controller.setSummaryText('project', '项目正文')
    controller.previewSummary('project')
    await controller.saveSummary('project')

    expect(source.summarySaveCalls[0]?.scopeKind).toBe('project')
    expect(source.summarySaveCalls[0]?.content).toEqual({
      sections: [{ id: 'manual', title: '项目总览', body: '项目正文' }],
    })
    expect(controller.getState().projectSummary?.view?.current?.versionId).toBe('p1')

    controller.closeProjectSummary()
    expect(controller.getState().projectSummary).toBeNull()
  })

  it('drops both summary areas when the project selection changes', async () => {
    const source = fakeSource()
    source.nextSummaryRead = { ok: true, summary: summaryView() }
    const controller = await loadedController(source)
    controller.openDetail('t1')
    await flush()
    await controller.loadProjectSummary()
    expect(controller.getState().taskSummary).not.toBeNull()
    expect(controller.getState().projectSummary).not.toBeNull()

    source.nextRead = {
      ok: true,
      snapshot: snapshot({ project: { ...PROJECT, projectId: 'ws-2' } }) as never,
    }
    await controller.selectProject('ws-2')

    const state = controller.getState()
    expect(state.taskSummary).toBeNull()
    expect(state.projectSummary).toBeNull()
  })

  it('drops a late summary response after the detail was closed', async () => {
    const source = fakeSource()
    let release: (result: SummaryReadResult) => void = () => undefined
    source.readSummary = () => new Promise<SummaryReadResult>((resolve) => { release = resolve })
    const controller = await loadedController(source)

    controller.openDetail('t1')
    controller.closeDetail()
    release({ ok: true, summary: summaryView() })
    await flush()

    expect(controller.getState().taskSummary).toBeNull()
  })
})