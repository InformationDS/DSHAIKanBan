/**
 * AIKanBan browser half (UI package) — the board panel and its palette entry,
 * as slot components.
 *
 * ## Why this is a separate package from `packages/plugin`
 *
 * `packages/plugin` is what the DSH client module system addresses: its
 * `package.json` carries `dsh.client`, its `exports["./client"]` is the served
 * bundle, and that bundle must contain **exactly one**
 * `window.__ModuleLoader__.load({ id: '@aikanban/dsh-aikanban', … })`
 * registration. Multiple registrations of one id are not a supported shape.
 *
 * So the UI code lives here as a normal library (built to declarations, no
 * bundle), and `packages/plugin/src/client.tsx` is a three-line loader entry
 * that re-exports it. `packages/plugin/tsdown.client.config.ts` resolves this
 * workspace package **into** the single client bundle rather than leaving it
 * external.
 *
 * ## Seats (ADR-004)
 *
 * | Seat | kind / scope | What lands there |
 * | --- | --- | --- |
 * | `main` (key `aikanban`) | keyed / root | the board's main panel body |
 * | `sidebar.panellist` (id `aikanban`) | list / root | the icon that selects it |
 *
 * `ctx.layout.selectPanel('aikanban')` is the shared navigation entry. The
 * `main` seat's keyDomain is **open**, so this key does not collide with the
 * shipped `conversation` key. ADR-004 explicitly forbids registering into
 * `root` (single slot: a second entry *shadows* the official frame) and into
 * `sidebar.workspaces` (same shadowing risk); neither is touched.
 *
 * ## Registration is declaration-aware
 *
 * Both seats are declared by *other* UI packages — `main` by
 * `@deepseek-ai/dsh-client-ui-layout`, `sidebar.panellist` by
 * `@deepseek-ai/dsh-client-ui-sidebar` — and client entry application order is
 * loader-driven, so a direct `ctx.slots.register` can run before its seat
 * exists. The slot service rejects that race
 * (`slot "…" is not declared (a parent entry's children table must declare
 * it)`), which the page's boot audit reports as a non-activating entry
 * (`web boot: N entries did not activate`). Every shipped registrant — the
 * official `dsh-client-ui-*` bundles and the third-party reference bundles —
 * therefore waits on the declaration with
 * `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`, whose callback
 * runs when the declaration is committed, is disposed when it collapses, and
 * runs again if it reappears. {@link registerSlots} prefers that API and keeps
 * the direct register as the fallback for shells (and unit fakes) without it.
 *
 * `dsh.client.inject` in `packages/plugin/package.json` is a *separate*
 * switch: it only orders boot-graph module arrival, it does not make a
 * registration legal, and it is not a cordis service `inject`.
 *
 * ## Why the context is typed structurally
 *
 * A dynamic bundle may only `require()` specifiers the shell's frozen module
 * table answers (`react`, `react/jsx-runtime`, `@deepseek-ai/cordis`, and the
 * static UI libraries). Importing `@deepseek-ai/dsh-client-ui-slots` purely for
 * its `SlotRegistry` type would still add a build-time package dependency for
 * zero runtime benefit, so the few members actually used are declared locally.
 *
 * @module @aikanban/plugin-client
 */

import { createElement, type ReactNode } from 'react'

import { boardPanel } from './board.js'
import { createChannelBoardSource, isConnectionLike } from './channel-source.js'
import { NO_CONNECTION_DETAIL, setBoardSource } from './runtime.js'
import { createUnavailableBoardSource } from './source.js'
import { BOARD_CHANNEL } from './wire.js'

/** Package identity of the plugin that ships this UI. */
const PLUGIN_ID = '@aikanban/dsh-aikanban'

/** Shared key between the `main` seat entry, the palette icon, and `selectPanel`. */
export const PANEL_ID = 'aikanban'

/* ------------------------------------------------------------------ *
 * Structural view of the browser context
 * ------------------------------------------------------------------ */

/** Slot scopes the shell exposes. ADR-004 uses root and session only. */
export type SlotScope = 'root' | 'session' | 'session-maybe'

/**
 * Registration options for `ctx.slots.register`. `key` is required by keyed
 * slots (`main`, `sidebar.right.pane.tab`); `id` is required by list slots
 * (`sidebar.panellist`).
 */
