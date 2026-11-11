/**
 * The delayed-ready wrapper around the real core adapter.
 *
 * ## Why the channel is registered before the data layer exists
 *
 * `apply()` is synchronous and must publish its activation signal immediately
 * (`tools/verify-host-import.mjs` depends on it), while opening the storage
 * domain is necessarily asynchronous. Registering the channel late would leave
 * the board unavailable for an unbounded window without any place to report it,
 * so the channel is registered up front with this wrapper instead.
 *
 * ## What it may answer (and what it must never do)
 *
 * - Data layer not ready → read **and** write answer `unavailable`: an explicit
 *   "the board is not usable", never an empty board and never a throw.
 * - Data layer ready → every method forwards to the real adapter with the same
 *   inputs. The adapter owns snapshot mapping, project registration, the
 *   post-write re-read and the §6 error mapping; this file does none of that.
 * - Never throw: the adapter already turns its own exceptions into failure
 *   results, but this wrapper is the component that must stay boring while half
 *   of the system is still booting.
 *
 * @module @aikanban/dsh-aikanban/delayed-board-port
 */

import type {
  HostActivityOutcome,
  HostBoardPort,
  HostCreateTaskOutcome,
  HostProjectListOutcome,
  HostReadOutcome,
  HostUpdateFieldsOutcome,
  HostWriteOutcome,
} from './board-channel.js'

/** What the delayed port needs from the data-layer owner. */
export interface DelayedPortState {
  /** Whether the core model has been created over an opened domain. */
  coreReady(): boolean
  /** Why the last bootstrap attempt failed, or `null`. Diagnostic only. */
  failureReason(): string | null
}

/**
 * Build the delayed-ready board port.
 *
 * @param state - live data-layer state, read on every call (never captured).
 * @param readyPort - the real adapter, used once the data layer is ready.
 * @returns a port safe to hand to `registerBoardChannel` at apply time.
 */
export function createDelayedBoardPort(state: DelayedPortState, readyPort: HostBoardPort): HostBoardPort {
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

  /**
   * The project list is gated exactly like a read: while the data layer is not
   * ready, selecting a project could not produce a board, so the wrapper says
   * "unavailable" instead of offering candidates that cannot be opened.
   */
  const unavailableProjects = (): HostProjectListOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，项目清单暂不可用${reasonSuffix()}；不会猜测或默认选择项目。`,
  })

  /**
   * The management writes are gated exactly like the status writes: while the
   * data layer is not ready nothing may be created or saved, and the answer must
   * be an explicit failure, never a silent success.
   */
  const unavailableCreate = (): HostCreateTaskOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，创建未执行${reasonSuffix()}；未创建任何任务。`,
  })

  const unavailableFields = (): HostUpdateFieldsOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，本次保存未执行${reasonSuffix()}；正式值未改变。`,
  })

  /** Activity history is a read: no data layer means "unavailable", not "no history". */
  const unavailableActivity = (): HostActivityOutcome => ({
    ok: false,
    code: 'unavailable',
    message: `数据层尚未就绪，活动历史暂不可用${reasonSuffix()}；不显示空历史。`,
  })

  return {
    async readBoard(input, signal) {
      return state.coreReady() ? readyPort.readBoard(input, signal) : unavailableRead()
    },
    async listProjects(signal) {
      return state.coreReady() ? readyPort.listProjects(signal) : unavailableProjects()
    },
    async setStatus(input) {
      return state.coreReady() ? readyPort.setStatus(input) : unavailableWrite()
    },
    async reorder(input) {
      return state.coreReady() ? readyPort.reorder(input) : unavailableWrite()
    },
    async undoStatusChange(input) {
      return state.coreReady() ? readyPort.undoStatusChange(input) : unavailableWrite()
    },
    async createTask(input, signal) {
      return state.coreReady() ? readyPort.createTask(input, signal) : unavailableCreate()
    },
    async updateTaskFields(input, signal) {
      return state.coreReady() ? readyPort.updateTaskFields(input, signal) : unavailableFields()
    },
    async readActivity(input, signal) {
      return state.coreReady() ? readyPort.readActivity(input, signal) : unavailableActivity()
    },
  }
}
