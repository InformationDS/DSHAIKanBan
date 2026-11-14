#!/usr/bin/env node
/**
 * Real-HTTP RPC roundtrip verification for the `/aikanban` Connection channel.
 *
 * ## What this tool is
 *
 * `tools/probe-host.mjs` proves the host half is composed, resolved, activated,
 * and that `/aikanban` was registered *inside the host process*. It never sends
 * an HTTP request. `packages/plugin/test/channel-roundtrip.test.ts` proves the
 * envelope contract in-process, between the built client bundle and the built
 * host handler. Neither proves the shipped HTTP carrier.
 *
 * This tool boots the same kind of **isolated host** (its own `DSH_HOME`,
 * `--port 0`, `--no-open`), exchanges the launch token for the host's signed
 * session cookie exactly like `probe-host.mjs` does, and then speaks the real
 * wire to `POST {origin}/aikanban/<endpoint>`:
 *
 *   1. `project/list` — a positive roundtrip; the candidate set comes from the
 *      host's `workspaceRegistry`.
 *   2. `board/read`  — a positive roundtrip; the snapshot comes from
 *      `@aikanban/core` behind the real adapter (the adapter registers the
 *      project with core as part of the same request).
 *   3. `task/create` — a positive roundtrip with a unique `requestId`; the value
 *      must carry the created task (id, `fver1:`/`ver1:` baselines) and a
 *      refreshed snapshot containing it.
 *   4. `task/fields.update` — a positive roundtrip that decodes the baselines
 *      returned by step 3, saves a new title, and must report `saved`, the new
 *      `fieldsRevision`, and the refreshed snapshot.
 *   5. `activity/read` — a positive roundtrip for the task created in step 3;
 *      entries are newest-first and carry `task-created` + `task-title-changed`
 *      with string-only `details`.
 *   6. Manual summary (F03) — three positive roundtrips on the task created in
 *      step 3: `summary/read` (empty scope → `current: null` plus the write
 *      baseline), `summary/save` (committed under that baseline, read back,
 *      replayed as `already-applied`, re-saved as `no-change`, then rejected as
 *      `stale-baseline` from the stale view), and `summary/draft.save` (upsert
 *      one open draft without promoting it to an official version).
 *   7. The fence negatives: no cookie → 401, bad `Origin` → 403, missing
 *      `content-type: application/json` → 415, non-POST method / missing
 *      endpoint segment → 404. A post-fence control request proves the cookie
 *      is still valid after the negative batch, so those statuses are caused by
 *      the deviation and not by a broken session.
 *   8. Supplementary contract negatives, clearly separated from the fence: an
 *      endpoint name outside the eleven-endpoint contract answers HTTP 200 +
 *      `{ok:false,error:{code:'unknown-endpoint'}}`; an unregistered `projectId`
 *      answers HTTP 200 + `{ok:false,error:{code:'unknown-project'}}`; a
 *      `task/create` with a blank title answers HTTP 200 +
 *      `{ok:false,error:{code:'invalid-input'}}` with `details.keptInput`; a
 *      `task/fields.update` whose baseline is not `fver1:<n>` answers HTTP 200 +
 *      `{ok:false,error:{code:'invalid-payload'}}` before the port is reached.
 *      The handler returns failures instead of throwing (an exception would be
 *      HTTP 500).
 *
 * ## What this tool does NOT prove (never claim otherwise)
 *
 * - It is **not** the browser half: the requests are sent by this script, not by
 *   a page's `ctx.connection.rpc.call` after `window.__DSH_BOOT__` assembly.
 *   The browser half's bundle loading and its adapter are covered elsewhere
 *   (`client-bundle.test.ts`, `channel-roundtrip.test.ts`), not here.
 * - It is **not** a real profile and not the user's GUI: the isolated home is
 *   throwaway, no profile is installed and no GUI is restarted.
 * - It does **not** prove the public `ctx.connection.rpc.handle` entry point
 *   works. The process-internal registration evidence reported separately (the
 *   `aikanban:board-channel` diagnostics event) says which path was used; on DSH
 *   44.7.0 it is `compat` (see ADR-005「宿主缺陷与兼容层」). "The channel answers
 *   real HTTP" and "the public registration entry point works" are two different
 *   facts and this tool keeps their evidence apart.
 * - It is **not** acceptance evidence for any AT. `acceptance.csv` is untouched
 *   and every AT remains 「待执行」.
 *
 * ## Workspace fixture
 *
 * A truly empty isolated home has no workspace, so `project/list` would be a
 * legal empty set and `board/read` could only be exercised with an unregistered
 * id. The tool therefore reuses the probe facility's fixture writer —
 * `packages/plugin/src/probe/harness/prepare.mjs` — which writes
 * `<home>/storages/workspace.json` (the durable workspace domain unit, version
 * 2) with the real project records observed in the live registry. This is probe
 * tooling, not product code: the product's `workspaceRegistry` reads that file
 * exactly as it would after a user created projects. `board/read` then exercises
 * the real adapter path `registry.get → core.registerProject → core.readBoard`;
 * registration has no separate HTTP endpoint by design.
 *
 * ## Isolation and gitignore
 *
 * The home and output directories are nested under the already-gitignored
 * `.probe-home-scaffold/` and `.probe-out-scaffold/` trees **as their own
 * subdirectories**, so this tool never shares a home with `probe-host.mjs` while
 * it runs. Both tools wipe only what they own. Deleting either tree is always
 * safe; this tool rebuilds its home on every run.
 *
 * ## Usage
 *
 * ```sh
 * node tools/verify-rpc-roundtrip.mjs            # boot, verify, tear down
 * node tools/verify-rpc-roundtrip.mjs --keep     # keep the isolated home
 * node tools/verify-rpc-roundtrip.mjs --timeout 240
 * ```
 *
 * Requires: `pnpm run build` has produced `packages/plugin/lib/index.js`, and
 * the `dsh` CLI is installed (`DSH_CLI` overrides the discovered path).
 *
 * Exit codes:
 *   0  every assertion passed (real HTTP positives + fence negatives)
 *   1  at least one assertion failed — read the summary, never treat as "ok"
 *   2  bad arguments, or the `dsh` CLI cannot be located
 *   4  `packages/plugin/lib/index.js` is missing (run `pnpm run build`)
 *   5  the isolated host never settled (no URL line) — environment problem
 *   6  the isolated home/fixture could not be prepared
 *
 * @module tools/verify-rpc-roundtrip
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The probe harness is reusable probe tooling (not product code): its only
// exports used here are the isolated-home fixture writer and the workspace path
// it writes into that fixture.
import { prepare, PRIMARY_WORKSPACE_PATH } from '../packages/plugin/src/probe/harness/prepare.mjs'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(WORKSPACE_ROOT, 'packages', 'plugin')
const PACKAGE_NAME = '@aikanban/dsh-aikanban'

/** Nested under the probe-host's gitignored home so no new ignore pattern is needed. */
const HOME_DIR = join(WORKSPACE_ROOT, '.probe-home-scaffold', 'rpc-roundtrip')
/** Raw transcripts + generated observer live here (gitignored). */
const OUT_DIR = join(WORKSPACE_ROOT, '.probe-out-scaffold', 'rpc-roundtrip')

/** The one channel this repository registers (ADR-005). */
const CHANNEL = '/aikanban'
/** The eleven-endpoint contract (slice A's five + slice B's three + F03's three). */
const CONTRACT_ENDPOINTS = [
  'board/read', 'project/list', 'task/status.set', 'task/reorder', 'task/status.undo',
  'task/create', 'task/fields.update', 'activity/read',
  'summary/read', 'summary/save', 'summary/draft.save',
]
/** The five board columns core produces for a fresh project. */
const CONTRACT_COLUMN_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled']
/** The nine browser failure codes (slice B added `invalid-input`). */
const CONTRACT_FAILURE_CODES = [
  'invalid-reason', 'invalid-input', 'not-found', 'save-failed', 'stale-baseline',
  'unknown-result', 'read-failed', 'unknown-project', 'unavailable',
]
/** Host-only protocol codes: these never travel as browser failure codes. */
const HOST_PROTOCOL_CODES = ['invalid-payload', 'unknown-endpoint']
/** F03 vocabulary mirrored from the wire parser, so the tool checks the contract level. */
const SUMMARY_ORIGINS = ['ai', 'user', 'ai+user']
const SUMMARY_CHANGE_KINDS = ['created', 'modified', 'cleared']
const SUMMARY_DRAFT_STATES = ['editing', 'ready', 'needsRecheck', 'saved', 'abandoned', 'failed']
/** An id that cannot be in the isolated home's workspace fixture. */
const UNREGISTERED_PROJECT_ID = '00000000-0000-4000-8000-000000000000'

const HELP = `Usage: node tools/verify-rpc-roundtrip.mjs [options]

Boot an isolated DSH host (own DSH_HOME, OS-assigned port, no browser), exchange
the launch token for its signed session cookie, and send real HTTP
POST /aikanban/<endpoint> requests to verify the RPC roundtrip and the fence.

What it verifies:
  positive   project/list and board/read return HTTP 200 + a valid
             {type:'server-response', rpcId, result} envelope; task/create,
             task/fields.update and activity/read roundtrip a real fixture
             (create -> field save -> newest-first history); summary/read,
             summary/save and summary/draft.save roundtrip one manual summary
             lifecycle (empty baseline -> committed -> read-back -> replay /
             no-change -> stale-baseline -> draft upsert)
  fence      no cookie -> 401, bad Origin -> 403, non-JSON content-type -> 415,
             non-POST / missing endpoint segment -> 404
  contract   unknown endpoint -> 'unknown-endpoint', unregistered project ->
             'unknown-project', blank-title create -> 'invalid-input',
             malformed fver1 baseline -> 'invalid-payload', missing summary task
             -> 'not-found'

Options:
  --profile <name>   isolated probe profile name (default: probe)
  --home <dir>       isolated Harness home (default: <workspace>/${HOME_DIR.replaceAll('\\', '/')})
  --port <n>         probe host port; 0 = OS-assigned (default: 0)
  --timeout <sec>    seconds to wait for the host to settle / data layer to be ready (default: 180)
  --keep             keep the isolated home after the run
  --help             show this help

The default home is namespaced to THIS tool. Never point --home at another
tool's probe home: that tool deletes and recreates its own home.

Exit codes: 0 all assertions passed, 1 an assertion failed, 2 bad arguments or
missing dsh CLI, 4 packages/plugin/lib/index.js missing, 5 isolated host never
settled, 6 isolated home/fixture could not be prepared.
`

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

/**
 * Parse `--flag value` / `--flag` arguments, rejecting unknown flags.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | true>} parsed options.
 */