export interface SlotRegisterOptions {
  /** Target seat name, e.g. `main`. */
  readonly name: string
  /** Key within a keyed seat, e.g. the `main` panel key. */
  readonly key?: string
  /** Identity within a list seat. */
  readonly id?: string
  /** Ordering hint inside list seats. */
  readonly order?: number
  /** Accessible label for list seats. */
  readonly label?: string
  readonly scope?: SlotScope
}

/** The slot registry service the client half needs. */
export interface SlotsLike {
  register(options: SlotRegisterOptions, component: () => ReactNode): () => void
  /**
   * Declaration-aware registration (the shell's slots service). Runs
   * `callback` synchronously when `ownerKey`'s declaration already exists, and
   * queues it until the declaring `register()` commits when it does not;
   * collapsing the declaration disposes the callback's registrations and a
   * later declaration runs it again.
   *
   * Optional so a shell without the API (and the unit-test fakes) can still
   * drive the direct-register fallback. It must be called as a member
   * expression — `ctx.slots.inject(...)` — because the service proxy binds its
   * caller context at call time.
   */
  inject?(ownerKey: string, callback: () => SlotInjectionEffect): () => void
}

/**
 * What a {@link SlotsLike.inject} callback may return: nothing, one disposer,
 * or an iterable of disposers (the service installs those transactionally and
 * disposes them in reverse order).
 */
export type SlotInjectionEffect = void | SlotDisposer | Iterable<SlotDisposer>

/** One registration disposer. */
export type SlotDisposer = () => void

/** The layout service: panel navigation. */
export interface LayoutLike {
  selectPanel(panelId: string | null): void
}

