/**
 * The browser half's data source over DSH's Connection RPC channel.
 *
 * ## The channel
 *
 * `ctx.connection` is a client service provided by `@deepseek-ai/dsh-client-connection`
 * (declared `immediately: true`, so it is composed before any page plugin runs).
 * Its `rpc.call(channel, endpoint, payload, signal)` POSTs to
 * `/<channel>/<endpoint>` and returns the host's `ConnectionRpcResult`. The
 * matching host registration is `ctx.connection.rpc.handle('/aikanban', handler)`,
 * which DSH mounts as an **authenticated** prefix route (Host/Origin checks and
 * the browser token run before our handler). See ADR-005.
 *
 * ## Honesty rules this adapter enforces
 *
 * - A read either returns a *parsed* snapshot or a failure. A malformed response
 *   is a failure (`read-failed`), never an empty board (REC-05).
 * - A write that the transport could not confirm is `unknown-result`, not
 *   "saved" and not "definitely not saved" (REC-03: verify before retrying).
 * - Failure codes are taken from the host's `error.code` when it is one of ours;
 *   anything else is reported as `save-failed` with the host's message.
 *
 * @module @aikanban/plugin-client/channel-source
 */

import type {
  BoardFailureCode,
  BoardReadResult,
  BoardSnapshot,
  BoardSource,
  FormalStatusValue,
  ReorderInput,
  StatusChangeInput,
  UndoInput,
  WriteResult,
} from './source.js'
import {
  BOARD_CHANNEL,
  BOARD_ENDPOINTS,
  isBoardFailureCode,
  parseBoardSnapshotValue,
  parseBoardWriteValue,
  parseFormalStatusValue,
  type ReadBoardPayload,
  type ReorderPayload,
  type SetStatusPayload,
  type UndoStatusPayload,
} from './wire.js'

/* ------------------------------------------------------------------ *
 * The structural view of `ctx.connection`
 * ------------------------------------------------------------------ */

/** DSH's `ConnectionRpcResult`. Mirrored structurally; no import. */
export type ConnectionRpcResultLike =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }

/** DSH's `ClientConnectionRpc`. */
export interface ConnectionRpcLike {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResultLike>
}

/** DSH's client `connection` service, as far as this plugin uses it. */
export interface ConnectionLike {
  readonly rpc: ConnectionRpcLike
}

/**
 * Tolerant probe for the connection service. Used instead of a hard `inject`
 * entry: a declared-but-absent service parks the plugin fiber forever, whereas
 * a probe lets the panel render an explicit failure (REC-05).
 *
 * @param value - a candidate service.
 * @returns whether it can serve as a Connection RPC caller.
 */
export function isConnectionLike(value: unknown): value is ConnectionLike {
  if (typeof value !== 'object' || value === null) return false
  const rpc = (value as { rpc?: unknown }).rpc
  if (typeof rpc !== 'object' || rpc === null) return false
  return typeof (rpc as { call?: unknown }).call === 'function'
}

/* ------------------------------------------------------------------ *
 * Failure mapping
 * ------------------------------------------------------------------ */

/**
 * Read failures are narrowed to the three outcomes the panel can act on:
 * `unknown-project` (its own visible state), `read-failed` (keep data, retry),
 * `unavailable` (no channel). Anything else is a read failure.
 *
 * @param code - the host's code.
 * @returns the read failure code to report.
 */
function readFailureCode(code: unknown): BoardFailureCode {
  if (code === 'unknown-project' || code === 'unavailable') return code
  return 'read-failed'
}

/** Text used when a response cannot be parsed. */
export const MALFORMED_RESPONSE_MESSAGE = '宿主返回的数据格式无效，未改变任何内容。'

function currentFromDetails(details: unknown): FormalStatusValue | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const parsed = parseFormalStatusValue((details as { current?: unknown }).current)
  return parsed ?? undefined
}

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

