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
}

/**
 * Build a {@link BoardSource} that talks to this plugin's own host half.
 *
 * The source holds **no project selection**: every read carries the id the
 * caller was given, and there is no "current project" (Q1=B). The controller is
 * the only owner of the selection.
 *
 * @param connection - the injected `ctx.connection` service.
 * @param options - channel override.
 * @returns a board source whose every failure is explicit.
 */
export function createChannelBoardSource(connection: ConnectionLike, options: ChannelBoardSourceOptions = {}): BoardSource {
  const channel = options.channel ?? BOARD_CHANNEL

  const call = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResultLike> =>
    connection.rpc.call(channel, endpoint, payload)

  const readBoard = async (projectId: string): Promise<BoardReadResult> => {
    // A read without a selection is a caller bug, not a request to guess: refuse
    // locally and send nothing. Controller state is the only source of the id.
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return {
        ok: false,
        code: 'read-failed',
        message: '读取被拒绝：没有显式选择的项目 id；宿主不会猜测项目。',
      }
    }
    const payload: ReadBoardPayload = { projectId }
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
      // REC-03: an unconfirmed write is "unknown". Do not invite a resubmission —
      // the user must first establish the current formal state.
      return {
        ok: false,
        code: 'unknown-result',
        message: `写入结果未知，请先核对当前正式状态，不要重复提交。（${messageOf(error)}）`,
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
        expectedStatusVersion: input.expectedStatusVersion,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
      }
      return write(BOARD_ENDPOINTS.setStatus, payload)
    },
    reorder: (input: ReorderInput) => {
      const payload: ReorderPayload = {
        taskId: input.taskId,
        status: input.status,
        toIndex: input.toIndex,
        operationId: input.operationId,
        expectedStatusVersion: input.expectedStatusVersion,
      }
      return write(BOARD_ENDPOINTS.reorder, payload)
    },
    undoStatusChange: (input: UndoInput) => {
      const payload: UndoStatusPayload = {
        taskId: input.taskId,
        operationId: input.operationId,
        expectedStatusVersion: input.expectedStatusVersion,
        appliedUpdateId: input.appliedUpdateId,
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