/** The browser context surface this plugin touches. */
export interface ClientContext {
  readonly slots: SlotsLike
  readonly layout?: LayoutLike
  readonly logger?: { info(...args: unknown[]): void }
  /**
   * Optional service probe. Used for `connection` instead of declaring it in
   * `inject`: a declared-but-absent service parks the fiber forever, while a
   * probe lets the panel render an explicit read failure (REC-05).
   */
  readonly reflect?: { get(name: string, strict?: false): unknown }
  /** Cordis's own accessor, used when `reflect` is unavailable. */
  readonly get?: (name: string) => unknown
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

/**
 * The board panel body. Defined in `board.tsx` (which owns the whole F02
 * surface) and re-exported here because the seat registration below mounts it.
 */
export { boardPanel }

/**
 * The palette icon that selects the board panel.
 *
 * @returns the icon node.
 */
export function paletteIcon(): ReactNode {
  return createElement(
    'span',
    {
      'data-aikanban-palette': PANEL_ID,
      role: 'img',
      'aria-label': 'AIKanBan',
      title: 'AIKanBan',
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '16px' },
    },
    // A column/board glyph: three lanes.
    createElement(
      'svg',
      { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' },
      createElement('rect', { x: 1, y: 1.5, width: 3.2, height: 11, rx: 1, fill: 'currentColor', opacity: 0.9 }),
      createElement('rect', { x: 5.4, y: 1.5, width: 3.2, height: 8, rx: 1, fill: 'currentColor', opacity: 0.65 }),
      createElement('rect', { x: 9.8, y: 1.5, width: 3.2, height: 5, rx: 1, fill: 'currentColor', opacity: 0.45 }),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * One ADR-004 seat: the slot declaration whose lifetime gates the
 * registration, the registration options, and the component factory.
 */
interface SlotSeat {
  /**
   * `ctx.slots.inject` owner key — the slot whose declaration must exist for
   * the registration to be legal. Both ADR-004 seats fill the slot they wait
   * on, which is the shape every shipped registrant uses.
   */
  readonly ownerKey: string
  readonly options: SlotRegisterOptions
  readonly component: () => ReactNode
}

/**
 * The two ADR-004 seats, in registration order.
 *
 * Seat 1 — the board itself: a new key on the root `main` slot (the seat's
 * keyDomain is open, so `aikanban` does not shadow `conversation`).
 * Seat 2 — the palette icon that selects it: same id as the `main` key, which
 * is what `ctx.layout.selectPanel` expects.
 */
const SLOT_SEATS: readonly SlotSeat[] = [
  {
    ownerKey: 'main',
    options: { name: 'main', key: PANEL_ID, scope: 'root', label: 'AIKanBan' },
    component: boardPanel,
  },
  {
    ownerKey: 'sidebar.panellist',
    options: { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'AIKanBan' },
    component: paletteIcon,
  },
]

/**
 * Register both seats and return their combined disposer.
 *
 * Registration is declaration-aware when the shell's slot service offers
 * {@link SlotsLike.inject}: each seat's `register` runs inside the inject
 * callback for its own slot, so it waits for the declaration instead of
 * racing it (a direct register before the declaration throws in the slot
 * service and fails the page boot). The direct-register fallback keeps this
 * function usable against a shell (or fake) without the API.
 *
 * Kept separate from `apply()` so the unit tests can drive it against a fake
 * slot registry without constructing a cordis context.
 *
 * @param ctx - the browser plugin context.
 * @returns a disposer that unregisters every seat this half owns.
 */
export function registerSlots(ctx: ClientContext): () => void {
  const disposers: SlotDisposer[] = []

  for (const seat of SLOT_SEATS) {
    // A member call on purpose: the slot service proxy binds the caller's
    // fiber context at call time, which routes disposal into this plugin.
    const register = (): SlotDisposer => ctx.slots.register(seat.options, seat.component)

    if (typeof ctx.slots.inject === 'function') {
      disposers.push(ctx.slots.inject(seat.ownerKey, register))
    } else {
      disposers.push(register())
    }
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Browser services this bundle needs before it may start. `slots` is a hard
 * requirement (there is nothing to do without it); `layout` is deliberately NOT
 * declared — it is only a convenience for the palette icon, and a
 * declared-but-absent service parks the fiber in `waiting` forever.
 */
export const inject: string[] = ['slots']

/**
 * Register the AIKanBan browser half.
 *
 * The transport is chosen here, once: `ctx.connection` (this plugin's own host
 * half over DSH's authenticated Connection RPC channel, ADR-005) when the
 * service is present, otherwise a source whose every read fails visibly. The
 * service is probed rather than declared in `inject`, so a composition without
 * it still mounts a panel that explains itself (REC-05) instead of parking the
 * fiber.
 *
 * The whole body is wrapped in try/catch purely as a diagnostic aid: the DSH
 * Desktop crash report captures the page's error-level `console` output, so
 * the log line below is where the stack for a failed activation ends up. The
 * error is rethrown rather than swallowed — a swallowed failure would leave
 * the fiber ACTIVE with no panel mounted, which the boot audit would not name
 * and the user would see as a silently missing icon. Rethrowing keeps the
 * failure attributed to this entry (`@aikanban/dsh-aikanban: failed`).
 *
 * @param ctx - the browser plugin context.
 * @returns a disposer that unregisters every seat this half owns.
 */
export function apply(ctx: ClientContext): () => void {
  console.info('[aikanban] client apply entered')
  try {
    const connection = ctx.reflect?.get('connection', false) ?? ctx.get?.('connection')
    if (isConnectionLike(connection)) {
      setBoardSource(createChannelBoardSource(connection))
      ctx.logger?.info(`[aikanban] active (client half) transport=connection channel=${BOARD_CHANNEL}`)
    } else {
      setBoardSource(createUnavailableBoardSource(NO_CONNECTION_DETAIL))
      ctx.logger?.info(`[aikanban] active (client half) transport=unavailable (${NO_CONNECTION_DETAIL})`)
    }

    const dispose = registerSlots(ctx)
    ctx.logger?.info(
      `[aikanban] active (client half) plugin=${PLUGIN_ID} slots=main:${PANEL_ID},sidebar.panellist:${PANEL_ID}`,
    )
    return dispose
  } catch (error) {
    console.error('[aikanban] client apply failed', error)
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * Public surface of the browser half
 *
 * Re-exported through this module because the DSH client module system serves
 * *this* file as the package's client half: whatever the panel, the tests and
 * the loader need must be reachable from here. The layers below are React-free
 * except the components, so the wire contract stays importable by the host half.
 * ------------------------------------------------------------------ */

export * from './model.js'
export * from './source.js'
export * from './wire.js'
export * from './channel-source.js'
export * from './controller.js'
export * from './board.js'
export * from './runtime.js'
