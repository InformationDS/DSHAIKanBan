#!/usr/bin/env node
/**
 * Isolated load-chain probe: boot a real DSH host in a throwaway Harness home
 * with the AIKanBan bundle installed, and verify the load chain end to end.
 *
 * ## Why this is the strongest evidence available
 *
 * `DSH_HOME` overrides the Harness home (precedence: explicit > `$DSH_HOME` >
 * `~/.dsh`). Pointing it at `.probe-home-scaffold/` inside the workspace gives a
 * **completely separate** host — its own `profiles/`, `sessions/`, `storages/`
 * and module tree. Nothing the user is running is touched, and no restart is
 * involved. The probe host binds `--port 0` (OS-assigned) and never opens a
 * browser, so it cannot collide with a live GUI on a fixed port.
 *
 * The home is **namespaced to this tool** because the probe deletes and
 * recreates it every run; sharing a probe home with another tool would destroy
 * that tool's fixtures. `--home <dir>` overrides it. Nothing is ever written
 * into the probe home except the throwaway `probe` profile — in particular no
 * credentials, so this probe stays hermetic and needs no live model.
 *
 * ## The three checks, and what each one proves
 *
 * | # | Check | What a failure means |
 * | --- | --- | --- |
 * | 1 | `--dump-config` lists the `aikanban` row | `cordis.patch.yml` did not compose, or the profile's layer list is wrong. |
 * | 2 | A profile-anchored `import()` of the resolved package succeeds and `apply()` logs the marker | The host half cannot be resolved/imported **from the profile**, or it throws on activation. This uses `createRequire(<profile>/package.json)` deliberately, so a package that only resolves from this workspace fails here. |
 * | 3 | The booting host publishes a `window.__DSH_BOOT__` row for the package, and serves its revisioned `client.js` | The browser half was not accepted: `dsh.client` malformed, missing `exports["./client"]`, or the bundle missing. |
 * | 4 | A `node:diagnostics_channel` message arrives from inside the booting host | `apply()` did not actually run in the host process. |
 *
 * Check 4 uses the diagnostics channel, **not** a log line, on purpose: cordis's
 * logger is an in-memory ring buffer plus registered exporters, and the shipped
 * `dsh` app registers no console exporter in the profiles measured — so a
 * `logger.warn` marker is real but invisible from outside the process. The
 * probe subscribes with `--require` passed through `NODE_OPTIONS`, which writes
 * nothing into the isolated home.
 *
 * ## What it does **not** prove
 *
 * That the *user's* profile picks the bundle up, or that the browser half
 * renders in a slot. Both need a write into the live profile plus a restart;
 * `tools/sync-to-profile.mjs` prints those steps and never runs them.
 *
 * ## Usage
 *
 * ```sh
 * node tools/probe-host.mjs                 # full probe
 * node tools/probe-host.mjs --dump-only     # composition only; never binds a port
 * node tools/probe-host.mjs --keep          # keep .probe-home for inspection
 * ```
 *
 * @module tools/probe-host
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(WORKSPACE_ROOT, 'packages', 'plugin')
const PACKAGE_NAME = '@aikanban/dsh-aikanban'

/** The marker the host half logs when `apply()` runs. */
const MARKER = '[aikanban] active'

const HOME_DIR_NAME = '.probe-home-scaffold'

const HELP = `Usage: node tools/probe-host.mjs [options]

Boot a real DSH host in an isolated, workspace-local Harness home and verify
that the AIKanBan bundle is composed, resolved, imported, activated and
published as a browser row.

Options:
  --profile <name>   probe profile name (default: probe)
  --home <dir>       isolated Harness home (default: <workspace>/${HOME_DIR_NAME})
  --port <n>         probe host port; 0 = OS-assigned (default: 0)
  --timeout <sec>    seconds to wait for the host to settle (default: 180)
  --dump-only        only compose the tree; never boot
  --keep             keep the isolated home after the run
  --help             show this help

The default home is namespaced to THIS tool because the probe deletes and
recreates it on every run. Never point --home at another tool's probe home: it
would be wiped, taking that tool's fixtures with it. No credential file may be
placed in the probe home either — this probe is hermetic and needs none.

Exit codes: 0 ok, 1 probe failed, 2 bad arguments, 4 package not built.
`

/**
 * Parse `--flag value` / `--flag` arguments, rejecting unknown flags.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | true>} parsed options.
 */
