/**
 * AIKanBan host half — one-file cordis plugin, zero `@deepseek-ai/*` runtime
 * imports.
 *
 * ## Why this file has no DSH imports
 *
 * The plugin loader mounts a composition row by importing this package and
 * reading the exported `apply(ctx)` / `inject` pair. Everything the plugin
 * needs at runtime (`tools`, `systemPrompt`, …) is *provided by the host*
 * through the cordis context, so importing the corresponding packages here
 * would only buy types while adding a resolvable-at-runtime dependency. The
 * context is instead described by the minimal structural interfaces below,
 * and the services are probed tolerantly (`ctx.reflect.get(name, false)` plus
 * the `internal/service` event) exactly like the shipped `dsh-genui` does.
 * Result: this half's import graph is `node:*`-free and package-free, which is
 * what `tools/verify-host-import.mjs` asserts.
 *
 * ## What it registers
 *
 * 1. A **startup log line** carrying {@link ACTIVATION_MARKER_PREFIX} plus the
 *    activation id — visible in the host's own log stream.
 * 2. A **read-only diagnostic tool** `aikanban_status`. This is the strongest
 *    load-verification handle available: it appears in `Tool.listTools()`, and
 *    calling it returns the full activation snapshot (apply timing, which
 *    services bound, which registrations landed). "The package merely
 *    resolved" and "the plugin actually activated" are distinguishable from
 *    outside the process because of this tool.
 * 3. The **`/aikanban` board channel** on `ctx.connection` (ADR-005). The
 *    registration is mounted synchronously through a `ctx.inject(['connection',
 *    'webServer'])` child fiber — the host's `rpc.handle` performs the route
 *    registration from the *reading* context and therefore needs `webServer` in
 *    the injector graph, without making it a hard dependency of this fiber. The
 *    port is delayed-ready: reads and writes answer an explicit failure until
 *    the data layer is ready, never an empty board and never a throw.
 *    Registration outcomes are published on {@link BOARD_CHANNEL_EVENT}.
 * 4. The **data layer**: asynchronously opens the `aikanban_core` storage
 *    domain and creates the core model over it (`data-layer.ts`). The result is
 *    mirrored into the activation snapshot's `dataLayerReady` and republished;
 *    failures stay visible instead of being presented as an empty board.
 *
 * Business behaviour (project/task records, paired confirmation, board data)
 * lives in `packages/core` (workstream S0-W2); the core→board adapter is the
 * next step (P5b), so the channel currently answers `not-wired-yet` once the
 * data layer is ready.
 *
 * @module @aikanban/dsh-aikanban
 */

import type { KanbanCore } from '@aikanban/core'
import { BOARD_CHANNEL } from '@aikanban/plugin-client/wire'

import {
  isHostConnectionLike,
  registerBoardChannel,
  type HostConnectionLike,
} from './board-channel.js'
import { createDelayedBoardPort } from './delayed-board-port.js'
import {
  isStorageDomainLike,
  openDataLayer,
  type StorageDomainLike,
} from './data-layer.js'
import { registerBoardChannelInScope } from './scoped-channel-registration.js'

/** Version reported by the diagnostic tool. Kept in sync with package.json. */
export const PLUGIN_VERSION = '0.0.0'

/**
 * The log prefix that identifies an AIKanBan activation in host stdout/stderr.
 *
 * **A log line is not a reliable load probe.** The cordis logger is an
 * in-memory ring buffer plus registered *exporters*; the shipped `dsh` app
 * registers no console exporter in the profiles we measured, so `logger.warn`
 * never reaches stdout even though it runs. See {@link publishActivationSignal}
 * for the surface that is actually observable from outside the process.
 */
export const ACTIVATION_MARKER_PREFIX = '[aikanban] active'

/**
 * Diagnostics-channel name published once per activation.
 *
 * Node's `node:diagnostics_channel` is the supported way for library code to
 * expose an internal event without a console sink: publishing costs a map
 * lookup when nobody subscribes, and a probe or test can subscribe from the
 * same process — an isolated host can therefore *observe* the activation with
 * `--import` and no source change. The channel is `[aikanban]`-prefixed so no
 * DSH channel is shadowed.
 */
