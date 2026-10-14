/**
 * Load-chain test — the one that actually proves the packaging.
 *
 * It executes the **built** client bundle (`lib/client.js`) the way the DSH
 * shell does, without a browser and without the DSH host:
 *
 * 1. Install a fake `window.__ModuleLoader__` that records registrations
 *    instead of queueing them.
 * 2. Read `lib/client.js` and run it as a classic script.
 * 3. Assert the script's *only* top-level effect was registering exactly one
 *    factory under the package id — i.e. the lazy-CJS contract holds and no
 *    module body ran at parse time.
 * 4. Materialize the factory with a `require` bound to the platform module
 *    table, assert the exports carry `apply`/`inject`, then activate against a
 *    fake slot registry and assert both ADR-004 seats were requested with the
 *    right shape (`main` keyed, `sidebar.panellist` listed).
 *
 * Steps 3–4 are precisely the two things that break in production when the
 * packaging is wrong: a bundle that runs its body eagerly, and a bundle whose
 * extents do not match the shell's frozen module table. A skeleton that merely
 * compiles cannot catch either.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const BUNDLE_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PLUGIN_ID = '@aikanban/dsh-aikanban'

/** One recorded `__ModuleLoader__.load` call. */
interface Registration {
  id: string
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** A recorded `ctx.slots.register` call. */
interface SlotCall {
  options: { name: string; key?: string; id?: string; order?: number; scope?: string; label?: string }
  component: unknown
}

/**
 * Run the built bundle against a fake loader + module table.
 *
 * @returns the captured registration and a materializer bound to the given
 *   externals.
 */
function executeBundle(externals: Record<string, unknown>) {
  const registrations: Registration[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      mode: 'queue' as const,
      pendingQueue: [] as Registration[],
      load(registration: Registration) { registrations.push(registration) },
      create() { throw new Error('not used in this test') },
    },
  }

  const source = readFileSync(BUNDLE_PATH, 'utf8')

  // eslint-disable-next-line no-new-func -- executing the artifact IS the test.
  const run = new Function('window', 'document', source)
  run(fakeWindow, undefined)

  expect(registrations).toHaveLength(1)
  const registration = registrations[0] as Registration
  expect(registration.id).toBe(PLUGIN_ID)

  const materialize = () => registration.factory((spec: string) => {
    if (!(spec in externals)) {
      throw new Error(`bundle required "${spec}", which is not in the platform module table`)
    }
    return externals[spec]
  })

  return { registration, materialize }
}

/** Minimal React stand-in: enough for `createElement` to build a plain tree. */
const fakeReact = {
  createElement(type: unknown, props: unknown, ...children: unknown[]) {
    return { type, props, children }
  },
}

/**
 * A fake slot registry that records registration shape.
 *
 * @returns the recorded calls plus the fake `ctx`.
 */
function fakeSlots() {
  const calls: SlotCall[] = []
  const disposed: SlotCall[] = []
  const ctx = {
    slots: {
      register(options: SlotCall['options'], component: unknown) {
        const call = { options, component }
        calls.push(call)
        return () => { disposed.push(call) }
      },
    },
    logger: { info: () => undefined },
  }
  return { ctx, calls, disposed }
}

describe('client bundle: registration protocol', () => {
  it('is present and non-empty', () => {
    const source = readFileSync(BUNDLE_PATH, 'utf8')
    expect(source.length).toBeGreaterThan(0)
  })

  it('registers exactly one factory, under the package id, as its only top-level effect', () => {
    const { registration } = executeBundle({ react: fakeReact, 'react/jsx-runtime': fakeReact })
    expect(registration.id).toBe(PLUGIN_ID)
    expect(typeof registration.factory).toBe('function')
  })

  it('does not execute module bodies at script parse time (lazy-CJS contract)', () => {
    // The fake table records every `require` the factory makes. If the bundle
    // ran its body eagerly, the table would be touched before materialization.
    const touched: string[] = []
    const { materialize } = executeBundle(new Proxy({}, {
      get(_target, spec: string) {
        touched.push(spec)
        return spec === 'react/jsx-runtime' ? fakeReact : fakeReact
      },
      has() { return true },
    }) as Record<string, unknown>)
    expect(touched).toEqual([])
    materialize()
    expect(touched.length).toBeGreaterThan(0)
  })

  it('materializes exports carrying apply() and inject', () => {
    const { materialize } = executeBundle({ react: fakeReact, 'react/jsx-runtime': fakeReact })
    const exports = materialize()
    expect(typeof exports['apply']).toBe('function')
    expect(Array.isArray(exports['inject'])).toBe(true)
    expect(exports['inject']).toEqual(['slots'])
  })
})

describe('client bundle: slot mounts (ADR-004)', () => {
  it('requests both seats with the shapes ADR-004 specifies', () => {
    const { materialize } = executeBundle({ react: fakeReact, 'react/jsx-runtime': fakeReact })
    const exports = materialize() as { apply: (ctx: unknown) => () => void }

    const { ctx, calls } = fakeSlots()
    exports.apply(ctx)

    expect(calls).toHaveLength(2)

    const main = calls.find((c) => c.options.name === 'main')
    expect(main, `no "main" registration among ${calls.map((c) => c.options.name).join(', ')}`).toBeDefined()
    // Keyed slot: a KEY is required, and it is the panel id `selectPanel` uses.
    expect(main?.options.key).toBe('aikanban')
    expect(main?.options.scope).toBe('root')
    expect(main?.component).toBeTypeOf('function')

    const palette = calls.find((c) => c.options.name === 'sidebar.panellist')
    expect(palette).toBeDefined()
    // List slot: an ID is required.
    expect(palette?.options.id).toBe('aikanban')
    expect(typeof palette?.options.order).toBe('number')

    // Nothing may touch the two seats ADR-004 forbids.
    const forbidden = calls.filter((c) => c.options.name === 'root' || c.options.name === 'sidebar.workspaces')
    expect(forbidden).toEqual([])
  })

  it('returns a disposer that unregisters every seat', () => {
    const { materialize } = executeBundle({ react: fakeReact, 'react/jsx-runtime': fakeReact })
    const exports = materialize() as { apply: (ctx: unknown) => () => void }
    const { ctx, calls, disposed } = fakeSlots()

    const dispose = exports.apply(ctx)
    expect(disposed).toHaveLength(0)
    dispose()
    expect(disposed).toHaveLength(calls.length)
  })

  it('renders both components without touching a DOM', () => {
    const { materialize } = executeBundle({ react: fakeReact, 'react/jsx-runtime': fakeReact })
    const exports = materialize() as { boardPanel: () => unknown; paletteIcon: () => unknown }
    expect(exports.boardPanel()).toBeDefined()
    expect(exports.paletteIcon()).toBeDefined()
  })
})
