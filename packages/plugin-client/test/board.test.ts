/**
 * Panel-rendering tests for the project selector (Q1=B).
 *
 * The board's React tree is rendered by a **pure** function (`renderBoard`), so
 * these tests need no DOM: they inspect the element tree and invoke the same
 * callbacks a click would. That is enough to pin the rules that are about
 * honesty rather than styling:
 *
 * - the candidate list has explicit loading / failed / empty / populated states;
 * - the populated state distinguishes same-title projects by path;
 * - nothing carries a default/current/recent marker, and nothing is selected
 *   before the user acts;
 * - the board offers an explicit way back to the selector, and the selector
 *   screen does not offer one.
 */
import { describe, expect, it } from 'vitest'

import {
  renderBoard,
  type BoardActions,
} from '../src/board.js'
import {
  ACTIVITY_EMPTY_TEXT,
  ACTIVITY_LOADING_TEXT,
  ACTIVITY_RETRY_TEXT,
  ACTIVITY_TASK_TITLE,
  deriveTaskDetail,
  type ActivityEntryView,
  type BoardTask,
  type BoardView,
} from '../src/model.js'
import {
  SELECTION_REQUIRED_DESCRIPTION,
  SELECTION_REQUIRED_TITLE,
  type BoardState,
  type CreateFormState,
  type FieldEditState,
} from '../src/controller.js'

/* ------------------------------------------------------------------ *
 * Tiny element-tree helpers (React elements are plain objects in node)
 * ------------------------------------------------------------------ */