function parseArgs(argv) {
  const options = {}
  const booleans = new Set(['keep', 'help'])
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

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`verify-rpc-roundtrip: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
if (options.help === true) {
  process.stdout.write(HELP)
  process.exit(0)
}

const profileName = typeof options.profile === 'string' ? options.profile : 'probe'
if (profileName === '' || profileName.includes('/') || profileName.includes('\\')) {
  process.stderr.write(`verify-rpc-roundtrip: invalid profile name ${JSON.stringify(profileName)}\n`)
  process.exit(2)
}
const home = resolve(WORKSPACE_ROOT, typeof options.home === 'string' ? options.home : HOME_DIR)
const port = typeof options.port === 'string' ? options.port : '0'
if (!/^\d+$/.test(port)) {
  process.stderr.write(`verify-rpc-roundtrip: --port must be a number, got ${JSON.stringify(port)}\n`)
  process.exit(2)
}
const timeoutSec = typeof options.timeout === 'string' ? Number(options.timeout) : 180
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  process.stderr.write('verify-rpc-roundtrip: --timeout must be a positive number of seconds\n')
  process.exit(2)
}
const keep = options.keep === true

/* ------------------------------------------------------------------ *
 * Small output/utility helpers
 * ------------------------------------------------------------------ */

const node = process.execPath
const profileDir = join(home, 'profiles', profileName)
const logPath = join(OUT_DIR, `roundtrip-${profileName}.log`)
const jsonPath = join(OUT_DIR, `roundtrip-${profileName}.json`)
const observerPath = join(OUT_DIR, 'activation-observer.cjs')
const observerMarker = '[roundtrip]'
const write = (text = '') => process.stdout.write(`${text}\n`)
const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })
const normalizePath = (value) => resolve(String(value)).replaceAll('/', '\\').toLowerCase()

/**
 * Redact the per-process launch token before the host log is persisted.
 *
 * @param {string} log - the host log.
 * @returns {string} the log with `token=…` values redacted.
 */
function sanitizeHostLog(log) {
  return log.replace(/token=[^&\s)]+/g, 'token=<redacted>')
}

/**
 * Redact the session cookie before anything is written to disk or printed.
 * The cookie is an authentication secret; the raw transcript only needs to say
 * that it was present and valid.
 *
 * @param {Record<string, string>} headers - request headers.
 * @returns {Record<string, string>} a redacted copy.
 */
function redactHeaders(headers) {
  const copy = { ...headers }
  if (typeof copy.cookie === 'string') copy.cookie = '<redacted dsh-auth session cookie>'
  return copy
}

/**
 * Locate the `dsh` CLI entry module.
 *
 * Same discovery order as `tools/probe-host.mjs`: explicit `DSH_CLI` first, then
 * the two common global install locations.
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
 * Write the isolated probe profile: the shipped `web` bundle list plus the one
 * insert entry under test, with the package junctioned into the profile's own
 * module tree so the probe always exercises the CURRENT build.
 *
 * Identical shape to `tools/probe-host.mjs`'s profile: `probe` is not a shipped
 * template, so the manifest is written explicitly for reproducibility.
 *
 * @param {string} dir - the probe profile directory.
 * @returns {string} the junction path that was created.
 */
function writeProbeProfile(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-probe',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), `# Isolated RPC roundtrip layer — generated by tools/verify-rpc-roundtrip.mjs.
- insert:
    - id: aikanban
      name: '${PACKAGE_NAME}'
`)
  writeFileSync(join(dir, 'cordis.yml'), '# roundtrip probe profile root — composed from patches\n[]\n')
  const linkPath = join(dir, 'node_modules', '@aikanban', 'dsh-aikanban')
  mkdirSync(dirname(linkPath), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(PACKAGE_DIR, linkPath, 'junction')
  return linkPath
}

/* ------------------------------------------------------------------ *
 * Check bookkeeping
 * ------------------------------------------------------------------ */

/** @type {{ id: string, group: string, name: string, expected: string, actual: string, httpStatus: number | null, ok: boolean }[]} */
const checks = []
/** Things observed but not asserted (e.g. the process-internal registration path). */
const evidence = {}

/**
 * Record one assertion result.
 *
 * @param {object} entry - assertion facts.
 * @param {string} entry.id - stable id (`AUTH-1`, `POS-2`, `FEN-3`, ...).
 * @param {string} entry.group - `setup` | `positive` | `fence` | `contract`.
 * @param {string} entry.name - human-readable assertion.
 * @param {string} entry.expected - expected value/status, verbatim.
 * @param {string} entry.actual - observed value/status, verbatim.
 * @param {number | null} [entry.httpStatus] - HTTP status when one was observed.
 * @param {boolean} entry.ok - whether the assertion held.
 */
function record(entry) {
  checks.push({ httpStatus: null, ...entry })
}

/**
 * Assert one condition and record it.
 *
 * @param {object} entry - assertion facts (same as {@link record} minus `actual`).
 * @param {boolean} entry.ok - the condition.
 * @param {string} entry.actualWhenOk - actual text on success.
 * @param {string} entry.actualWhenFail - actual text on failure.
 */
function assertCheck({ actualWhenOk, actualWhenFail, ...entry }) {
  record({
    ...entry,
    actual: entry.ok ? (actualWhenOk ?? entry.actual) : (actualWhenFail ?? entry.actual),
  })
}

/* ------------------------------------------------------------------ *
 * Envelope + payload validation (contract-level, no product import)
 * ------------------------------------------------------------------ */

/**
 * Validate the shipped `{type:'server-response', rpcId, result}` envelope.
 *
 * @param {string} text - raw response body.
 * @returns {{ parsed: Record<string, unknown> | null, issues: string[] }} parse result.
 */
function parseEnvelope(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { parsed: null, issues: ['body is not JSON'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { parsed: null, issues: ['body is not a JSON object'] }
  }
  const issues = []
  if (parsed.type !== 'server-response') issues.push(`type=${JSON.stringify(parsed.type)}`)
  if (typeof parsed.rpcId !== 'string') issues.push('rpcId is not a string')
  const result = parsed.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    issues.push('result is not an object')
    return { parsed, issues }
  }
  if (result.ok === true) {
    if (!Object.prototype.hasOwnProperty.call(result, 'value')) issues.push('result.ok=true carries no value')
  } else if (result.ok === false) {
    const error = result.error
    if (typeof error !== 'object' || error === null || Array.isArray(error)) {
      issues.push('result.error is not an object')
    } else {
      if (typeof error.code !== 'string') issues.push('error.code is not a string')
      if (typeof error.message !== 'string') issues.push('error.message is not a string')
      if (typeof error.details !== 'object' || error.details === null) issues.push('error.details is not an object')
    }
  } else {
    issues.push('result.ok is not a boolean')
  }
  return { parsed, issues }
}

/**
 * Validate a `project/list` success value against the fixture written into the
 * isolated home. The candidate set must be exactly the fixture's workspaces:
 * listing reads the host registry and selects nothing.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {{ id: string, path: string, title: string }[]} fixtureRows - expected workspaces.
 * @returns {{ issues: string[], summary: string }} validation result.
 */
function validateProjectList(value, fixtureRows) {
  const issues = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issues: ['value is not an object'], summary: 'value is not an object' }
  }
  const projects = value.projects
  if (!Array.isArray(projects)) return { issues: ['value.projects is not an array'], summary: 'value.projects is not an array' }
  for (const [index, item] of projects.entries()) {
    if (typeof item !== 'object' || item === null) { issues.push(`projects[${index}] is not an object`); continue }
    if (typeof item.projectId !== 'string' || item.projectId.length === 0) issues.push(`projects[${index}].projectId is not a non-empty string`)
    if (typeof item.title !== 'string') issues.push(`projects[${index}].title is not a string`)
    if (typeof item.path !== 'string') issues.push(`projects[${index}].path is not a string`)
  }
  const seen = new Set()
  for (const row of fixtureRows) {
    const match = projects.find((item) => item?.projectId === row.id)
    if (match === undefined) { issues.push(`fixture workspace ${row.id} is absent from the candidate set`); continue }
    if (normalizePath(match.path) !== normalizePath(row.path)) issues.push(`workspace ${row.id} path mismatch: ${String(match.path)}`)
    if (match.title !== row.title) issues.push(`workspace ${row.id} title mismatch: ${String(match.title)}`)
    seen.add(match.projectId)
  }
  for (const item of projects) {
    if (typeof item?.projectId === 'string' && !seen.has(item.projectId)) issues.push(`unexpected project ${item.projectId} (not in the fixture)`)
  }
  const summary = projects.length === 0
    ? '0 projects (list is a legal empty set, but the fixture is expected non-empty)'
    : `${String(projects.length)} projects: ${projects.map((item) => `${String(item.projectId).slice(0, 8)}…(${String(item.title)})`).join(', ')}`
  return { issues, summary }
}

/**
 * Validate a `board/read` success value: the snapshot shape the browser half
 * parses. Kept to contract-level shape checks (the adapter's own unit tests own
 * detailed semantics); the values observed are recorded for the report.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {{ id: string, path: string, title: string }} projectRow - expected project.
 * @returns {{ issues: string[], summary: string, taskCount: number | null }} validation result.
 */
function validateBoardSnapshot(value, projectRow) {
  const issues = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issues: ['value is not an object'], summary: 'value is not an object', taskCount: null }
  }
  const project = value.project
  if (typeof project !== 'object' || project === null) {
    issues.push('value.project is not an object')
  } else {
    if (project.projectId !== projectRow.id) issues.push(`project.projectId=${JSON.stringify(project.projectId)}`)
    if (typeof project.title !== 'string' || project.title.length === 0) issues.push('project.title is not a non-empty string')
    if (project.title !== projectRow.title) issues.push(`project.title=${JSON.stringify(project.title)} differs from the fixture`)
    if (typeof project.path !== 'string') issues.push('project.path is not a string')
    else if (normalizePath(project.path) !== normalizePath(projectRow.path)) issues.push(`project.path=${String(project.path)} differs from the fixture`)
    if (!['ok', 'missing-dir', 'unknown'].includes(project.workScopeAvailability)) {
      issues.push(`project.workScopeAvailability=${JSON.stringify(project.workScopeAvailability)}`)
    }
    if (typeof project.workScopeAllowed !== 'boolean') issues.push('project.workScopeAllowed is not a boolean')
  }
  const tasks = value.tasks
  if (!Array.isArray(tasks)) issues.push('value.tasks is not an array')
  const columns = value.columns
  if (!Array.isArray(columns)) {
    issues.push('value.columns is not an array')
  } else {
    const statuses = columns.map((column) => column?.status)
    if (columns.length !== CONTRACT_COLUMN_STATUSES.length) issues.push(`columns.length=${String(columns.length)} (expected ${String(CONTRACT_COLUMN_STATUSES.length)})`)
    if (statuses.slice().sort().join(',') !== CONTRACT_COLUMN_STATUSES.slice().sort().join(',')) {
      issues.push(`column statuses=[${statuses.map(String).join(', ')}]`)
    }
    for (const [index, column] of columns.entries()) {
      if (typeof column?.label !== 'string' || column.label.length === 0) issues.push(`columns[${index}].label is not a non-empty string`)
      if (typeof column?.collapsedByDefault !== 'boolean') issues.push(`columns[${index}].collapsedByDefault is not a boolean`)
    }
  }
  if (typeof value.boardToken !== 'string' || value.boardToken.length === 0) issues.push('value.boardToken is not a non-empty string')
  const capabilities = value.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) {
    issues.push('value.capabilities is not an object')
  } else {
    for (const key of ['statusChange', 'reorder', 'undo']) {
      if (capabilities[key] !== true) issues.push(`capabilities.${key}=${JSON.stringify(capabilities[key])}`)
    }
  }
  const taskCount = Array.isArray(tasks) ? tasks.length : null
  for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
    if (typeof task?.taskId !== 'string' || task.taskId.length === 0) issues.push(`tasks[${index}].taskId is not a non-empty string`)
    if (task?.projectId !== projectRow.id) issues.push(`tasks[${index}].projectId=${JSON.stringify(task?.projectId)}`)
    if (typeof task?.title !== 'string') issues.push(`tasks[${index}].title is not a string`)
    if (typeof task?.status !== 'string') issues.push(`tasks[${index}].status is not a string`)
    if (typeof task?.statusRevision !== 'number') issues.push(`tasks[${index}].statusRevision is not a number`)
  }
  const columnLabels = Array.isArray(columns) ? columns.map((column) => `${String(column?.status)}:${String(column?.label)}`).join(', ') : 'n/a'
  const summary = `project=${String(project?.projectId)} tasks=${String(taskCount)} columns=[${columnLabels}] boardToken=${String(value.boardToken).slice(0, 12)}… capabilities=${JSON.stringify(capabilities)}`
  return { issues, summary, taskCount }
}

/* ------------------------------------------------------------------ *
 * Slice B value validation (task/create, task/fields.update, activity/read)
 * ------------------------------------------------------------------ */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonNegativeInteger = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0
/** Encode a fields revision the way the wire baseline parser requires. */
const fieldsVersionOf = (revision) => `fver1:${String(revision)}`
/** Encode a status revision the way the wire baseline parser requires. */
const statusVersionOf = (revision) => `ver1:${String(revision)}`

/**
 * Validate a `task/create` success value against the request that produced it.
 * `snapshot` must be non-null: a landed create that cannot re-read the board is
 * a real failure for this tool's purpose, not a result to hide.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {{ projectId: string, title: string, path: string }} projectRow - the registered project (from `project/list`).
 * @param {string} expectedTitle - the title sent in the request.
 * @returns {{ issues: string[], summary: string, taskId: string | null, fieldsRevision: number | null, statusRevision: number | null }} validation result.
 */
function validateCreateTaskValue(value, projectRow, expectedTitle) {
  if (!isRecord(value)) {
    return { issues: ['value is not an object'], summary: 'value is not an object', taskId: null, fieldsRevision: null, statusRevision: null }
  }
  const issues = []
  if (value.outcome !== 'created' && value.outcome !== 'already-created') issues.push(`outcome=${JSON.stringify(value.outcome)}`)
  const task = value.task
  if (!isRecord(task)) {
    issues.push('value.task is not an object')
  } else {
    if (typeof task.taskId !== 'string' || task.taskId.length === 0) issues.push('task.taskId is not a non-empty string')
    if (task.projectId !== projectRow.projectId) issues.push(`task.projectId=${JSON.stringify(task.projectId)} (expected ${JSON.stringify(projectRow.projectId)})`)
    if (task.title !== expectedTitle) issues.push(`task.title=${JSON.stringify(task.title)} (expected the request title)`)
    if (typeof task.status !== 'string' || task.status.length === 0) issues.push('task.status is not a non-empty string')
    if (typeof task.statusRevision !== 'number') issues.push('task.statusRevision is not a number')
    if (!isNonNegativeInteger(task.fieldsRevision)) issues.push(`task.fieldsRevision=${JSON.stringify(task.fieldsRevision)}`)
  }
  const snapshot = value.snapshot
  if (!isRecord(snapshot)) {
    issues.push('value.snapshot is not an object (a landed create must not hide a re-read failure)')
  } else if (!Array.isArray(snapshot.tasks)) {
    issues.push('snapshot.tasks is not an array')
  } else if (isRecord(task) && !snapshot.tasks.some((item) => item?.taskId === task.taskId)) {
    issues.push(`snapshot.tasks does not contain the created task ${JSON.stringify(task.taskId)}`)
  }
  const taskId = isRecord(task) && typeof task.taskId === 'string' ? task.taskId : null
  const fieldsRevision = isRecord(task) && isNonNegativeInteger(task.fieldsRevision) ? task.fieldsRevision : null
  const statusRevision = isRecord(task) && isNonNegativeInteger(task.statusRevision) ? task.statusRevision : null
  const summary = `outcome=${String(value.outcome)} taskId=${String(taskId)} title=${JSON.stringify(isRecord(task) ? task.title : null)} fieldsRevision=${String(fieldsRevision)} statusRevision=${String(statusRevision)} snapshotTasks=${Array.isArray(snapshot?.tasks) ? String(snapshot.tasks.length) : 'n/a'}`
  return { issues, summary, taskId, fieldsRevision, statusRevision }
}

/**
 * Validate a `task/fields.update` success value: the outcome vocabulary, the
 * advanced `fieldsRevision`, and the refreshed snapshot carrying the new title.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {string} expectedTaskId - the task created earlier in this run.
 * @param {number} previousFieldsRevision - the revision returned by task/create.
 * @param {string} expectedTitle - the title sent in the update request.
 * @returns {{ issues: string[], summary: string, fieldsRevision: number | null }} validation result.
 */
function validateFieldsUpdateValue(value, expectedTaskId, previousFieldsRevision, expectedTitle) {
  if (!isRecord(value)) return { issues: ['value is not an object'], summary: 'value is not an object', fieldsRevision: null }
  const issues = []
  if (!['saved', 'no-change', 'already-applied'].includes(value.outcome)) issues.push(`outcome=${JSON.stringify(value.outcome)}`)
  const task = value.task
  if (!isRecord(task)) {
    issues.push('value.task is not an object')
  } else {
    if (task.taskId !== expectedTaskId) issues.push(`task.taskId=${JSON.stringify(task.taskId)}`)
    if (value.outcome === 'saved' && task.title !== expectedTitle) issues.push(`task.title=${JSON.stringify(task.title)} (expected the updated title)`)
    if (typeof task.status !== 'string' || task.status.length === 0) issues.push('task.status is not a non-empty string')
    if (typeof task.statusRevision !== 'number') issues.push('task.statusRevision is not a number')
  }
  if (!Array.isArray(value.changed)) issues.push('value.changed is not an array')
  else if (value.outcome === 'saved' && !value.changed.includes('title')) issues.push(`changed=[${value.changed.map(String).join(', ')}] does not include title`)
  if (!isNonNegativeInteger(value.fieldsRevision)) issues.push(`value.fieldsRevision=${JSON.stringify(value.fieldsRevision)}`)
  else if (value.outcome === 'saved' && value.fieldsRevision !== previousFieldsRevision + 1) {
    issues.push(`fieldsRevision=${String(value.fieldsRevision)} (expected ${String(previousFieldsRevision + 1)})`)
  }
  const snapshot = value.snapshot
  if (!isRecord(snapshot)) {
    issues.push('value.snapshot is not an object (a landed save must not hide a re-read failure)')
  } else if (!Array.isArray(snapshot.tasks)) {
    issues.push('snapshot.tasks is not an array')
  } else if (value.outcome === 'saved') {
    const saved = snapshot.tasks.find((item) => item?.taskId === expectedTaskId)
    if (saved === undefined) issues.push(`snapshot.tasks does not contain ${JSON.stringify(expectedTaskId)}`)
    else if (saved.title !== expectedTitle) issues.push(`snapshot task title=${JSON.stringify(saved.title)}`)
  }
  const fieldsRevision = isNonNegativeInteger(value.fieldsRevision) ? value.fieldsRevision : null
  const summary = `outcome=${String(value.outcome)} fieldsRevision=${String(fieldsRevision)} changed=[${Array.isArray(value.changed) ? value.changed.map(String).join(', ') : 'n/a'}] snapshotTasks=${Array.isArray(snapshot?.tasks) ? String(snapshot.tasks.length) : 'n/a'}`
  return { issues, summary, fieldsRevision }
}

/**
 * Validate an `activity/read` success value for the task created in this run:
 * newest-first ordering, verbatim string-only `details`, and the two entries the
 * create + rename must have produced.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {string} expectedTaskId - the task the history is scoped to.
 * @returns {{ issues: string[], summary: string, entryCount: number | null, codes: string[] }} validation result.
 */
function validateActivityValue(value, expectedTaskId) {
  if (!isRecord(value)) return { issues: ['value is not an object'], summary: 'value is not an object', entryCount: null, codes: [] }
  const entries = value.entries
  if (!Array.isArray(entries)) return { issues: ['value.entries is not an array'], summary: 'value.entries is not an array', entryCount: null, codes: [] }
  const issues = []
  if (entries.length === 0) issues.push('entries is empty (this run created and renamed a task)')
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      issues.push(`entries[${index}] is not an object`)
      continue
    }
    if (typeof entry.activityId !== 'string' || entry.activityId.length === 0) issues.push(`entries[${index}].activityId is not a non-empty string`)
    if (typeof entry.at !== 'string' || entry.at.length === 0) issues.push(`entries[${index}].at is not a non-empty string`)
    else if (Number.isNaN(Date.parse(entry.at))) issues.push(`entries[${index}].at=${JSON.stringify(entry.at)} is not a parseable date`)
    if (entry.scopeKind !== 'task') issues.push(`entries[${index}].scopeKind=${JSON.stringify(entry.scopeKind)}`)
    if (entry.scopeId !== expectedTaskId) issues.push(`entries[${index}].scopeId=${JSON.stringify(entry.scopeId)}`)
    if (typeof entry.code !== 'string' || entry.code.length === 0) issues.push(`entries[${index}].code is not a non-empty string`)
    if (typeof entry.summary !== 'string') issues.push(`entries[${index}].summary is not a string`)
    if (!isRecord(entry.details)) {
      issues.push(`entries[${index}].details is not an object`)
    } else {
      for (const [key, detail] of Object.entries(entry.details)) {
        if (typeof detail !== 'string') issues.push(`entries[${index}].details.${key} is not a string`)
      }
    }
  }
  const codes = entries.filter(isRecord).map((entry) => entry.code)
  const titleChangedIndex = codes.indexOf('task-title-changed')
  const createdIndex = codes.indexOf('task-created')
  if (titleChangedIndex === -1) issues.push('no task-title-changed entry')
  if (createdIndex === -1) issues.push('no task-created entry')
  if (titleChangedIndex !== -1 && createdIndex !== -1 && titleChangedIndex > createdIndex) {
    issues.push(`entries are not newest-first: task-title-changed index=${String(titleChangedIndex)} after task-created index=${String(createdIndex)}`)
  }
  const summary = `${String(entries.length)} entries newest-first codes=[${codes.map(String).join(', ')}]`
  return { issues, summary, entryCount: entries.length, codes }
}

/* ------------------------------------------------------------------ *
 * F03 manual summary value validation (contract-level, no product import)
 * ------------------------------------------------------------------ */

/**
 * Build a summary content object in the shape `summary/save` and
 * `summary/draft.save` accept: one section is enough to make the body
 * identifiable in the read-back view.
 *
 * @param {string} body - section body; unique per request in this run.
 * @returns {{ sections: { id: string, title: string, body: string }[] }} content.
 */
function summaryContent(body) {
  return { sections: [{ id: 'progress', title: '进展', body }] }
}

/**
 * Validate summary content as the wire parser reads it back. `sections` is
 * required and non-empty; `conclusions` is optional but must be an array of
 * conclusion objects when the response carries it.
 *
 * @param {unknown} value - the content field.
 * @param {string} path - report path for messages.
 * @returns {string[]} issues.
 */
function validateSummaryContent(value, path) {
  const issues = []
  if (!isRecord(value)) return [`${path} is not an object`]
  if (!Array.isArray(value.sections)) {
    issues.push(`${path}.sections is not an array`)
  } else if (value.sections.length === 0) {
    issues.push(`${path}.sections is empty`)
  } else {
    for (const [index, section] of value.sections.entries()) {
      if (!isRecord(section)) {
        issues.push(`${path}.sections[${index}] is not an object`)
        continue
      }
      if (typeof section.id !== 'string' || section.id.length === 0) issues.push(`${path}.sections[${index}].id is not a non-empty string`)
      if (typeof section.title !== 'string' || section.title.length === 0) issues.push(`${path}.sections[${index}].title is not a non-empty string`)
      if (typeof section.body !== 'string') issues.push(`${path}.sections[${index}].body is not a string`)
    }
  }
  if (value.conclusions !== undefined) {
    if (!Array.isArray(value.conclusions)) {
      issues.push(`${path}.conclusions is not an array`)
    } else {
      for (const [index, conclusion] of value.conclusions.entries()) {
        if (!isRecord(conclusion)) {
          issues.push(`${path}.conclusions[${index}] is not an object`)
          continue
        }
        for (const key of ['id', 'text', 'statedState', 'state']) {
          if (typeof conclusion[key] !== 'string' || conclusion[key].length === 0) {
            issues.push(`${path}.conclusions[${index}].${key} is not a non-empty string`)
          }
        }
        if (conclusion.amendedBy !== null && typeof conclusion.amendedBy !== 'string') {
          issues.push(`${path}.conclusions[${index}].amendedBy is neither null nor a string`)
        }
      }
    }
  }
  return issues
}

/**
 * Validate one official summary version. `seq` starts at 1; `previousVersionId`
 * is null on the first version; `readToken` must be non-empty.
 *
 * @param {unknown} value - the version object.
 * @param {string} path - report path for messages.
 * @returns {{ issues: string[], version: Record<string, unknown> | null }} validation result.
 */
function validateSummaryVersion(value, path) {
  if (!isRecord(value)) return { issues: [`${path} is not an object`], version: null }
  const issues = []
  if (typeof value.versionId !== 'string' || value.versionId.length === 0) issues.push(`${path}.versionId is not a non-empty string`)
  if (!isNonNegativeInteger(value.seq) || value.seq < 1) issues.push(`${path}.seq=${JSON.stringify(value.seq)} (expected an integer >= 1)`)
  if (typeof value.confirmedAt !== 'string' || value.confirmedAt.length === 0) issues.push(`${path}.confirmedAt is not a non-empty string`)
  if (!SUMMARY_ORIGINS.includes(value.origin)) issues.push(`${path}.origin=${JSON.stringify(value.origin)}`)
  if (!SUMMARY_CHANGE_KINDS.includes(value.changeKind)) issues.push(`${path}.changeKind=${JSON.stringify(value.changeKind)}`)
  if (value.previousVersionId !== null && (typeof value.previousVersionId !== 'string' || value.previousVersionId.length === 0)) {
    issues.push(`${path}.previousVersionId is neither null nor a non-empty string`)
  }
  issues.push(...validateSummaryContent(value.content, `${path}.content`))
  if (!Array.isArray(value.conclusions)) issues.push(`${path}.conclusions is not an array`)
  if (typeof value.readToken !== 'string' || value.readToken.length === 0) issues.push(`${path}.readToken is not a non-empty string`)
  return { issues, version: value }
}

/**
 * Validate one summary draft. The draft state vocabulary comes from the wire
 * parser; `updateId` is the optional idempotency key echoed back (null when the
 * caller did not send one).
 *
 * @param {unknown} value - the draft object.
 * @param {string} path - report path for messages.
 * @returns {{ issues: string[], draft: Record<string, unknown> | null }} validation result.
 */
function validateSummaryDraft(value, path) {
  if (!isRecord(value)) return { issues: [`${path} is not an object`], draft: null }
  const issues = []
  if (typeof value.draftId !== 'string' || value.draftId.length === 0) issues.push(`${path}.draftId is not a non-empty string`)
  if (!SUMMARY_DRAFT_STATES.includes(value.state)) issues.push(`${path}.state=${JSON.stringify(value.state)}`)
  if (value.updateId !== null && (typeof value.updateId !== 'string' || value.updateId.length === 0)) issues.push(`${path}.updateId is neither null nor a non-empty string`)
  if (typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) issues.push(`${path}.updatedAt is not a non-empty string`)
  if (!isRecord(value.base)) {
    issues.push(`${path}.base is not an object`)
  } else {
    if (!isNonNegativeInteger(value.base.scopeRevision)) issues.push(`${path}.base.scopeRevision is not a non-negative integer`)
    if (!isNonNegativeInteger(value.base.applicabilityRevision)) issues.push(`${path}.base.applicabilityRevision is not a non-negative integer`)
  }
  issues.push(...validateSummaryContent(value.content, `${path}.content`))
  return { issues, draft: value }
}

/**
 * Validate a `summary/read` view and its write baseline. The baseline is the
 * tuple a save must echo back, so it must agree with the view it was read with:
 * `baseline.revision === revision`, same for `applicabilityRevision`, and
 * `baseline.summaryVersionId` is null exactly until the first committed version.
 *
 * @param {unknown} value - the summary view.
 * @param {string} path - report path for messages.
 * @returns {{ issues: string[], view: Record<string, unknown> | null }} validation result.
 */
function validateSummaryView(value, path) {
  if (!isRecord(value)) return { issues: [`${path} is not an object`], view: null }
  const issues = []
  if (value.scopeKind !== 'task' && value.scopeKind !== 'project') issues.push(`${path}.scopeKind=${JSON.stringify(value.scopeKind)}`)
  if (typeof value.scopeId !== 'string' || value.scopeId.length === 0) issues.push(`${path}.scopeId is not a non-empty string`)
  if (!isNonNegativeInteger(value.revision)) issues.push(`${path}.revision is not a non-negative integer`)
  if (!isNonNegativeInteger(value.applicabilityRevision)) issues.push(`${path}.applicabilityRevision is not a non-negative integer`)
  if (!isRecord(value.baseline)) {
    issues.push(`${path}.baseline is not an object`)
  } else {
    const baseline = value.baseline
    if (!isNonNegativeInteger(baseline.revision)) {
      issues.push(`${path}.baseline.revision is not a non-negative integer`)
    } else if (baseline.revision !== value.revision) {
      issues.push(`${path}.baseline.revision=${String(baseline.revision)} differs from view.revision=${String(value.revision)}`)
    }
    if (!isNonNegativeInteger(baseline.applicabilityRevision)) {
      issues.push(`${path}.baseline.applicabilityRevision is not a non-negative integer`)
    } else if (baseline.applicabilityRevision !== value.applicabilityRevision) {
      issues.push(`${path}.baseline.applicabilityRevision=${String(baseline.applicabilityRevision)} differs from view.applicabilityRevision=${String(value.applicabilityRevision)}`)
    }
    if (baseline.summaryVersionId !== null && (typeof baseline.summaryVersionId !== 'string' || baseline.summaryVersionId.length === 0)) {
      issues.push(`${path}.baseline.summaryVersionId is neither null nor a non-empty string`)
    }
  }
  if (value.current !== null) issues.push(...validateSummaryVersion(value.current, `${path}.current`).issues)
  if (!Array.isArray(value.history)) {
    issues.push(`${path}.history is not an array`)
  } else {
    for (const [index, version] of value.history.entries()) {
      issues.push(...validateSummaryVersion(version, `${path}.history[${index}]`).issues)
    }
  }
  if (value.draft !== null) issues.push(...validateSummaryDraft(value.draft, `${path}.draft`).issues)
  if (typeof value.needsRecheck !== 'boolean') issues.push(`${path}.needsRecheck is not a boolean`)
  if (!isRecord(value.recheck)) {
    issues.push(`${path}.recheck is not an object`)
  } else {
    if (typeof value.recheck.pending !== 'boolean') issues.push(`${path}.recheck.pending is not a boolean`)
    if (!Array.isArray(value.recheck.reasons)) issues.push(`${path}.recheck.reasons is not an array`)
    if (value.recheck.markedAt !== null && typeof value.recheck.markedAt !== 'string') issues.push(`${path}.recheck.markedAt is neither null nor a string`)
  }
  return { issues, view: value }
}

/**
 * Validate a `summary/read` success value: `{summary: view|null}`. `summary:null`
 * is legal at the wire level (the scope may simply have no row for this caller),
 * so the caller decides whether null is acceptable for the case being proven.
 *
 * @param {unknown} value - envelope `result.value`.
 * @param {string} path - report path for messages.
 * @returns {{ issues: string[], summary: Record<string, unknown> | null }} validation result.
 */
function validateSummaryReadValue(value, path) {
  if (!isRecord(value)) return { issues: [`${path} is not an object`], summary: null }
  if (!Object.prototype.hasOwnProperty.call(value, 'summary')) return { issues: [`${path}.summary is absent`], summary: null }
  if (value.summary === null) return { issues: [], summary: null }
  const validation = validateSummaryView(value.summary, `${path}.summary`)
  return { issues: validation.issues, summary: validation.view }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

/** Assigned once the isolated host prints its URL; all requests use it. */
let origin = ''
/** Request authority (`host:port`) — also the cookie's signed audience. */
let authority = ''
/** The `set-cookie` value (name=value), exchanged from the launch token. */
let cookie = ''
/** Raw HTTP transcript (cookies redacted) written next to the report. */
const transcript = []

/**
 * One raw HTTP request with node:http so `Host`, `Origin`, `content-type` and
 * the exact method are all under the caller's control (Node's fetch silently
 * ignores a caller-supplied `Host`, which would make the fence negatives
 * unprovable).
 *
 * @param {object} request - request facts.
 * @param {string} request.label - transcript label.
 * @param {string} request.method - HTTP method.
 * @param {string} request.path - path (relative to `origin`).
 * @param {Record<string, string>} request.headers - request headers.
 * @param {string} [request.body] - request body.
 * @param {number} [request.timeoutMs] - per-request timeout.
 * @returns {Promise<{ status: number | undefined, headers: import('node:http').IncomingHttpHeaders, body: string }>} response.
 */
function httpRequest({ label, method, path, headers, body, timeoutMs = 30_000 }) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, origin)
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const requestHeaders = { ...headers }
    if (payload !== undefined) requestHeaders['content-length'] = String(payload.byteLength)
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      agent: false,
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        transcript.push({
          label,
          request: { method, path, headers: redactHeaders(requestHeaders) },
          response: { status: response.statusCode, headers: { 'content-type': response.headers['content-type'] ?? null }, body: text },
        })
        resolvePromise({ status: response.statusCode, headers: response.headers, body: text })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`)))
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/**
 * POST one real RPC envelope to `/aikanban/<endpoint>`.
 *
 * @param {object} call - call facts.
 * @param {string} call.label - transcript label.
 * @param {string} call.endpoint - envelope method AND URL's last segment.
 * @param {unknown} call.payload - envelope payload.
 * @param {Record<string, string>} [call.headers] - header overrides/additions.
 * @param {boolean} [call.useCookie] - send the exchanged session cookie (default true).
 * @param {boolean} [call.useOrigin] - send a same-origin `Origin` header (default true).
 * @returns {Promise<{ status: number | undefined, body: string, rpcId: string, parsed: Record<string, unknown> | null, issues: string[] }>} the call result.
 */
