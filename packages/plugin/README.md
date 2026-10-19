# AIKanBan plugin package

The **DSH-addressed** package of the monorepo: this is what a profile's
`cordis.patch.yml` names in an `insert` entry, and the only package that
declares `dsh.bundle` / `dsh.client`.

| Field | Value | Why |
| --- | --- | --- |
| `name` | `@aikanban/dsh-aikanban` | The boot graph row id, the `__ModuleLoader__` registration key, and the `/plugins/<id>/client.js` route segment. It must **not** reuse `@omdsh-dev/dsh-aikanban` — that name is an unrelated, sealed older implementation still present in `profiles/web`. |
| `main` | `lib/index.js` | Host half: plain ESM, `import()`ed by the loader through the profile's `node_modules`. |
| `exports["./client"]` | `./lib/client.js` | Browser half. The client module system *requires* this subpath to exist whenever `dsh.client` is declared; its string/`{default}` form is read to locate the served bundle. |
| `dsh.bundle.patch` | `./cordis.patch.yml` | Makes the package usable as a profile **bundle layer**. |
| `dsh.client.platform` | `web` | Any other value and the client module system skips the row entirely. |

## Two halves, two output contracts

```
packages/plugin/
  src/index.ts          host half      -> tsdown.config.ts        -> lib/index.js   (ESM, node)
  src/client.tsx        loader entry   -> tsdown.client.config.ts -> lib/client.js  (CJS factory, browser)
  cordis.patch.yml      bundle layer
```

`src/client.tsx` deliberately contains no UI: it re-exports
`@aikanban/plugin-client`, which `tsdown.client.config.ts` resolves **into** the
bundle. One plugin id must produce exactly one
`window.__ModuleLoader__.load({ id, factory })` registration, so the UI library
is not allowed to build a bundle of its own.

## Commands

Run from the repository root — see the root `README` section that Lead collects.
In short:

```sh
pnpm run typecheck   # tsc -b, project references, dependency order
pnpm run build       # tsc -b (declarations -> dist/) + tsdown (bundles -> lib/)
pnpm test            # vitest across packages
pnpm run verify      # above + tools/verify-host-import.mjs
```

## Load-chain notes (verified against the shipped DSH packages)

- The boot layer rewrites an `insert` entry whose `name` starts with `./`, `../`
  or is absolute into a `file:` URL **anchored beside the patch file**
  (`anchorInsertedPluginNames`, `@deepseek-ai/dsh-app-boot`). A bare package
  name is resolved through the profile's `node_modules` instead. Both forms are
  therefore legal; this file uses the bare name.
- `dsh.client` is read by `@deepseek-ai/dsh-client-modules`: a non-string
  `platform` throws, and a declared `dsh.client` without an
  `exports["./client"]` entry throws. Both are load-time failures, not warnings.
- The browser half may only `require()` specifiers the shell's frozen
  `PLATFORM_MODULES` table answers (React, Cordis, static UI libraries).
  `tsdown.client.config.ts` fails the build on any other `@deepseek-ai/*`
  import rather than letting it become a runtime throw in the user's page.