function parseArgs(argv) {
  const options = {}
  const booleans = new Set(['dump-only', 'keep', 'help'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${String(arg)}"`)
    const [flag, inline] = arg.split('=')
    const key = String(flag).slice(2)
    if (booleans.has(key)) {
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

/**
 * Locate the `dsh` CLI entry module.
 *
 * @returns {string} absolute path to the CLI's `lib/bin.js`.
 */
function locateCli() {
  const candidates = []
  const fromEnv = process.env['DSH_CLI']
  if (fromEnv !== undefined && fromEnv.trim() !== '') candidates.push(fromEnv)
  if (process.platform === 'win32' && process.env['APPDATA'] !== undefined) {
    candidates.push(join(process.env['APPDATA'], 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  if (process.env['HOME'] !== undefined) {
    candidates.push(join(process.env['HOME'], '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  throw new Error(
    'cannot find the dsh CLI. Set DSH_CLI to the absolute path of @deepseek-ai/dsh/lib/bin.js.\n'
    + `Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  )
}

/**
 * Write the isolated home's probe profile: a shipped bundle template plus the
 * one insert entry under test, with the package junctioned into the profile's
 * own module tree so the probe always exercises the CURRENT build.
 *
 * @param {string} profileDir - the probe profile directory.
 * @returns {string} the junction path that was created.
 */
function writeProbeProfile(profileDir) {
  mkdirSync(profileDir, { recursive: true })

  // The shipped `web` template's bundle list, written explicitly: `probe` is not
  // a template name, so the host would refuse to auto-initialize it, and an
  // explicit file makes the probe reproducible.
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-probe',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }, undefined, 2)}\n`)

  writeFileSync(join(profileDir, 'cordis.patch.yml'), `# Isolated AIKanBan probe layer — generated by tools/probe-host.mjs.
- insert:
    - id: aikanban
      name: '${PACKAGE_NAME}'
`)
  writeFileSync(join(profileDir, 'cordis.yml'), '# probe profile root — composed from patches\n[]\n')

  const linkPath = join(profileDir, 'node_modules', '@aikanban', 'dsh-aikanban')
  mkdirSync(dirname(linkPath), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(PACKAGE_DIR, linkPath, 'junction')
  return linkPath
}

/**
 * Run a child process to completion, capturing stdout and stderr.
 *
 * @param {string} command - executable path.
 * @param {string[]} args - arguments.
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} options - spawn options.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} the result.
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { child.kill('SIGKILL') }, options.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  process.stdout.write(HELP)
  process.exit(0)
}

const profileName = typeof options.profile === 'string' ? options.profile : 'probe'
if (profileName === '' || profileName.includes('/') || profileName.includes('\\')) {
  process.stderr.write(`probe-host: invalid profile name ${JSON.stringify(profileName)}\n`)
  process.exit(2)
}
const home = resolve(WORKSPACE_ROOT, typeof options.home === 'string' ? options.home : HOME_DIR_NAME)
const port = typeof options.port === 'string' ? options.port : '0'
if (!/^\d+$/.test(port)) {
  process.stderr.write(`probe-host: --port must be a number, got ${JSON.stringify(port)}\n`)
  process.exit(2)
}
const timeoutSec = typeof options.timeout === 'string' ? Number(options.timeout) : 180
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  process.stderr.write('probe-host: --timeout must be a positive number of seconds\n')
  process.exit(2)
}
const dumpOnly = options['dump-only'] === true
const keep = options.keep === true

const node = process.execPath
const profileDir = join(home, 'profiles', profileName)
const outDir = join(WORKSPACE_ROOT, '.probe-out-scaffold')
const logPath = join(outDir, `probe-${profileName}.log`)
const dumpPath = join(outDir, `probe-${profileName}-dump.txt`)

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const checks = []
/** Things this run could not observe; printed separately so they are never read as verified. */
const observations = []
const record = (name, ok, detail) => { checks.push({ name, ok, detail }) }

process.stdout.write('AIKanBan isolated load probe\n\n')
process.stdout.write(`  workspace        ${WORKSPACE_ROOT}\n`)
process.stdout.write(`  isolated home    ${home}\n`)
process.stdout.write(`  probe profile    ${profileDir}\n`)
process.stdout.write(`  port             ${port === '0' ? '0 (OS-assigned — cannot collide with a running GUI)' : port}\n`)
process.stdout.write(`  mode             ${dumpOnly ? 'composition only' : 'composition + real boot'}\n\n`)

if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
  process.stderr.write('probe-host: packages/plugin/lib/index.js is missing — run `pnpm run build` first\n')
  process.exit(4)
}

let cli
try {
  cli = locateCli()
} catch (error) {
  process.stderr.write(`probe-host: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
process.stdout.write(`  dsh cli          ${cli}\n  node             ${node}\n\n`)

// Fresh home every run: a stale profile could pass the probe for the wrong reason.
rmSync(home, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const linkPath = writeProbeProfile(profileDir)
process.stdout.write(`prepared isolated home; ${PACKAGE_NAME} → ${linkPath}\n\n`)

/* ---------------- 1. composition ---------------- */
process.stdout.write('[1/4] composing the probe profile tree (--dump-config)\n')
const dump = await run(node, [cli, '--profile', profileName, '--dump-config'], { env: { DSH_HOME: home }, timeoutMs: 180_000 })
writeFileSync(dumpPath, `# exit ${String(dump.code)}\n# stdout\n${dump.stdout}\n# stderr\n${dump.stderr}\n`)
const dumpLines = `${dump.stdout}\n${dump.stderr}`.split(/\r?\n/).filter((line) => line.includes('aikanban'))
if (dump.code === 0 && dumpLines.length > 0) {
  record('composed tree contains the aikanban row', true, dumpLines[0]?.trim() ?? '')
  process.stdout.write(`  PASS  ${dumpLines.slice(0, 2).map((l) => l.trim()).join(' | ')}\n`)
} else {
  const diagnostic = `${dump.stdout}\n${dump.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-20)
  record('composed tree contains the aikanban row', false, `exit=${String(dump.code ?? 'spawn-error')}`)
  process.stdout.write(`  FAIL  exit=${String(dump.code ?? 'spawn-error')}\n${diagnostic.map((l) => `        ${l}`).join('\n')}\n`)
}

/* ---------------- 2. profile-anchored resolution + activation ---------------- */
process.stdout.write('\n[2/4] resolving and activating the host half from the profile directory\n')
try {
  // Anchor resolution at the PROFILE, exactly like the host: `createRequire`
  // against the profile manifest resolves `@aikanban/dsh-aikanban` through the
  // profile's node_modules. Nothing here may fall back to this workspace.
  const profileRequire = createRequire(pathToFileURL(join(profileDir, 'package.json')).href)
  const manifestPath = profileRequire.resolve(`${PACKAGE_NAME}/package.json`)
  if (!isAbsolute(manifestPath)) throw new Error(`resolved a non-absolute manifest: ${manifestPath}`)
  const relManifest = relative(WORKSPACE_ROOT, manifestPath)
  if (relManifest.startsWith('..')) throw new Error(`resolved outside the workspace: ${manifestPath}`)

  const manifest = profileRequire(`${PACKAGE_NAME}/package.json`)
  const entryRel = manifest.exports['.'].default
  const entryPath = join(dirname(manifestPath), entryRel)

  // Run the load in a child process whose cwd is the profile and whose module
  // resolution is anchored there, so a workspace-only import cannot slip in.
  const script = `
    import { pathToFileURL } from 'node:url'
    const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)})
    const logs = []
    const host = {
      logger: { info: (...a) => logs.push(a.map(String).join(' ')), warn: (...a) => logs.push(a.map(String).join(' ')) },
      reflect: { get: () => undefined },
      on: () => undefined,
    }
    mod.apply(host)
    const marker = logs.find((line) => line.includes(${JSON.stringify(MARKER)}))
    if (marker === undefined) { console.error('NO_MARKER ' + JSON.stringify(logs)); process.exit(3) }
    process.stdout.write(marker)
  `
  const activation = await run(node, ['--input-type=module', '-e', script], { timeoutMs: 60_000 })
  const marker = `${activation.stdout}${activation.stderr}`.split(/\r?\n/).find((line) => line.includes(MARKER))
  if (activation.code === 0 && marker !== undefined) {
    record('host half resolves from the profile and apply() activates', true, `${relManifest.replaceAll('\\', '/')} → ${marker.trim()}`)
    process.stdout.write(`  PASS  ${relManifest.replaceAll('\\', '/')}\n        ${marker.trim()}\n`)
  } else {
    record('host half resolves from the profile and apply() activates', false, `exit=${String(activation.code ?? 'spawn-error')}`)
    process.stdout.write(`  FAIL  exit=${String(activation.code ?? 'spawn-error')}\n        ${(activation.stderr || activation.stdout).trim().split(/\r?\n/).slice(-6).join('\n        ')}\n`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  record('host half resolves from the profile and apply() activates', false, message)
  process.stdout.write(`  FAIL  ${message}\n`)
}

if (dumpOnly) {
  process.stdout.write('\ncomposition-only: no host was booted, no port was bound.\n')
  process.stdout.write(`full dump: ${relative(WORKSPACE_ROOT, dumpPath).replaceAll('\\', '/')}\n`)
  if (!keep) rmSync(home, { recursive: true, force: true })
  process.exit(checks.every((c) => c.ok) ? 0 : 1)
}

/* ---------------- 3 + 4. real boot ---------------- */
process.stdout.write('\n[3/4] booting the probe host; reading its window.__DSH_BOOT__ graph\n')
writeFileSync(logPath, '')

// Subscribe to the plugin's activation channel inside the host process. The
// cordis logger is an in-memory buffer plus exporters and the shipped dsh app
// registers no console exporter, so a log line is NOT observable from outside;
// `node:diagnostics_channel` is. The observer is a real file rather than an
// inline `--eval` because `NODE_OPTIONS` value quoting through a Windows env
// var is fragile enough to prevent the host from starting at all — which looks
// exactly like a plugin failure.
const observerPath = join(outDir, 'activation-observer.cjs')
writeFileSync(observerPath, `// Generated by tools/probe-host.mjs — subscribes to the AIKanBan activation channel.
const dc = require('node:diagnostics_channel')
dc.subscribe('aikanban:activation', (payload) => {
  process.stderr.write('[probe] ACTIVATION ' + JSON.stringify(payload) + '\\n')
})
`)
const child = spawn(node, [cli, '--profile', profileName, '--port', port, '--no-open'], {
  cwd: WORKSPACE_ROOT,
  env: {
    ...process.env,
    DSH_HOME: home,
    NODE_OPTIONS: [process.env['NODE_OPTIONS'], `--require=${observerPath}`].filter(Boolean).join(' '),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { bootLog += chunk })
child.stderr.on('data', (chunk) => { bootLog += chunk })

/**
 * Wait until `predicate` matches a log line, the host exits, or time runs out.
 *
 * @param {(line: string) => boolean} predicate - line test.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<string | null>} the matching line, or null.
 */
function waitForLine(predicate, timeoutMs) {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs
    const poll = setInterval(() => {
      const match = bootLog.split(/\r?\n/).find((line) => predicate(line))
      if (match !== undefined) { clearInterval(poll); resolvePromise(match); return }
      if (child.exitCode !== null) { clearInterval(poll); resolvePromise(null); return }
      if (Date.now() > deadline) { clearInterval(poll); resolvePromise(null) }
    }, 250)
  })
}

const urlLine = await waitForLine((line) => line.includes('http://'), timeoutSec * 1000)
const observerUnavailable = /--require[^\s]*activation-observer|NODE_OPTIONS/.test(bootLog)
  || bootLog.includes('is not allowed in NODE_OPTIONS')
let boot = { entryFound: false, bundleOk: false, detail: 'host never printed a URL' }

if (urlLine !== null) {
  process.stdout.write(`  ok    host settled and bound: ${urlLine.trim()}\n`)
  try {
    const base = /(https?:\/\/\S+)/.exec(urlLine)?.[1]
    const parsed = new URL(base ?? '')
    const origin = parsed.origin
    const token = parsed.searchParams.get('token')

    // The launch token is exchanged for a signed cookie (303 + set-cookie);
    // it is not an authorization header.
    let cookieHeader = {}
    if (token !== null) {
      const exchange = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
      const raw = exchange.headers.getSetCookie?.()[0] ?? exchange.headers.get('set-cookie')
      if (raw != null) cookieHeader = { cookie: raw.split(';')[0] }
    }

    const page = await fetch(`${origin}/`, { headers: cookieHeader })
    const html = await page.text()
    const json = extractJsonAfter(html, '"__DSH_BOOT__"] = ')
      ?? extractJsonAfter(html, '__DSH_BOOT__"] = ')
      ?? extractJsonAfter(html, '__DSH_BOOT__ = ')
    if (json === null) throw new Error(`no window.__DSH_BOOT__ in the served index (${String(page.status)}, ${String(html.length)}B)`)
    const graph = JSON.parse(json)
    const entry = (graph.entries ?? []).find((e) => e.id === PACKAGE_NAME)
    boot = { entryFound: entry !== undefined, bundleOk: false, detail: `graph rev=${String(graph.rev)} entries=${String(graph.entries?.length)}` }
    if (entry === undefined) {
      process.stdout.write(`  FAIL  ${PACKAGE_NAME} is absent from window.__DSH_BOOT__ (${boot.detail})\n`)
    } else {
      const bundle = await fetch(`${origin}${entry.url}`, { headers: cookieHeader })
      const body = await bundle.text()
      boot.bundleOk = bundle.status === 200 && body.includes('__ModuleLoader__') && body.includes(PACKAGE_NAME)
      boot.detail = `entry=${entry.url} status=${String(bundle.status)} bytes=${String(body.length)}`
      process.stdout.write(`  PASS  browser row published: ${entry.url}\n`)
      process.stdout.write(`        served ${String(bundle.status)} ${String(body.length)}B: ${body.slice(0, 80).replace(/\s+/g, ' ')}…\n`)
    }
  } catch (error) {
    boot.detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  FAIL  ${boot.detail}\n`)
  }
} else {
  process.stdout.write('  FAIL  the host never printed its URL line\n')
}

record('host publishes a window.__DSH_BOOT__ row and serves client.js', boot.entryFound && boot.bundleOk, boot.detail)

process.stdout.write('\n[4/4] waiting for the activation signal from inside the host\n')
const signalLine = await waitForLine((line) => line.includes('[probe] ACTIVATION '), 60_000)
if (signalLine !== null) {
  const payload = signalLine.slice(signalLine.indexOf('[probe] ACTIVATION ') + '[probe] ACTIVATION '.length)
  let detail = payload
  try {
    const parsed = JSON.parse(payload)
    detail = `activation=${String(parsed.activationId)} pid=${String(parsed.pid)} tools=${String(parsed.statusToolRegistered)} systemPrompt=${String(parsed.promptSectionRegistered)}`
  } catch { /* keep the raw payload */ }
  process.stdout.write(`  PASS  the booting host published aikanban:activation:\n        ${detail}\n`)
  record('apply() ran inside the booting host', true, detail)
} else if (observerUnavailable) {
  // Never claim a skipped observation as verified.
  process.stdout.write('  SKIP  the observer preload was refused into the host process (NODE_OPTIONS restricted)\n')
  observations.push('apply() in the booting host was NOT observed this run: the observer preload was refused')
} else {
  process.stdout.write('  FAIL  the host never published aikanban:activation\n')
  record('apply() ran inside the booting host', false, 'no aikanban:activation message observed in the host process')
}

// Tear the probe host down: never leave a server behind.
if (child.exitCode === null) {
  if (process.platform === 'win32') await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeoutMs: 20_000 })
  else child.kill('SIGTERM')
}
await new Promise((r) => { setTimeout(r, 800) })
writeFileSync(logPath, bootLog)

if (!keep) {
  rmSync(home, { recursive: true, force: true })
}

/* ---------------- report ---------------- */
const failed = checks.filter((c) => !c.ok)
process.stdout.write(`\nprobe host log: ${relative(WORKSPACE_ROOT, logPath).replaceAll('\\', '/')}\n`)
if (!keep) process.stdout.write('isolated home removed (pass --keep to inspect it)\n')
process.stdout.write(`\nsummary\n${checks.map((c) => `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`).join('\n')}\n`)
if (observations.length > 0) {
  process.stdout.write(`\nnot observed (NOT verified)\n${observations.map((o) => `  - ${o}`).join('\n')}\n`)
}
process.stdout.write(`\n${failed.length === 0
  ? 'PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.'
  : 'PROBE FAILED'}\n`)
for (const failure of failed) process.stdout.write(`  - ${failure.name}: ${failure.detail}\n`)
process.exit(failed.length === 0 ? 0 : 1)

/**
 * Extract the first balanced JSON object or array that follows `anchor`.
 *
 * Substring matching is not enough: the graph is an inline script assignment
 * whose JSON contains braces and the literal `</script>`-adjacent text.
 *
 * @param {string} html - the page source.
 * @param {string} anchor - the text immediately before the JSON.
 * @returns {string | null} the balanced JSON text, or null.
 */
function extractJsonAfter(html, anchor) {
  const start = html.indexOf(anchor)
  if (start < 0) return null
  const open = start + anchor.length
  const opener = html[open]
  if (opener !== '{' && opener !== '[') return null
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) return html.slice(open, i + 1)
    }
  }
  return null
}