async function postEnvelope({ label, endpoint, payload, headers = {}, useCookie = true, useOrigin = true }) {
  const rpcId = `roundtrip-${randomUUID()}`
  const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
  const requestHeaders = {
    host: authority,
    ...(useCookie ? { cookie } : {}),
    ...(useOrigin ? { origin } : {}),
    'content-type': 'application/json',
    ...headers,
  }
  const response = await httpRequest({
    label,
    method: 'POST',
    path: `${CHANNEL}/${endpoint}`,
    headers: requestHeaders,
    body,
  })
  const { parsed, issues } = parseEnvelope(response.body)
  return { status: response.status, body: response.body, rpcId, parsed, issues }
}

/**
 * Extract the envelope's `result` for convenient assertion text.
 *
 * @param {Record<string, unknown> | null} parsed - parsed envelope.
 * @returns {Record<string, unknown> | null} result or null.
 */
function resultOf(parsed) {
  if (typeof parsed !== 'object' || parsed === null) return null
  const result = parsed.result
  return typeof result === 'object' && result !== null ? result : null
}

/**
 * Extract the failure code of an envelope, if any.
 *
 * @param {Record<string, unknown> | null} parsed - parsed envelope.
 * @returns {string | null} the error code.
 */
function failureCodeOf(parsed) {
  const result = resultOf(parsed)
  if (result === null || result.ok !== false) return null
  const error = result.error
  return typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : null
}

