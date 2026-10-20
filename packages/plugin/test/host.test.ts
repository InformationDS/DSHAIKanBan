/**
 * Host-half tests.
 *
 * These drive `apply()` against a hand-built fake cordis context. The point is
 * not to test cordis — it is to pin the properties the load chain depends on,
 * which are exactly the ones that fail silently in production:
 *
 * 1. `apply()` never throws when the optional services are absent (a minimal
 *    composition). A throw here fails the whole boot sweep.
 * 2. Every registration is idempotent — the `internal/service` re-probe must not
 *    register the tool or the prompt section twice.
 * 3. Late service arrival still lands both registrations.
 * 4. The startup marker reaches the logger, and the diagnostic tool both
 *    registers and reports the same activation id the module tracks.
 */
import { describe, expect, it } from 'vitest'

import {
  ACTIVATION_CHANNEL,
  ACTIVATION_MARKER_PREFIX,
  BOARD_CHANNEL_EVENT,
  STATUS_TOOL_NAME,
  apply,
  createStatusTool,
  getDataLayerError,
  getKanbanCore,
  getLastActivation,
  inject,
  publishActivationSignal,
  type ActivationSnapshot,
  type BoardChannelEventPayload,
  type BoardRpcHandler,
  type DiagnosticTool,
  type HostContext,
} from '../src/index.js'

/**
 * Build a fake host context.
 *
 * `services` seeds the services that are bound *before* `apply()` runs; the
 * returned `bindService` emits `internal/service` afterwards, which is how a
 * real host delivers a late binding. Pass `withTools: false` to model a
 * composition that provides no tool registry at all.
 *
 * `withInject: true` adds `ctx.inject(deps, callback)`: a child scope that runs
 * once every dependency is bound (the shipped host's dynamic-inject contract).
 * Without it, the context models the load-chain fakes, which have no injector.
 */