export const ACTIVATION_CHANNEL = 'aikanban:activation'

/**
 * Diagnostics-channel name for `/aikanban` registration outcomes.
 *
 * Published once per registration attempt: an attempt with no `connection`
 * service reports `registered:false, reason:'no-connection'`, a failed
 * `rpc.handle` reports `registered:false, reason:'register-failed'`, and a
 * successful registration reports `registered:true, reason:null`. The probe
 * waits for the `registered:true` line; an earlier "not yet" line is expected
 * because services arrive after `apply()`.
 */
export const BOARD_CHANNEL_EVENT = 'aikanban:board-channel'

/** Why the board channel is (or is not) registered. */
export type BoardChannelRegistrationReason = 'no-connection' | 'register-failed' | null

/** Payload of one {@link BOARD_CHANNEL_EVENT} message. */
export interface BoardChannelEventPayload {
  /** The channel the registration targets ({@link BOARD_CHANNEL} on failure). */
  readonly channel: string
  /** Whether `connection.rpc.handle(channel, handler)` returned. */
  readonly registered: boolean
  /** Why it did not register; `null` on success. */
  readonly reason: BoardChannelRegistrationReason
  /** Epoch milliseconds of the attempt. */
  readonly at: number
}

/**
 * Names taken from the environment shape so both branch arms typecheck.
 *
 * `node:diagnostics_channel` exposes `channel(name)` — a module-level `publish`
 * does **not** exist. Reaching for one throws a TypeError that the `catch` below
 * would swallow silently, leaving the activation invisible with no diagnostic;
 * the shipped probe caught exactly that. Import is lazy via
 * `process.getBuiltinModule` so the module graph gains no builtin dependency.
 */
interface DiagnosticsChannelModuleLike {
  channel(name: string): { publish(payload: unknown): void }
}

/**
 * Best-effort publish of one diagnostics event. Never throws: observability
 * must not fail a plugin activation or a registration.
 *
 * @param channelName - the `aikanban:`-prefixed diagnostics channel.
 * @param payload - the event payload.
 */
function publishDiagnostic(channelName: string, payload: unknown): void {
  try {
    const loader = (globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown }
    }).process?.getBuiltinModule
    if (typeof loader !== 'function') return
    const dc = loader('node:diagnostics_channel') as DiagnosticsChannelModuleLike | undefined
    dc?.channel(channelName).publish(payload)
  } catch {
    // Observability is optional; activation and registration are not.
  }
}

/**
 * Best-effort publish of one activation event.
 *
 * @param payload - the activation snapshot to publish.
 */
export function publishActivationSignal(payload: ActivationSnapshot): void {
  publishDiagnostic(ACTIVATION_CHANNEL, payload)
}

/**
 * Best-effort publish of one board-channel registration event.
 *
 * @param payload - the registration outcome to publish.
 */
export function publishBoardChannelSignal(payload: BoardChannelEventPayload): void {
  publishDiagnostic(BOARD_CHANNEL_EVENT, payload)
}

/** Name under which the diagnostic tool registers in the `tools` service. */
export const STATUS_TOOL_NAME = 'aikanban_status'

/**
 * Ordered record of what `apply()` did, surfaced by the diagnostic tool. Kept
 * as data (not just log lines) so the client half and the probe host can both
 * read it back after the fact.
 */
