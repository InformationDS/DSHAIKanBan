/**
 * Build config for the AIKanBan **browser half**.
 *
 * Output contract (mirrors the shipped `@omdsh-dev/dsh-genui` and
 * `@dsh-external/dsh-visualize` bundles, which are the working precedents):
 *
 * 1. **One classic script** at `lib/client.js`, addressed by
 *    `package.json#exports["./client"]` — the path the DSH client module system
 *    serves at `/plugins/@aikanban/dsh-aikanban/client.js`.
 * 2. The script's only top-level effect is registering a factory:
 *    `window.__ModuleLoader__.load({ id, factory })`. It must **not** execute
 *    module bodies: lazy-CJS materialization happens on first `require`.
 *    The `banner`/`intro`/`footer` wrappers below produce exactly that.
 * 3. `format: 'cjs'` + `platform: 'browser'` is what makes the factory body
 *    speak `require(...)`: the loader hands the factory a synchronous `require`
 *    bound to the frozen platform module table.
 * 4. Only module-table specifiers may stay external, and the table is frozen
 *    (`PLATFORM_MODULES`: React, Cordis, static UI libraries). `react` and
 *    `react/jsx-runtime` are in it; anything else must be bundled. The
 *    `purityGate` below turns a violation into a **build failure** instead of a
 *    runtime throw inside the user's page.
 */
import { defineConfig } from 'tsdown'

/** Package id — must equal the boot graph row id and the `__ModuleLoader__` key. */
const ID = '@aikanban/dsh-aikanban'

/**
 * Module-table specifiers this bundle may leave unbundled. Keep this list as
 * small as possible: every entry is a promise that the shell's frozen table
 * answers it.
 */
const EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/cordis']

/**
 * Fail the build on any externalised `@deepseek-ai/*` import that is not in
 * {@link EXTERNALS}: those are cross-plugin value imports, which the client
 * module system refuses at runtime. The shipped genui preset ships the same
 * gate; keeping it means a mistake surfaces here rather than as a blank panel.
 */
function purityGate() {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/') && source !== 'react-dom' && source !== 'react') return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the platform module table (EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services instead.',
      )
    },
  }
}

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client.tsx' },
  outDir: 'lib',
  // CJS: the factory receives `require` and returns `module.exports`.
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    // Everything else — including the workspace-local `@aikanban/plugin-client`
    // library — is resolved into this single bundle, so exactly one
    // `__ModuleLoader__.load` registration exists for this package id.
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [purityGate()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