/** Options for {@link createChannelBoardSource}. */
export interface ChannelBoardSourceOptions {
  /** Channel override; defaults to {@link BOARD_CHANNEL}. */
  readonly channel?: string
  /** Project key to read; absent means "the host's current project". */
  readonly projectId?: string
}

/**
 * Build a {@link BoardSource} that talks to this plugin's own host half.
 *
 * @param connection - the injected `ctx.connection` service.
 * @param options - channel and project selection.
 * @returns a board source whose every failure is explicit.
 */
export function createChannelBoardSource(connection: ConnectionLike, options: ChannelBoardSourceOptions = {}): BoardSource {
  const channel = options.channel ?? BOARD_CHANNEL
  const projectId = options.projectId

  const call = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResultLike> =>
    connection.rpc.call(channel, endpoint, payload)

  const readBoard = async (): Promise<BoardReadResult> => {
    const payload: ReadBoardPayload = projectId === undefined ? {} : { projectId }
    let result: ConnectionRpcResultLike
    try {
      result = await call(BOARD_ENDPOINTS.readBoard, payload)
    } catch (error) {
      return { ok: false, code: 'read-failed', message: `${MALFORMED_RESPONSE_MESSAGE}（${messageOf(error)}）` }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: readFailureCode(result.error.code),
        message: result.error.message,
      }
    }
    const snapshot = parseBoardSnapshotValue(result.value)
    if (snapshot === null) return { ok: false, code: 'read-failed', message: MALFORMED_RESPONSE_MESSAGE }
    const value: BoardSnapshot = snapshot
    return { ok: true, snapshot: value }
  }

  const write = async (
    endpoint: string,
    payload: SetStatusPayload | ReorderPayload | UndoStatusPayload,
  ): Promise<WriteResult> => {
    let result: ConnectionRpcResultLike
    try {
      result = await call(endpoint, payload)
    } catch (error) {
      // REC-03: an unconfirmed write is "unknown", so the UI asks the user to
      // verify instead of offering a blind retry.
      return {
        ok: false,
        code: 'unknown-result',
        message: `写入结果未知，请先核对当前正式状态后重试。（${messageOf(error)}）`,
      }
    }
    if (!result.ok) {
      const current = currentFromDetails(result.error.details)
      return {
        ok: false,
        code: isBoardFailureCode(result.error.code) ? result.error.code : 'save-failed',
        message: result.error.message,
        ...(current === undefined ? {} : { current }),
      }
    }
    const value = parseBoardWriteValue(result.value)
    if (value === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
    }
    if (value.snapshot === null) {
      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
    }
    return { ok: true, snapshot: value.snapshot, undoable: value.undoable }
  }

  return {
    transport: { kind: 'host', detail: `connection rpc ${channel}` },
    readBoard,
    setStatus: (input: StatusChangeInput) => {
      const payload: SetStatusPayload = {
        taskId: input.taskId,
        next: input.next,
        operationId: input.operationId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
        ...(input.expectedStatusVersion === undefined ? {} : { expectedStatusVersion: input.expectedStatusVersion }),
      }
      return write(BOARD_ENDPOINTS.setStatus, payload)
    },
    reorder: (input: ReorderInput) => {
      const payload: ReorderPayload = {
        taskId: input.taskId,
        status: input.status,
        toIndex: input.toIndex,
        operationId: input.operationId,
        ...(input.expectedStatusVersion === undefined ? {} : { expectedStatusVersion: input.expectedStatusVersion }),
      }
      return write(BOARD_ENDPOINTS.reorder, payload)
    },
    undoStatusChange: (input: UndoInput) => {
      const payload: UndoStatusPayload = {
        taskId: input.taskId,
        operationId: input.operationId,
        ...(input.expectedStatusVersion === undefined ? {} : { expectedStatusVersion: input.expectedStatusVersion }),
      }
      return write(BOARD_ENDPOINTS.undoStatusChange, payload)
    },
  }
}

/**
 * Message of an unknown thrown value.
 *
 * @param error - the thrown value.
 * @returns a printable message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
