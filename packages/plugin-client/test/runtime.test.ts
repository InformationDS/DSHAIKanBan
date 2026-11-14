/**
 * Runtime-level tests for the late-bound `uiWorkspace` resolver.
 *
 * The real shell may bind `uiWorkspace` after this plugin's `apply()` runs. A
 * one-shot probe would then leave every conversation entry permanently
 * unavailable, so the runtime resolves the service at call time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspacePort } from '../src/controller.js'
import { getBoardController, resetBoardRuntime, setWorkspaceResolver } from '../src/runtime.js'

afterEach(() => {
  resetBoardRuntime()
})

describe('plugin-client: runtime workspace resolver', () => {
  it('resolves uiWorkspace on use, after the controller was created', async () => {
    let port: WorkspacePort | null = null
    const connectWorkspace = vi.fn(async () => 'conversation-1')
    const openSession = vi.fn()

    setWorkspaceResolver(() => port)
    const controller = getBoardController()
    await controller.selectProject('project-1')

    // The service arrives only after the controller (and its previous probe).
    port = { connectWorkspace, openSession }
    await controller.newProjectConversation()

    expect(connectWorkspace).toHaveBeenCalledTimes(1)
    expect(connectWorkspace).toHaveBeenCalledWith('project-1')
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith('conversation-1')
    expect(controller.getState().projectConversation?.phase).toBe('opened')
  })

  it('fails visibly and creates nothing when the service is still absent', async () => {
    setWorkspaceResolver(() => null)
    const controller = getBoardController()
    await controller.selectProject('project-1')

    await controller.newProjectConversation()

    const entry = controller.getState().projectConversation
    expect(entry?.phase).toBe('failed')
    expect(entry?.step).toBe('connect')
    expect(entry?.error).toContain('未找到 uiWorkspace 服务')
    expect(entry?.conversationId).toBeNull()
  })
})
