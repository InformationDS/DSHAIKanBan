#!/usr/bin/env node
/**
 * P6c install script: put AIKanBan into a real DSH profile **repeatably**, with
 * a validated patch entry, and undo it in one command.
 *
 * ## Why this exists (and why it is not `sync-to-profile.mjs`)
 *
 * `tools/sync-to-profile.mjs` only *syncs* the payload and prints the profile
 * steps for a human. The P6b attempt did those steps by hand and the app failed
 * to boot, so the manual notes are not good enough to repeat: this script owns
 * the exact bytes written into the profile and validates the composition layer
 * before it lets anyone restart.
 *
 * The desktop profile is Electron-managed, so `dsh plugin … add` is refused for
 * it; the only supported shape is the manual one this script performs:
 *
 * 1. Back up the four profile manifests to `<home>/aikanban-profile-backup-<date>/`
 *    (a fresh sibling directory per run, so a second attempt never overwrites
 *    the first backup).
 * 2. Copy the built payload (`packages/plugin`: `package.json`, `README.md`,
 *    `lib/`) into `<profile>/node_modules/@aikanban/dsh-aikanban`.
 * 3. Append the composition entry to `<profile>/cordis.patch.yml` in the
 *    **authoritative insert-list shape**:
 *
 *    ```yaml
 *    - insert:
 *        - id: aikanban
 *          name: "@aikanban/dsh-aikanban"
 *    ```
 *
 *    A top-level `- id: aikanban` is a *patch* of an already-loaded entry; the
 *    loader silently ignores it when no such entry exists, which is how a
 *    "successful install" can produce no plugin at all. The script refuses that
 *    shape and validates the append with PyYAML.
 * 4. Junction the package to `<home>/profiles/node_modules/@aikanban/dsh-aikanban`
 *    — the shared resolution anchor `tools/probe-host.mjs` proved resolves from
 *    a profile context. The copy above is what the junction target owns; both
 *    point at the same bytes.
 *
 * ## What it deliberately does not do
 *
 * It never restarts the app, never touches `dsh.profile.bundles`, never edits
 * `package.json`, never runs `dsh plugin`, and never writes outside the paths
 * it prints. Activation still needs an app restart, which the user performs:
 * restarting the GUI ends the running session, so it must not be an automation
 * side effect.
 *
 * ## Usage
 *
 * ```sh
 * # inspect the plan (resolves and prints every absolute path; writes nothing)
 * node tools/install-to-profile.mjs --dry-run
 *
 * # install into the desktop profile
 * node tools/install-to-profile.mjs
 *
 * # one-command rollback from a backup directory this script (or the app) made
 * node tools/install-to-profile.mjs --restore C:\Users\<user>\aikanban-profile-backup-<date>
 * ```
 *
 * @module tools/install-to-profile
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(WORKSPACE_ROOT, 'packages', 'plugin')
const PACKAGE_NAME = '@aikanban/dsh-aikanban'
/** Loader entry id in the profile patch layer. Distinct from the package name. */
const PATCH_ID = 'aikanban'

/** Files that make up the installable runtime payload, relative to `packages/plugin`. */
const PAYLOAD = ['package.json', 'README.md', 'lib']
/** Files the script requires in the source package before it will install. */
const REQUIRED_BUILT = ['package.json', 'README.md', 'lib/index.js', 'lib/client.js']

/** The four profile manifests backed up before any write. */
const MANIFESTS = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']

/** The exact composition entry appended to the profile patch layer. */
const PATCH_ENTRY = { insert: [{ id: PATCH_ID, name: PACKAGE_NAME }] }

const HELP = `Usage: node tools/install-to-profile.mjs [options]

Install AIKanBan into a DSH profile as a manual bundle layer: backup manifests,
copy the built payload, append a validated insert entry, and junction the shared
resolution anchor. Writes only the paths it prints; never restarts the app.

Options:
  --profile <name>    profile under $DSH_HOME/profiles (default: desktop)
  --home <dir>        Harness home (default: $DSH_HOME, else ~/.dsh)
  --backup-root <d>   parent directory for backups (default: ~)
  --date <yyyyMMdd>   backup suffix (default: today, local time)
  --python <path>     Python interpreter with PyYAML (default: python)
  --dry-run           print the plan and the resolved absolute paths, write nothing
  --restore <dir>     one-command rollback: copy four manifests back, remove install points
  --help              show this help

Exit codes:
  0 ok
  2 bad arguments / unknown flag
  3 profile or its manifests missing
  4 payload not built (run \`pnpm run build\` first)
  5 an install path is not safe to replace (a real directory where a junction belongs)
  6 backup failed
  7 patch-entry append or PyYAML validation failed
  8 no Python with PyYAML found
  9 restore directory is incomplete
`