function fakeHost(options: { services?: Record<string, unknown>; withTools?: boolean; withInject?: boolean } = {}) {
  const logs: string[] = []
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const injections: { deps: readonly string[]; callback: (scoped: HostContext) => void }[] = []
  const registered: unknown[] = []
  const sections: { name: string; order: number; text: string }[] = []
  const bound = new Map<string, unknown>(Object.entries(options.services ?? {}))

  const toolsService = { register: (tool: unknown) => { registered.push(tool); return tool } }
  const systemPromptService = {
    section: (s: { name: string; order: number; text: string }) => { sections.push(s); return s },
  }
  if (options.withTools !== false) bound.set('tools', toolsService)

  /** A child scope with the injected dependencies exposed as direct properties. */
  const scopedContext = (): HostContext => {
    const scoped: Record<string, unknown> = {
      logger: ctx.logger,
      reflect: { get: (name: string) => bound.get(name) },
      on: () => undefined,
    }
    for (const [name, value] of bound) scoped[name] = value
    return scoped as unknown as HostContext
  }

  /** Run every queued injection whose dependencies are now all bound. */
  const runInjections = (): void => {
    for (const injection of [...injections]) {
      if (!injection.deps.every((name) => bound.has(name))) continue
      injections.splice(injections.indexOf(injection), 1)
      injection.callback(scopedContext())
    }
  }

  const ctx: HostContext = {
    logger: {
      info: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
      warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    },
    reflect: { get: (name: string) => bound.get(name) },
    on: (event: string, listener: (...args: never[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => { listeners.set(event, list.filter((l) => l !== listener)) }
    },
    ...(options.withInject === true
      ? {
          inject: (deps: readonly string[], callback: (scoped: HostContext) => void) => {
            injections.push({ deps, callback })
            runInjections()
            return undefined
          },
        }
      : {}),
  }

  return {
    ctx,
    logs,
    registered,
    sections,
    bindService(name: string, value: unknown) {
      bound.set(name, value)
      for (const listener of listeners.get('internal/service') ?? []) {
        (listener as unknown as (n: string, v: unknown) => void)(name, value)
      }
      runInjections()
    },
    toolsService: () => toolsService,
    systemPromptService: () => systemPromptService,
  }
}

/** A context with no services at all — the minimal-composition case. */
function bareHost(): HostContext {
  return { reflect: { get: () => undefined }, on: () => undefined }
}

/**
 * A `connection` service double recording every `rpc.handle` call.
 *
 * `throwOnHandle` models a composition-level channel collision, which the host
 * half must report as `register-failed` instead of letting it break `apply()`.
 */
function fakeConnection(options: { throwOnHandle?: boolean } = {}) {
  const handles: { channel: string; handler: BoardRpcHandler }[] = []
  const connection = {
    rpc: {
      handle(channel: string, handler: BoardRpcHandler) {
        if (options.throwOnHandle === true) throw new Error('rpc.handle refused the channel')
        handles.push({ channel, handler })
        return () => { handles.length = 0 }
      },
    },
  }
  return { connection, handles }
}

/** A storage-domain handle good enough for `createStorageDomainPort`. */
function fakeDomain(name = 'aikanban_core') {
  const tables = new Map<string, Map<string, unknown>>()
  const tableOf = (tableName: string): Map<string, unknown> => {
    let records = tables.get(tableName)
    if (records === undefined) {
      records = new Map()
      tables.set(tableName, records)
    }
    return records
  }
  return {
    name,
    table(tableName: string) {
      const records = tableOf(tableName)
      return {
        get: (key: string) => records.get(key),
        entries: () => records.entries(),
        keys: () => records.keys(),
        get size() { return records.size },
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async (key: string) => records.delete(key),
        update: async (key: string, transform: (current: unknown) => unknown) => {
          const next = transform(records.get(key))
          records.set(key, next)
          return next
        },
      }
    },
  }
}

/** A `storageDomain` service double recording the specs it was asked to open. */
function fakeStorageDomain(options: { reject?: Error; domainName?: string } = {}) {
  const opened: unknown[] = []
  return {
    opened,
    service: {
      async open(spec: unknown) {
        opened.push(spec)
        if (options.reject !== undefined) throw options.reject
        return fakeDomain(options.domainName)
      },
    },
  }
}

/** Subscribe to one diagnostics channel for the duration of a test. */
async function subscribe<T>(channelName: string) {
  const dc = await import('node:diagnostics_channel')
  const received: T[] = []
  const listener = (payload: unknown): void => { received.push(payload as T) }
  dc.subscribe(channelName, listener)
  return { received, unsubscribe: (): void => { dc.unsubscribe(channelName, listener) } }
}

/** Wait for an asynchronously-published state; fails the test after ~1s. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('host half: activation', () => {
  it('activates without throwing when no optional service is bound', () => {
    expect(() => { apply(bareHost()) }).not.toThrow()
    const snapshot = getLastActivation()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.statusToolRegistered).toBe(false)
    expect(snapshot?.promptSectionRegistered).toBe(false)
    expect(snapshot?.boardChannelRegistered).toBe(false)
    expect(snapshot?.boardChannel).toBeNull()
    expect(snapshot?.dataLayerReady).toBe(false)
    expect(snapshot?.servicesObserved).toEqual([])
  })

  it('activates without a logger (logger is optional in the contract)', () => {
    expect(() => { apply(bareHost()) }).not.toThrow()
  })

  it('emits the startup marker on the host logger', () => {
    const host = fakeHost()
    apply(host.ctx)
    const marker = host.logs.find((line) => line.includes(ACTIVATION_MARKER_PREFIX))
    expect(marker, `no log line contained ${ACTIVATION_MARKER_PREFIX}: ${host.logs.join(' | ')}`).toBeDefined()
    expect(marker).toContain('@aikanban/dsh-aikanban')
  })

  it('declares no required services', () => {
    // Mirrors the shipped dsh-genui reasoning: cordis `inject` is a hard
    // activation gate, so a declared-but-absent service parks the fiber in
    // `waiting` forever and `apply()` never runs. This plugin is a leaf.
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toHaveLength(0)
  })

  it('gives each activation a distinct id', () => {
    apply(fakeHost().ctx)
    const idA = getLastActivation()?.activationId
    apply(fakeHost().ctx)
    const idB = getLastActivation()?.activationId
    expect(idA).toBeDefined()
    expect(idB).toBeDefined()
    expect(idA).not.toBe(idB)
  })
})

describe('host half: registration', () => {
  it('registers exactly one diagnostic tool when `tools` is already bound', () => {
    const host = fakeHost()
    apply(host.ctx)
    expect(host.registered).toHaveLength(1)
  })

  it('re-probing the same service does not double-register', () => {
    const host = fakeHost()
    apply(host.ctx)
    // cordis emits `internal/service` on every binding, including re-bindings.
    host.bindService('tools', host.toolsService())
    host.bindService('tools', host.toolsService())
    expect(host.registered).toHaveLength(1)
  })

  it('lands both registrations when services arrive after apply()', () => {
    const host = fakeHost({ withTools: false })
    apply(host.ctx)
    expect(host.registered).toHaveLength(0)

    host.bindService('tools', host.toolsService())
    host.bindService('systemPrompt', host.systemPromptService())

    expect(host.registered).toHaveLength(1)
    expect(host.sections).toHaveLength(1)
    expect(host.sections[0]?.name).toBe('aikanban:plugin-status')
    expect(getLastActivation()?.promptSectionRegistered).toBe(true)
  })

  it('ignores a malformed service value instead of throwing during boot', () => {
    const host = fakeHost({ withTools: false })
    apply(host.ctx)
    expect(() => {
      host.bindService('tools', { register: 'not a function' })
      host.bindService('tools', null)
      host.bindService('other', { nope: true })
    }).not.toThrow()
    expect(host.registered).toHaveLength(0)
  })
})

describe('host half: diagnostic tool', () => {
  it('is shaped as a registered ToolDefinition (name/description/parameters/output/execute)', () => {
    const tool = createStatusTool(getLastActivation() ?? {
      marker: ACTIVATION_MARKER_PREFIX,
      plugin: '@aikanban/dsh-aikanban',
      version: '0.0.0',
      activationId: 'test',
      startedAt: 0,
      appliedAt: 0,
      pid: null,
      statusToolRegistered: false,
      promptSectionRegistered: false,
      boardChannelRegistered: false,
      boardChannel: null,
      dataLayerReady: false,
      servicesObserved: [],
    })
    expect(tool.name).toBe(STATUS_TOOL_NAME)
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.parameters).toEqual({})
    expect(tool.output.schema).toBeTypeOf('object')
    expect(tool.output.render).toBeTypeOf('function')
    expect(tool.execute).toBeTypeOf('function')
  })

  it('reports the live snapshot, matching the activation id', async () => {
    const host = fakeHost()
    apply(host.ctx)

    const snapshot = getLastActivation() as ActivationSnapshot
    expect(snapshot).not.toBeNull()

    const tool = host.registered[0] as DiagnosticTool
    const value = await tool.execute({}, {}) as ActivationSnapshot
    expect(value.marker).toBe(ACTIVATION_MARKER_PREFIX)
    expect(value.activationId).toBe(snapshot.activationId)
    expect(value.servicesObserved).toContain('tools')

    const rendered = tool.output.render({}, value)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.type).toBe('text')
    expect(rendered[0]?.text).toContain(ACTIVATION_MARKER_PREFIX)
  })

  it('exposes a stable marker prefix for log grepping', () => {
    expect(ACTIVATION_MARKER_PREFIX).toMatch(/^\[aikanban\]/)
  })
})

/**
 * The activation signal: `node:diagnostics_channel`.
 *
 * This is the surface a probe outside the host process can actually observe.
 * The cordis logger is an in-memory buffer plus exporters and the shipped `dsh`
 * app registers no console exporter, so a log line never reaches stdout — the
 * first version of this plugin used `logger.info`, and the isolated-host probe
 * could not see the activation at all.
 */
describe('host half: activation signal', () => {
  it('publishes on the documented channel when apply() runs', async () => {
    const dc = await import('node:diagnostics_channel')
    const received: unknown[] = []
    const listener = (payload: unknown) => { received.push(payload) }
    dc.subscribe(ACTIVATION_CHANNEL, listener)
    try {
      apply(fakeHost().ctx)
    } finally {
      dc.unsubscribe(ACTIVATION_CHANNEL, listener)
    }
    expect(received).toHaveLength(1)
    const snapshot = received[0] as ActivationSnapshot
    expect(snapshot.marker).toBe(ACTIVATION_MARKER_PREFIX)
    expect(snapshot.activationId).toBe(getLastActivation()?.activationId)
    expect(snapshot.servicesObserved).toContain('tools')
  })

  it('uses the module-level channel() accessor, not a module-level publish()', async () => {
    // `node:diagnostics_channel` has no top-level `publish`; reaching for one
    // throws a TypeError that a best-effort catch would swallow silently, which
    // is how the activation stayed invisible through two probe iterations.
    const dc = await import('node:diagnostics_channel') as unknown as Record<string, unknown>
    expect(typeof dc['publish']).toBe('undefined')
    expect(typeof dc['channel']).toBe('function')
  })

  it('never throws when the channel cannot be reached', () => {
    expect(() => { publishActivationSignal({
      marker: ACTIVATION_MARKER_PREFIX,
      plugin: '@aikanban/dsh-aikanban',
      version: '0.0.0',
      activationId: 'no-channel',
      startedAt: 0,
      appliedAt: 0,
      pid: null,
      statusToolRegistered: false,
      promptSectionRegistered: false,
      boardChannelRegistered: false,
      boardChannel: null,
      dataLayerReady: false,
      servicesObserved: [],
    }) }).not.toThrow()
  })

  it('names the channel with the plugin prefix so no DSH channel is shadowed', () => {
    expect(ACTIVATION_CHANNEL).toMatch(/^aikanban:/)
    expect(BOARD_CHANNEL_EVENT).toMatch(/^aikanban:/)
  })
})

/**
 * The host enforces a strict schema subset before a tool may register
 * (`assertSupportedJsonSchema`, @deepseek-ai/dsh-tools). Violating it is not a
 * soft failure: registration throws and the **whole host load fails** — which
 * is exactly what happened the first time this tool ran inside a real probe
 * host, because the schema was written in the *parameter* dialect
 * (`required: true` per property, `type: ["integer","null"]`).
 *
 * These assertions re-implement the two rules that were violated, so the
 * mistake cannot come back silently. They deliberately check the schema as
 * data, so they need no dependency on the host package.
 */
describe('host half: output schema obeys the host-enforced subset', () => {
  const tool = createStatusTool({
    marker: ACTIVATION_MARKER_PREFIX,
    plugin: '@aikanban/dsh-aikanban',
    version: '0.0.0',
    activationId: 'schema-check',
    startedAt: 0,
    appliedAt: 0,
    pid: null,
    statusToolRegistered: false,
    promptSectionRegistered: false,
    boardChannelRegistered: false,
    boardChannel: null,
    dataLayerReady: false,
    servicesObserved: [],
  })

  /** The keyword set the host accepts, verbatim from its own diagnostic. */
  const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
  const ANNOTATIONS = new Set(['description', 'title'])

  /**
   * Walk a schema the way the host does.
   *
   * @param schema - the candidate schema.
   * @param path - diagnostic path prefix.
   * @returns the list of violations (empty when the host would accept it).
   */
  function checkSchema(schema: unknown, path = 'schema'): string[] {
    const violations: string[] = []
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      return [`${path} must be a schema object`]
    }
    const node = schema as Record<string, unknown>
    for (const key of Object.keys(node)) {
      if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) {
        violations.push(`${path}.${key} is not a supported keyword`)
      }
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')

    if (hasType) {
      if (typeof node['type'] !== 'string') {
        violations.push(`${path}.type must be a single type string`)
      }
      // Object-only keywords on a non-object node are a violation, not an
      // unknown keyword — the host's message names the type.
      for (const key of ['properties', 'required', 'additionalProperties']) {
        if (Object.hasOwn(node, key) && node['type'] !== 'object') {
          violations.push(`${path}.${key} is not supported on type "${String(node['type'])}"`)
        }
      }
      if (Object.hasOwn(node, 'enum') && !['string', 'number', 'integer', 'boolean', 'null'].includes(String(node['type']))) {
        violations.push(`${path}.enum is not supported on type "${String(node['type'])}"`)
      }
      if (Object.hasOwn(node, 'items') && node['type'] !== 'array') {
        violations.push(`${path}.items is not supported on type "${String(node['type'])}"`)
      }
      if (node['type'] === 'object') {
        if (Object.hasOwn(node, 'additionalProperties') && typeof node['additionalProperties'] !== 'boolean') {
          violations.push(`${path}.additionalProperties must be a boolean`)
        }
        const required = node['required']
        if (Object.hasOwn(node, 'required')) {
          if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
            violations.push(`${path}.required must be an array of strings`)
          } else {
            const declared = (node['properties'] ?? {}) as Record<string, unknown>
            for (const name of required) {
              if (!Object.hasOwn(declared, name)) violations.push(`${path}.required names "${name}" which is not in properties`)
            }
          }
        }
        for (const [key, child] of Object.entries((node['properties'] ?? {}) as Record<string, unknown>)) {
          violations.push(...checkSchema(child, `${path}.properties.${key}`))
        }
      }
      if (node['type'] === 'array') {
        violations.push(...checkSchema(node['items'], `${path}.items`))
      }
    } else if (hasOneOf) {
      const oneOf = node['oneOf']
      if (!Array.isArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`)
      else oneOf.forEach((child, index) => { violations.push(...checkSchema(child, `${path}.oneOf[${index}]`)) })
    } else {
      violations.push(`${path} declares neither type nor oneOf`)
    }
    return violations
  }

  it('has no violations under the host rules', () => {
    // `required` applies to the OUTPUT schema. `parameters: {}` is already
    // valid (no type/properties at all).
    expect(checkSchema(tool.output.schema)).toEqual([])
  })

  it('covers exactly the runtime activation snapshot fields (sentinel)', () => {
    // Benchmarked against `apply(fakeHost)` + `getLastActivation()`, NOT a
    // hand-written literal: test files are not checked by `tsc -b`, so a literal
    // and the schema could drift together while this assertion still passed.
    const host = fakeHost()
    apply(host.ctx)
    const snapshot = getLastActivation()
    expect(snapshot, 'apply() did not record an activation snapshot').not.toBeNull()
    const runtime = createStatusTool(snapshot as ActivationSnapshot)
    const schema = runtime.output.schema as {
      properties?: Record<string, unknown>
      required?: readonly string[]
    }
    const fields = Object.keys(snapshot as ActivationSnapshot).sort()
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(fields)
    expect([...(schema.required ?? [])].sort()).toEqual(fields)
    expect(checkSchema(schema)).toEqual([])
  })

  it('rejects the mistakes that broke the real host (regression guard)', () => {
    // Mistake 1: `required: true` on a property. The host accepts `required`
    // only as an OBJECT-level array, so on a string node it reports the
    // object-only keyword rather than an unknown keyword.
    expect(checkSchema({
      type: 'object',
      properties: { marker: { type: 'string', required: true } },
    })).toContain('schema.properties.marker.required is not supported on type "string"')

    // Mistake 2: a type array for a nullable field.
    expect(checkSchema({
      type: 'object',
      properties: { pid: { type: ['integer', 'null'] } },
    })).toContain('schema.properties.pid.type must be a single type string')

    // Mistake 3: a `required` naming a property that is not declared.
    expect(checkSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['b'],
    })).toContain('schema.required names "b" which is not in properties')

    // Mistake 4: an unsupported keyword (e.g. `format`).
    expect(checkSchema({
      type: 'object',
      properties: { a: { type: 'string', format: 'date-time' } },
    })).toContain('schema.properties.a.format is not a supported keyword')

    // Mistake 5: a non-boolean `additionalProperties`.
    expect(checkSchema({
      type: 'object',
      additionalProperties: {},
      properties: { a: { type: 'string' } },
    })).toContain('schema.additionalProperties must be a boolean')
  })

  it('accepts an empty parameter schema (no-argument tool)', () => {
    expect(tool.parameters).toEqual({})
  })
})

/**
 * `/aikanban` registration (ADR-005, s1-wiring.md §5.1/§5.5).
 *
 * The channel is registered synchronously in `apply()`, but the `connection`
 * service arrives after `apply()` in the shipped web host, so the late-binding
 * path is the one the probe actually exercises. A registration failure must be
 * visible on the diagnostics channel and must not throw out of `apply()`.
 */
describe('host half: /aikanban board channel', () => {
  it('registers /aikanban when the connection service is already bound', async () => {
    const { connection, handles } = fakeConnection()
    const host = fakeHost({ services: { connection } })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      apply(host.ctx)
      expect(handles.map((entry) => entry.channel)).toEqual(['/aikanban'])
      const snapshot = getLastActivation()
      expect(snapshot?.boardChannelRegistered).toBe(true)
      expect(snapshot?.boardChannel).toBe('/aikanban')
      const registered = events.received.find((event) => event.registered)
      expect(registered).toMatchObject({ channel: '/aikanban', registered: true, reason: null })
      expect(typeof registered?.at).toBe('number')
    } finally {
      events.unsubscribe()
    }
  })

  it('registers the channel when connection arrives after apply()', async () => {
    const host = fakeHost()
    const { connection, handles } = fakeConnection()
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      apply(host.ctx)
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)
      expect(events.received.some((event) => event.reason === 'no-connection')).toBe(true)

      host.bindService('connection', connection)

      expect(handles.map((entry) => entry.channel)).toEqual(['/aikanban'])
      expect(getLastActivation()?.boardChannelRegistered).toBe(true)
      expect(getLastActivation()?.boardChannel).toBe('/aikanban')
      expect(events.received.some((event) => event.registered && event.channel === '/aikanban')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('does not throw and reports no-connection when connection is absent', async () => {
    const host = fakeHost()
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      expect(() => { apply(host.ctx) }).not.toThrow()
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)
      expect(getLastActivation()?.boardChannel).toBeNull()
      const event = events.received[0]
      expect(event).toMatchObject({ channel: '/aikanban', registered: false, reason: 'no-connection' })
      expect(typeof event?.at).toBe('number')
    } finally {
      events.unsubscribe()
    }
  })

  it('reports register-failed and does not throw when rpc.handle throws', async () => {
    const { connection } = fakeConnection({ throwOnHandle: true })
    const host = fakeHost({ services: { connection } })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      expect(() => { apply(host.ctx) }).not.toThrow()
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)
      expect(getLastActivation()?.boardChannel).toBeNull()
      expect(events.received.some((event) => event.reason === 'register-failed')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('answers unavailable on every endpoint before the data layer is ready', async () => {
    const { connection, handles } = fakeConnection()
    const host = fakeHost({ services: { connection } })
    apply(host.ctx)
    const handler = handles[0]?.handler
    expect(handler).toBeDefined()
    if (handler === undefined) return
    const signal = AbortSignal.timeout(5_000)

    const read = await handler('board/read', { projectId: 'project-1' }, signal)
    expect(read).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const setStatus = await handler('task/status.set', { taskId: 't1', next: 'done', operationId: 'op-1', expectedStatusVersion: 'ver1:0' }, signal)
    expect(setStatus).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const reorder = await handler('task/reorder', { taskId: 't1', status: 'todo', toIndex: 0, operationId: 'op-2', expectedStatusVersion: 'ver1:0' }, signal)
    expect(reorder).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const undo = await handler('task/status.undo', { taskId: 't1', operationId: 'op-3', expectedStatusVersion: 'ver1:0', appliedUpdateId: 'op-0' }, signal)
    expect(undo).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})

/**
 * Data-layer bootstrap (s1-wiring.md §5.1/§5.2).
 *
 * `openDataLayer` must open the real spec shape through whatever `open()`
 * implementation the host exposes, do one read, and report failure instead of
 * throwing. The zod-free shim is asserted to actually validate, because a
 * pass-through stub would silently accept corrupt records on reopen.
 */
describe('host half: data layer bootstrap', () => {
  it('opens aikanban_core through storageDomain and marks the data layer ready', async () => {
    const storage = fakeStorageDomain()
    const { connection, handles } = fakeConnection()
    const host = fakeHost({ services: { storageDomain: storage.service, connection } })
    apply(host.ctx)
    await waitFor(() => getLastActivation()?.dataLayerReady === true, 'dataLayerReady=true')

    expect(storage.opened).toHaveLength(1)
    const spec = storage.opened[0] as {
      name: string
      version: number
      layout: string
      tables: Record<string, { valueSchema: { parse(value: unknown): unknown } }>
    }
    expect(spec.name).toBe('aikanban_core')
    expect(spec.version).toBe(1)
    expect(spec.layout).toBe('single')
    expect(Object.keys(spec.tables).sort()).toEqual(['drafts', 'scope_state'])
    // The shim is real validation, not a pass-through stub.
    expect(() => spec.tables['scope_state']?.valueSchema.parse({})).toThrow()
    expect(getKanbanCore()).not.toBeNull()
    expect(getLastActivation()?.dataLayerReady).toBe(true)
    expect(getLastActivation()?.servicesObserved).toContain('storageDomain')

    // Ready without the core adapter (P5b) = explicit placeholder, never an
    // empty board and never a silent success.
    const handler = handles[0]?.handler
    expect(handler).toBeDefined()
    if (handler === undefined) return
    const signal = AbortSignal.timeout(5_000)
    const read = await handler('board/read', { projectId: 'project-1' }, signal)
    expect(read).toMatchObject({ ok: false, error: { code: 'read-failed' } })
    expect(JSON.stringify(read)).toContain('not-wired-yet')
    const write = await handler('task/status.set', { taskId: 't1', next: 'done', operationId: 'op-1', expectedStatusVersion: 'ver1:0' }, signal)
    expect(write).toMatchObject({ ok: false, error: { code: 'save-failed' } })
    expect(JSON.stringify(write)).toContain('not-wired-yet')
  })

  it('keeps dataLayerReady false and exposes the reason when open() rejects', async () => {
    const storage = fakeStorageDomain({ reject: new Error('domain was refused by the host') })
    const host = fakeHost({ services: { storageDomain: storage.service } })
    expect(() => { apply(host.ctx) }).not.toThrow()
    await waitFor(() => getDataLayerError() !== null, 'a visible data-layer failure')
    expect(getLastActivation()?.dataLayerReady).toBe(false)
    expect(getKanbanCore()).toBeNull()
    expect(getDataLayerError()).toContain('domain was refused by the host')
  })

  it('does not attempt to open a domain when storageDomain is absent', async () => {
    const host = fakeHost()
    apply(host.ctx)
    // Give a (wrong) bootstrap a chance to run: none must happen without the service.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getKanbanCore()).toBeNull()
    expect(getLastActivation()?.dataLayerReady).toBe(false)
    expect(getDataLayerError()).toBe('storageDomain service is not bound')
  })

  it('republishes the activation signal once the data layer is ready', async () => {
    const storage = fakeStorageDomain()
    const host = fakeHost({ services: { storageDomain: storage.service } })
    const dc = await import('node:diagnostics_channel')
    const received: ActivationSnapshot[] = []
    const listener = (payload: unknown): void => { received.push(payload as ActivationSnapshot) }
    dc.subscribe(ACTIVATION_CHANNEL, listener)
    try {
      apply(host.ctx)
      await waitFor(() => getLastActivation()?.dataLayerReady === true, 'dataLayerReady=true')
      expect(received.some((snapshot) => snapshot.dataLayerReady === true)).toBe(true)
    } finally {
      dc.unsubscribe(ACTIVATION_CHANNEL, listener)
    }
  })
})

/**
 * Reproduces DSH 44.7.0's channel-registration defect in a fake service.
 *
 * The shipped `connection` service exposes `rpc.handle`, but its closure
 * captures an owner context shadowed to the service provider (which cannot
 * resolve `webServer`), so `handle` throws. The same class also has the
 * internal `register(owner, channel, handler)` that `handle` delegates to.
 */
class ShadowedRpcConnection {
  readonly routes: { channel: string; handler: unknown }[] = []

  get rpc() {
    return {
      handle: (channel: string, handler: unknown): unknown => {
        void channel
        void handler
        throw new Error('cannot get property "webServer" without inject')
      },
    }
  }

  register(owner: unknown, channel: string, handler: unknown): void {
    const webServer = (owner as { webServer?: { register?: unknown } }).webServer
    if (typeof webServer?.register !== 'function') {
      throw new Error('cannot get property "webServer" without inject')
    }
    ;(webServer.register as (route: unknown) => unknown)({ kind: 'prefix', path: channel, handler })
    this.routes.push({ channel, handler })
  }
}

/**
 * Scoped channel registration (s1-wiring.md §5.1/§5.5).
 *
 * The channel must be registered from a context that injects `connection` and
 * `webServer`. On DSH 44.7.0 the public `rpc.handle` throws before that works,
 * so the fallback to the host's own `register(owner, …)` is pinned here; a
 * future host that fixes `rpc.handle` keeps working through the primary path.
 */
describe('host half: scoped board channel registration', () => {
  it('registers through the documented path when the host supports it', async () => {
    const { connection } = fakeConnection()
    const webServer = { register: () => () => undefined }
    const host = fakeHost({ withInject: true, services: { connection, webServer } })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      apply(host.ctx)
      expect(getLastActivation()?.boardChannelRegistered).toBe(true)
      expect(getLastActivation()?.boardChannel).toBe('/aikanban')
      expect(events.received.some((event) => event.registered && event.channel === '/aikanban')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('falls back to the host register(owner) path when rpc.handle throws', async () => {
    const connection = new ShadowedRpcConnection()
    const webServer = { routes: [] as unknown[], register(route: unknown) { this.routes.push(route); return () => undefined } }
    const host = fakeHost({ withInject: true, services: { connection, webServer } })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      apply(host.ctx)
      expect(connection.routes.map((route) => route.channel)).toEqual(['/aikanban'])
      expect(webServer.routes).toHaveLength(1)
      const snapshot = getLastActivation()
      expect(snapshot?.boardChannelRegistered).toBe(true)
      expect(snapshot?.boardChannel).toBe('/aikanban')
      expect(events.received.some((event) => event.registered && event.channel === '/aikanban')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('waits for both injected services before registering', async () => {
    const connection = new ShadowedRpcConnection()
    const webServer = { register: () => () => undefined }
    const host = fakeHost({ withInject: true })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      apply(host.ctx)
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)

      host.bindService('connection', connection)
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)

      host.bindService('webServer', webServer)
      expect(connection.routes.map((route) => route.channel)).toEqual(['/aikanban'])
      expect(getLastActivation()?.boardChannelRegistered).toBe(true)
      expect(events.received.some((event) => event.registered)).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('reports register-failed when neither the public nor the fallback path works', async () => {
    const broken = {
      get rpc() {
        return {
          handle: () => { throw new Error('connection is closed') },
        }
      },
    }
    const webServer = { register: () => () => undefined }
    const host = fakeHost({ withInject: true, services: { connection: broken, webServer } })
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      expect(() => { apply(host.ctx) }).not.toThrow()
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)
      expect(events.received.some((event) => event.reason === 'register-failed')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })

  it('does not throw and reports register-failed when ctx.inject throws', async () => {
    const host = fakeHost({ withInject: true })
    ;(host.ctx as unknown as { inject: () => unknown }).inject = () => {
      throw new Error('inject refused by the host')
    }
    const events = await subscribe<BoardChannelEventPayload>(BOARD_CHANNEL_EVENT)
    try {
      expect(() => { apply(host.ctx) }).not.toThrow()
      expect(getLastActivation()?.boardChannelRegistered).toBe(false)
      expect(getLastActivation()?.boardChannel).toBeNull()
      expect(events.received.some((event) => event.reason === 'register-failed')).toBe(true)
    } finally {
      events.unsubscribe()
    }
  })
})
