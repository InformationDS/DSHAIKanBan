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
 * ## Why the context is typed structurally
 *
 * A dynamic bundle may only `require()` specifiers the shell's frozen module
 * table answers (`react`, `react/jsx-runtime`, `@deepseek-ai/cordis`, and the
 * static UI libraries). Importing `@deepseek-ai/dsh-client-ui-slots` purely for
 * its `SlotRegistry` type would still add a build-time package dependency for
 * zero runtime benefit, so the two methods actually used are declared locally.
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
}

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
 * Register both seats and return their combined disposer.
 *
 * Kept separate from `apply()` so the unit tests can drive it against a fake
 * slot registry without constructing a cordis context.
 *
 * @param ctx - the browser plugin context.
 * @returns a disposer that unregisters every seat this half owns.
 */
export function registerSlots(ctx: ClientContext): () => void {
  const disposers: (() => void)[] = []

  // Seat 1 — the board itself: a new key on the root `main` slot.
  disposers.push(ctx.slots.register(
    { name: 'main', key: PANEL_ID, scope: 'root', label: 'AIKanBan' },
    boardPanel,
  ))

  // Seat 2 — the entry point that selects it. Same id as the `main` key, which
  // is what `ctx.layout.selectPanel` expects.
  disposers.push(ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'AIKanBan' },
    paletteIcon,
  ))

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
 * @param ctx - the browser plugin context.
 * @returns a disposer that unregisters every seat this half owns.
 */
export function apply(ctx: ClientContext): () => void {
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