/**
 * Parse `--flag value` / `--flag` arguments, rejecting unknown flags so a typo
 * cannot silently retarget a write.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | true>} parsed options.
 */
function parseArgs(argv) {
  const options = {}
  const booleans = new Set(['dry-run', 'help'])
  const valueFlags = new Set(['profile', 'home', 'backup-root', 'date', 'python', 'restore'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${String(arg)}"`)
    const [flag, inline] = arg.split('=')
    const key = String(flag).slice(2)
    if (booleans.has(key)) {
      options[key] = true
      continue
    }
    if (!valueFlags.has(key)) throw new Error(`unknown option --${key}`)
    const value = inline ?? argv[i + 1]
    if (value === undefined) throw new Error(`--${key} needs a value`)
    if (inline === undefined) i += 1
    options[key] = value
  }
  return options
}

/**
 * Resolve the Harness home the way the host does: explicit value, then
 * `$DSH_HOME`, then `~/.dsh`.
 *
 * @param {string | undefined} explicit - the `--home` value, when given.
 * @returns {string} the absolute home directory.
 */
function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Reject profile names the host itself would reject.
 *
 * @param {string} name - the candidate profile name.
 * @returns {string} the validated name.
 */
function validateProfileName(name) {
  if (name === '' || name === '.' || name === '..' || name === 'node_modules'
    || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * Local calendar date as `yyyyMMdd`, used as the backup suffix.
 *
 * @param {Date} date - the timestamp to format.
 * @returns {string} the local-date suffix.
 */
function localDateSuffix(date) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * Format a byte count.
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
 * Total bytes under a path (junctions are not followed).
 *
 * @param {string} path - file or directory.
 * @returns {number} total bytes.
 */
function measure(path) {
  if (!existsSync(path)) return 0
  if (!statSync(path).isDirectory()) return statSync(path).size
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    total += entry.isDirectory() ? measure(child) : statSync(child).size
  }
  return total
}

/**
 * Remove one install point without ever following a junction into its target.
 *
 * @param {string} path - the install point (junction, file, or copied directory).
 * @returns {string} a human description of what was removed.
 */
function removeInstallPoint(path) {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing === undefined) return 'absent'
  if (existing.isSymbolicLink()) {
    // A junction is deleted as a link; its target keeps every byte.
    rmSync(path, { force: true })
    return 'junction removed (target untouched)'
  }
  if (existing.isDirectory()) {
    rmSync(path, { recursive: true, force: true })
    return 'copied directory removed'
  }
  rmSync(path, { force: true })
  return 'file removed'
}

/**
 * Find a Python interpreter that can import PyYAML, or explain how to point at
 * one. `python`/`python3`/`py -3` are the Windows and POSIX defaults.
 *
 * @param {string | undefined} explicit - the `--python` value, when given.
 * @returns {{ command: string, prefix: string[] } | undefined} the interpreter, or undefined.
 */
function locatePython(explicit) {
  const candidates = explicit !== undefined
    ? [{ command: explicit, prefix: [] }]
    : [
        { command: 'python', prefix: [] },
        { command: 'python3', prefix: [] },
        { command: 'py', prefix: ['-3'] },
      ]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '-c', 'import yaml, sys; sys.exit(0)'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

/**
 * Run the PyYAML assertion over a freshly written patch layer: the new file
 * must equal the old one plus exactly the one authoritative insert entry, with
 * no top-level `- id: aikanban` look-alike anywhere (that shape is ignored by
 * the loader and would install nothing).
 *
 * @param {{ command: string, prefix: string[] }} python - located interpreter.
 * @param {string} oldPath - backup copy of the untouched patch layer.
 * @param {string} newPath - patch layer after the append.
 * @param {number} expectedDelta - entries that must have been added (1 fresh, 0 repeat run).
 * @returns {{ oldEntries: number, newEntries: number } | undefined} counts, or undefined with the printed error.
 */
function validatePatchWithPyYaml(python, oldPath, newPath, expectedDelta) {
  const program = `
import json
import sys

import yaml

old_path, new_path, expected_delta, expected_entry = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4])
with open(old_path, encoding='utf-8') as handle:
    old = yaml.safe_load(handle)
with open(new_path, encoding='utf-8') as handle:
    new = yaml.safe_load(handle)

problems = []
if not isinstance(old, list):
    problems.append(f'old patch layer is {type(old).__name__}, expected a top-level list')
if not isinstance(new, list):
    problems.append(f'new patch layer is {type(new).__name__}, expected a top-level list')
if not problems:
    delta = len(new) - len(old)
    if delta != expected_delta:
        problems.append(f'entry count changed by {delta}, expected {expected_delta} (old={len(old)}, new={len(new)})')
    if expected_delta == 1:
        if new != old + [expected_entry]:
            problems.append('new patch layer is not exactly the old layer plus the expected insert entry')
    elif new != old:
        problems.append('entry count was expected to stay unchanged, but the parsed layer differs')
    matches = [entry for entry in new
               if isinstance(entry, dict)
               and isinstance(entry.get('insert'), list)
               and any(isinstance(item, dict)
                       and item.get('id') == expected_entry['insert'][0]['id']
                       and item.get('name') == expected_entry['insert'][0]['name']
                       for item in entry['insert'])]
    if len(matches) != 1:
        problems.append(f'expected exactly one insert entry for "{expected_entry["insert"][0]["id"]}", found {len(matches)}')
    top_level_ids = [entry.get('id') for entry in new if isinstance(entry, dict) and 'id' in entry]
    if expected_entry['insert'][0]['id'] in top_level_ids:
        problems.append('a top-level "- id:" entry for this plugin exists: the loader silently ignores that shape (it patches an already-loaded entry); it must be an insert list')

if problems:
    print('PYYAML-VALIDATION FAILED', file=sys.stderr)
    for problem in problems:
        print('  - ' + problem, file=sys.stderr)
    sys.exit(1)
print(json.dumps({'old': len(old), 'new': len(new), 'delta': len(new) - len(old)}))
`
  const result = spawnSync(
    python.command,
    [...python.prefix, '-c', program, oldPath, newPath, String(expectedDelta), JSON.stringify(PATCH_ENTRY)],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    process.stderr.write(`${result.stderr.trim()}\n`)
    if (result.error !== undefined) process.stderr.write(`  spawn error: ${result.error.message}\n`)
    return undefined
  }
  process.stdout.write(`  pyyaml  ${result.stdout.trim()}\n`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    process.stderr.write(`install-to-profile: unparsable pyyaml output: ${result.stdout.trim()}\n`)
    return undefined
  }
}

/**
 * Build the new patch-layer text: append the authoritative insert block, or
 * replace the empty flow sequence (`[]`) that a block sequence cannot follow.
 * Returns `undefined` only for shapes this script cannot safely edit (the
 * caller has already parsed the file with PyYAML, so this function only knows
 * the two text shapes it must produce).
 *
 * @param {string} oldText - current patch layer text.
 * @returns {{ text: string, delta: number } | undefined} the new text and expected count delta.
 */
function buildPatchLayer(oldText) {
  const block = `\n- insert:\n    - id: ${PATCH_ID}\n      name: "${PACKAGE_NAME}"\n`

  if (oldText.trim() === '' || oldText.trim() === '[]') {
    // An empty flow sequence cannot be followed by a block sequence, so the
    // `[]` marker is replaced instead of appended to.
    const stripped = oldText.replace(/\[\]\s*$/, '')
    const needsNewline = stripped !== '' && !stripped.endsWith('\n')
    return { text: `${stripped}${needsNewline ? '\n' : ''}${block}`, delta: 1 }
  }
  const separator = oldText.endsWith('\n') ? '' : '\n'
  return { text: `${oldText}${separator}${block}`, delta: 1 }
}

/**
 * Read and parse a YAML patch layer through PyYAML.
 *
 * @param {{ command: string, prefix: string[] }} python - located interpreter.
 * @param {string} path - patch layer to parse.
 * @returns {unknown[] | undefined} the top-level list, or undefined with the error printed.
 */
function parseYamlWithPython(python, path) {
  const program = `
import json
import sys

import yaml

with open(sys.argv[1], encoding='utf-8') as handle:
    value = yaml.safe_load(handle)
print(json.dumps(value if isinstance(value, list) else None))
`
  const result = spawnSync(python.command, [...python.prefix, '-c', program, path], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(`install-to-profile: pyyaml could not parse ${path}:\n${result.stderr.trim()}\n`)
    return undefined
  }
  const value = JSON.parse(result.stdout)
  return Array.isArray(value) ? value : undefined
}

/**
 * Decide whether the layer already carries the exact authoritative insert
 * entry, and refuse the look-alike top-level shape.
 *
 * @param {unknown[]} entries - parsed patch layer entries.
 * @returns {'present' | 'absent' | 'wrong-shape'} the decision.
 */
function inspectExistingEntry(entries) {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    if (record['id'] === PATCH_ID) return 'wrong-shape'
    const insert = record['insert']
    if (!Array.isArray(insert)) continue
    for (const item of insert) {
      if (typeof item === 'object' && item !== null && /** @type {Record<string, unknown>} */ (item)['id'] === PATCH_ID) {
        return 'present'
      }
    }
  }
  return 'absent'
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  process.stdout.write(HELP)
  process.exit(0)
}

const dryRun = options['dry-run'] === true
const pythonOption = typeof options.python === 'string' ? options.python : undefined

/* ---------------- restore mode ---------------- */
if (typeof options.restore === 'string') {
  const restoreDir = resolve(options.restore)
  const home = resolveDshHome(typeof options.home === 'string' ? options.home : undefined)
  const profileName = validateProfileName(typeof options.profile === 'string' ? options.profile : 'desktop')
  const profileDir = join(home, 'profiles', profileName)
  const installDir = join(profileDir, 'node_modules', '@aikanban', 'dsh-aikanban')
  const anchorPath = join(home, 'profiles', 'node_modules', '@aikanban', 'dsh-aikanban')

  process.stdout.write('AIKanBan profile restore\n\n')
  process.stdout.write(`  backup dir       ${restoreDir}\n`)
  process.stdout.write(`  harness home     ${home}\n`)
  process.stdout.write(`  profile dir      ${profileDir}\n\n`)

  if (!existsSync(join(restoreDir, 'package.json'))) {
    process.stderr.write(`install-to-profile: ${restoreDir} has no package.json — not a backup of this shape\n`)
    process.exit(9)
  }
  if (!existsSync(join(restoreDir, 'cordis.patch.yml'))) {
    process.stderr.write(`install-to-profile: ${restoreDir} has no cordis.patch.yml — refusing a partial restore\n`)
    process.exit(9)
  }
  if (!existsSync(join(profileDir, 'package.json'))) {
    process.stderr.write(
      `install-to-profile: no profile manifest at ${join(profileDir, 'package.json')}\n`
      + '  Point --home/--profile at the profile to restore into.\n',
    )
    process.exit(3)
  }
  if (dryRun) {
    process.stdout.write('dry run: would restore the four manifests and remove the install points; nothing was written.\n')
    process.exit(0)
  }

  for (const manifest of MANIFESTS) {
    const source = join(restoreDir, manifest)
    if (!existsSync(source)) {
      process.stdout.write(`  skip    ${manifest} (not in the backup)\n`)
      continue
    }
    cpSync(source, join(profileDir, manifest))
    process.stdout.write(`  restore ${manifest}\n`)
  }
  process.stdout.write(`  remove  ${installDir}: ${removeInstallPoint(installDir)}\n`)
  process.stdout.write(`  remove  ${anchorPath}: ${removeInstallPoint(anchorPath)}\n`)
  for (const dir of [dirname(installDir), dirname(anchorPath)]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  }
  process.stdout.write(`\nrestored. The app must be restarted for the loader to recompose without the bundle layer.\n`)
  process.exit(0)
}

/* ---------------- install mode ---------------- */
const profileName = validateProfileName(typeof options.profile === 'string' ? options.profile : 'desktop')
const home = resolveDshHome(typeof options.home === 'string' ? options.home : undefined)
const profileDir = join(home, 'profiles', profileName)
const installDir = join(profileDir, 'node_modules', '@aikanban', 'dsh-aikanban')
const anchorPath = join(home, 'profiles', 'node_modules', '@aikanban', 'dsh-aikanban')
const backupRoot = resolve(typeof options.backup-root === 'string' ? options.backup-root : homedir())
const dateSuffix = typeof options.date === 'string' ? options.date : localDateSuffix(new Date())
if (!/^\d{8}$/.test(dateSuffix)) {
  process.stderr.write(`install-to-profile: --date must be yyyyMMdd, got ${JSON.stringify(dateSuffix)}\n`)
  process.exit(2)
}

/** Pick a backup directory that does not exist yet, keeping repeat runs non-destructive. */
function pickBackupDir() {
  const base = join(backupRoot, `aikanban-profile-backup-${dateSuffix}`)
  if (!existsSync(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${String(index)}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`no free backup directory beside ${base}`)
}

process.stdout.write('AIKanBan → DSH profile install (manual bundle layer)\n\n')
process.stdout.write(`  workspace        ${WORKSPACE_ROOT}\n`)
process.stdout.write(`  package          ${relative(WORKSPACE_ROOT, PACKAGE_DIR).replaceAll('\\', '/')}\n`)
process.stdout.write(`  harness home     ${home}${process.env['DSH_HOME'] !== undefined ? '   (from $DSH_HOME)' : ''}\n`)
process.stdout.write(`  profile          ${profileName}\n`)
process.stdout.write(`  profile dir      ${profileDir}\n`)
process.stdout.write(`  install dir      ${installDir}\n`)
process.stdout.write(`  anchor junction  ${anchorPath}\n`)
process.stdout.write(`  patch layer      ${join(profileDir, 'cordis.patch.yml')}\n`)
process.stdout.write(`  backup root      ${backupRoot}\n`)
process.stdout.write(`  mode             install${dryRun ? ' (dry run)' : ''}\n\n`)

if (!existsSync(join(profileDir, 'package.json'))) {
  process.stderr.write(
    `install-to-profile: no profile manifest at ${join(profileDir, 'package.json')}\n`
    + `  Refusing to create a profile implicitly. Current home: ${home}\n`
    + `  Point --home at the right Harness home, or create the profile first.\n`,
  )
  process.exit(3)
}
for (const manifest of MANIFESTS) {
  if (!existsSync(join(profileDir, manifest))) {
    process.stderr.write(`install-to-profile: profile is missing ${manifest}; refusing an install whose backup would be incomplete\n`)
    process.exit(3)
  }
}

const missing = REQUIRED_BUILT.filter((entry) => !existsSync(join(PACKAGE_DIR, entry)))
if (missing.length > 0) {
  process.stderr.write(
    `install-to-profile: the package is not built — missing ${missing.join(', ')}\n`
    + '  Run `pnpm run build` first (from the checkout that should be installed).\n',
  )
  process.exit(4)
}

process.stdout.write('payload\n')
for (const entry of PAYLOAD) {
  process.stdout.write(`  ${entry.padEnd(14)} ${humanBytes(measure(join(PACKAGE_DIR, entry)))}\n`)
}
process.stdout.write('\n')

const python = locatePython(pythonOption)
if (python === undefined) {
  process.stderr.write(
    'install-to-profile: no Python with PyYAML found (tried python, python3, py -3).\n'
    + '  The patch layer MUST be validated before it is written; install PyYAML or pass --python <path>.\n',
  )
  process.exit(8)
}

// Read the current layer and decide the delta before writing anything.
const patchPath = join(profileDir, 'cordis.patch.yml')
const oldPatchText = readFileSync(patchPath, 'utf8')
const oldEntries = parseYamlWithPython(python, patchPath)
if (oldEntries === undefined) process.exit(7)
const existing = inspectExistingEntry(oldEntries)
if (existing === 'wrong-shape') {
  process.stderr.write(
    `install-to-profile: ${patchPath} already carries a top-level "- id: ${PATCH_ID}" entry.\n`
    + '  That shape patches an already-loaded entry and is silently ignored by the loader.\n'
    + '  Remove it and use the insert-list shape this script writes.\n',
  )
  process.exit(7)
}
const expectedDelta = existing === 'present' ? 0 : 1

if (existing === 'present') {
  process.stdout.write('patch layer already has the authoritative insert entry; it will be left unchanged\n\n')
} else {
  process.stdout.write('patch layer will gain\n\n'
    + '- insert:\n'
    + `    - id: ${PATCH_ID}\n`
    + `      name: "${PACKAGE_NAME}"\n\n`)
}

const backupDir = pickBackupDir()
process.stdout.write(`backup dir       ${backupDir}\n`)

if (dryRun) {
  process.stdout.write('\ndry run plan (nothing was written)\n')
  process.stdout.write(`  1. copy ${MANIFESTS.join(', ')} → ${backupDir}\n`)
  process.stdout.write(`  2. copy ${PAYLOAD.join(', ')} → ${installDir}\n`)
  process.stdout.write(`  3. append the insert entry to ${patchPath} (delta ${String(expectedDelta)}), then validate with PyYAML\n`)
  process.stdout.write(`  4. recreate the junction ${anchorPath} → ${installDir}\n`)
  process.stdout.write('\ndry run: nothing was written.\n')
  process.exit(0)
}

/* 1. backup — before any write, and never overwrite an earlier backup. */
try {
  mkdirSync(backupDir, { recursive: true })
  for (const manifest of MANIFESTS) {
    cpSync(join(profileDir, manifest), join(backupDir, manifest))
  }
  writeFileSync(join(backupDir, 'install-record.json'), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    workspace: WORKSPACE_ROOT,
    packageDir: PACKAGE_DIR,
    home,
    profile: profileName,
    profileDir,
    installDir,
    anchorPath,
    patchLayer: patchPath,
    patchDelta: expectedDelta,
    patchEntry: PATCH_ENTRY,
    payload: Object.fromEntries(PAYLOAD.map((entry) => [entry, measure(join(PACKAGE_DIR, entry))])),
  }, undefined, 2)}\n`)
  process.stdout.write(`backed up ${String(MANIFESTS.length)} manifests → ${backupDir}\n`)
} catch (error) {
  process.stderr.write(`install-to-profile: backup failed — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(6)
}

