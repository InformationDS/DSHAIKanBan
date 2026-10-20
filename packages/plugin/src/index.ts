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
 * ## What it registers (skeleton scope)
 *
 * 1. A **startup log line** carrying {@link ACTIVATION_MARKER_PREFIX} plus the
 *    activation id — visible in the host's own log stream.
 * 2. A **read-only diagnostic tool** `aikanban_status`. This is the strongest
 *    load-verification handle available: it appears in `Tool.listTools()`, and
 *    calling it returns the full activation snapshot (apply timing, which
 *    services bound, which registrations landed). "The package merely
 *    resolved" and "the plugin actually activated" are distinguishable from
 *    outside the process because of this tool.
 *
 * Business behaviour (project/task records, paired confirmation, board data)
 * lives in `packages/core` (workstream S0-W2) and is wired in later; this
 * milestone deliberately proves the load chain only.
 *
 * @module @aikanban/dsh-aikanban
 */

import type { KanbanCore } from '@aikanban/core'

import {
  isStorageDomainLike,
  openDataLayer,
  type DataLayerOpenResult,
  type StorageDomainLike,
} from './data-layer.js'

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
 * Best-effort publish of one activation event. Never throws: a diagnostics
 * failure must not fail a plugin activation.
 *
 * @param payload - the activation snapshot to publish.
 */
export function publishActivationSignal(payload: ActivationSnapshot): void {
  try {
    const loader = (globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown }
    }).process?.getBuiltinModule
    if (typeof loader !== 'function') return
    const dc = loader('node:diagnostics_channel') as DiagnosticsChannelModuleLike | undefined
    dc?.channel(ACTIVATION_CHANNEL).publish(payload)
  } catch {
    // Observability is optional; activation is not.
  }
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
  /** Cordis event subscription; returns a disposer in cordis 4. */
  on(event: string, listener: (...args: never[]) => void): unknown
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
          'pid', 'statusToolRegistered', 'promptSectionRegistered', 'servicesObserved',
        ],
        properties: {
          marker: { type: 'string' },
          plugin: { type: 'string' },
          version: { type: 'string' },
          activationId: { type: 'string' },
          startedAt: { type: 'integer' },
          appliedAt: { type: 'integer' },
          // No `["integer","null"]`: use oneOf for a nullable integer.
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          statusToolRegistered: { type: 'boolean' },
          promptSectionRegistered: { type: 'boolean' },
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
 * Registration is speculative by design: `tools` and `systemPrompt` may bind
 * at any time relative to this plugin's own start (the shipped `dsh-genui`
 * documents exactly this race), so each registration is attempted immediately
 * and again on every `internal/service` binding, guarded by a once-only flag.
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

  // ---- data layer: open `aikanban_core` and build the core (async) ----
  //
  // P2 evidence step: nothing consumes the core yet (the board channel is
  // registered in the next change). This block exists to answer, inside a real
  // host, whether `ctx.storageDomain.open(<bare DomainSpecLike>)` is accepted
  // and when the service becomes reachable. The probe reads the TEMPORARY
  // console lines below from the captured host stdout; they are replaced by the
  // activation snapshot fields once those exist.
  const serviceAt = (name: string): unknown => ctx.reflect?.get(name, false)

  console.warn(
    '[aikanban] P2 services at apply(): '
    + ['storageDomain', 'connection', 'workspaceRegistry']
      .map((name) => `${name}=${serviceAt(name) === undefined ? 'absent' : 'reachable'}`)
      .join(' '),
  )

  type BootstrapState = 'idle' | 'running' | 'ready' | 'failed'
  let bootstrapState: BootstrapState = 'idle'

  const reportBootstrap = (result: DataLayerOpenResult | null, thrown?: unknown): void => {
    // TEMPORARY (P2 evidence): the host's stdout/stderr is the only surface the
    // isolated probe can read before the activation snapshot carries the
    // data-layer state. Removed when those snapshot fields land.
    if (result === null) {
      console.warn(`[aikanban] P2 data-layer: exception ${errorMessage(thrown)}`)
      return
    }
    if (result.ok) {
      console.warn(`[aikanban] P2 data-layer: open-ok domain=${result.domain.name} probeRead=getDraft`)
      return
    }
    console.warn(`[aikanban] P2 data-layer: ${result.stage} message=${result.message}`)
  }

  const startBootstrap = (candidate?: unknown): void => {
    if (bootstrapState === 'running' || bootstrapState === 'ready') return
    const storageDomain = isStorageDomainLike(candidate) ? candidate : serviceAt('storageDomain')
    if (!isStorageDomainLike(storageDomain)) {
      bootstrapState = 'failed'
      lastDataLayerError = 'storageDomain service is not bound'
      return
    }
    if (bootstrapState === 'failed') {
      console.warn('[aikanban] P2 data-layer: storageDomain became reachable after apply()')
    }
    bootstrapState = 'running'
    noteService('storageDomain')
    runBootstrap(storageDomain)
  }

  const runBootstrap = (storageDomain: StorageDomainLike): void => {
    void (async (): Promise<void> => {
      const result = await openDataLayer(storageDomain)
      reportBootstrap(result)
      if (result.ok) {
        lastCore = result.core
        lastDataLayerError = null
        bootstrapState = 'ready'
        ctx.logger?.info(`${ACTIVATION_MARKER_PREFIX} data layer ready (domain ${result.domain.name})`)
      } else {
        lastDataLayerError = result.message
        bootstrapState = 'failed'
        ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} data layer failed at ${result.stage}: ${result.message}`)
      }
      // The data-layer state is a `servicesObserved` entry today and becomes a
      // snapshot field in the next change; either way the latest state is
      // republished so outside observers can wait for the final answer.
      lastActivation = snapshot()
      publishActivationSignal(lastActivation)
    })().catch((error: unknown) => {
      // `openDataLayer` returns failures, so this is belt-and-braces: an
      // unhandled rejection here could be treated as a host crash.
      bootstrapState = 'failed'
      lastDataLayerError = errorMessage(error)
      ctx.logger?.warn(`${ACTIVATION_MARKER_PREFIX} data layer bootstrap threw: ${lastDataLayerError}`)
      reportBootstrap(null, error)
    })
  }

  startBootstrap()

  // Service arrival is order-independent: re-attempt on every binding.
  ctx.on('internal/service', ((name: string, value: unknown) => {
    if (name === 'tools') tryRegisterTool(value)
    else if (name === 'systemPrompt') tryRegisterSection(value)
    else if (name === 'storageDomain') startBootstrap(value)
  }) as never)

  lastActivation = snapshot()
  // Both signals, for different consumers. The logger lines are readable in
  // hosts that DO export the logger; the diagnostics channel is observable from
  // outside any host (see ACTIVATION_CHANNEL).
  ctx.logger?.warn(
    `${ACTIVATION_MARKER_PREFIX} host half applied in ${String(nowMs() - startedAt)}ms `
    + `(tools=${String(statusToolRegistered)}, systemPrompt=${String(promptSectionRegistered)})`,
  )
  publishActivationSignal(lastActivation)
}

/* ------------------------------------------------------------------ *
 * Board data channel (F02) — see ADR-005
 *
 * Re-exported so the host half presents its whole channel surface from this one
 * entry module: the probe, the tests and the core adapter import from here
 * rather than reaching into `lib/board-channel.js`. Registering it inside
 * `apply()` is deliberately NOT done yet — the `packages/core` contract the
 * adapter needs is not published, and a channel without a data layer would
 * answer every read with a failure the user cannot act on.
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
