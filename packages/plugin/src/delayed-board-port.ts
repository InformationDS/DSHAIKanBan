/**
 * The board port the `/aikanban` channel is registered with **before** the data
 * layer is ready, and until the real core adapter lands in P5b.
 *
 * ## Why the channel is registered before the data layer exists
 *
 * `apply()` is synchronous and must publish its activation signal immediately
 * (`tools/verify-host-import.mjs` depends on it), while opening the storage
 * domain is necessarily asynchronous. Registering the channel late would leave
 * the board unavailable for an unbounded window without any place to report it,
 * so the channel is registered up front with this port instead.
 *
 * ## What it may answer (and what it must never do)
 *
 * - Data layer not ready → read **and** write answer `unavailable`: an explicit
 *   "the board is not usable", never an empty board and never a throw.
 * - Data layer ready, adapter not wired yet (P5b) → read answers `read-failed`,
 *   write answers `save-failed` (nothing was written, so the formal value is
 *   unchanged). Message says `not-wired-yet` on purpose so a caller cannot
 *   mistake this milestone's plumbing for a data-layer bug.
 * - Never throw: the channel handler already maps exceptions to unknown results,
 *   but this port is the one component that must stay boring while half of the
 *   system is still booting.
 *
 * @module @aikanban/dsh-aikanban/delayed-board-port
 */

import type { HostBoardPort, HostReadOutcome, HostWriteOutcome } from './board-channel.js'

/** What the delayed port needs from the data-layer owner. */
export interface DelayedPortState {
  /** Whether the core model has been created over an opened domain. */
  coreReady(): boolean
  /** Why the last bootstrap attempt failed, or `null`. Diagnostic only. */
  failureReason(): string | null
}

/** Marker in the pre-adapter failure messages; also asserted by host tests. */
export const NOT_WIRED_MARKER = 'not-wired-yet'

/**
 * Build the delayed-ready board port.
 *
 * @param state - live data-layer state, read on every call (never captured).
 * @returns a port safe to hand to `registerBoardChannel` at apply time.
 */
export function createDelayedBoardPort(state: DelayedPortState): HostBoardPort {
  const reasonSuffix = (): string => {
    const reason = state.failureReason()
    return reason === null || reason === '' ? '' : `（原因：${reason}）`
  }

  const unavailableRead = (): HostReadOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，看板暂不可用${reasonSuffix()}；不显示空看板。`,
  })

  const unavailableWrite = (): HostWriteOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，本次操作未执行${reasonSuffix()}；正式值未改变。`,
  })

  const notWiredRead = (): HostReadOutcome => ({
    ok: false,
    code: 'read-failed',
    message: `数据层已就绪，但看板适配器尚未接线（${NOT_WIRED_MARKER}）；本次读取未发生。`,
  })

  const notWiredWrite = (): HostWriteOutcome => ({
    ok: false,
    code: 'save-failed',
    message: `数据层已就绪，但写入适配器尚未接线（${NOT_WIRED_MARKER}）；本次写入未发生，正式值未改变。`,
  })

  return {
    async readBoard() {
      return state.coreReady() ? notWiredRead() : unavailableRead()
    },
    async setStatus() {
      return state.coreReady() ? notWiredWrite() : unavailableWrite()
    },
    async reorder() {
      return state.coreReady() ? notWiredWrite() : unavailableWrite()
    },
    async undoStatusChange() {
      return state.coreReady() ? notWiredWrite() : unavailableWrite()
    },
  }
}
