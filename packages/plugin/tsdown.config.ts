/**
 * Build config for the AIKanBan **host half**.
 *
 * Two independently-satisfied output contracts in this workspace:
 *
 * - **Host half (this config)** — a plain ESM module the DSH loader `import()`s
 *   by package name. It must keep `node:*` external and stay readable, so it is
 *   emitted as an unminified ESM bundle with a stable `lib/index.js` path that
 *   `package.json#main` points at.
 * - **Client half (`tsdown.client.config.ts`)** — a single classic script that
 *   registers itself through `window.__ModuleLoader__.load({ id, factory })`.
 *   That one must be CJS-format and browser-platform.
 *
 * `dts` is off: `tsc -b` (see tsconfig.json) owns declarations in `./dist`, so
 * a declaration pass here would duplicate or fight it.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@aikanban/dsh-aikanban',
  // `src/client.tsx` is intentionally NOT an entry here: it belongs to the
  // browser bundle below and would otherwise be emitted twice with different
  // module semantics (ESM vs the loader's CJS factory form).
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  // Minification is deliberately off: this half is small, and readable host
  // bundles make a load failure diagnosable from the log stream alone.
  minify: false,
  sourcemap: true,
  // `tsc -b` writes ./dist in the same run; never let tsdown wipe it.
  clean: false,
  // The host half shares the F02 wire contract with the browser half
  // (`@aikanban/plugin-client/wire`). It MUST be inlined: the host resolves its
  // imports from the profile directory, where no `@aikanban/*` package exists,
  // and `tools/verify-host-import.mjs` fails the chain on a surviving bare
  // specifier. React-free by construction — `wire.ts` imports types only.
  deps: { alwaysBundle: (id: string) => id.startsWith('@aikanban/') },
  outputOptions: { entryFileNames: '[name].js' },
})