/* 2. payload copy — replace only this package's own install point. */
try {
  removeInstallPoint(installDir)
  mkdirSync(installDir, { recursive: true })
  for (const entry of PAYLOAD) {
    cpSync(join(PACKAGE_DIR, entry), join(installDir, entry), { recursive: true })
  }
  process.stdout.write(`copied payload ${humanBytes(measure(installDir))} → ${installDir}\n`)
} catch (error) {
  process.stderr.write(`install-to-profile: payload copy failed — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(6)
}

/* 3. patch layer append + PyYAML assertion. */
if (expectedDelta === 1) {
  const layer = buildPatchLayer(oldPatchText)
  if (layer === undefined) {
    process.stderr.write('install-to-profile: refused to build the patch layer\n')
    process.exit(7)
  }
  writeFileSync(patchPath, layer.text)
}
const validation = validatePatchWithPyYaml(python, join(backupDir, 'cordis.patch.yml'), patchPath, expectedDelta)
if (validation === undefined) {
  process.stderr.write(
    'install-to-profile: PyYAML validation failed; the patch layer was NOT accepted.\n'
    + `  Restore it from ${join(backupDir, 'cordis.patch.yml')} before retrying.\n`,
  )
  process.exit(7)
}
process.stdout.write(`patch layer validated: ${String(validation.oldEntries)} → ${String(validation.newEntries)} entries\n`)

/* 4. shared-anchor junction (the target is the copy above, never the workspace). */
try {
  const existingAnchor = lstatSync(anchorPath, { throwIfNoEntry: false })
  if (existingAnchor !== undefined) {
    if (!existingAnchor.isSymbolicLink()) {
      process.stderr.write(
        `install-to-profile: ${anchorPath} exists and is not a junction.\n`
        + '  Refusing to replace a real directory. Remove it yourself if that is what you want.\n',
      )
      process.exit(5)
    }
    rmSync(anchorPath, { force: true })
  }
  mkdirSync(dirname(anchorPath), { recursive: true })
  symlinkSync(installDir, anchorPath, 'junction')
  process.stdout.write(`junction ${anchorPath} → ${installDir}\n`)
} catch (error) {
  process.stderr.write(`install-to-profile: anchor junction failed — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(5)
}

process.stdout.write(`
installed. NOT active until the app restarts (the loader composes layers at startup).
----------------------------------------------------------------------
1. Close and reopen the DSH Desktop app. This ends the current session.
2. After restart, in DevTools → Console run tools/browser-check.js; the page-side
   boot audit must not name @aikanban/dsh-aikanban, and B1/B4 must PASS.
3. If the app fails to boot again, use the dialog's "disable third-party plugins"
   button, then run the one-command restore:

     node tools/install-to-profile.mjs --restore "${backupDir}"

   (That button also rewrites the profile bundle list; --restore copies the
   backed-up package.json/cordis.patch.yml back and removes both install points.)

rollback directory: ${backupDir}
`)
