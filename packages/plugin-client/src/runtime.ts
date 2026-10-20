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

import { createBoardController, type BoardController } from './controller.js'
import { createUnavailableBoardSource, type BoardSource } from './source.js'

/** Reason shown when the plugin never found the connection service. */
export const NO_CONNECTION_DETAIL = "未找到 ctx.connection（该组合未挂载 dsh-client-connection）"

let currentSource: BoardSource = createUnavailableBoardSource(NO_CONNECTION_DETAIL)
let currentController: BoardController | null = null

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
  currentController ??= createBoardController({ source: currentSource })
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
}