export interface ActivationSnapshot {
  /** Always {@link ACTIVATION_MARKER_PREFIX}; lets a consumer assert identity. */
  readonly marker: string
  readonly plugin: string
  readonly version: string
  /** Stable per-process id, so two activations of the same build differ. */
  readonly activationId: string
  /** Epoch milliseconds when `apply()` was entered. */
  readonly startedAt: number
  /** Epoch milliseconds when `apply()` returned. */
  readonly appliedAt: number
  /** `process.pid` when available; `null` in a browser-like host. */
  readonly pid: number | null
  /** Whether the diagnostic tool reached the `tools` registry. */
  readonly statusToolRegistered: boolean
  /** Whether the system-prompt section landed (needs `systemPrompt`). */
  readonly promptSectionRegistered: boolean
  /** Whether `/aikanban` was registered on the host `connection` service. */
  readonly boardChannelRegistered: boolean
  /** The registered board channel, or `null` while it is not registered. */
  readonly boardChannel: string | null
  /** Whether the `aikanban_core` domain opened and the core model was created. */
  readonly dataLayerReady: boolean
  /** Service names that were present when probed, in first-observation order. */
  readonly servicesObserved: readonly string[]
}

/* ------------------------------------------------------------------ *
 * Structural view of the host context.
 *
 * Deliberately minimal and `unknown`-centric: the plugin must not depend on
 * the host's own type packages being resolvable at build time. Each interface
 * documents the exact shape the shipped host uses.
 * ------------------------------------------------------------------ */

/** `ctx.logger` — cordis's scoped logger. */
interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** The subset of `ctx.reflect` this plugin uses. */
interface ReflectLike {
  /** Non-throwing optional service lookup: `get(name, false)` → `undefined`. */
  get(name: string, strict?: false): unknown
}

/** The subset of the `tools` service this plugin uses. */
interface ToolsLike {
  register(tool: unknown): unknown
}

/** The subset of the `systemPrompt` service this plugin uses. */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): unknown
}

/**
 * One workspace entity, as far as the host half needs it (ADR-003 W1/W2).
 *
 * Only the fields the board adapter will resolve a project from are named.
 * `status()` is `Promise<'ok' | 'missing-dir'>` — two values, no `unknown` —
 * according to the shipped `dsh-workspace` declarations; the display-only
 * `unknown` value lives in `@aikanban/core`, not in the host.
 */
export interface WorkspaceLike {
  readonly id: string
  readonly title?: string
  readonly path?: string
  status(): Promise<'ok' | 'missing-dir'>
}

/** The subset of `ctx.workspaceRegistry` the host half needs (read-only). */
export interface WorkspaceRegistryLike {
  get(id: string): WorkspaceLike | undefined
  list(): readonly WorkspaceLike[]
}

