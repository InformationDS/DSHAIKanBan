# @aikanban/plugin-client

The AIKanBan **browser-half UI library**: the board panel body and its palette
icon, as DSH client-slot components.

## Why this is not the package DSH addresses

`@aikanban/dsh-aikanban` (`packages/plugin`) is what a profile mounts. Its
`package.json` carries `dsh.client`, its `exports["./client"]` is the served
bundle, and that bundle must contain **exactly one**

```js
window.__ModuleLoader__.load({ id: '@aikanban/dsh-aikanban', factory })
```

registration — a second registration for one id is not a supported shape. So
this package is a plain library (built to declarations under `dist/`), and
`packages/plugin/src/client.tsx` re-exports it;
`packages/plugin/tsdown.client.config.ts` resolves it **into** the single client
bundle rather than leaving it external.

Consequence for contributors: this package has **no** `dsh.*` block, no
`cordis.patch.yml`, and no tsdown config. Adding any of them would create a
second, competing plugin identity.

## What it registers (ADR-004)

| Seat | kind / scope | Entry |
| --- | --- | --- |
| `main` | keyed / root | `{ name: 'main', key: 'aikanban', scope: 'root' }` |
| `sidebar.panellist` | list / root | `{ name: 'sidebar.panellist', id: 'aikanban', order: 40 }` |

Both share the id `aikanban`, which is what `ctx.layout.selectPanel('aikanban')`
navigates to. The `main` seat's keyDomain is open, so this key does not collide
with the shipped `conversation` key.

**Forbidden seats** (ADR-004): `root` and `sidebar.workspaces` are single slots —
a second entry *shadows* the official UI rather than sitting beside it.
`conversation.view` does not exist in the current DSH slot catalog. The test
suite asserts none of the three is touched.

## Types are structural on purpose

A dynamic bundle may only `require()` specifiers the shell's frozen
`PLATFORM_MODULES` table answers. Importing
`@deepseek-ai/dsh-client-ui-slots` purely for its `SlotRegistry` type would add a
build-time package dependency for zero runtime benefit, so the two methods this
half actually uses (`slots.register`, and optionally `layout.selectPanel`) are
declared locally as `SlotsLike` / `LayoutLike`.

## Commands

```sh
pnpm -C packages/plugin-client run build      # tsc -b -> dist/ (declarations + js)
pnpm -C packages/plugin-client run test       # vitest run
```

`inject = ['slots']` only. `layout` is used opportunistically and deliberately
**not** declared: cordis `inject` is a hard activation gate, so a
declared-but-absent service parks the fiber in `waiting` forever.
