/**
 * Runtime-level tests for the late-bound `uiWorkspace` resolver.
 *
 * The real shell may bind `uiWorkspace` after this plugin's `apply()` runs. A
 * one-shot probe would then leave every conversation entry permanently
 * unavailable, so the runtime resolves the service at call time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspacePort } from '../src/controller.js'
import {
  getBoardController,
  resetBoardRuntime,
  setBoardSource,
  setWorkspaceResolver,
} from '../src/runtime.js'
import { createUnavailableBoardSource, type BoardSource } from '../src/source.js'

afterEach(() => {
  resetBoardRuntime()
})

function sourceWithFreshConversation(): BoardSource {
  const conversationId = 'conversation-1'
  return {
    ...createUnavailableBoardSource('runtime-test'),
    createConversation: async () => ({ ok: true, conversationId }),
  }
}

describe('plugin-client: runtime workspace resolver', () => {
  it('resolves uiWorkspace on use, after the controller was created', async () => {
    let port: WorkspacePort | null = null
    const openSession = vi.fn()
    setBoardSource(sourceWithFreshConversation())
    setWorkspaceResolver(() => port)
    const controller = getBoardController()
    await controller.selectProject('project-1')

    // The service arrives only after the controller (and its previous probe).
    port = { connectWorkspace: async () => 'unused', openSession }
    await controller.newProjectConversation()

    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith('conversation-1')
    expect(controller.getState().projectConversation?.phase).toBe('opened')
  })

  it('fails visibly and creates nothing when the service is still absent', async () => {
    const createConversation = vi.fn(async () => ({ ok: true as const, conversationId: 'conversation-1' }))
    setBoardSource({ ...createUnavailableBoardSource('runtime-test'), createConversation })
    setWorkspaceResolver(() => null)
    const controller = getBoardController()
    await controller.selectProject('project-1')

    await controller.newProjectConversation()

    const entry = controller.getState().projectConversation
    expect(createConversation).not.toHaveBeenCalled()
    expect(entry?.phase).toBe('failed')
    expect(entry?.step).toBe('connect')
    expect(entry?.error).toContain('未找到 uiWorkspace 服务')
    expect(entry?.conversationId).toBeNull()
  })
})
