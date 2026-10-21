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
  BoardFailureCode,
  BoardReadResult,
  BoardSource,
  FormalStatusValue,
  ProjectListResult,
  ReorderInput,
  StatusChangeInput,
  UndoInput,
  WriteResult,
} from '../src/source.js'
import type { TaskDetailView } from '../src/model.js'

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
  nextRead: BoardReadResult
  nextWrite: WriteResult
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
    nextRead: options.read ?? { ok: true, snapshot: snapshot() as never },
    nextWrite: options.write ?? { ok: true, snapshot: snapshot() as never, undoable: true },
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
