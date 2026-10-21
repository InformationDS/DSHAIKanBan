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
  SELECTION_REQUIRED_DESCRIPTION,
  SELECTION_REQUIRED_TITLE,
  type BoardState,
} from '../src/controller.js'
import type { BoardView } from '../src/model.js'

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
    feedback: null,
    busy: null,
    ...overrides,
  }
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
