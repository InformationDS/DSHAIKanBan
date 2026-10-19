#!/usr/bin/env node
/**
 * Host-half import verification — the load-chain proof that needs no host.
 *
 * ## What this proves
 *
 * The DSH loader activates a host-half plugin by `import()`ing the package's
 * `main` (a plain ESM module) and calling its exported `apply`. Three packaging
 * mistakes break that, and all three are silent until a user's profile fails to
 * boot:
 *
 * 1. The emitted `lib/index.js` is not valid ESM, or wraps itself in the
 *    browser-half `window.__ModuleLoader__` banner by mistake.
 * 2. It imports something the *host* cannot resolve. A host resolves from the
 *    profile directory, so a bare `@deepseek-ai/*` import that only exists in
 *    this workspace's `node_modules` fails there.
 * 3. `package.json` does not point at the file, or the loader contract
 *    (`apply` / `inject`) is not exported.
 *
 * So this script: asserts the metadata wiring, scans the built module's import
 * graph transitively, requires every specifier to be a `node:` builtin, then
 * dynamically imports it and checks the exports.
 *
 * ## Usage
 *
 * ```sh
 * node tools/verify-host-import.mjs [--package packages/plugin]
 * ```
 *
 * Exits non-zero with a diagnostic on the first failure.
 *
 * @module tools/verify-host-import
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Matches static imports, side-effect imports, dynamic imports, and re-exports. */
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[\s\S]*?\sfrom\s*)['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/**
 * Extract every module specifier a chunk of ESM text requests.
 *
 * @param {string} source - the module text.
 * @returns {Set<string>} bare or relative specifiers, in first-seen order.
 */
function scanSpecifiers(source) {
  const found = new Set()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1])
    }
  }
  return found
}

/**
 * Resolve a relative specifier against the module that requested it.
 *
 * @param {string} specifier - the raw specifier.
 * @param {string} fromFile - absolute path of the requesting module.
 * @returns {string | null} an existing file path, or null when unresolvable.
 */
function resolveRelative(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier)
  // TypeScript's ESM convention: `./x.js` on disk may be `./x.ts` at source
  // time, but we only ever walk *built* output, where the `.js` is real.
  if (existsSync(base)) return realpathSync(base)
  return null
}

/**
 * Walk the import graph of a built module and collect every bare specifier.
 *
 * @param {string} entryFile - absolute path to the built entry module.
 * @returns {Promise<{ bare: Map<string, string>, files: string[] }>} bare
 *   specifiers mapped to the file that imported them, plus the visited files.
 */
async function collectImportGraph(entryFile) {
  const bare = new Map()
  const files = []
  const seen = new Set()
  const queue = [realpathSync(entryFile)]

  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    files.push(file)

    // Read as text rather than importing: we must not execute arbitrary
    // transitive modules just to inspect their imports.
    const source = readFileSync(file, 'utf8')
    for (const specifier of scanSpecifiers(source)) {
      if (specifier.startsWith('node:') || isBuiltin(specifier)) {
        bare.set(specifier, file)
        continue
      }
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(specifier, file)
        if (resolved === null) {
          throw new Error(
            `unresolvable relative import "${specifier}" in ${relative(WORKSPACE_ROOT, file)}`,
          )
        }
        queue.push(resolved)
        continue
      }
      if (specifier.startsWith('data:') || specifier.startsWith('http:')) continue
      bare.set(specifier, file)
    }
  }

  return { bare, files }
}

/**
 * Format a byte count for a human-readable report line.
 *
 * @param {number} bytes - the size.
 * @returns {string} a short human string.
 */
function humanBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Parse `--flag value` pairs; unknown flags are a hard error so typos cannot
 * silently change what is verified.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | true>} parsed options.
 */
function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${String(arg)}"`)
    const [flag, inline] = arg.split('=')
    const key = String(flag).slice(2)
    if (key === 'json' || key === 'help') {
      options[key] = true
      continue
    }
    const value = inline ?? argv[i + 1]
    if (value === undefined) throw new Error(`--${key} needs a value`)
    if (inline === undefined) i += 1
    options[key] = value
  }
  return options
}

const HELP = `Usage: node tools/verify-host-import.mjs [options]

Verifies that the built AIKanBan host half is a valid, dependency-free ESM
module that satisfies the DSH plugin loader contract. Run \`pnpm run build\`
first.

Options:
  --package <dir>   package directory to verify (default: packages/plugin)
  --json            print a machine-readable JSON report instead of prose
  --help            show this help
`

/** The result of one verification run. */
const checks = []

/**
 * Record and run one named check.
 *
 * @param {string} name - the check's name.
 * @param {() => unknown} body - the check; throw to fail.
 * @returns {unknown} the check's return value.
 */
