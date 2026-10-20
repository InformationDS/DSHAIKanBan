/**
 * Register `/aikanban` from the injected child fiber, with a compatibility path
 * for a DSH 44.7.0 defect in the documented entry point.
 *
 * ## What the host's public surface does
 *
 * `ctx.connection.rpc.handle(channel, handler)` is documented to register an
 * authenticated absolute channel prefix (ADR-005). Its implementation is:
 *
 * ```js
 * get rpc() {
 *   const owner = this.ctx
 *   return { handle: (channel, handler) => this.register(owner, channel, handler) }
 * }
 * // register(owner, ...) => owner.effect(() => owner.webServer.register(route), …)
 * ```
 *
 * ## What we measured in the shipped host (44.7.0)
 *
 * Calling `handle` from an injected child fiber that has both `connection` and
 * `webServer` throws `cannot get property "webServer" without inject`, because
 * cordis's service tracing rebinds `this.ctx` to the *provider's* context
 * (`dsh-client-connection`), so `owner.effect(...)` runs on a fiber that cannot
 * resolve `webServer`. Measured variants in the isolated probe:
 *
 * | access path | result |
 * | --- | --- |
 * | `scoped.connection.rpc.handle(...)` | throws `cannot get property "webServer" without inject` |
 * | `scoped.reflect.get('connection').rpc.handle(...)` | same throw |
 * | host's `register(owner=scoped, …)` (what `handle` calls without the shadowing) | **works** |
 * | same via the `rpc` getter with an explicit `this.ctx` | works |
 *
 * ## Consequence
 *
 * The public path is attempted first and is used unchanged on any host where it
 * works. Only when it throws do we invoke the host's own internal
 * `register(owner, channel, handler)` with the injected child as owner — the
 * same code the public getter would call if it had passed the caller's context.
 * This is a **workaround for a host bug**, kept in one place so it can be
 * deleted the moment the public path works; a failure to find the internal
 * method is reported as `register-failed` (never a silent success).
 *
 * @module @aikanban/dsh-aikanban/scoped-channel-registration
 */

import { createBoardChannelHandler, type HostBoardPort } from './board-channel.js'

/** Outcome of one scoped registration attempt. */
export interface ScopedChannelRegistration {
  /** Whether `connection.rpc.handle` (or its compatibility equivalent) returned. */
  readonly ok: boolean
  /** The registered channel on success, `null` otherwise. */
  readonly channel: string | null
  /**
   * `public` when the documented path worked, `compat` when the workaround was
   * needed, `failed` otherwise. Diagnostic only.
   */
  readonly path: 'public' | 'compat' | 'failed'
  /** Failure description, empty on success. */
  readonly message: string
}

/** The one method `handle` delegates to; `private` in the shipped class, on its prototype at runtime. */
interface HostConnectionInternal {
  register?(owner: unknown, channel: string, handler: unknown): unknown
}

/**
 * Register one channel from a context that injects `connection` and `webServer`.
 *
 * @param connection - the `connection` service as read from the injected child.
 * @param owner - the injected child context (`ctx.inject` callback argument).
 * @param port - the data layer behind the channel.
 * @param channel - the channel to register.
 * @returns whether registration landed, and which path was used.
 */
export function registerBoardChannelInScope(
  connection: unknown,
  owner: unknown,
  port: HostBoardPort,
  channel: string,
): ScopedChannelRegistration {
  const handler = createBoardChannelHandler(port)
  const service = connection as { readonly rpc?: { readonly handle?: unknown } }
  let publicFailure = ''

  // 1. Documented path. Works wherever the host passes the caller context to
  //    `register`; on 44.7.0 it throws, which is what the fallback is for.
  try {
    if (typeof service.rpc?.handle === 'function') {
      ;(service.rpc.handle as (channelName: string, rpcHandler: unknown) => unknown)(channel, handler)
      return { ok: true, channel, path: 'public', message: '' }
    }
    publicFailure = 'connection.rpc.handle is not a function'
  } catch (error) {
    publicFailure = messageOf(error)
  }

  // 2. Compatibility path: call the same internal `register`, but with the
  //    injected child as owner, so `owner.webServer` resolves.
  const proto = typeof connection === 'object' && connection !== null
    ? Object.getPrototypeOf(connection) as HostConnectionInternal | null
    : null
  const register = proto?.register
  if (typeof register !== 'function') {
    return {
      ok: false,
      channel: null,
      path: 'failed',
      message: `connection.rpc.handle failed (${publicFailure}) and the service exposes no register(owner, channel, handler) to fall back to`,
    }
  }
  try {
    register.call(connection, owner, channel, handler)
    return { ok: true, channel, path: 'compat', message: '' }
  } catch (error) {
    return {
      ok: false,
      channel: null,
      path: 'failed',
      message: `connection.rpc.handle failed (${publicFailure}); compatibility register failed: ${messageOf(error)}`,
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
