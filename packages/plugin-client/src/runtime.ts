/**
 * The browser half's runtime: which data source the panel talks to, and the one
 * controller instance that owns the panel's state.
 *
 * ## Why a holder rather than a parameter
 *
 * The seat registry mounts components that take no props
 * (`ctx.slots.register(options, component)`), so the source has to be reachable
 * from the component. Keeping it here also means the transport decision lives in
 * exactly two places: `apply()` in `index.tsx` chooses the source once, and this
 * module hands it to the controller.
 *
 * ## Failure is a state, not a crash
 *
 * Before `apply()` runs — or in a composition with no `connection` service — the
 * source is {@link createUnavailableBoardSource}: every read fails visibly and
 * the panel says so. It never renders an empty board (REC-05).
 *
 * @module @aikanban/plugin-client/runtime
 */

import { createBoardController, type BoardController, type WorkspacePort } from './controller.js'
import { CONVERSATION_UNAVAILABLE_TEXT } from './model.js'
import { createUnavailableBoardSource, type BoardSource } from './source.js'

/** Reason shown when the plugin never found the connection service. */
export const NO_CONNECTION_DETAIL = "未找到 ctx.connection（该组合未挂载 dsh-client-connection）"

let currentSource: BoardSource = createUnavailableBoardSource(NO_CONNECTION_DETAIL)
let currentController: BoardController | null = null
/** The optional browser workspace service (`uiWorkspace`), when present. */
let currentWorkspace: WorkspacePort | null = null
/** A late-bound resolver for `uiWorkspace`; probed on use, never only at apply(). */
let currentWorkspaceResolver: (() => WorkspacePort | null) | null = null

/**
 * Resolve the workspace port now. A resolver is deliberately consulted on every
 * use: `uiWorkspace` is a client service that can be bound after this plugin's
 * `apply()` runs, so a one-shot probe would pin the conversation entry to
 * "unavailable" for the rest of the session.
 *
 * @returns the current port, or null when no service is reachable yet.
 */
function resolveWorkspacePort(): WorkspacePort | null {
  const resolved = currentWorkspaceResolver?.()
  if (resolved !== null && resolved !== undefined) {
    currentWorkspace = resolved
    return resolved
  }
  return currentWorkspace
}

/**
 * Build a port whose two calls resolve the service at call time. This keeps the
 * controller's existing `workspace === null` check meaningful for a genuinely
 * unavailable composition while allowing a late-bound service to start working
 * without recreating the panel.
 *
 * @returns a call-time workspace port.
 */
function createLazyWorkspacePort(): WorkspacePort {
  return {
    connectWorkspace(projectId) {
      const workspace = resolveWorkspacePort()
      if (workspace === null) return Promise.reject(new Error(CONVERSATION_UNAVAILABLE_TEXT))
      return workspace.connectWorkspace(projectId)
    },
    openSession(conversationId) {
      const workspace = resolveWorkspacePort()
      if (workspace === null) throw new Error(CONVERSATION_UNAVAILABLE_TEXT)
      workspace.openSession(conversationId)
    },
  }
}

/**
 * Install the data source. Drops the controller so the next panel mount reads
 * through the new transport (a swap means a different world view).
 *
 * @param source - the source to use from now on.
 */
export function setBoardSource(source: BoardSource): void {
  currentSource = source
  currentController = null
}

/**
 * The source currently installed.
 *
 * @returns the source.
 */
export function getBoardSource(): BoardSource {
  return currentSource
}

/**
 * Install the optional browser workspace service. Drops the controller so the
 * next mount injects the new port (the conversation entry is an optional
 * capability, not a hard dependency).
 *
 * @param workspace - the workspace port, or null when the composition has none.
 */
export function setWorkspacePort(workspace: WorkspacePort | null): void {
  currentWorkspace = workspace
  currentWorkspaceResolver = null
  currentController = null
}

/**
 * Install a late-bound workspace resolver. Unlike {@link setWorkspacePort}, the
 * callback is invoked on every conversation-entry use, so a service bound after
 * `apply()` still becomes reachable. Passing null stops resolving and drops the
 * controller.
 *
 * @param resolver - the resolver, or null to clear it.
 */
export function setWorkspaceResolver(resolver: (() => WorkspacePort | null) | null): void {
  currentWorkspaceResolver = resolver
  currentWorkspace = null
  currentController = null
}

/**
 * The workspace port currently installed, or null.
 *
 * @returns the port, or null.
 */
export function getWorkspacePort(): WorkspacePort | null {
  return resolveWorkspacePort()
}

/**
 * The panel's controller, created on first use.
 *
 * A new controller starts on the explicit `selection-required` state and with no
 * project (Q1=B). The selection lives **only** in `controller.state` — this
 * module deliberately keeps no copy, so nothing can survive a panel mount or be
 * persisted.
 *
 * @returns the controller bound to the installed source.
 */
export function getBoardController(): BoardController {
  const workspace = currentWorkspaceResolver === null ? currentWorkspace : createLazyWorkspacePort()
  currentController ??= createBoardController({ source: currentSource, workspace })
  return currentController
}

/**
 * Replace the controller (used by tests and by an explicit project switch).
 *
 * @param controller - the controller to use, or null to recreate it lazily.
 */
export function setBoardController(controller: BoardController | null): void {
  currentController = controller
}

/**
 * Restore the initial runtime state. Test-only helper, exported so a test can
 * isolate itself without reaching into module internals.
 */
export function resetBoardRuntime(): void {
  currentSource = createUnavailableBoardSource(NO_CONNECTION_DETAIL)
  currentController = null
  currentWorkspace = null
  currentWorkspaceResolver = null
}