/** The subset of the `tools` {@link ToolDefinition} this plugin builds. */
export interface DiagnosticTool {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly render: (args: unknown, value: unknown) => readonly { type: 'text'; text: string }[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
  presentCall(args: unknown): { card: 'generic'; title: string; kind: 'other'; rawInput: unknown }
}

/** The parts of the cordis context the host half touches. */
export interface HostContext {
  readonly logger?: LoggerLike
  readonly reflect?: ReflectLike
  /**
   * `ctx.connection` — the authenticated Connection RPC host (ADR-005).
   *
   * Declared for typing only: at runtime the service is resolved through
   * {@link serviceOf} because a direct `ctx.connection` read throws when the
   * service is not bound yet (cordis: "cannot get property without inject").
   */
  readonly connection?: HostConnectionLike
  /** `ctx.storageDomain` — the domain facility the core is opened through. */
  readonly storageDomain?: StorageDomainLike
  /** `ctx.workspaceRegistry` — workspace entities; project resolution is P5b. */
  readonly workspaceRegistry?: WorkspaceRegistryLike
  /**
   * `ctx.inject(deps, callback)` — mount a **child** fiber that runs `callback`
   * once every service in `deps` is bound (cordis 4); the parent fiber is not
   * gated. Optional: the load-chain fakes and minimal compositions provide no
   * injector.
   *
   * Required for channel registration: `connection.register()` registers the
   * route through the *reading* context (`owner.effect` → `owner.webServer`),
   * so calling `rpc.handle` from this plugin's own fiber fails with "cannot get
   * property webServer without inject". The dynamic child below injects the two
   * services the registration needs without making them hard dependencies.
   */
  readonly inject?: (deps: readonly string[], callback: (scoped: HostContext) => void) => unknown
  /** Cordis event subscription; returns a disposer in cordis 4. */
  on(event: string, listener: (...args: never[]) => void): unknown
}

/**
 * Non-throwing service lookup.
 *
 * A direct `ctx.someService` read throws when the service is absent — cordis
 * treats it as a dependency the fiber did not inject. `apply()` must activate in
 * minimal compositions, so every optional service is resolved through
 * `ctx.reflect.get(name, false)`, which returns `undefined` instead.
 *
 * @param ctx - the host context.
 * @param name - the service name.
 * @returns the service value, or `undefined` when it is not bound.
 */
function serviceOf<T>(ctx: HostContext, name: string): T | undefined {
  const value = ctx.reflect?.get(name, false)
  return value === undefined || value === null ? undefined : (value as T)
}

/* ------------------------------------------------------------------ *
 * Activation bookkeeping
 * ------------------------------------------------------------------ */

let activationCounter = 0

/** Deterministic-but-unique activation id: no randomness, no clock collision. */
function nextActivationId(): string {
  activationCounter += 1
  return `${Date.now().toString(36)}-${activationCounter.toString(36)}`
}

function nowMs(): number {
  return Date.now()
}

function readPid(): number | null {
  const candidate = (globalThis as { process?: { pid?: unknown } }).process
  const pid = candidate?.pid
  return typeof pid === 'number' ? pid : null
}

/** Render an unknown thrown value for a diagnostic line; never throws itself. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Diagnostic tool
 * ------------------------------------------------------------------ */

/**
 * Build the `aikanban_status` tool definition.
 *
 * Hand-built rather than via `defineTool()` so the host half keeps a
 * dependency-free import graph; the shape mirrors the shipped
 * `@deepseek-ai/dsh-tools` `ToolDefinition` contract (a mandatory `output`
 * declaration with a pure `render`).
 *
 * @param snapshot - live activation record, read on every call.
 * @returns a tool definition ready for `tools.register()`.
 */
export function createStatusTool(snapshot: ActivationSnapshot): DiagnosticTool {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Read-only AIKanBan diagnostic. Returns this plugin host half\'s activation snapshot '
      + '(plugin id/version, activation id, apply timing, pid, which host services bound). '
      + 'Takes no arguments and changes nothing; use it to confirm the AIKanBan plugin is loaded and active.',
    parameters: {},
    output: {
      // The host enforces a strict schema subset before a tool may register
      // (`assertSupportedJsonSchema` in @deepseek-ai/dsh-tools): a single
      // `type` string per node (no type arrays), `required` as an OBJECT-level
      // array of property names, `additionalProperties` limited to a boolean,
      // and no `format`/`examples`. A hand-written schema that ignores those
      // rules does not degrade — it fails the whole load.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'marker', 'plugin', 'version', 'activationId', 'startedAt', 'appliedAt',
          'pid', 'statusToolRegistered', 'promptSectionRegistered',
          'boardChannelRegistered', 'boardChannel', 'dataLayerReady', 'servicesObserved',
        ],
        properties: {
          marker: { type: 'string' },
          plugin: { type: 'string' },
          version: { type: 'string' },
          activationId: { type: 'string' },
          startedAt: { type: 'integer' },
          appliedAt: { type: 'integer' },
          // No `["integer","null"]`: use oneOf for a nullable value.
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          statusToolRegistered: { type: 'boolean' },
          promptSectionRegistered: { type: 'boolean' },
          boardChannelRegistered: { type: 'boolean' },
          boardChannel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          dataLayerReady: { type: 'boolean' },
          servicesObserved: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as ActivationSnapshot
        return [{
          type: 'text',
          text: `${v.marker} (plugin ${v.plugin}@${v.version}, activation ${v.activationId}, pid ${String(v.pid)}, `
            + `services seen: ${v.servicesObserved.length === 0 ? 'none' : v.servicesObserved.join(', ')})`,
        }]
      },
    },
    execute(args) {
      void args
      return Promise.resolve({ ...snapshot })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'AIKanBan status',
      kind: 'other',
      rawInput: args,
    }),
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Cordis dependency declaration. Intentionally empty: this plugin is a leaf
 * observer, so it must activate even in a minimal composition that provides
 * neither `tools` nor `systemPrompt`. Those two are probed optionally in
 * {@link apply} — a declared-but-absent service would park the fiber in
 * `waiting` forever and the activation would never happen.
 */
