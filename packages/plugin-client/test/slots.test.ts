/**
 * Browser-half unit tests.
 *
 * These run against **source**, not the bundle, so a failure here localizes a
 * problem to the registration logic rather than to the packaging. The bundle's
 * own load-chain test lives in `packages/plugin/test/client-bundle.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import { PANEL_ID, apply, inject, registerSlots, type SlotRegisterOptions, type SlotsLike } from '../src/index.js'

/** A fake slot registry that records the registrations it receives. */
function fakeSlots() {
  const calls: { options: SlotRegisterOptions; component: () => unknown }[] = []
  const released: SlotRegisterOptions[] = []
  const slots: SlotsLike = {
    register(options, component) {
      calls.push({ options, component })
      return () => { released.push(options) }
    },
  }
  return { slots, calls, released }
}

describe('plugin-client: seats', () => {
  it('registers exactly the two ADR-004 seats', () => {
    const { slots, calls } = fakeSlots()
    registerSlots({ slots })
    expect(calls.map((c) => c.options.name).sort()).toEqual(['main', 'sidebar.panellist'])
  })

  it('uses a key (not an id) for the keyed `main` seat and the same panel id for the palette', () => {
    const { slots, calls } = fakeSlots()
    registerSlots({ slots })

    const main = calls.find((c) => c.options.name === 'main')
    expect(main?.options.key).toBe(PANEL_ID)
    expect(main?.options.id).toBeUndefined()
    // `main` is a root-scope keyed slot; the keyDomain is open, so a new key is
    // legal and does not shadow the shipped `conversation` key.
    expect(main?.options.scope).toBe('root')

    const palette = calls.find((c) => c.options.name === 'sidebar.panellist')
    expect(palette?.options.id).toBe(PANEL_ID)
    expect(palette?.options.key).toBeUndefined()
    expect(palette?.options.label).toBe('AIKanBan')
  })

  it('never touches the seats ADR-004 forbids', () => {
    const { slots, calls } = fakeSlots()
    registerSlots({ slots })
    const names = calls.map((c) => c.options.name)
    expect(names).not.toContain('root')
    expect(names).not.toContain('sidebar.workspaces')
    expect(names).not.toContain('conversation.view')
  })

  it('mounts components as zero-argument factories', () => {
    const { slots, calls } = fakeSlots()
    registerSlots({ slots })
    for (const call of calls) expect(call.component).toBeTypeOf('function')
  })

  it('releases every registration through the returned disposer', () => {
    const { slots, calls, released } = fakeSlots()
    const dispose = registerSlots({ slots })
    expect(released).toHaveLength(0)
    dispose()
    expect(released).toHaveLength(calls.length)
  })

  it('requires only the `slots` service', () => {
    // `layout` is used opportunistically; declaring it would park the fiber on
    // hosts that ship no layout service.
    expect(inject).toEqual(['slots'])
  })

  it('returns a disposer from apply() as well', () => {
    const { slots, released } = fakeSlots()
    const dispose = apply({ slots })
    expect(dispose).toBeTypeOf('function')
    dispose()
    expect(released).toHaveLength(2)
  })
})
