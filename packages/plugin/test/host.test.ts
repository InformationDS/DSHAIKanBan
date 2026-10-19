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
  STATUS_TOOL_NAME,
  apply,
  createStatusTool,
  getLastActivation,
  inject,
  publishActivationSignal,
  type ActivationSnapshot,
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
 */
function fakeHost(options: { services?: Record<string, unknown>; withTools?: boolean } = {}) {
  const logs: string[] = []
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const registered: unknown[] = []
  const sections: { name: string; order: number; text: string }[] = []
  const bound = new Map<string, unknown>(Object.entries(options.services ?? {}))

  const toolsService = { register: (tool: unknown) => { registered.push(tool); return tool } }
  const systemPromptService = {
    section: (s: { name: string; order: number; text: string }) => { sections.push(s); return s },
  }
  if (options.withTools !== false) bound.set('tools', toolsService)

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
    },
    toolsService: () => toolsService,
    systemPromptService: () => systemPromptService,
  }
}

/** A context with no services at all — the minimal-composition case. */
function bareHost(): HostContext {
  return { reflect: { get: () => undefined }, on: () => undefined }
}

describe('host half: activation', () => {
  it('activates without throwing when no optional service is bound', () => {
    expect(() => { apply(bareHost()) }).not.toThrow()
    const snapshot = getLastActivation()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.statusToolRegistered).toBe(false)
    expect(snapshot?.promptSectionRegistered).toBe(false)
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
      servicesObserved: [],
    }) }).not.toThrow()
  })

  it('names the channel with the plugin prefix so no DSH channel is shadowed', () => {
    expect(ACTIVATION_CHANNEL).toMatch(/^aikanban:/)
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