/**
 * Extract the whole failure object (`{code, message, details}`) of an envelope.
 *
 * @param {Record<string, unknown> | null} parsed - parsed envelope.
 * @returns {Record<string, unknown> | null} the error object or null.
 */
function failureOf(parsed) {
  const result = resultOf(parsed)
  if (result === null || result.ok !== false) return null
  const error = result.error
  return isRecord(error) ? error : null
}

/**
 * Parse the diagnostics-channel lines the observer preload wrote to stderr.
 *
 * @param {string} log - the host log.
 * @returns {{ activations: Record<string, unknown>[], boardChannels: Record<string, unknown>[] }} parsed payloads.
 */
function parseDiagnostics(log) {
  const activations = []
  const boardChannels = []
  for (const line of log.split(/\r?\n/)) {
    const target = line.includes(`${observerMarker} ACTIVATION `)
      ? { prefix: `${observerMarker} ACTIVATION `, bucket: activations }
      : line.includes(`${observerMarker} BOARD-CHANNEL `)
        ? { prefix: `${observerMarker} BOARD-CHANNEL `, bucket: boardChannels }
        : null
    if (target === null) continue
    try {
      target.bucket.push(JSON.parse(line.slice(line.indexOf(target.prefix) + target.prefix.length)))
    } catch {
      // A truncated line is skipped; earlier complete lines may still exist.
    }
  }
  return { activations, boardChannels }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

/**
 * Render the pasteable summary. Every assertion shows expected/actual and, when
 * a request was made, its HTTP status.
 *
 * @param {{ bootError: string | null }} context - run context.
 */
function printReport(context) {
  const groupTitles = {
    setup: 'setup / authentication',
    positive: 'positive: real HTTP RPC roundtrip',
    fence: 'negative: carrier fence and authentication',
    contract: 'supplementary: contract-level failures over real HTTP',
  }
  for (const [group, title] of Object.entries(groupTitles)) {
    const rows = checks.filter((check) => check.group === group)
    if (rows.length === 0) continue
    write(`\n[${title}]`)
    for (const row of rows) {
      const status = row.httpStatus === null ? '   -' : String(row.httpStatus).padStart(4)
      write(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.id.padEnd(6)} HTTP ${status}  ${row.name}`)
      write(`        expected: ${row.expected}`)
      write(`        actual:   ${row.actual}`)
    }
  }

  // The process-internal registration evidence is reported separately, so it can
  // never be read as part of the HTTP result. It is evidence, not an assertion.
  write('\n[process-internal registration evidence — diagnostics channel, NOT HTTP]')
  if (evidence.registration === undefined) {
    write('  NOT OBSERVED  no observer was started for this run')
  } else if (evidence.registration.observed !== true) {
    write(`  NOT OBSERVED  ${String(evidence.registration.reason)}`)
  } else {
    write(`  observed      aikanban:board-channel channel=${CHANNEL} registered=true path=${String(evidence.registration.path)}`)
    write(`  dataLayer     dataLayerReady=${String(evidence.registration.dataLayerReady)} (from the last aikanban:activation payload)`)
    write('  meaning       the registration path is process-internal only. path=compat means the')
    write('                public ctx.connection.rpc.handle path threw and the compatibility')
    write('                register() call was used (ADR-005); it does NOT say the public path works.')
  }
  const failed = checks.filter((check) => !check.ok)
  const requiredGroups = new Set(['setup', 'positive', 'fence'])
  const failedRequired = failed.filter((check) => requiredGroups.has(check.group))
  const projectsChecks = checks.filter((check) => ['POS-1', 'POS-2', 'POS-3'].includes(check.id))
  const projectsOk = projectsChecks.length === 3 && projectsChecks.every((check) => check.ok)
  const boardChecks = checks.filter((check) => ['POS-4', 'POS-5', 'POS-6'].includes(check.id))
  const boardOk = boardChecks.length === 3 && boardChecks.every((check) => check.ok)
  const createChecks = checks.filter((check) => ['POS-7', 'POS-8', 'POS-9'].includes(check.id))
  const createOk = createChecks.length === 3 && createChecks.every((check) => check.ok)
  const fieldsChecks = checks.filter((check) => ['POS-10', 'POS-11', 'POS-12'].includes(check.id))
  const fieldsOk = fieldsChecks.length === 3 && fieldsChecks.every((check) => check.ok)
  const activityChecks = checks.filter((check) => ['POS-13', 'POS-14', 'POS-15'].includes(check.id))
  const activityOk = activityChecks.length === 3 && activityChecks.every((check) => check.ok)
  const summaryChecks = checks.filter((check) => ['POS-16', 'POS-17', 'POS-18', 'POS-19', 'POS-20', 'POS-21', 'POS-22'].includes(check.id))
  const summaryOk = summaryChecks.length === 7 && summaryChecks.every((check) => check.ok)
  const fenceChecks = checks.filter((check) => check.group === 'fence')
  const fenceOk = fenceChecks.length > 0 && fenceChecks.every((check) => check.ok)
  const infrastructureOk = (context.bootError ?? null) === null

  write('\n[verdict]')
  write(`  project/list over real HTTP : ${projectsOk ? 'RPC roundtrip observed (envelope + candidate set)' : 'NOT proven this run'}`)
  write(`  board/read over real HTTP   : ${boardOk ? 'RPC roundtrip observed (envelope + snapshot)' : 'NOT proven this run'}`)
  write(`  task/create over real HTTP  : ${createOk ? 'RPC roundtrip observed (idempotent creation + refreshed snapshot)' : 'NOT proven this run'}`)
  write(`  task/fields.update over HTTP: ${fieldsOk ? 'RPC roundtrip observed (decoded fver1/ver1 baselines + saved fields)' : 'NOT proven this run'}`)
  write(`  activity/read over real HTTP: ${activityOk ? 'RPC roundtrip observed (newest-first entries + string-only details)' : 'NOT proven this run'}`)
  write(`  summary (F03) over HTTP     : ${summaryOk ? 'RPC roundtrip observed (empty baseline -> committed -> replay/no-change/stale-baseline -> draft upsert)' : 'NOT proven this run'}`)
  write(`  carrier fence               : ${fenceOk ? 'authentication + Host/Origin enforced (401/403/415/404 observed)' : 'one or more fence assertions FAILED'}`)
  write(`  registration path evidence  : ${evidence.registration?.observed === true ? `process-internal path=${String(evidence.registration.path)} (separate from the HTTP result)` : 'NOT OBSERVED this run'}`)
  write('  NOT proven here             : the browser half (a page\'s rpc.call after __DSH_BOOT__ assembly),')
  write('                                a real profile / real GUI, and the public registration entry point.')
  write('  AT                          : none executed; acceptance.csv untouched; every AT remains 待执行.')
  write(`\n  assertions: ${String(checks.length - failed.length)}/${String(checks.length)} passed`
    + ` (required groups failed: ${String(failedRequired.length)})`)
  const exitCode = !infrastructureOk ? 5 : failed.length === 0 ? 0 : 1
  write(`  exit code:  ${String(exitCode)} (${!infrastructureOk ? 'the isolated host never settled' : failed.length === 0 ? 'all assertions passed' : 'assertions failed'})`)
  write(`  raw transcript: ${relative(WORKSPACE_ROOT, logPath).replaceAll('\\', '/')}`)
  write(`  run report:     ${relative(WORKSPACE_ROOT, jsonPath).replaceAll('\\', '/')}`)
  if (!keep) write('  isolated home removed (pass --keep to inspect it)')
  else write(`  isolated home kept: ${home}`)
  if (context.bootError !== null) write(`\n  boot error: ${context.bootError}`)
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

/**
 * Run the whole verification.
 *
 * @returns {Promise<number>} process exit code.
 */
async function main() {
  write('AIKanBan real-HTTP RPC roundtrip verification')
  write('')
  write(`  workspace        ${WORKSPACE_ROOT}`)
  write(`  isolated home    ${home}`)
  write(`  probe profile    ${profileDir}`)
  write(`  port             ${port === '0' ? '0 (OS-assigned — never hardcode a GUI port)' : port}`)
  write(`  channel          ${CHANNEL} (${String(CONTRACT_ENDPOINTS.length)} endpoints: ${CONTRACT_ENDPOINTS.join(', ')})`)
  write(`  failure codes    ${String(CONTRACT_FAILURE_CODES.length)} browser codes (includes invalid-input): ${CONTRACT_FAILURE_CODES.join(', ')}`)
  write(`  host protocol    ${String(HOST_PROTOCOL_CODES.length)} host-only codes: ${HOST_PROTOCOL_CODES.join(', ')}`)
  write('')

  if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
    process.stderr.write('verify-rpc-roundtrip: packages/plugin/lib/index.js is missing — run `pnpm run build` first\n')
    return 4
  }

  let cli
  try {
    cli = locateCli()
  } catch (error) {
    process.stderr.write(`verify-rpc-roundtrip: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  write(`  dsh cli          ${cli}`)
  write(`  node             ${node}`)
  write('')

  // ---- isolated home + workspace fixture --------------------------------
  rmSync(home, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  let fixtureRows
  let linkPath
  try {
    prepare(home)
    linkPath = writeProbeProfile(profileDir)
    const fixturePath = join(home, 'storages', 'workspace.json')
    if (!existsSync(fixturePath)) throw new Error(`the probe harness did not write ${fixturePath}`)
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const rows = fixture?.tables?.workspaces
    if (typeof rows !== 'object' || rows === null) throw new Error(`${fixturePath} has no tables.workspaces`)
    fixtureRows = Object.entries(rows).map(([id, row]) => ({
      id,
      path: typeof row?.path === 'string' ? row.path : '',
      title: typeof row?.title === 'string' ? row.title : '',
    }))
    if (fixtureRows.length === 0) throw new Error(`${fixturePath} contains no workspaces`)
  } catch (error) {
    process.stderr.write(`verify-rpc-roundtrip: cannot prepare the isolated home: ${error instanceof Error ? error.message : String(error)}\n`)
    if (!keep) rmSync(home, { recursive: true, force: true })
    return 6
  }
  write(`prepared isolated home; workspace fixture: ${String(fixtureRows.length)} workspace(s)`)
  for (const row of fixtureRows) write(`  ${row.id}  ${row.title}  ${row.path}`)
  write(`prepared profile; ${PACKAGE_NAME} → ${linkPath}`)
  // The last fixture row is the one this run reads the board for; prefer the
  // primary repo workspace so the report names the expected project.
  const primaryRow = fixtureRows.find((row) => normalizePath(row.path) === normalizePath(PRIMARY_WORKSPACE_PATH)) ?? fixtureRows[0]

  write('\n[1/10] booting the isolated host (own DSH_HOME, --port 0, --no-open)')
  writeFileSync(observerPath, `// Generated by tools/verify-rpc-roundtrip.mjs — subscribes to the AIKanBan diagnostics channels.
const dc = require('node:diagnostics_channel')
dc.subscribe('aikanban:activation', (payload) => {
  process.stderr.write('${observerMarker} ACTIVATION ' + JSON.stringify(payload) + '\\n')
})
dc.subscribe('aikanban:board-channel', (payload) => {
  process.stderr.write('${observerMarker} BOARD-CHANNEL ' + JSON.stringify(payload) + '\\n')
})
`)
  // Strip inherited DSH_* session plumbing so the child cannot pick up the
  // caller's live desktop profile; only the isolated DSH_HOME is passed on.
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('DSH_') && key !== 'DSH_CLI') delete childEnv[key]
  }
  childEnv.DSH_HOME = home
  childEnv.NODE_OPTIONS = [process.env['NODE_OPTIONS'], `--require=${observerPath}`].filter(Boolean).join(' ')

  const child = spawn(node, [cli, '--profile', profileName, '--port', port, '--no-open'], {
    cwd: WORKSPACE_ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let hostLog = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { hostLog += chunk })
  child.stderr.on('data', (chunk) => { hostLog += chunk })

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
        const match = hostLog.split(/\r?\n/).find(predicate)
        if (match !== undefined) { clearInterval(poll); resolvePromise(match); return }
        if (child.exitCode !== null) { clearInterval(poll); resolvePromise(null); return }
        if (Date.now() > deadline) { clearInterval(poll); resolvePromise(null) }
      }, 250)
    })
  }

  const bootError = { value: null }
  try {
    const urlLine = await waitForLine((line) => line.includes('http://'), timeoutSec * 1000)
    if (urlLine === null) {
      bootError.value = 'the isolated host never printed its URL line'
      write('  FAIL  the host never printed a URL line')
      write(`\n${hostLog.trim().split(/\r?\n/).slice(-20).join('\n')}\n`)
      return 5
    }
    const base = /(https?:\/\/\S+)/.exec(urlLine)?.[1]
    const parsedOrigin = new URL(base ?? '')
    origin = parsedOrigin.origin
    authority = parsedOrigin.host
    const token = parsedOrigin.searchParams.get('token')
    write(`  ok    isolated host settled and bound: ${urlLine.trim()}`)
    write(`  ok    request origin (OS-assigned): ${origin}`)
    transcript.push({ label: 'host settled', urlLine: urlLine.replace(/token=[^&\s]+/, 'token=<redacted>') })

    // ---- authentication: launch token → signed cookie ----------------
    write('\n[2/10] exchanging the launch token for the signed session cookie')
    if (token === null) {
      record({
        id: 'AUTH-1', group: 'setup', name: 'launch URL carries a token and exchanges for a cookie',
        expected: 'URL token present; GET /?token=… → 303 + set-cookie', actual: 'the printed URL carries no token', ok: false,
      })
    } else {
      const exchange = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
      const rawCookie = exchange.headers.getSetCookie?.()[0] ?? exchange.headers.get('set-cookie')
      cookie = rawCookie === null || rawCookie === undefined ? '' : rawCookie.split(';')[0]
      transcript.push({ label: 'cookie exchange', request: { method: 'GET', path: '/?token=<redacted>' }, response: { status: exchange.status, setCookie: cookie === '' ? null : `${cookie.split('=')[0]}=<redacted>` } })
      assertCheck({
        id: 'AUTH-1', group: 'setup',
        name: 'launch token → signed session cookie exchange',
        expected: '303 with a set-cookie header',
        actual: `${String(exchange.status)} with ${cookie === '' ? 'no set-cookie' : `set-cookie (${cookie.split('=')[0]}=…)`}`,
        httpStatus: exchange.status,
        ok: exchange.status === 303 && cookie !== '',
      })
    }

    if (cookie !== '') {
      const indexPage = await fetch(`${origin}/`, { headers: { cookie } })
      const html = await indexPage.text()
      transcript.push({ label: 'authenticated index', request: { method: 'GET', path: '/' }, response: { status: indexPage.status, bytes: html.length, bytesNote: 'body not stored' } })
      assertCheck({
        id: 'AUTH-2', group: 'setup',
        name: 'the exchanged cookie authenticates the app shell',
        expected: 'GET / with the cookie → 200 and the shell HTML',
        actual: `${String(indexPage.status)} (${String(html.length)}B, __DSH_BOOT__ present: ${String(html.includes('__DSH_BOOT__'))})`,
        httpStatus: indexPage.status,
        ok: indexPage.status === 200 && html.includes('__DSH_BOOT__'),
      })
    } else {
      record({ id: 'AUTH-2', group: 'setup', name: 'the exchanged cookie authenticates the app shell', expected: 'GET / with the cookie → 200', actual: 'not attempted: no cookie', ok: false })
    }

    // ---- positive: project/list --------------------------------------
    write('\n[3/10] positive: POST /aikanban/project/list over real HTTP')
    // The delayed-ready board port answers `unavailable` until the core domain
    // has opened; polling is the black-box equivalent of the browser's retry and
    // keeps the tool honest about readiness instead of assuming a boot window.
    const deadline = Date.now() + timeoutSec * 1000
    let attempts = 0
    let listResponse
    for (;;) {
      attempts += 1
      listResponse = await postEnvelope({ label: `project/list attempt ${String(attempts)}`, endpoint: 'project/list', payload: {} })
      const code = failureCodeOf(listResponse.parsed)
      if (listResponse.status === 200 && (resultOf(listResponse.parsed)?.ok === true || code !== 'unavailable')) break
      if (Date.now() > deadline) break
      await sleep(500)
    }
    const listResult = resultOf(listResponse.parsed)
    assertCheck({
      id: 'POS-1', group: 'positive',
      name: 'project/list answers HTTP 200 (after data-layer readiness, if needed)',
      expected: 'HTTP 200',
      actual: `HTTP ${String(listResponse.status)} after ${String(attempts)} attempt(s)`,
      httpStatus: listResponse.status,
      ok: listResponse.status === 200,
    })
    const listEnvelopeOk = listResponse.issues.length === 0
      && listResult?.ok === true
      && listResponse.parsed?.type === 'server-response'
      && listResponse.parsed?.rpcId === listResponse.rpcId
    assertCheck({
      id: 'POS-2', group: 'positive',
      name: 'project/list response is a valid RPC envelope (type/rpcId echo/result.ok)',
      expected: "type='server-response', rpcId echoes the request, result.ok=true, content-type application/json",
      actual: listResponse.issues.length > 0
        ? `envelope issues: ${listResponse.issues.join('; ')}`
        : `type=${String(listResponse.parsed?.type)} rpcId-echo=${String(listResponse.parsed?.rpcId === listResponse.rpcId)} result.ok=${String(listResult?.ok)}`,
      httpStatus: listResponse.status,
      ok: listEnvelopeOk,
    })
    const listValue = listResult?.ok === true ? listResult.value : null
    const projectListValidation = listResult?.ok === true
      ? validateProjectList(listValue, fixtureRows)
      : { issues: [`result.ok=${String(listResult?.ok)} so there is no candidate set to validate`], summary: 'no success value' }
    assertCheck({
      id: 'POS-3', group: 'positive',
      name: 'project/list value carries the candidate set from the host workspaceRegistry',
      expected: `${String(fixtureRows.length)} fixture workspace(s) with matching projectId/title/path; no selection fields`,
      actual: projectListValidation.summary,
      httpStatus: listResponse.status,
      ok: projectListValidation.issues.length === 0,
      actualWhenFail: `${projectListValidation.summary}; issues: ${projectListValidation.issues.join('; ')}`,
    })

    // ---- positive: board/read ----------------------------------------
    write('\n[4/10] positive: POST /aikanban/board/read over real HTTP')
    const listedProjects = listResult?.ok === true && Array.isArray(listValue?.projects) ? listValue.projects : []
    const selectedProject = listedProjects.find((item) => item?.projectId === primaryRow.id) ?? listedProjects[0]
    if (selectedProject === undefined) {
      for (const id of ['POS-4', 'POS-5', 'POS-6']) {
        record({
          id, group: 'positive', name: 'board/read snapshot over real HTTP',
          expected: 'HTTP 200 + valid envelope + snapshot shape', actual: 'not attempted: project/list returned no project to read', ok: false,
        })
      }
    } else {
      const readResponse = await postEnvelope({
        label: 'board/read',
        endpoint: 'board/read',
        payload: { projectId: selectedProject.projectId },
      })
      const readResult = resultOf(readResponse.parsed)
      assertCheck({
        id: 'POS-4', group: 'positive',
        name: 'board/read answers HTTP 200',
        expected: 'HTTP 200',
        actual: `HTTP ${String(readResponse.status)} for projectId=${String(selectedProject.projectId)}`,
        httpStatus: readResponse.status,
        ok: readResponse.status === 200,
      })
      const readEnvelopeOk = readResponse.issues.length === 0
        && readResult?.ok === true
        && readResponse.parsed?.type === 'server-response'
        && readResponse.parsed?.rpcId === readResponse.rpcId
      assertCheck({
        id: 'POS-5', group: 'positive',
        name: 'board/read response is a valid RPC envelope (type/rpcId echo/result.ok)',
        expected: "type='server-response', rpcId echoes the request, result.ok=true",
        actual: readResponse.issues.length > 0
          ? `envelope issues: ${readResponse.issues.join('; ')}`
          : `type=${String(readResponse.parsed?.type)} rpcId-echo=${String(readResponse.parsed?.rpcId === readResponse.rpcId)} result.ok=${String(readResult?.ok)}`,
        httpStatus: readResponse.status,
        ok: readEnvelopeOk,
        actualWhenFail: readResponse.issues.length > 0
          ? `envelope issues: ${readResponse.issues.join('; ')}`
          : `envelope invalid; body=${readResponse.body.slice(0, 300)}`,
      })
      const snapshotValidation = readResult?.ok === true
        ? validateBoardSnapshot(readResult.value, primaryRow)
        : { issues: [`result.ok=${String(readResult?.ok)} so there is no snapshot to validate`], summary: 'no success value', taskCount: null }
      assertCheck({
        id: 'POS-6', group: 'positive',
        name: 'board/read value is a board snapshot for the explicitly selected project',
        expected: 'project.projectId/title/path match the registry fixture; tasks array; 5 columns; boardToken; capabilities',
        actual: snapshotValidation.summary,
        httpStatus: readResponse.status,
        ok: snapshotValidation.issues.length === 0,
        actualWhenFail: `${snapshotValidation.summary}; issues: ${snapshotValidation.issues.join('; ')}`,
      })
      evidence.boardSnapshot = {
        projectId: selectedProject.projectId,
        taskCount: snapshotValidation.taskCount,
        summary: snapshotValidation.summary,
      }
    }

    // ---- positive: task/create ---------------------------------------
    write('\n[5/10] positive: POST /aikanban/task/create over real HTTP')
    // A unique requestId makes the retry idempotent: if the data layer is still
    // opening, a replay returns `already-created` for the same task instead of
    // creating a second one.
    const createRequestId = `roundtrip-create-${randomUUID()}`
    const createTitle = `RPC roundtrip 任务 ${createRequestId.slice(-8)}`
    let createdTask = null
    if (selectedProject === undefined) {
      for (const id of ['POS-7', 'POS-8', 'POS-9']) {
        record({
          id, group: 'positive', name: 'task/create over real HTTP',
          expected: 'HTTP 200 + valid envelope + created task', actual: 'not attempted: project/list returned no project to create a task in', ok: false,
        })
      }
    } else {
      const createDeadline = Date.now() + timeoutSec * 1000
      let createAttempts = 0
      let createResponse
      for (;;) {
        createAttempts += 1
        createResponse = await postEnvelope({
          label: `task/create attempt ${String(createAttempts)}`,
          endpoint: 'task/create',
          payload: {
            projectId: selectedProject.projectId,
            requestId: createRequestId,
            title: createTitle,
            goal: 'slice B contract verification',
          },
        })
        const code = failureCodeOf(createResponse.parsed)
        if (createResponse.status === 200 && (resultOf(createResponse.parsed)?.ok === true || code !== 'unavailable')) break
        if (Date.now() > createDeadline) break
        await sleep(500)
      }
      assertCheck({
        id: 'POS-7', group: 'positive',
        name: 'task/create answers HTTP 200 (after data-layer readiness, if needed)',
        expected: 'HTTP 200',
        actual: `HTTP ${String(createResponse.status)} after ${String(createAttempts)} attempt(s)`,
        httpStatus: createResponse.status,
        ok: createResponse.status === 200,
      })
      const createResult = resultOf(createResponse.parsed)
      const createEnvelopeOk = createResponse.issues.length === 0
        && createResult?.ok === true
        && createResponse.parsed?.type === 'server-response'
        && createResponse.parsed?.rpcId === createResponse.rpcId
      assertCheck({
        id: 'POS-8', group: 'positive',
        name: 'task/create response is a valid RPC envelope (type/rpcId echo/result.ok)',
        expected: "type='server-response', rpcId echoes the request, result.ok=true",
        actual: createResponse.issues.length > 0
          ? `envelope issues: ${createResponse.issues.join('; ')}`
          : `type=${String(createResponse.parsed?.type)} rpcId-echo=${String(createResponse.parsed?.rpcId === createResponse.rpcId)} result.ok=${String(createResult?.ok)}`,
        httpStatus: createResponse.status,
        ok: createEnvelopeOk,
      })
      const createValidation = createResult?.ok === true
        ? validateCreateTaskValue(createResult.value, selectedProject, createTitle)
        : { issues: [`result.ok=${String(createResult?.ok)} so there is no created task to validate`], summary: 'no success value', taskId: null, fieldsRevision: null, statusRevision: null }
      assertCheck({
        id: 'POS-9', group: 'positive',
        name: 'task/create value carries the created task and a refreshed snapshot',
        expected: "outcome created|already-created; task.taskId/projectId/title; non-negative fieldsRevision; snapshot contains the task",
        actual: createValidation.summary,
        httpStatus: createResponse.status,
        ok: createValidation.issues.length === 0,
        actualWhenFail: `${createValidation.summary}; issues: ${createValidation.issues.join('; ')}`,
      })
      if (createValidation.taskId !== null && createValidation.fieldsRevision !== null && createValidation.statusRevision !== null) {
        createdTask = {
          taskId: createValidation.taskId,
          title: createTitle,
          fieldsRevision: createValidation.fieldsRevision,
          statusRevision: createValidation.statusRevision,
        }
        evidence.taskCreate = {
          taskId: createdTask.taskId,
          outcome: createResult?.ok === true ? createResult.value.outcome : null,
          fieldsRevision: createdTask.fieldsRevision,
          statusRevision: createdTask.statusRevision,
        }
      }
    }

    // ---- positive: task/fields.update --------------------------------
    write('\n[6/10] positive: POST /aikanban/task/fields.update over real HTTP')
    const updatedTitle = createdTask === null ? null : `${String(createdTask.title)} · updated`
    if (createdTask === null || updatedTitle === null) {
      for (const id of ['POS-10', 'POS-11', 'POS-12']) {
        record({
          id, group: 'positive', name: 'task/fields.update over real HTTP',
          expected: 'HTTP 200 + valid envelope + saved fields', actual: 'not attempted: task/create produced no task id and baselines', ok: false,
        })
      }
    } else {
      const updateResponse = await postEnvelope({
        label: 'task/fields.update',
        endpoint: 'task/fields.update',
        payload: {
          taskId: createdTask.taskId,
          requestId: `roundtrip-fields-${randomUUID()}`,
          expectedFieldsVersion: fieldsVersionOf(createdTask.fieldsRevision),
          expectedStatusVersion: statusVersionOf(createdTask.statusRevision),
          title: updatedTitle,
        },
      })
      const updateResult = resultOf(updateResponse.parsed)
      assertCheck({
        id: 'POS-10', group: 'positive',
        name: 'task/fields.update answers HTTP 200 with the decoded baselines',
        expected: 'HTTP 200',
        actual: `HTTP ${String(updateResponse.status)} for taskId=${String(createdTask.taskId)}`,
        httpStatus: updateResponse.status,
        ok: updateResponse.status === 200,
      })
      const updateEnvelopeOk = updateResponse.issues.length === 0
        && updateResult?.ok === true
        && updateResponse.parsed?.type === 'server-response'
        && updateResponse.parsed?.rpcId === updateResponse.rpcId
      assertCheck({
        id: 'POS-11', group: 'positive',
        name: 'task/fields.update response is a valid RPC envelope (type/rpcId echo/result.ok)',
        expected: "type='server-response', rpcId echoes the request, result.ok=true",
        actual: updateResponse.issues.length > 0
          ? `envelope issues: ${updateResponse.issues.join('; ')}`
          : `type=${String(updateResponse.parsed?.type)} rpcId-echo=${String(updateResponse.parsed?.rpcId === updateResponse.rpcId)} result.ok=${String(updateResult?.ok)}`,
        httpStatus: updateResponse.status,
        ok: updateEnvelopeOk,
      })
      const updateValidation = updateResult?.ok === true
        ? validateFieldsUpdateValue(updateResult.value, createdTask.taskId, createdTask.fieldsRevision, updatedTitle)
        : { issues: [`result.ok=${String(updateResult?.ok)} so there is no saved task to validate`], summary: 'no success value', fieldsRevision: null }
      assertCheck({
        id: 'POS-12', group: 'positive',
        name: 'task/fields.update value reports saved fields and a refreshed snapshot',
        expected: "outcome saved; changed includes title; fieldsRevision advanced by 1; snapshot task carries the new title",
        actual: updateValidation.summary,
        httpStatus: updateResponse.status,
        ok: updateValidation.issues.length === 0,
        actualWhenFail: `${updateValidation.summary}; issues: ${updateValidation.issues.join('; ')}`,
      })
      if (updateValidation.fieldsRevision !== null) {
        createdTask = { ...createdTask, title: updatedTitle, fieldsRevision: updateValidation.fieldsRevision }
      }
      evidence.taskFieldsUpdate = {
        taskId: createdTask.taskId,
        outcome: updateResult?.ok === true ? updateResult.value.outcome : null,
        fieldsRevision: createdTask.fieldsRevision,
      }
    }

    // ---- positive: activity/read -------------------------------------
    write('\n[7/10] positive: POST /aikanban/activity/read over real HTTP')
    if (createdTask === null) {
      for (const id of ['POS-13', 'POS-14', 'POS-15']) {
        record({
          id, group: 'positive', name: 'activity/read over real HTTP',
          expected: 'HTTP 200 + valid envelope + newest-first entries', actual: 'not attempted: task/create produced no task id', ok: false,
        })
      }
    } else {
      const activityResponse = await postEnvelope({
        label: 'activity/read',
        endpoint: 'activity/read',
        payload: { scopeKind: 'task', scopeId: createdTask.taskId, limit: 20 },
      })
      const activityResult = resultOf(activityResponse.parsed)
      assertCheck({
        id: 'POS-13', group: 'positive',
        name: 'activity/read answers HTTP 200 for the task scope',
        expected: 'HTTP 200',
        actual: `HTTP ${String(activityResponse.status)} for scopeId=${String(createdTask.taskId)}`,
        httpStatus: activityResponse.status,
        ok: activityResponse.status === 200,
      })
      const activityEnvelopeOk = activityResponse.issues.length === 0
        && activityResult?.ok === true
        && activityResponse.parsed?.type === 'server-response'
        && activityResponse.parsed?.rpcId === activityResponse.rpcId
      assertCheck({
        id: 'POS-14', group: 'positive',
        name: 'activity/read response is a valid RPC envelope (type/rpcId echo/result.ok)',
        expected: "type='server-response', rpcId echoes the request, result.ok=true",
        actual: activityResponse.issues.length > 0
          ? `envelope issues: ${activityResponse.issues.join('; ')}`
          : `type=${String(activityResponse.parsed?.type)} rpcId-echo=${String(activityResponse.parsed?.rpcId === activityResponse.rpcId)} result.ok=${String(activityResult?.ok)}`,
        httpStatus: activityResponse.status,
        ok: activityEnvelopeOk,
      })
      const activityValidation = activityResult?.ok === true
        ? validateActivityValue(activityResult.value, createdTask.taskId)
        : { issues: [`result.ok=${String(activityResult?.ok)} so there are no activity entries to validate`], summary: 'no success value', entryCount: null, codes: [] }
      assertCheck({
        id: 'POS-15', group: 'positive',
        name: 'activity/read value is newest-first task history with string-only details',
        expected: "entries newest-first; task-title-changed before task-created; scopeKind='task'; details Record<string,string>",
        actual: activityValidation.summary,
        httpStatus: activityResponse.status,
        ok: activityValidation.issues.length === 0,
        actualWhenFail: `${activityValidation.summary}; issues: ${activityValidation.issues.join('; ')}`,
      })
      evidence.activity = {
        scopeId: createdTask.taskId,
        entryCount: activityValidation.entryCount,
        codes: activityValidation.codes,
      }
    }

    // ---- positive: manual summary (F03) ------------------------------
    write('\n[8/10] positive: POST /aikanban/summary/{read,save,draft.save} over real HTTP')
    const summaryScopeId = createdTask === null ? null : createdTask.taskId
    const summaryCheckIds = ['POS-16', 'POS-17', 'POS-18', 'POS-19', 'POS-20', 'POS-21', 'POS-22']
    const recordSummaryNotAttempted = (ids, reason) => {
      for (const id of ids) {
        record({
          id, group: 'positive',
          name: 'manual summary read/save/draft over real HTTP',
          expected: 'HTTP 200 + valid envelope + summary lifecycle',
          actual: `not attempted: ${reason}`,
          ok: false,
        })
      }
    }
    if (summaryScopeId === null) {
      recordSummaryNotAttempted(summaryCheckIds, 'task/create produced no task id to scope the summary')
    } else {
      const summaryScope = { scopeKind: 'task', scopeId: summaryScopeId }
      const summaryUpdateId = `roundtrip-summary-${randomUUID()}`
      const summaryBody = `RPC roundtrip 摘要 ${summaryUpdateId.slice(-8)}`
      const readSummary = (label) => postEnvelope({ label, endpoint: 'summary/read', payload: { ...summaryScope } })

      // POS-16: the scope exists (the task was created above) and already carries
      // the write baseline even though no official version exists yet.
      const emptyRead = await readSummary('summary/read (empty scope)')
      const emptyResult = resultOf(emptyRead.parsed)
      const emptyValue = emptyResult?.ok === true && isRecord(emptyResult.value) ? emptyResult.value : null
      const emptyValidation = emptyValue === null
        ? { issues: [`result.ok=${String(emptyResult?.ok)} so there is no summary value to validate`], summary: null }
        : validateSummaryReadValue(emptyValue, 'summary/read.value')
      const emptyView = emptyValidation.summary
      const emptyFacts = emptyView === null ? null : {
        revision: emptyView.revision,
        applicabilityRevision: emptyView.applicabilityRevision,
        baselineVersionId: emptyView.baseline?.summaryVersionId ?? null,
        historyLength: Array.isArray(emptyView.history) ? emptyView.history.length : null,
      }
      assertCheck({
        id: 'POS-16', group: 'positive',
        name: 'summary/read reports the empty task summary plus its write baseline',
        expected: "HTTP 200 + valid envelope + view{scopeKind:'task', current:null, history:[], draft:null, baseline.summaryVersionId:null}",
        actual: `HTTP ${String(emptyRead.status)} ${emptyView === null ? 'no view' : JSON.stringify(emptyFacts)}`,
        httpStatus: emptyRead.status,
        ok: emptyRead.status === 200
          && emptyRead.issues.length === 0
          && emptyValidation.issues.length === 0
          && emptyView !== null
          && emptyView.scopeKind === 'task'
          && emptyView.scopeId === summaryScopeId
          && emptyView.current === null
          && emptyFacts.historyLength === 0
          && emptyView.draft === null
          && emptyView.needsRecheck === false
          && emptyFacts.baselineVersionId === null,
        actualWhenFail: `HTTP ${String(emptyRead.status)}; issues: ${[...emptyRead.issues, ...emptyValidation.issues].join('; ') || 'none'}; body=${emptyRead.body.slice(0, 300)}`,
      })

      if (emptyView === null) {
        recordSummaryNotAttempted(['POS-17', 'POS-18', 'POS-19', 'POS-20', 'POS-21', 'POS-22'], 'summary/read produced no empty view to save under')
      } else {
        const emptyBaseline = {
          expectedRevision: emptyView.revision,
          expectedApplicabilityRevision: emptyView.applicabilityRevision,
          expectedSummaryVersionId: emptyFacts.baselineVersionId,
        }
        const firstSavePayload = { ...summaryScope, updateId: summaryUpdateId, ...emptyBaseline, content: summaryContent(summaryBody) }

        // POS-17: the first committed version under the empty baseline.
        const firstSave = await postEnvelope({ label: 'summary/save (committed)', endpoint: 'summary/save', payload: firstSavePayload })
        const firstSaveResult = resultOf(firstSave.parsed)
        const firstSaveValue = firstSaveResult?.ok === true && isRecord(firstSaveResult.value) ? firstSaveResult.value : null
        const firstSaveIssues = []
        if (firstSaveValue === null) {
          firstSaveIssues.push(`result.ok=${String(firstSaveResult?.ok)} so there is no committed value`)
        } else {
          if (firstSaveValue.outcome !== 'committed') firstSaveIssues.push(`outcome=${JSON.stringify(firstSaveValue.outcome)}`)
          if (firstSaveValue.changeKind !== 'created') firstSaveIssues.push(`changeKind=${JSON.stringify(firstSaveValue.changeKind)}`)
          if (firstSaveValue.revision !== emptyView.revision + 1) firstSaveIssues.push(`revision=${String(firstSaveValue.revision)} (expected ${String(emptyView.revision + 1)})`)
          if (typeof firstSaveValue.versionId !== 'string' || firstSaveValue.versionId.length === 0) firstSaveIssues.push('versionId is not a non-empty string')
          if (!Array.isArray(firstSaveValue.consumedDraftIds)) firstSaveIssues.push('consumedDraftIds is not an array')
          if (!Array.isArray(firstSaveValue.draftUpdateFailures)) firstSaveIssues.push('draftUpdateFailures is not an array')
          if (typeof firstSaveValue.needsRecheck !== 'boolean') firstSaveIssues.push('needsRecheck is not a boolean')
          const savedViewValidation = isRecord(firstSaveValue.view)
            ? validateSummaryView(firstSaveValue.view, 'summary/save.value.view')
            : { issues: ['view is not an object'], view: null }
          firstSaveIssues.push(...savedViewValidation.issues)
          const savedView = savedViewValidation.view
          if (savedView !== null) {
            if (savedView.current === null) {
              firstSaveIssues.push('view.current is null after a committed save')
            } else {
              if (savedView.current.versionId !== firstSaveValue.versionId) firstSaveIssues.push('view.current.versionId differs from the save versionId')
              if (savedView.current.changeKind !== 'created') firstSaveIssues.push(`view.current.changeKind=${JSON.stringify(savedView.current.changeKind)}`)
              if (savedView.current.origin !== 'user') firstSaveIssues.push(`view.current.origin=${JSON.stringify(savedView.current.origin)}`)
              if (savedView.current.content?.sections?.[0]?.body !== summaryBody) firstSaveIssues.push(`view.current content body=${JSON.stringify(savedView.current.content?.sections?.[0]?.body)}`)
            }
            if (!Array.isArray(savedView.history) || savedView.history.length !== 1) firstSaveIssues.push(`view.history length=${Array.isArray(savedView.history) ? String(savedView.history.length) : 'n/a'} (expected 1)`)
            if (!isRecord(savedView.baseline) || savedView.baseline.summaryVersionId !== firstSaveValue.versionId) firstSaveIssues.push('view.baseline.summaryVersionId does not carry the committed version')
          }
        }
        assertCheck({
          id: 'POS-17', group: 'positive',
          name: 'summary/save commits the first official version under the empty baseline',
          expected: 'HTTP 200 + outcome=committed + changeKind=created + revision advanced by 1 + view.current(origin=user) + history length 1',
          actual: `HTTP ${String(firstSave.status)} outcome=${JSON.stringify(firstSaveValue?.outcome ?? null)} versionId=${JSON.stringify(firstSaveValue?.versionId ?? null)} revision=${String(firstSaveValue?.revision)}`,
          httpStatus: firstSave.status,
          ok: firstSave.status === 200 && firstSave.issues.length === 0 && firstSaveIssues.length === 0,
          actualWhenFail: `HTTP ${String(firstSave.status)}; issues: ${[...firstSave.issues, ...firstSaveIssues].join('; ') || 'none'}; body=${firstSave.body.slice(0, 300)}`,
        })
        const committed = firstSaveValue !== null
          && firstSaveValue.outcome === 'committed'
          && typeof firstSaveValue.versionId === 'string'
          && isNonNegativeInteger(firstSaveValue.revision)
          && isRecord(firstSaveValue.view)
          && isNonNegativeInteger(firstSaveValue.view.applicabilityRevision)
          ? {
              versionId: firstSaveValue.versionId,
              revision: firstSaveValue.revision,
              applicabilityRevision: firstSaveValue.view.applicabilityRevision,
              view: firstSaveValue.view,
            }
          : null
        if (committed === null) {
          recordSummaryNotAttempted(['POS-18', 'POS-19', 'POS-20', 'POS-21', 'POS-22'], 'summary/save committed without a usable version/baseline to continue from')
        } else {
          // POS-18: reading the scope back returns the committed version in
          // `current` and an advanced baseline that can drive the next save.
          const existingRead = await readSummary('summary/read (existing version)')
          const existingResult = resultOf(existingRead.parsed)
          const existingValue = existingResult?.ok === true && isRecord(existingResult.value) ? existingResult.value : null
          const existingValidation = existingValue === null
            ? { issues: [`result.ok=${String(existingResult?.ok)} so there is no summary value to validate`], summary: null }
            : validateSummaryReadValue(existingValue, 'summary/read.value')
          const existingView = existingValidation.summary
          const existingIssues = []
          if (existingView === null) {
            existingIssues.push('view is null')
          } else {
            if (existingView.current === null) existingIssues.push('current is null after a committed save')
            else if (existingView.current.versionId !== committed.versionId) existingIssues.push(`current.versionId=${JSON.stringify(existingView.current.versionId)}`)
            if (existingView.revision !== committed.revision) existingIssues.push(`revision=${String(existingView.revision)} (expected ${String(committed.revision)})`)
            if (!Array.isArray(existingView.history) || existingView.history.length !== 1) existingIssues.push(`history length=${Array.isArray(existingView.history) ? String(existingView.history.length) : 'n/a'}`)
            else if (existingView.history[0]?.versionId !== committed.versionId) existingIssues.push('history[0].versionId differs from the committed version')
            if (!isRecord(existingView.baseline) || existingView.baseline.summaryVersionId !== committed.versionId) existingIssues.push('baseline.summaryVersionId does not carry the committed version')
            if (existingView.current?.content?.sections?.[0]?.body !== summaryBody) existingIssues.push('current content body does not echo the committed body')
          }
          assertCheck({
            id: 'POS-18', group: 'positive',
            name: 'summary/read returns the committed version and the advanced baseline',
            expected: 'HTTP 200 + current.versionId=committed + revision=committed + history length 1 + baseline.summaryVersionId=committed',
            actual: `HTTP ${String(existingRead.status)} current=${JSON.stringify(existingView?.current?.versionId ?? null)} revision=${String(existingView?.revision)} history=${String(Array.isArray(existingView?.history) ? existingView.history.length : null)}`,
            httpStatus: existingRead.status,
            ok: existingRead.status === 200 && existingRead.issues.length === 0 && existingValidation.issues.length === 0 && existingIssues.length === 0,
            actualWhenFail: `HTTP ${String(existingRead.status)}; issues: ${[...existingRead.issues, ...existingValidation.issues, ...existingIssues].join('; ') || 'none'}; body=${existingRead.body.slice(0, 300)}`,
          })

          // POS-19: replaying the committed updateId is idempotent; the stale
          // baseline in the exact same payload must not turn it into a failure.
          const replay = await postEnvelope({ label: 'summary/save (replay of the committed updateId)', endpoint: 'summary/save', payload: firstSavePayload })
          const replayResult = resultOf(replay.parsed)
          const replayValue = replayResult?.ok === true && isRecord(replayResult.value) ? replayResult.value : null
          const replayIssues = []
          if (replayValue === null) {
            replayIssues.push(`result.ok=${String(replayResult?.ok)} so there is no replay value`)
          } else {
            if (replayValue.outcome !== 'already-applied') replayIssues.push(`outcome=${JSON.stringify(replayValue.outcome)}`)
            if (replayValue.versionId !== committed.versionId) replayIssues.push(`versionId=${JSON.stringify(replayValue.versionId)}`)
            if (replayValue.revision !== committed.revision) replayIssues.push(`revision=${String(replayValue.revision)} (expected ${String(committed.revision)})`)
            if (!Array.isArray(replayValue.consumedDraftIds) || replayValue.consumedDraftIds.length !== 0) replayIssues.push('consumedDraftIds is not an empty array')
          }
          assertCheck({
            id: 'POS-19', group: 'positive',
            name: 'summary/save replays the same updateId as already-applied (no new version)',
            expected: 'HTTP 200 + outcome=already-applied + the committed versionId + unchanged revision + consumedDraftIds []',
            actual: `HTTP ${String(replay.status)} outcome=${JSON.stringify(replayValue?.outcome ?? null)} versionId=${JSON.stringify(replayValue?.versionId ?? null)}`,
            httpStatus: replay.status,
            ok: replay.status === 200 && replay.issues.length === 0 && replayIssues.length === 0,
            actualWhenFail: `HTTP ${String(replay.status)}; issues: ${[...replay.issues, ...replayIssues].join('; ') || 'none'}; body=${replay.body.slice(0, 300)}`,
          })

          // POS-20: the identical body under the fresh baseline is a no-change
          // save: it must not create a second version.
          const noChangePayload = {
            ...summaryScope,
            updateId: `roundtrip-summary-nochange-${randomUUID()}`,
            expectedRevision: committed.revision,
            expectedApplicabilityRevision: committed.applicabilityRevision,
            expectedSummaryVersionId: committed.versionId,
            content: summaryContent(summaryBody),
          }
          const noChange = await postEnvelope({ label: 'summary/save (identical body)', endpoint: 'summary/save', payload: noChangePayload })
          const noChangeResult = resultOf(noChange.parsed)
          const noChangeValue = noChangeResult?.ok === true && isRecord(noChangeResult.value) ? noChangeResult.value : null
          const noChangeIssues = []
          if (noChangeValue === null) {
            noChangeIssues.push(`result.ok=${String(noChangeResult?.ok)} so there is no no-change value`)
          } else {
            if (noChangeValue.outcome !== 'no-change') noChangeIssues.push(`outcome=${JSON.stringify(noChangeValue.outcome)}`)
            if (noChangeValue.revision !== committed.revision) noChangeIssues.push(`revision=${String(noChangeValue.revision)} (expected ${String(committed.revision)})`)
            if (noChangeValue.summaryVersionId !== committed.versionId) noChangeIssues.push(`summaryVersionId=${JSON.stringify(noChangeValue.summaryVersionId)}`)
            if (isRecord(noChangeValue.view)) {
              if (noChangeValue.view.current?.versionId !== committed.versionId) noChangeIssues.push('view.current.versionId changed on a no-change save')
              if (!Array.isArray(noChangeValue.view.history) || noChangeValue.view.history.length !== 1) noChangeIssues.push('view.history length changed on a no-change save')
            } else {
              noChangeIssues.push('value.view is not an object')
            }
          }
          assertCheck({
            id: 'POS-20', group: 'positive',
            name: 'summary/save with the identical body is no-change (no second version)',
            expected: 'HTTP 200 + outcome=no-change + revision unchanged + summaryVersionId=committed + history length 1',
            actual: `HTTP ${String(noChange.status)} outcome=${JSON.stringify(noChangeValue?.outcome ?? null)} revision=${String(noChangeValue?.revision)} summaryVersionId=${JSON.stringify(noChangeValue?.summaryVersionId ?? null)}`,
            httpStatus: noChange.status,
            ok: noChange.status === 200 && noChange.issues.length === 0 && noChangeIssues.length === 0,
            actualWhenFail: `HTTP ${String(noChange.status)}; issues: ${[...noChange.issues, ...noChangeIssues].join('; ') || 'none'}; body=${noChange.body.slice(0, 300)}`,
          })

          // POS-21: a fresh updateId under the stale empty baseline is refused
          // with the browser `stale-baseline` code and the expected/actual tuple.
          const stalePayload = { ...summaryScope, updateId: `roundtrip-summary-stale-${randomUUID()}`, ...emptyBaseline, content: summaryContent(`${summaryBody} stale`) }
          const stale = await postEnvelope({ label: 'summary/save (stale baseline)', endpoint: 'summary/save', payload: stalePayload })
          const staleResult = resultOf(stale.parsed)
          const staleFailure = staleResult?.ok === false ? failureOf(stale.parsed) : null
          const staleBaseline = isRecord(staleFailure?.details?.baseline) ? staleFailure.details.baseline : null
          const staleIssues = []
          if (staleFailure === null) {
            staleIssues.push(`result.ok=${String(staleResult?.ok)} so there is no failure envelope`)
          } else {
            if (staleFailure.code !== 'stale-baseline') staleIssues.push(`code=${JSON.stringify(staleFailure.code)}`)
            if (!isRecord(staleBaseline?.expected) || staleBaseline.expected.revision !== emptyView.revision) staleIssues.push('details.baseline.expected.revision does not match the stale baseline')
            if (!isRecord(staleBaseline?.actual) || staleBaseline.actual.revision !== committed.revision) staleIssues.push('details.baseline.actual.revision does not match the committed revision')
            if (!isRecord(staleBaseline?.actual) || staleBaseline.actual.summaryVersionId !== committed.versionId) staleIssues.push('details.baseline.actual.summaryVersionId does not match the committed version')
          }
          assertCheck({
            id: 'POS-21', group: 'positive',
            name: 'summary/save under the stale baseline fails with stale-baseline + expected/actual',
            expected: "HTTP 200 + result.ok=false + error.code='stale-baseline' + details.baseline.{expected,actual} revisions",
            actual: `HTTP ${String(stale.status)} code=${JSON.stringify(staleFailure?.code ?? null)} expectedRevision=${String(staleBaseline?.expected?.revision)} actualRevision=${String(staleBaseline?.actual?.revision)}`,
            httpStatus: stale.status,
            ok: stale.status === 200 && stale.issues.length === 0 && staleIssues.length === 0,
            actualWhenFail: `HTTP ${String(stale.status)}; issues: ${[...stale.issues, ...staleIssues].join('; ') || 'none'}; body=${stale.body.slice(0, 300)}`,
          })

          // POS-22: draft save upserts without promoting anything to an official
          // version; the read after the draft keeps the committed revision.
          const draftUpdateId = `roundtrip-draft-${randomUUID()}`
          const draftFirstBody = `RPC roundtrip 草稿 ${draftUpdateId.slice(-8)}`
          const draftFirst = await postEnvelope({ label: 'summary/draft.save (create)', endpoint: 'summary/draft.save', payload: { ...summaryScope, updateId: draftUpdateId, content: summaryContent(draftFirstBody) } })
          const draftFirstResult = resultOf(draftFirst.parsed)
          const draftFirstValue = draftFirstResult?.ok === true && isRecord(draftFirstResult.value) ? draftFirstResult.value : null
          const draftFirstValidation = draftFirstValue === null
            ? { issues: [`result.ok=${String(draftFirstResult?.ok)} so there is no draft value`], draft: null }
            : validateSummaryDraft(draftFirstValue.draft, 'summary/draft.save.value.draft')
          const draftFirstDraft = draftFirstValidation.draft
          const draftIssues = [...draftFirstValidation.issues]
          if (draftFirstDraft === null) {
            draftIssues.push('value.draft is not an object')
          } else {
            if (draftFirstDraft.state !== 'editing') draftIssues.push(`state=${JSON.stringify(draftFirstDraft.state)}`)
            if (draftFirstDraft.updateId !== draftUpdateId) draftIssues.push(`updateId=${JSON.stringify(draftFirstDraft.updateId)}`)
            if (draftFirstDraft.content?.sections?.[0]?.body !== draftFirstBody) draftIssues.push('draft content does not echo the request body')
            if (!isRecord(draftFirstDraft.base) || draftFirstDraft.base.scopeRevision !== committed.revision) draftIssues.push('draft.base.scopeRevision does not match the committed revision')
          }
          const draftSecondBody = `${draftFirstBody} (updated)`
          const draftSecond = await postEnvelope({ label: 'summary/draft.save (upsert)', endpoint: 'summary/draft.save', payload: { ...summaryScope, content: summaryContent(draftSecondBody) } })
          const draftSecondResult = resultOf(draftSecond.parsed)
          const draftSecondValue = draftSecondResult?.ok === true && isRecord(draftSecondResult.value) ? draftSecondResult.value : null
          const draftSecondValidation = draftSecondValue === null
            ? { issues: [`result.ok=${String(draftSecondResult?.ok)} so there is no draft value`], draft: null }
            : validateSummaryDraft(draftSecondValue.draft, 'summary/draft.save.value.draft')
          const draftSecondDraft = draftSecondValidation.draft
          draftIssues.push(...draftSecondValidation.issues)
          if (draftFirstDraft !== null && draftSecondDraft !== null) {
            if (draftSecondDraft.draftId !== draftFirstDraft.draftId) draftIssues.push('the upsert created a different draftId')
            if (draftSecondDraft.content?.sections?.[0]?.body !== draftSecondBody) draftIssues.push('the upsert did not keep the newest body')
          } else {
            draftIssues.push('the upsert returned no draft object')
          }
          const readAfterDraft = await readSummary('summary/read (after draft)')
          const afterDraftResult = resultOf(readAfterDraft.parsed)
          const afterDraftValue = afterDraftResult?.ok === true && isRecord(afterDraftResult.value) ? afterDraftResult.value : null
          const afterDraftValidation = afterDraftValue === null
            ? { issues: [`result.ok=${String(afterDraftResult?.ok)} so there is no summary value to validate`], summary: null }
            : validateSummaryReadValue(afterDraftValue, 'summary/read.value')
          draftIssues.push(...afterDraftValidation.issues)
          const afterDraftView = afterDraftValidation.summary
          if (afterDraftView !== null) {
            if (afterDraftView.revision !== committed.revision) draftIssues.push(`a draft changed the official revision (${String(afterDraftView.revision)} != ${String(committed.revision)})`)
            if (afterDraftView.current?.versionId !== committed.versionId) draftIssues.push('a draft changed the current official version')
            if (!isRecord(afterDraftView.draft) || afterDraftView.draft.draftId !== draftFirstDraft?.draftId) draftIssues.push('the read after the draft does not carry the upserted draft')
            else if (afterDraftView.draft.content?.sections?.[0]?.body !== draftSecondBody) draftIssues.push('the read-after-draft draft body is stale')
          } else {
            draftIssues.push('the read after the draft returned no view')
          }
          assertCheck({
            id: 'POS-22', group: 'positive',
            name: 'summary/draft.save upserts one draft without an official version or revision bump',
            expected: 'HTTP 200 + draft.state=editing (same draftId) + read after draft: revision/current unchanged, draft present + newest body',
            actual: `HTTP ${String(draftFirst.status)}/${String(draftSecond.status)} draftId=${JSON.stringify(draftFirstDraft?.draftId ?? null)} revision=${String(afterDraftView?.revision)} body=${JSON.stringify(afterDraftView?.draft?.content?.sections?.[0]?.body ?? null)}`,
            httpStatus: draftFirst.status,
            ok: draftFirst.status === 200 && draftSecond.status === 200
              && draftFirst.issues.length === 0 && draftSecond.issues.length === 0
              && readAfterDraft.status === 200 && readAfterDraft.issues.length === 0
              && draftIssues.length === 0,
            actualWhenFail: `HTTP ${String(draftFirst.status)}/${String(draftSecond.status)}/${String(readAfterDraft.status)}; issues: ${[...draftFirst.issues, ...draftSecond.issues, ...readAfterDraft.issues, ...draftIssues].join('; ') || 'none'}; bodies=${[draftFirst.body, draftSecond.body, readAfterDraft.body].map((body) => body.slice(0, 200)).join(' | ')}`,
          })
          evidence.summary = {
            scopeId: summaryScopeId,
            emptyRevision: emptyView.revision,
            committedVersionId: committed.versionId,
            committedRevision: committed.revision,
            draftId: draftFirstDraft?.draftId ?? null,
          }
        }
      }
    }

    // ---- fence negatives ---------------------------------------------
    write('\n[9/10] negative: carrier fence and authentication')
    // Each deviation changes exactly one request property. FEN-7 repeats a
    // healthy request afterwards so the 401/403/415/404 statuses cannot be
    // explained by a session that broke midway through the batch.
    const fenceCases = [
      {
        id: 'FEN-1',
        name: 'no session cookie → 401',
        expected: 'HTTP 401 (authentication rejected before the handler)',
        request: () => postEnvelope({ label: 'fence: no cookie', endpoint: 'project/list', payload: {}, useCookie: false, useOrigin: false }),
        check: (response) => response.status === 401,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 40))}`,
      },
      {
        id: 'FEN-2',
        name: 'valid cookie but cross-site Origin → 403',
        expected: 'HTTP 403 (Host/Origin fence rejected before authentication)',
        request: () => postEnvelope({ label: 'fence: bad origin', endpoint: 'project/list', payload: {}, headers: { origin: 'https://evil.example' } }),
        check: (response) => response.status === 403,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 40))}`,
      },
      {
        id: 'FEN-3',
        name: 'cookie valid but content-type is not application/json → 415',
        expected: 'HTTP 415 (the carrier requires application/json)',
        request: () => postEnvelope({ label: 'fence: content-type text/plain', endpoint: 'project/list', payload: {}, headers: { 'content-type': 'text/plain' } }),
        check: (response) => response.status === 415,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 50))}`,
      },
      {
        id: 'FEN-4',
        name: 'non-POST method (GET) → 404',
        expected: 'HTTP 404 (only POST is routed to the RPC handler)',
        request: () => httpRequest({ label: 'fence: GET', method: 'GET', path: `${CHANNEL}/project/list`, headers: { host: authority, cookie, origin } }),
        check: (response) => response.status === 404,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 40))}`,
      },
      {
        id: 'FEN-5',
        name: 'POST without an endpoint segment (path /aikanban) → 404',
        expected: 'HTTP 404 (no endpoint can be derived from the path)',
        request: () => httpRequest({
          label: 'fence: no endpoint segment',
          method: 'POST',
          path: CHANNEL,
          headers: { host: authority, cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: `roundtrip-${randomUUID()}`, method: 'project/list', payload: {} }),
        }),
        check: (response) => response.status === 404,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 40))}`,
      },
      {
        id: 'FEN-6',
        name: 'cookie valid but Host names a non-loopback authority → 403',
        expected: 'HTTP 403 (the Host fence rejects a rebound authority)',
        request: () => postEnvelope({ label: 'fence: bad host', endpoint: 'project/list', payload: {}, headers: { host: 'evil.example:1234' } }),
        check: (response) => response.status === 403,
        detail: (response) => `HTTP ${String(response.status)} body=${JSON.stringify(response.body.trim().slice(0, 40))}`,
      },
    ]
    for (const fenceCase of fenceCases) {
      const response = await fenceCase.request()
      assertCheck({
        id: fenceCase.id,
        group: 'fence',
        name: fenceCase.name,
        expected: fenceCase.expected,
        actual: fenceCase.detail(response),
        httpStatus: response.status,
        ok: fenceCase.check(response),
      })
    }
    const control = await postEnvelope({ label: 'fence: control after negatives', endpoint: 'project/list', payload: {} })
    assertCheck({
      id: 'FEN-7', group: 'fence',
      name: 'control: the same cookie still succeeds after the negative batch',
      expected: 'HTTP 200 + result.ok=true (so the negative statuses above are caused by the deviations)',
      actual: `HTTP ${String(control.status)} result.ok=${String(resultOf(control.parsed)?.ok)}`,
      httpStatus: control.status,
      ok: control.status === 200 && resultOf(control.parsed)?.ok === true,
    })

    // ---- contract negatives ------------------------------------------
    write('\n[10/10] supplementary: contract-level failures over real HTTP (not fence evidence)')
    const unknownEndpoint = await postEnvelope({ label: 'contract: unknown endpoint', endpoint: 'does-not-exist', payload: {} })
    assertCheck({
      id: 'CON-1', group: 'contract',
      name: 'endpoint outside the eleven-endpoint contract returns a failure envelope, not a throw',
      expected: "HTTP 200 + result.ok=false + error.code='unknown-endpoint'",
      actual: `HTTP ${String(unknownEndpoint.status)} code=${JSON.stringify(failureCodeOf(unknownEndpoint.parsed))}`,
      httpStatus: unknownEndpoint.status,
      ok: unknownEndpoint.status === 200 && failureCodeOf(unknownEndpoint.parsed) === 'unknown-endpoint',
    })
    const unknownProject = await postEnvelope({ label: 'contract: unregistered project', endpoint: 'board/read', payload: { projectId: UNREGISTERED_PROJECT_ID } })
    assertCheck({
      id: 'CON-2', group: 'contract',
      name: 'board/read for an unregistered projectId returns a failure envelope, not an empty board',
      expected: "HTTP 200 + result.ok=false + error.code='unknown-project'",
      actual: `HTTP ${String(unknownProject.status)} code=${JSON.stringify(failureCodeOf(unknownProject.parsed))}`,
      httpStatus: unknownProject.status,
      ok: unknownProject.status === 200 && failureCodeOf(unknownProject.parsed) === 'unknown-project',
    })

    // CON-3 exercises the slice-B `invalid-input` code through the real adapter:
    // a blank title is a legal payload shape (core owns the title policy) and the
    // handler must keep the input for the form instead of throwing.
    let invalidInputStatus = null
    let invalidInputOk = false
    let invalidInputActual = 'not attempted: project/list returned no project to target'
    if (selectedProject !== undefined) {
      const blankTitle = await postEnvelope({
        label: 'contract: blank-title create',
        endpoint: 'task/create',
        payload: { projectId: selectedProject.projectId, requestId: `roundtrip-invalid-${randomUUID()}`, title: '   ' },
      })
      const blankError = failureOf(blankTitle.parsed)
      const keptTitle = isRecord(blankError?.details?.keptInput) ? blankError.details.keptInput.title : undefined
      invalidInputStatus = blankTitle.status
      invalidInputActual = `HTTP ${String(blankTitle.status)} code=${JSON.stringify(blankError?.code ?? null)} keptInput.title=${JSON.stringify(keptTitle)}`
      invalidInputOk = blankTitle.status === 200 && blankError?.code === 'invalid-input' && keptTitle === '   '
    }
    assertCheck({
      id: 'CON-3', group: 'contract',
      name: 'task/create with a blank title returns invalid-input with the kept input',
      expected: "HTTP 200 + result.ok=false + error.code='invalid-input' + details.keptInput.title='   '",
      actual: invalidInputActual,
      httpStatus: invalidInputStatus,
      ok: invalidInputOk,
    })

    // CON-4 proves the host decodes the baseline notation itself: the wire says
    // `fver1:<n>`, so a bare `3` must fail before the port can read it as 3.
    let malformedStatus = null
    let malformedOk = false
    let malformedActual = 'not attempted: task/create produced no task id'
    if (createdTask !== null) {
      const malformed = await postEnvelope({
        label: 'contract: malformed fver1 baseline',
        endpoint: 'task/fields.update',
        payload: {
          taskId: createdTask.taskId,
          requestId: `roundtrip-baseline-${randomUUID()}`,
          expectedFieldsVersion: '3',
          expectedStatusVersion: statusVersionOf(createdTask.statusRevision),
          title: 'must not be written',
        },
      })
      malformedStatus = malformed.status
      malformedActual = `HTTP ${String(malformed.status)} code=${JSON.stringify(failureCodeOf(malformed.parsed))}`
      malformedOk = malformed.status === 200 && failureCodeOf(malformed.parsed) === 'invalid-payload'
    }
    assertCheck({
      id: 'CON-4', group: 'contract',
      name: 'task/fields.update with a non-canonical fver1 baseline returns invalid-payload',
      expected: "HTTP 200 + result.ok=false + error.code='invalid-payload' (handler decodes the baseline; the port never sees '3')",
      actual: malformedActual,
      httpStatus: malformedStatus,
      ok: malformedOk,
    })

    // CON-5/CON-6 extend the same failure-code matrix to the summary endpoints:
    // a random task id cannot exist in the isolated home, and the unregistered
    // project id already used by CON-2 must map identically on the new read.
    const missingSummaryTaskId = randomUUID()
    const missingSummarySave = await postEnvelope({
      label: 'contract: summary/save for a missing task',
      endpoint: 'summary/save',
      payload: {
        scopeKind: 'task',
        scopeId: missingSummaryTaskId,
        updateId: `roundtrip-missing-${randomUUID()}`,
        expectedRevision: 0,
        expectedApplicabilityRevision: 0,
        expectedSummaryVersionId: null,
        content: summaryContent('must not be written'),
      },
    })
    assertCheck({
      id: 'CON-5', group: 'contract',
      name: 'summary/save for a missing task returns not-found (shared failure-code matrix)',
      expected: "HTTP 200 + result.ok=false + error.code='not-found'",
      actual: `HTTP ${String(missingSummarySave.status)} code=${JSON.stringify(failureCodeOf(missingSummarySave.parsed))}`,
      httpStatus: missingSummarySave.status,
      ok: missingSummarySave.status === 200 && failureCodeOf(missingSummarySave.parsed) === 'not-found',
    })
    const unregisteredSummaryRead = await postEnvelope({
      label: 'contract: summary/read for an unregistered project',
      endpoint: 'summary/read',
      payload: { scopeKind: 'project', scopeId: UNREGISTERED_PROJECT_ID },
    })
    assertCheck({
      id: 'CON-6', group: 'contract',
      name: 'summary/read for an unregistered projectId returns unknown-project',
      expected: "HTTP 200 + result.ok=false + error.code='unknown-project'",
      actual: `HTTP ${String(unregisteredSummaryRead.status)} code=${JSON.stringify(failureCodeOf(unregisteredSummaryRead.parsed))}`,
      httpStatus: unregisteredSummaryRead.status,
      ok: unregisteredSummaryRead.status === 200 && failureCodeOf(unregisteredSummaryRead.parsed) === 'unknown-project',
    })

    // ---- process-internal registration evidence (separate from HTTP) --
    const diagnostics = parseDiagnostics(hostLog)
    const registered = [...diagnostics.boardChannels].reverse()
      .find((payload) => payload.channel === CHANNEL && payload.registered === true)
    const observerRefused = /activation-observer|is not allowed in NODE_OPTIONS/.test(hostLog)
    const failedRegistration = [...diagnostics.boardChannels].reverse()
      .find((payload) => payload.channel === CHANNEL && payload.registered === false)
    if (registered !== undefined) {
      const latestActivation = diagnostics.activations.at(-1)
      evidence.registration = {
        observed: true,
        path: registered.path,
        dataLayerReady: latestActivation?.dataLayerReady === true,
      }
    } else {
      evidence.registration = {
        observed: false,
        reason: observerRefused
          ? 'the observer preload was refused into the host process (NODE_OPTIONS restricted)'
          : failedRegistration !== undefined
            ? `a registration failure was observed: reason=${String(failedRegistration.reason)}, path=${String(failedRegistration.path)}`
            : 'no aikanban:board-channel message was observed in the host process',
      }
    }
    if (diagnostics.activations.length > 0) evidence.activationSnapshots = diagnostics.activations.length

    return checks.every((check) => check.ok) ? 0 : 1
  } catch (error) {
    bootError.value = error instanceof Error ? `${error.message}` : String(error)
    process.stderr.write(`verify-rpc-roundtrip: unexpected failure: ${bootError.value}\n`)
    return 1
  } finally {
    // Tear the isolated host down: never leave a server behind.
    if (child.exitCode === null) {
      if (process.platform === 'win32') await new Promise((resolvePromise) => {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', resolvePromise)
      })
      else child.kill('SIGTERM')
    }
    await sleep(300)

    if (bootError.value !== null) evidence.infrastructureError = bootError.value
    if (origin === '' && evidence.registration === undefined) {
      evidence.registration = { observed: false, reason: 'the isolated host never settled; no diagnostics were read' }
    }

    // Persist the evidence even when assertions failed: the host log and the raw
    // transcript are what a reviewer reads next.
    const allAssertionsPassed = checks.length > 0 && checks.every((check) => check.ok) && bootError.value === null
    const finalExitCode = bootError.value !== null ? 5 : allAssertionsPassed ? 0 : 1
    const report = {
      tool: 'tools/verify-rpc-roundtrip.mjs',
      generatedAt: new Date().toISOString(),
      environment: {
        workspace: WORKSPACE_ROOT,
        isolatedHome: home,
        profile: profileName,
        origin,
        dshCli: cli,
        node,
        channel: CHANNEL,
        endpoints: CONTRACT_ENDPOINTS,
        failureCodes: CONTRACT_FAILURE_CODES,
        hostOnlyProtocolCodes: HOST_PROTOCOL_CODES,
      },
      workspaceFixture: fixtureRows,
      checks,
      evidence,
      verdict: {
        allAssertionsPassed,
        browserHalfProven: false,
        realProfileProven: false,
        publicRegistrationEntryPointProven: false,
      },
      transcript,
      hostLogTail: sanitizeHostLog(hostLog).split(/\r?\n/).filter(Boolean).slice(-120),
    }
    writeFileSync(logPath, [
      '# AIKanBan real-HTTP RPC roundtrip — raw transcript',
      `# generatedAt ${report.generatedAt}`,
      `# origin ${origin}`,
      `# dsh cli ${cli}`,
      `# exit ${String(finalExitCode)}`,
      '',
      '## checks',
      ...checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.id} | ${check.name} | expected=${check.expected} | actual=${check.actual} | http=${check.httpStatus === null ? '-' : String(check.httpStatus)}`),
      '',
      '## http transcript',
      ...transcript.map((entry) => JSON.stringify(entry)),
      '',
      '## host log',
      sanitizeHostLog(hostLog),
    ].join('\n'))
    writeFileSync(jsonPath, `${JSON.stringify(report, undefined, 2)}\n`)
    if (!keep) rmSync(home, { recursive: true, force: true })
    printReport({ bootError: bootError.value })
  }
}

let exitCode = 6
try {
  exitCode = await main()
} catch (error) {
  process.stderr.write(`verify-rpc-roundtrip: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  exitCode = 6
}
process.exit(exitCode)