interface TestElement {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

/** Collect every element whose props contain `attribute`. */
function elementsWith(tree: unknown, attribute: string): TestElement[] {
  const found: TestElement[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const props = (node as { props?: unknown }).props
    if (typeof props !== 'object' || props === null) return
    const record = props as Record<string, unknown>
    if (attribute in record) found.push({ type: (node as TestElement).type, props: record })
    walk(record['children'])
  }
  walk(tree)
  return found
}

/** Concatenate every rendered text leaf. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node === 'object' && node !== null) {
    const props = (node as { props?: Record<string, unknown> }).props
    if (typeof props === 'object' && props !== null) return textOf(props['children'])
  }
  return ''
}

/** Invoke a rendered element's onClick handler as the shell would. */
function click(element: TestElement): void {
  const onClick = element.props['onClick']
  if (typeof onClick !== 'function') throw new Error('the element has no click handler')
  ;(onClick as () => void)()
}

/** Invoke a rendered input's onChange handler as the shell would. */
function change(element: TestElement, value: string): void {
  const onChange = element.props['onChange']
  if (typeof onChange !== 'function') throw new Error('the element has no change handler')
  ;(onChange as (event: { target: { value: string } }) => void)({ target: { value } })
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CAPABILITIES = { statusChange: true, reorder: true, undo: true }

const VIEW: BoardView = {
  project: { projectId: 'ws-1', title: 'Demo', workScopeAvailability: 'ok', workScopeAllowed: true },
  columns: [],
  capabilities: CAPABILITIES,
  boardToken: 'tok-1',
}

const CHOICES = [
  { projectId: 'ws-1', title: 'Demo', path: 'C:/work/demo' },
  { projectId: 'ws-2', title: 'Demo', path: 'D:/archive/demo' },
]

const TASK: BoardTask = {
  taskId: 't1',
  projectId: 'ws-1',
  title: '任务一',
  goal: '目标一',
  status: 'todo',
  statusLabel: '未开始',
  order: 0,
  statusRevision: 2,
  fieldsRevision: 3,
  undoTarget: null,
}

/** A board with one task and the five core columns, for management UI tests. */
const MANAGEMENT_VIEW: BoardView = {
  project: { projectId: 'ws-1', title: 'Demo', workScopeAvailability: 'ok', workScopeAllowed: true },
  columns: [
    { status: 'todo', label: '未开始', collapsedByDefault: false, tasks: [TASK] },
    { status: 'doing', label: '进行中', collapsedByDefault: false, tasks: [] },
    { status: 'blocked', label: '已阻塞', collapsedByDefault: false, tasks: [] },
    { status: 'done', label: '已完成', collapsedByDefault: false, tasks: [] },
    { status: 'cancelled', label: '已取消', collapsedByDefault: true, tasks: [] },
  ],
  capabilities: CAPABILITIES,
  boardToken: 'tok-1',
}

const ACTIVITY_ENTRY: ActivityEntryView = {
  activityId: 'a-1',
  scopeKind: 'task',
  scopeId: 't1',
  at: '2026-11-11T06:00:00.000Z',
  time: '2026-11-11 06:00:00',
  code: 'goal-changed',
  summary: '目标已修改',
  details: [],
}

function state(overrides: Partial<BoardState> = {}): BoardState {
  return {
    read: { kind: 'selection-required', message: SELECTION_REQUIRED_DESCRIPTION },
    projects: { kind: 'loaded', projects: CHOICES },
    transport: { kind: 'host', detail: 'connection rpc /aikanban' },
    selectedProjectId: null,
    cancelledExpanded: false,
    openTaskId: null,
    detail: null,
    statusDialog: null,
    createForm: null,
    fieldEdit: null,
    taskActivity: { kind: 'idle' },
    projectActivity: { kind: 'idle' },
    feedback: null,
    busy: null,
    ...overrides,
  }
}

/** A ready board with the management view and an explicit selection. */
function readyState(overrides: Partial<BoardState> = {}): BoardState {
  return state({
    read: {
      kind: 'ready',
      projectId: 'ws-1',
      boardToken: 'tok-1',
      view: MANAGEMENT_VIEW,
      capabilities: CAPABILITIES,
    },
    selectedProjectId: 'ws-1',
    ...overrides,
  })
}

interface RecordingActions extends BoardActions {
  readonly calls: string[]
}

function recordingActions(): RecordingActions {
  const calls: string[] = []
  return {
    calls,
    onStatusSelect: (taskId, statusId) => { calls.push(`status:${taskId}:${statusId}`) },
    onDragStart: (taskId) => { calls.push(`drag:${taskId}`) },
    onDrop: (status, index) => { calls.push(`drop:${status}:${String(index)}`) },
    onOpenDetail: (taskId) => { calls.push(`detail:${taskId}`) },
    onCloseDetail: () => { calls.push('close-detail') },
    onToggleCollapsed: () => { calls.push('toggle') },
    onRetry: () => { calls.push('retry') },
    onUndo: () => { calls.push('undo') },
    onUndoTask: (taskId) => { calls.push(`undo-task:${taskId}`) },
    onDialogReason: () => { calls.push('dialog-reason') },
    onDialogConfirm: () => { calls.push('dialog-confirm') },
    onDialogCancel: () => { calls.push('dialog-cancel') },
    onSelectProject: (projectId) => { calls.push(`select:${projectId}`) },
    onLoadProjects: () => { calls.push('load-projects') },
    onSwitchProject: () => { calls.push('switch-project') },
    onCreateOpen: () => { calls.push('create-open') },
    onCreateClose: () => { calls.push('create-close') },
    onCreateTitle: (text) => { calls.push(`create-title:${text}`) },
    onCreateGoal: (text) => { calls.push(`create-goal:${text}`) },
    onCreateStatus: (status) => { calls.push(`create-status:${status}`) },
    onCreateBlockedReason: (text) => { calls.push(`create-blocked:${text}`) },
    onCreateSubmit: () => { calls.push('create-submit') },
    onEditOpen: () => { calls.push('edit-open') },
    onEditClose: () => { calls.push('edit-close') },
    onEditTitle: (text) => { calls.push(`edit-title:${text}`) },
    onEditGoal: (text) => { calls.push(`edit-goal:${text}`) },
    onEditSave: () => { calls.push('edit-save') },
    onTaskActivity: () => { calls.push('task-activity') },
    onTaskActivityClose: () => { calls.push('task-activity-close') },
    onProjectActivity: () => { calls.push('project-activity') },
    onProjectActivityClose: () => { calls.push('project-activity-close') },
  }
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('project selector rendering (Q1=B)', () => {
  it('shows a loading state while the candidate list is in flight — no fabricated entry', () => {
    const tree = renderBoard(state({ projects: { kind: 'loading' } }), recordingActions())

    expect(textOf(tree)).toContain(SELECTION_REQUIRED_TITLE)
    expect(textOf(tree)).toContain('正在加载项目')
    expect(elementsWith(tree, 'data-aikanban-project')).toHaveLength(0)
    expect(elementsWith(tree, 'data-aikanban-projects-retry')).toHaveLength(0)
  })

  it('states a failed listing with an inline retry and never renders it as an empty list', () => {
    const actions = recordingActions()
    const tree = renderBoard(
      state({
        projects: { kind: 'failed', code: 'unavailable', message: '项目清单通道未接通，未读取任何项目。' },
        feedback: {
          kind: 'failure',
          text: '项目清单通道未接通，未读取任何项目。',
          code: 'unavailable',
          retry: { kind: 'read' },
        },
      }),
      actions,
    )

    expect(textOf(tree)).toContain('项目清单通道未接通')
    expect(elementsWith(tree, 'data-aikanban-project')).toHaveLength(0)
    // The selector owns this failure: one message, one retry, no duplicate banner.
    const retry = elementsWith(tree, 'data-aikanban-projects-retry')
    expect(retry).toHaveLength(1)
    expect(textOf(tree)).not.toContain('没有可用项目')
    expect(elementsWith(tree, 'data-aikanban-feedback')).toHaveLength(0)
    click(retry[0] as TestElement)
    expect(actions.calls).toEqual(['load-projects'])
  })

  it('states an empty registry as 「没有可用项目」, not as a board and not as a default project', () => {
    const actions = recordingActions()
    const tree = renderBoard(state({ projects: { kind: 'loaded', projects: [] } }), actions)

    expect(textOf(tree)).toContain('没有可用项目')
    expect(elementsWith(tree, 'data-aikanban-project')).toHaveLength(0)
    // An empty list may be refreshed, but nothing is chosen on the user's behalf.
    const refresh = elementsWith(tree, 'data-aikanban-projects-refresh')
    expect(refresh).toHaveLength(1)
    click(refresh[0] as TestElement)
    expect(actions.calls).toEqual(['load-projects'])
    expect(actions.calls.some((call) => call.startsWith('select:'))).toBe(false)
  })

  it('renders one explicit choice per project, with path distinguishing equal titles, and no default marker', () => {
    const tree = renderBoard(state(), recordingActions())
    const buttons = elementsWith(tree, 'data-aikanban-project')

    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.props['data-aikanban-project']).toBe('ws-1')
    expect(buttons[1]?.props['data-aikanban-project']).toBe('ws-2')
    expect(textOf(buttons[0])).toContain('Demo')
    expect(textOf(buttons[0])).toContain('C:/work/demo')
    expect(textOf(buttons[1])).toContain('D:/archive/demo')

    for (const button of buttons) {
      // No entry is visually "the selected one" before the user acts, and none
      // claims to be a default, a recent or a recommendation (Q1=B).
      expect(button.props['aria-selected']).toBeUndefined()
      expect(button.props['aria-pressed']).toBeUndefined()
      expect(button.props['aria-current']).toBeUndefined()
      for (const forbidden of ['默认项目', '最近使用', '推荐']) {
        expect(textOf(button)).not.toContain(forbidden)
      }
    }
  })

  it('passes the explicitly clicked project id to onSelectProject — nothing is selected automatically', () => {
    const actions = recordingActions()
    const tree = renderBoard(state(), actions)
    const buttons = elementsWith(tree, 'data-aikanban-project')

    expect(actions.calls).toEqual([])
    click(buttons[1] as TestElement)
    expect(actions.calls).toEqual(['select:ws-2'])
  })

  it('offers 「切换项目」 only once a project was selected, and it returns to the selector', () => {
    const actions = recordingActions()
    const selectable = state()
    expect(elementsWith(renderBoard(selectable, actions), 'data-aikanban-switch-project')).toHaveLength(0)
    expect(actions.calls).toEqual([])

    const board = state({
      read: { kind: 'ready', projectId: 'ws-1', boardToken: 'tok-1', view: VIEW, capabilities: CAPABILITIES },
      selectedProjectId: 'ws-1',
    })
    const tree = renderBoard(board, actions)
    const switchButtons = elementsWith(tree, 'data-aikanban-switch-project')
    expect(switchButtons).toHaveLength(1)
    click(switchButtons[0] as TestElement)
    // The action drops the selection and re-reads the candidate list; the
    // controller test pins that behaviour, this pins the entry point exists.
    expect(actions.calls).toEqual(['switch-project'])
  })
})

/* ------------------------------------------------------------------ *
 * Slice B: creation, inline edit, activity history
 * ------------------------------------------------------------------ */

describe('task creation UI (F01-R02/R03)', () => {
  it('offers 「新建任务」 only on a ready board — not on the selector and not on a stale kept view', () => {
    const actions = recordingActions()
    expect(elementsWith(renderBoard(state(), actions), 'data-aikanban-create')).toHaveLength(0)

    const failed = readyState({
      read: {
        kind: 'failed',
        projectId: 'ws-1',
        code: 'read-failed',
        message: '读取失败',
        kept: MANAGEMENT_VIEW,
        capabilities: CAPABILITIES,
      },
    })
    expect(elementsWith(renderBoard(failed, actions), 'data-aikanban-create')).toHaveLength(0)
    expect(actions.calls).toEqual([])

    const tree = renderBoard(readyState(), actions)
    const buttons = elementsWith(tree, 'data-aikanban-create')
    expect(buttons).toHaveLength(1)
    click(buttons[0] as TestElement)
    expect(actions.calls).toEqual(['create-open'])
  })

  it('renders the form with title, goal, the board columns and the blocked reason only for the blocked status', () => {
    const actions = recordingActions()
    const form = (initialStatus: string): CreateFormState => ({
      title: '输入中的标题',
      goal: '输入中的目标',
      initialStatus,
      blockedReason: initialStatus === 'blocked' ? '等接口' : '',
      error: null,
      requestId: 'op-1',
    })

    const free = renderBoard(readyState({ createForm: form('todo') }), actions)
    expect(elementsWith(free, 'data-aikanban-create-form')).toHaveLength(1)
    expect(elementsWith(free, 'data-aikanban-create-title')[0]?.props['value']).toBe('输入中的标题')
    expect(elementsWith(free, 'data-aikanban-create-goal')[0]?.props['value']).toBe('输入中的目标')
    expect(elementsWith(free, 'data-aikanban-create-blocked-reason')).toHaveLength(0)
    // The status select offers exactly the data layer's columns.
    const status = elementsWith(free, 'data-aikanban-create-status')[0] as TestElement
    expect(status.props['value']).toBe('todo')
    const options = Array.isArray(status.props['children']) ? status.props['children'] as TestElement[] : []
    expect(options.map((option) => option.props['value'])).toEqual(['todo', 'doing', 'blocked', 'done', 'cancelled'])

    const blocked = renderBoard(readyState({ createForm: form('blocked') }), actions)
    expect(elementsWith(blocked, 'data-aikanban-create-blocked-reason')).toHaveLength(1)
    expect(textOf(blocked)).toContain('阻塞原因（必填）')
  })

  it('shows the in-place error and wired submit/cancel/field callbacks', () => {
    const actions = recordingActions()
    const form: CreateFormState = {
      title: '标题',
      goal: '目标',
      initialStatus: 'blocked',
      blockedReason: '',
      error: '进入「已阻塞」必须填写原因，否则状态不变。',
      requestId: 'op-1',
    }
    const tree = renderBoard(readyState({ createForm: form, busy: { kind: 'create' } }), actions)

    expect(elementsWith(tree, 'data-aikanban-create-error')).toHaveLength(1)
    expect(textOf(tree)).toContain('必须填写原因')
    // While submitting the buttons are disabled and the form says so.
    expect(elementsWith(tree, 'data-aikanban-create-submit')[0]?.props['disabled']).toBe(true)
    expect(textOf(tree)).toContain('正在创建任务')

    change(elementsWith(tree, 'data-aikanban-create-title')[0] as TestElement, '改过的标题')
    change(elementsWith(tree, 'data-aikanban-create-goal')[0] as TestElement, '改过的目标')
    change(elementsWith(tree, 'data-aikanban-create-status')[0] as TestElement, 'doing')
    change(elementsWith(tree, 'data-aikanban-create-blocked-reason')[0] as TestElement, '等接口')
    click(elementsWith(tree, 'data-aikanban-create-submit')[0] as TestElement)
    click(elementsWith(tree, 'data-aikanban-create-cancel')[0] as TestElement)

    expect(actions.calls).toEqual([
      'create-title:改过的标题',
      'create-goal:改过的目标',
      'create-status:doing',
      'create-blocked:等接口',
      'create-submit',
      'create-close',
    ])
  })
})

describe('inline field editing UI (F01-R05/R06)', () => {
  it('offers an edit entry in the detail and renders the draft editor with save/cancel', () => {
    const actions = recordingActions()
    const detail = deriveTaskDetail(TASK)
    const viewing = renderBoard(readyState({ openTaskId: 't1', detail }), actions)
    const editEntries = elementsWith(viewing, 'data-aikanban-edit')
    expect(editEntries).toHaveLength(1)
    click(editEntries[0] as TestElement)
    expect(actions.calls).toEqual(['edit-open'])

    const edit: FieldEditState = {
      taskId: 't1',
      title: '草稿标题',
      goal: '草稿目标',
      error: '任务标题不能为空（只有空白字符同样无效）。',
      requestId: 'op-2',
      expectedFieldsVersion: 'fver1:3',
      expectedStatusVersion: 'ver1:2',
    }
    const editing = renderBoard(readyState({ openTaskId: 't1', detail, fieldEdit: edit }), actions)
    expect(elementsWith(editing, 'data-aikanban-edit-form')).toHaveLength(1)
    expect(elementsWith(editing, 'data-aikanban-edit')).toHaveLength(0)
    expect(elementsWith(editing, 'data-aikanban-edit-error')).toHaveLength(1)
    expect(textOf(editing)).toContain('任务标题不能为空')
    expect(elementsWith(editing, 'data-aikanban-edit-title')[0]?.props['value']).toBe('草稿标题')

    change(elementsWith(editing, 'data-aikanban-edit-title')[0] as TestElement, '新草稿')
    change(elementsWith(editing, 'data-aikanban-edit-goal')[0] as TestElement, '新目标')
    click(elementsWith(editing, 'data-aikanban-save-edit')[0] as TestElement)
    click(elementsWith(editing, 'data-aikanban-cancel-edit')[0] as TestElement)

    expect(actions.calls).toEqual([
      'edit-open',
      'edit-title:新草稿',
      'edit-goal:新目标',
      'edit-save',
      'edit-close',
    ])
  })
})

describe('activity history UI (F01-R07)', () => {
  const detail = deriveTaskDetail(TASK)

  it('renders the task activity on demand with loading, populated, empty and failed states', () => {
    const actions = recordingActions()

    const idle = renderBoard(readyState({ openTaskId: 't1', detail }), actions)
    const openers = elementsWith(idle, 'data-aikanban-task-activity-button')
    expect(openers).toHaveLength(1)
    expect(textOf(openers[0])).toContain(ACTIVITY_TASK_TITLE)
    click(openers[0] as TestElement)
    expect(actions.calls).toEqual(['task-activity'])

    const loading = renderBoard(
      readyState({ openTaskId: 't1', detail, taskActivity: { kind: 'loading', scopeId: 't1' } }),
      actions,
    )
    expect(elementsWith(loading, 'data-aikanban-activity-loading')).toHaveLength(1)
    expect(textOf(loading)).toContain(ACTIVITY_LOADING_TEXT)

    const ready = renderBoard(
      readyState({
        openTaskId: 't1',
        detail,
        taskActivity: { kind: 'ready', scopeId: 't1', entries: [ACTIVITY_ENTRY] },
      }),
      actions,
    )
    expect(elementsWith(ready, 'data-aikanban-task-activity')).toHaveLength(1)
    expect(elementsWith(ready, 'data-aikanban-activity-entry')).toHaveLength(1)
    expect(textOf(ready)).toContain('目标已修改')
    expect(textOf(ready)).toContain('2026-11-11 06:00:00')
    click(elementsWith(ready, 'data-aikanban-activity-close')[0] as TestElement)
    expect(actions.calls).toEqual(['task-activity', 'task-activity-close'])

    const empty = renderBoard(
      readyState({ openTaskId: 't1', detail, taskActivity: { kind: 'ready', scopeId: 't1', entries: [] } }),
      actions,
    )
    expect(elementsWith(empty, 'data-aikanban-activity-empty')).toHaveLength(1)
    expect(textOf(empty)).toContain(ACTIVITY_EMPTY_TEXT)
    expect(textOf(empty)).not.toContain('失败')

    const failed = renderBoard(
      readyState({
        openTaskId: 't1',
        detail,
        taskActivity: { kind: 'failed', scopeId: 't1', code: 'read-failed', message: '活动历史读取失败。' },
      }),
      actions,
    )
    expect(elementsWith(failed, 'data-aikanban-activity-failed')[0]?.props['data-aikanban-activity-failed']).toBe('read-failed')
    expect(textOf(failed)).toContain('活动历史读取失败。')
    expect(elementsWith(failed, 'data-aikanban-activity-empty')).toHaveLength(0)
    const reloads = elementsWith(failed, 'data-aikanban-activity-reload')
    expect(reloads).toHaveLength(1)
    expect(textOf(reloads[0])).toContain(ACTIVITY_RETRY_TEXT)
    click(reloads[0] as TestElement)
    expect(actions.calls).toEqual(['task-activity', 'task-activity-close', 'task-activity'])
  })

  it('renders the project activity under the project header for the selected project', () => {
    const actions = recordingActions()
    const idle = renderBoard(readyState(), actions)
    const openers = elementsWith(idle, 'data-aikanban-project-activity-button')
    expect(openers).toHaveLength(1)
    click(openers[0] as TestElement)
    expect(actions.calls).toEqual(['project-activity'])

    const ready = renderBoard(
      readyState({
        projectActivity: {
          kind: 'ready',
          scopeId: 'ws-1',
          entries: [{ ...ACTIVITY_ENTRY, scopeKind: 'project', scopeId: 'ws-1' }],
        },
      }),
      actions,
    )
    expect(elementsWith(ready, 'data-aikanban-project-activity')).toHaveLength(1)
    expect(elementsWith(ready, 'data-aikanban-activity-entry')).toHaveLength(1)
    click(elementsWith(ready, 'data-aikanban-activity-close')[0] as TestElement)
    expect(actions.calls).toEqual(['project-activity', 'project-activity-close'])

    const failed = renderBoard(
      readyState({ projectActivity: { kind: 'failed', scopeId: 'ws-1', code: 'read-failed', message: '读取失败。' } }),
      actions,
    )
    click(elementsWith(failed, 'data-aikanban-activity-reload')[0] as TestElement)
    expect(actions.calls).toEqual(['project-activity', 'project-activity-close', 'project-activity'])
  })
})

describe('write-landed / view-stale feedback (REC-01/REC-05)', () => {
  it('renders a stale view as a confirmation with a re-read, never as a failure', () => {
    const actions = recordingActions()
    const tree = renderBoard(
      readyState({ feedback: { kind: 'stale-view', text: '任务已创建，但看板视图未刷新。请重新读取。' } }),
      actions,
    )

    expect(elementsWith(tree, 'data-aikanban-feedback')[0]?.props['data-aikanban-feedback']).toBe('stale-view')
    expect(textOf(tree)).toContain('视图未刷新')
    const refresh = elementsWith(tree, 'data-aikanban-refresh-view')
    expect(refresh).toHaveLength(1)
    click(refresh[0] as TestElement)
    expect(actions.calls).toEqual(['retry'])
  })
})