export const inject: string[] = []

/** The most recently completed activation, or `null` before `apply()` runs. */
let lastActivation: ActivationSnapshot | null = null

/** The core opened by the asynchronous data-layer bootstrap, or `null`. */
let lastCore: KanbanCore | null = null

/** Why the last data-layer bootstrap attempt failed, or `null`. Diagnostic only. */
let lastDataLayerError: string | null = null

/**
 * Read the last activation snapshot. Exported so tests and the probe host can
 * assert on the same value the diagnostic tool returns.
 *
 * @returns the snapshot, or `null` when `apply()` has not run.
 */
export function getLastActivation(): ActivationSnapshot | null {
  return lastActivation
}

/**
 * Read the core opened by the data-layer bootstrap.
 *
 * @returns the core, or `null` while the data layer is not ready.
 */
export function getKanbanCore(): KanbanCore | null {
  return lastCore
}

/**
 * Read why the data-layer bootstrap last failed.
 *
 * @returns the failure message, or `null` when no attempt failed.
 */
export function getDataLayerError(): string | null {
  return lastDataLayerError
}

/**
 * Register the AIKanBan host half with a cordis host.
 *
 * Registration is speculative by design: `tools`, `systemPrompt`, `connection`
 * and `storageDomain` may bind at any time relative to this plugin's own start
 * (the shipped `dsh-genui` documents exactly this race), so each registration
 * is attempted immediately and again on every `internal/service` binding,
 * guarded against repeating work that already landed.
 *
 * `apply()` itself stays synchronous and never throws: the channel is registered
 * with a delayed-ready port, the data-layer bootstrap is fire-and-forget with an
 * explicit `catch`, and the activation signal is published before returning.
 *
 * @param ctx - the host context (structurally typed, see {@link HostContext}).
 */