function check(name, body) {
  try {
    const detail = body()
    if (detail instanceof Promise) {
      // Async checks append their own record once settled; returning a promise
      // here would render as "[object Promise]" in the report.
      return detail.then(
        (settled) => { checks.push({ name, ok: true, detail: settled === undefined ? '' : String(settled) }) },
        (error) => {
          checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
          throw error
        },
      )
    }
    checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
    return detail
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name, ok: false, detail: message })
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }

  const packageDir = resolve(WORKSPACE_ROOT, typeof options.package === 'string' ? options.package : 'packages/plugin')
  const relativePackageDir = relative(WORKSPACE_ROOT, packageDir).replaceAll('\\', '/')
  const asJson = options.json === true

  /** Collected report lines, printed at the end (or as JSON). */
  const report = { packageDir: relativePackageDir, checks, ok: true }

  try {
    const manifestPath = join(packageDir, 'package.json')
    check('package.json exists', () => {
      if (!existsSync(manifestPath)) throw new Error(`missing ${relative(WORKSPACE_ROOT, manifestPath)}`)
      return relative(WORKSPACE_ROOT, manifestPath)
    })

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check('manifest declares type: module', () => {
      if (manifest.type !== 'module') throw new Error(`type is ${JSON.stringify(manifest.type)}, expected "module"`)
      return manifest.type
    })

    const mainRel = check('manifest declares a main entry', () => {
      const main = manifest.exports?.['.']?.default ?? manifest.main
      if (typeof main !== 'string') throw new Error('neither exports["."].default nor main is a string')
      return main
    })

    const entryFile = join(packageDir, String(mainRel))
    check('host entry is built', () => {
      if (!existsSync(entryFile)) {
        throw new Error(`${relative(WORKSPACE_ROOT, entryFile)} is missing — run \`pnpm run build\` first`)
      }
      return `${relative(WORKSPACE_ROOT, entryFile)} (${humanBytes(readFileSync(entryFile).byteLength)})`
    })

    const entrySource = readFileSync(entryFile, 'utf8')

    check('host entry is ESM, not a browser-half bundle', () => {
      if (entrySource.includes('__ModuleLoader__')) {
        throw new Error(
          'lib/index.js contains `__ModuleLoader__`: the browser-half banner leaked into the host half. '
          + 'Check that tsdown.config.ts does not pick up src/client.tsx as an entry.',
        )
      }
      if (!/\b(export|import)\b/.test(entrySource)) throw new Error('no import/export statement found — is this ESM?')
      return 'no __ModuleLoader__ banner; ESM statements present'
    })

    const { bare, files } = await collectImportGraph(entryFile)

    check('import graph is host-resolvable (no bare specifiers)', () => {
      const foreign = [...bare.entries()].filter(([specifier]) => !specifier.startsWith('node:') && !isBuiltin(specifier))
      if (foreign.length > 0) {
        const lines = foreign.map(([specifier, file]) => `  - ${specifier} (from ${relative(WORKSPACE_ROOT, file)})`)
        throw new Error(
          `the host half imports packages a profile cannot resolve:\n${lines.join('\n')}\n`
          + 'The host resolves from the profile directory, so the host half must either use only node: builtins '
          + 'or declare the package as a real dependency.',
        )
      }
      return `${String(files.length)} module(s), only node: builtins`
    })

    check('module graph is fully present on disk', () => `${String(files.length)} file(s) reachable`)

    const loaded = await import(pathToFileURL(entryFile).href)

    check('exports apply() for the loader to call', () => {
      if (typeof loaded.apply !== 'function') throw new Error(`apply is ${typeof loaded.apply}`)
      return 'function apply(ctx)'
    })

    check('exports an inject array (cordis activation gate)', () => {
      if (!Array.isArray(loaded.inject)) throw new Error(`inject is ${typeof loaded.inject}`)
      return `[${loaded.inject.join(', ')}]`
    })

    await check('apply() activates against a service-less context', async () => {
      // Observe the diagnostics channel, NOT the logger: cordis's logger is an
      // in-memory buffer plus exporters and the shipped dsh app registers no
      // console exporter, so a `logger.warn` marker never reaches a caller.
      const dc = await import('node:diagnostics_channel')
      const received = []
      const listener = (payload) => { received.push(payload) }
      dc.subscribe(loaded.ACTIVATION_CHANNEL, listener)
      let logs = []
      try {
        const fakeHost = {
          logger: { info: (...args) => logs.push(args.map(String).join(' ')), warn: (...args) => logs.push(args.map(String).join(' ')) },
          reflect: { get: () => undefined },
          on: () => undefined,
        }
        loaded.apply(fakeHost)
      } finally {
        dc.unsubscribe(loaded.ACTIVATION_CHANNEL, listener)
      }
      const payload = received[0]
      if (payload === undefined) {
        throw new Error(
          `no ${String(loaded.ACTIVATION_CHANNEL)} message; logger saw: ${logs.join(' | ') || '(nothing)'}`,
        )
      }
      if (!String(payload.marker).includes('[aikanban] active')) {
        throw new Error(`unexpected marker in the activation payload: ${JSON.stringify(payload.marker)}`)
      }
      return `activation=${String(payload.activationId)} pid=${String(payload.pid)}`
    })

    await check('diagnostic tool is exported and callable', async () => {
      const snapshot = loaded.getLastActivation()
      if (snapshot === null || snapshot === undefined) throw new Error('getLastActivation() returned empty')
      const tool = loaded.createStatusTool(snapshot)
      const value = await tool.execute({}, {})
      if (value.marker !== snapshot.marker) throw new Error('tool snapshot does not match the activation record')
      const rendered = tool.output.render({}, value)
      const text = rendered?.[0]?.text
      if (typeof text !== 'string' || !text.includes('[aikanban] active')) {
        throw new Error('tool output does not name the activation marker')
      }
      return `${tool.name} → ${text}`
    })
  } catch {
    report.ok = false
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const width = Math.max(...checks.map((c) => c.name.length))
    process.stdout.write(`\nHost-half import verification — ${relativePackageDir}\n\n`)
    for (const item of checks) {
      process.stdout.write(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(width)}  ${item.detail}\n`)
    }
    process.stdout.write(`\n${report.ok ? 'OK' : 'FAILED'}\n`)
  }

  if (!report.ok) process.exitCode = 1
}

await main()
