/**
 * Loader entry for the AIKanBan browser half.
 *
 * The DSH client module system serves `package.json#exports["./client"]` as one
 * classic script and expects it to register exactly one factory:
 *
 * ```js
 * window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => exports })
 * ```
 *
 * The factory's returned exports is what cordis activates as the browser
 * plugin, so `apply` / `inject` must be re-exported **from this module** —
 * that is the whole reason this file exists instead of pointing
 * `exports["./client"]` straight at a library entry. All UI code lives in
 * `@aikanban/plugin-client`; `tsdown.client.config.ts` bundles it in rather
 * than leaving it external.
 *
 * @module @aikanban/dsh-aikanban/client
 */

export { apply, inject, boardPanel, paletteIcon, registerSlots, PANEL_ID } from '@aikanban/plugin-client'
export type { ClientContext, LayoutLike, SlotDisposer, SlotInjectionEffect, SlotRegisterOptions, SlotScope, SlotsLike } from '@aikanban/plugin-client'

/* ------------------------------------------------------------------ *
 * Board layer (F02)
 *
 * Re-exported through the bundle because the loader serves *this* module as the
 * package's client half: the panel, the loader-protocol tests and the channel
 * round-trip test all read the same built artifact, so a missing export fails a
 * test rather than surfacing as a blank panel in a browser.
 * ------------------------------------------------------------------ */

export {
  BLOCKED_STATUS_ID,
  COLLAPSED_BY_DEFAULT_STATUS_ID,
  DETAIL_PLACEHOLDERS,
  NO_CAPABILITIES,
  REOPENABLE_STATUS_IDS,
  buildBoardView,
  deriveCardProgress,
  deriveTaskDetail,
  isBlockedReasonValid,
  isReopenable,
  normalizeReason,
  sortByOrder,
  statusLabelOf,
  toSingleLine,
} from '@aikanban/plugin-client'

export {
  createChannelBoardSource,
  isConnectionLike,
} from '@aikanban/plugin-client'

export {
  CAPABILITY_MISSING_MESSAGE,
  REORDER_SAVED_TEXT,
  UNDO_DONE_TEXT,
  UNKNOWN_PROJECT_MESSAGE,
  createBoardController,
  statusChangedText,
  undoBlockedText,
  writeFailedText,
} from '@aikanban/plugin-client'

export { BOARD_CHANNEL, BOARD_ENDPOINTS, BOARD_FAILURE_CODES } from '@aikanban/plugin-client'

export { createUnavailableBoardSource, nextOperationId } from '@aikanban/plugin-client'

export type {
  BoardActionHint,
  BoardCapabilities,
  BoardColumnInput,
  BoardColumnView,
  BoardFeedback,
  BoardProjectView,
  BoardReadData,
  BoardReadResult,
  BoardReadState,
  BoardSnapshot,
  BoardSource,
  BoardState,
  BoardTask,
  BoardView,
  CardProgress,
  ConnectionLike,
  FormalStatusValue,
  ReorderInput,
  StatusChangeInput,
  StatusDialogState,
  StatusId,
  TaskDetailView,
  TaskProgressView,
  UndoInput,
  WriteResult,
} from '@aikanban/plugin-client'