export function apply(ctx: HostContext): void {
  const startedAt = nowMs()
  const activationId = nextActivationId()
  const servicesObserved: string[] = []
  let statusToolRegistered = false
  let promptSectionRegistered = false
  lastCore = null
  lastDataLayerError = null

  const noteService = (name: string): void => {
    if (!servicesObserved.includes(name)) servicesObserved.push(name)
  }

  /** `/aikanban` registration outcome, mirrored into every snapshot. */
  const channelState: {
    registered: boolean
    channel: string | null
    reason: BoardChannelRegistrationReason
  } = { registered: false, channel: null, reason: null }
  /** Whether `apply()` has returned; late changes republish the signal. */
  let applyCompleted = false

  const snapshot = (): ActivationSnapshot => ({
    marker: ACTIVATION_MARKER_PREFIX,
    plugin: '@aikanban/dsh-aikanban',
    version: PLUGIN_VERSION,
    activationId,
    startedAt,
    appliedAt: lastActivation?.appliedAt ?? startedAt,
    pid: readPid(),
    statusToolRegistered,
    promptSectionRegistered,
    boardChannelRegistered: channelState.registered,
    boardChannel: channelState.channel,
    dataLayerReady: lastCore !== null,
    servicesObserved: [...servicesObserved],
  })

  // `warn`, not `info`: the shipped `dsh` app registers no console log
  // exporter, but a host that does export normally starts at `warn`, and this
  // line is the activation marker a human greps for. It is NOT the load probe
  // of record — see ACTIVATION_CHANNEL for the surface that is observable from
  // outside the process.
  ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} (host half) plugin=@aikanban/dsh-aikanban version=${PLUGIN_VERSION} activation=${activationId}`)

  // ---- optional service: tools -------------------------------------
  const tryRegisterTool = (value?: unknown): void => {
    if (statusToolRegistered) return
    const tools = (value ?? ctx.reflect?.get('tools', false)) as ToolsLike | undefined
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return
    noteService('tools')
    tools.register(createStatusTool(snapshot()))
    statusToolRegistered = true
    lastActivation = snapshot()
    ctx.logger?.info(`${ACTIVATION_MARKER_PREFIX} diagnostic tool "${STATUS_TOOL_NAME}" registered`)
  }

  // ---- optional service: systemPrompt ------------------------------
  //
  // The section teaches the model the AIKanBan status handle. Skeleton scope
  // only: F11's real background-injection rules are a later milestone. A
  // plugin-owned section name keeps this separable from shipped sections.
  const PROMPT_SECTION = {
    name: 'aikanban:plugin-status',
    order: 190,
    text:
      'AIKanBan is installed. Its host half exposes the read-only tool `aikanban_status`; '
      + 'call it if you need to confirm the board plugin is loaded and which host services it bound. '
      + 'This tool only reports plugin state — it reads and writes no user data.',
  } as const
  let sectionRegistered = false

  const tryRegisterSection = (value?: unknown): void => {
    if (sectionRegistered) return
    const systemPrompt = (value ?? ctx.reflect?.get('systemPrompt', false)) as SystemPromptLike | undefined
    if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') return
    noteService('systemPrompt')
    systemPrompt.section(PROMPT_SECTION)
    sectionRegistered = true
    promptSectionRegistered = true
    lastActivation = snapshot()
    ctx.logger?.info(`${ACTIVATION_MARKER_PREFIX} prompt section "${PROMPT_SECTION.name}" registered`)
  }

  tryRegisterTool()
  tryRegisterSection()

  // ---- `/aikanban` channel: port delayed-ready, registration in a child fiber
  //
  // Opening the storage domain is asynchronous, but `apply()` may not be, so
  // the channel is registered up front with a port that answers `unavailable`
  // (not an empty board) until the data layer is ready, and `not-wired-yet`
  // until the core adapter lands in P5b. Registration is wrapped: a throwing
  // `connection.rpc.handle` is reported as `register-failed` and never escapes
  // `apply()`.
  const delayedPort = createDelayedBoardPort({
    coreReady: () => lastCore !== null,
    failureReason: () => lastDataLayerError,
  })

  const publishChannelState = (): void => {
    publishBoardChannelSignal({
      channel: channelState.channel ?? BOARD_CHANNEL,
      registered: channelState.registered,
      reason: channelState.reason,
      at: nowMs(),
    })
  }

  /** One registration outcome, ready to mirror into state/diagnostics. */
  interface ChannelRegistrationOutcome {
    readonly ok: boolean
    readonly channel: string | null
    readonly reason: BoardChannelRegistrationReason
    readonly message: string
    /** The documented path failed and the compatibility path succeeded. */
    readonly viaCompat?: boolean
  }

  /**
   * Mirror one registration outcome into the snapshot and diagnostics channel,
   * then republish the activation signal when `apply()` has already returned.
   * Never throws.
   */
  const settleChannelRegistration = (outcome: ChannelRegistrationOutcome): void => {
    channelState.registered = outcome.ok
    channelState.channel = outcome.ok ? outcome.channel : null
    channelState.reason = outcome.ok ? null : outcome.reason
    if (!outcome.ok) {
      ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} board channel registration failed: ${outcome.message}`)
    } else if (outcome.viaCompat === true) {
      ctx.logger?.warn(
        `${ACTIVATION_MARKER_PREFIX} board channel registered through the compatibility path: `
        + 'this host\'s public connection.rpc.handle throws "cannot get property webServer without inject"',
      )
    }
    publishChannelState()
    lastActivation = snapshot()
    if (applyCompleted) publishActivationSignal(lastActivation)
  }

  const tryRegisterChannel = (candidate?: unknown): void => {
    if (channelState.registered) return
    const connection = isHostConnectionLike(candidate)
      ? candidate
      : serviceOf<HostConnectionLike>(ctx, 'connection')
    if (!isHostConnectionLike(connection)) {
      // Only reachable in a composition without an injector (load-chain fakes):
      // the shipped web host registers from the injected child below.
      settleChannelRegistration({
        ok: false,
        channel: null,
        reason: 'no-connection',
        message: 'connection service is not bound',
      })
      return
    }
    noteService('connection')
    try {
      const registration = registerBoardChannel(connection, delayedPort)
      settleChannelRegistration(
        registration.ok
          ? { ok: true, channel: registration.channel, reason: null, message: '' }
          : { ok: false, channel: null, reason: registration.reason, message: 'the connection service rejected rpc.handle registration' },
      )
    } catch (error) {
      // `register-failed` is diagnostic only — it is not a browser failure code:
      // an unregistered channel means the handler is never called, so browser
      // reads surface as `read-failed` and writes as `unknown-result`.
      settleChannelRegistration({ ok: false, channel: null, reason: 'register-failed', message: errorMessage(error) })
    }
  }

  /** Whether a registration attempt (direct or via the child fiber) started. */
  let channelMountStarted = false

  /**
   * Mount the registration attempt.
   *
   * The shipped `connection.register()` derives the registration's lifetime and
   * HTTP route from the *reading* context: `owner.effect(() => owner.webServer
   * .register(route))`. Two problems, both measured in the isolated probe:
   *
   * 1. This plugin's own fiber cannot resolve `webServer`, so registration is
   *    mounted through a dynamic `ctx.inject(['connection', 'webServer'])`
   *    child instead of a static dependency (which would gate activation in
   *    minimal compositions).
   * 2. In DSH 44.7.0 the public `rpc.handle` shadows `owner` to the service's
   *    provider context and therefore throws `cannot get property "webServer"
   *    without inject` even from that child. `scoped-channel-registration.ts`
   *    tries the documented path first and falls back to the same internal
   *    registration call with the injected child as owner.
   *
   * Compositions without an injector (load-chain fakes) fall back to a direct
   * public attempt so the contract stays observable. A synchronous throw from
   * `ctx.inject` itself is caught: `apply()` must never throw.
   */
  const mountBoardChannel = (): void => {
    if (channelState.registered || channelMountStarted) return
    channelMountStarted = true
    if (typeof ctx.inject !== 'function') {
      tryRegisterChannel()
      return
    }
    try {
      ctx.inject(['connection', 'webServer'], (scoped) => {
        try {
          const scopedConnection = (scoped as unknown as { connection?: unknown }).connection
          noteService('connection')
          const registration = registerBoardChannelInScope(scopedConnection, scoped, delayedPort, BOARD_CHANNEL)
          settleChannelRegistration(
            registration.ok
              ? {
                  ok: true,
                  channel: registration.channel,
                  reason: null,
                  message: '',
                  viaCompat: registration.path === 'compat',
                }
              : { ok: false, channel: null, reason: 'register-failed', message: registration.message },
          )
        } catch (error) {
          // A throwing injected callback must not become an unhandled fiber
          // rejection: report it and keep the visible failed state instead.
          settleChannelRegistration({ ok: false, channel: null, reason: 'register-failed', message: errorMessage(error) })
        }
      })
    } catch (error) {
      settleChannelRegistration({
        ok: false,
        channel: null,
        reason: 'register-failed',
        message: `ctx.inject threw: ${errorMessage(error)}`,
      })
    }
  }

  // ---- data layer: open `aikanban_core` and build the core (async) ----
  //
  // The storage-domain facility arrives after `apply()` in the shipped web host
  // (probe evidence), so the bootstrap is re-attempted on `internal/service`
  // and its failures stay visible (`lastDataLayerError`) instead of faking an
  // empty board. `void bootstrap().catch(...)`: an unhandled rejection here
  // could be treated as a host crash.
  type BootstrapState = 'idle' | 'running' | 'ready' | 'failed'
  let bootstrapState: BootstrapState = 'idle'

  const startBootstrap = (candidate?: unknown): void => {
    if (bootstrapState === 'running' || bootstrapState === 'ready') return
    const storageDomain = isStorageDomainLike(candidate)
      ? candidate
      : serviceOf<StorageDomainLike>(ctx, 'storageDomain')
    if (!isStorageDomainLike(storageDomain)) {
      bootstrapState = 'failed'
      lastDataLayerError = 'storageDomain service is not bound'
      return
    }
    bootstrapState = 'running'
    // The port reports "not ready" while the open is in flight; do not keep a
    // stale "service is not bound" reason visible during that window.
    lastDataLayerError = null
    noteService('storageDomain')
    runBootstrap(storageDomain)
  }

  const runBootstrap = (storageDomain: StorageDomainLike): void => {
    void (async (): Promise<void> => {
      const result = await openDataLayer(storageDomain)
      if (result.ok) {
        lastCore = result.core
        bootstrapState = 'ready'
        lastDataLayerError = null
        ctx.logger?.info(`${ACTIVATION_MARKER_PREFIX} data layer ready (domain ${result.domain.name})`)
      } else {
        lastCore = null
        bootstrapState = 'failed'
        lastDataLayerError = result.message
        ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} data layer failed at ${result.stage}: ${result.message}`)
      }
      // The data-layer result is part of the activation snapshot
      // (`dataLayerReady`), so the final state is republished for observers.
      lastActivation = snapshot()
      publishActivationSignal(lastActivation)
    })().catch((error: unknown) => {
      // `openDataLayer` returns failures, so this is belt-and-braces only.
      lastCore = null
      bootstrapState = 'failed'
      lastDataLayerError = errorMessage(error)
      ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} data layer bootstrap threw: ${lastDataLayerError}`)
      lastActivation = snapshot()
      publishActivationSignal(lastActivation)
    })
  }

  mountBoardChannel()
  startBootstrap()

  // Service arrival is order-independent: re-attempt on every binding.
  ctx.on('internal/service', ((name: string, value: unknown) => {
    if (name === 'tools') tryRegisterTool(value)
    else if (name === 'systemPrompt') tryRegisterSection(value)
    else if (name === 'connection') {
      // With an injector, the child mounted at apply() waits for `webServer` too;
      // without one (load-chain fakes), retry the direct registration.
      if (typeof ctx.inject === 'function') mountBoardChannel()
      else tryRegisterChannel(value)
    } else if (name === 'storageDomain') startBootstrap(value)
  }) as never)

  applyCompleted = true
  lastActivation = snapshot()
  // Both signals, for different consumers. The logger lines are readable in
  // hosts that DO export the logger; the diagnostics channels are observable
  // from outside any host (see ACTIVATION_CHANNEL and BOARD_CHANNEL_EVENT).
  ctx.logger?.warn(
    `${ACTIVATION_MARKER_PREFIX} host half applied in ${String(nowMs() - startedAt)}ms `
    + `(tools=${String(statusToolRegistered)}, systemPrompt=${String(promptSectionRegistered)}, `
    + `channel=${String(channelState.registered)}, dataLayer=${String(lastCore !== null)})`,
  )
  publishActivationSignal(lastActivation)
}

/* ------------------------------------------------------------------ *
 * Board data channel (F02) — see ADR-005
 *
 * Re-exported so the host half presents its whole channel surface from this one
 * entry module: the probe, the tests and the core adapter import from here
 * rather than reaching into `lib/board-channel.js`. The channel itself is
 * registered inside `apply()`; the port behind it is `delayed-board-port.ts`
 * until the core adapter (P5b) replaces it.
 * ------------------------------------------------------------------ */

export {
  createBoardChannelHandler,
  isHostConnectionLike,
  registerBoardChannel,
} from './board-channel.js'
export type {
  BoardChannelRegistration,
  BoardRpcHandler,
  BoardRpcResult,
  HostBoardPort,
  HostReadOutcome,
  HostWriteOutcome,
} from './board-channel.js'
