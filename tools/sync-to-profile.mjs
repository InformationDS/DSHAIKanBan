#!/usr/bin/env node
/**
 * Sync the built AIKanBan bundle into a DSH profile.
 *
 * ## Why this is a separate, parameterised script
 *
 * Writing into a profile means writing **outside the workspace**
 * (`$DSH_HOME/profiles/<name>`), which normally needs an escalated one-shot
 * retry. Keeping the step isolated, explicit, and dry-runnable means the
 * privileged action is one command with one visible target — never a side
 * effect of `pnpm run build`.
 *
 * The profile is **never hardcoded**: `--profile` selects it (default
 * `desktop`, the profile the Electron app owns), and the resolved absolute
 * directory is printed before anything is touched.
 *
 * ## What it does
 *
 * 1. Resolve the Harness home and the profile directory; refuse to continue
 *    when the profile directory does not exist (a typo must not create one).
 * 2. Stage the publishable files under `.probe-out/sync-<profile>/` so the
 *    exact payload is inspectable before it is installed.
 * 3. `link` mode (default): create/replace a junction at
 *    `<profile>/node_modules/@aikanban/dsh-aikanban` → `packages/plugin`, so
 *    `pnpm run build` is picked up with no re-sync. `copy` mode: copy the
 *    staged payload, so the profile is a frozen snapshot.
 * 4. Print the exact `cordis.patch.yml` insert entry the profile needs, and the
 *    exact restart command. **It does not edit `cordis.patch.yml`** — that file
 *    belongs to the user, and the official `dsh plugin ... add` flow appends the
 *    bundle layer for you.
 *
 * ## Usage
 *
 * ```sh
 * # inspect the plan without touching anything (safe in any sandbox)
 * node tools/sync-to-profile.mjs --dry-run
 *
 * # sync into the default (desktop) profile
 * node tools/sync-to-profile.mjs
 *
 * # sync into another profile
 * node tools/sync-to-profile.mjs --profile web
 *
 * # copy instead of link (frozen snapshot)
 * node tools/sync-to-profile.mjs --mode copy
 * ```
 *
 * @module tools/sync-to-profile
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(WORKSPACE_ROOT, 'packages', 'plugin')
const PACKAGE_NAME = '@aikanban/dsh-aikanban'

/** Files that make up the installable payload, relative to the package dir. */
const PAYLOAD = ['package.json', 'README.md', 'cordis.patch.yml', 'lib', 'dist']

const HELP = `Usage: node tools/sync-to-profile.mjs [options]

Stage the built AIKanBan bundle and install it into a DSH profile. The target
lives outside this workspace, so this is the one step that may need an
escalated write.

Options:
  --profile <name>   profile under $DSH_HOME/profiles (default: desktop)
  --home <dir>       Harness home (default: $DSH_HOME, else ~/.dsh)
  --mode <m>         link (default) | copy
  --dry-run          print the resolved paths and the planned actions, touch nothing
  --help             show this help

Exit codes: 0 ok, 2 bad arguments, 3 target profile missing, 4 package not built.
`

/**
 * Parse `--flag value` / `--flag` arguments, rejecting anything unknown so a
 * typo cannot silently retarget the write.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | true>} parsed options.
 */
function parseArgs(argv) {
  const options = {}
  const booleanFlags = new Set(['dry-run', 'help'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`unexpected argument "${String(arg)}"`)
    const [flag, inline] = arg.split('=')
    const key = String(flag).slice(2)
    if (booleanFlags.has(key)) {
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
 * Resolve the value the host itself would use for the Harness home.
 *
 * Mirrors `dsh-home-paths` precedence: an explicit value, then `$DSH_HOME`,
 * then `~/.dsh`.
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
 * `resolveProfileDir` refuses `/`, `\`, `.`, `..`, `node_modules` and the empty
 * name; doing the same here keeps this script from writing somewhere the host
 * would never read.
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
 * Recursively sum bytes under a path.
 *
 * @param {string} path - the path to measure.
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

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  process.stdout.write(HELP)
  process.exit(0)
}

const profileName = validateProfileName(typeof options.profile === 'string' ? options.profile : 'desktop')
const mode = typeof options.mode === 'string' ? options.mode : 'link'
if (mode !== 'link' && mode !== 'copy') {
  process.stderr.write(`sync-to-profile: --mode must be "link" or "copy", got ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
const dryRun = options['dry-run'] === true
const home = resolveDshHome(typeof options.home === 'string' ? options.home : undefined)
const profileDir = join(home, 'profiles', profileName)
const stageDir = join(WORKSPACE_ROOT, '.probe-out-scaffold', `sync-${profileName}`)
const linkPath = join(profileDir, 'node_modules', '@aikanban', 'dsh-aikanban')

process.stdout.write('AIKanBan → DSH profile sync\n\n')
process.stdout.write(`  workspace          ${WORKSPACE_ROOT}\n`)
process.stdout.write(`  package            ${relative(WORKSPACE_ROOT, PACKAGE_DIR).replaceAll('\\', '/')}\n`)
process.stdout.write(`  harness home       ${home}${process.env['DSH_HOME'] !== undefined ? '   (from $DSH_HOME)' : ''}\n`)
process.stdout.write(`  profile            ${profileName}\n`)
process.stdout.write(`  profile dir        ${profileDir}\n`)
process.stdout.write(`  install target     ${linkPath}\n`)
process.stdout.write(`  mode               ${mode}${dryRun ? ' (dry run)' : ''}\n\n`)

if (!existsSync(join(profileDir, 'package.json'))) {
  process.stderr.write(
    `sync-to-profile: no profile manifest at ${join(profileDir, 'package.json')}\n`
    + `  Refusing to create a profile implicitly. Create it with the shipped template first, e.g.:\n`
    + `    dsh --profile ${profileName} --from-default-profile web --dump-config\n`
    + `  or point --home at the right Harness home (current: ${home}).\n`,
  )
  process.exit(3)
}

const missing = PAYLOAD.filter((entry) => !existsSync(join(PACKAGE_DIR, entry)))
const entryRel = 'lib/index.js'
if (!existsSync(join(PACKAGE_DIR, entryRel))) missing.push(entryRel)
if (missing.length > 0) {
  process.stderr.write(
    `sync-to-profile: the package is not built — missing ${missing.join(', ')}\n`
    + '  Run `pnpm run build` first.\n',
  )
  process.exit(4)
}

process.stdout.write('payload\n')
for (const entry of PAYLOAD) {
  const source = join(PACKAGE_DIR, entry)
  process.stdout.write(`  ${entry.padEnd(18)} ${humanBytes(measure(source))}\n`)
}
process.stdout.write('\n')

if (dryRun) {
  process.stdout.write('dry run: nothing was written.\n\n')
} else {
  // 1. Stage: a visible, inspectable copy of exactly what would be installed.
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, PACKAGE_NAME), { recursive: true })
  for (const entry of PAYLOAD) {
    cpSync(join(PACKAGE_DIR, entry), join(stageDir, PACKAGE_NAME, entry), { recursive: true })
  }
  process.stdout.write(`staged  ${relative(WORKSPACE_ROOT, stageDir).replaceAll('\\', '/')}\n`)

  // 2. Install.
  mkdirSync(dirname(linkPath), { recursive: true })
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) rmSync(linkPath, { force: true })
    else if (mode === 'link') {
      process.stderr.write(
        `sync-to-profile: ${linkPath} exists and is not a junction.\n`
        + '  Refusing to replace a real directory. Remove it yourself if that is what you want.\n',
      )
      process.exit(5)
    }
  }

  if (mode === 'link') {
    symlinkSync(PACKAGE_DIR, linkPath, 'junction')
    process.stdout.write(`linked  ${linkPath} → ${PACKAGE_DIR}\n`)
  } else {
    rmSync(linkPath, { recursive: true, force: true })
    mkdirSync(linkPath, { recursive: true })
    for (const entry of PAYLOAD) {
      cpSync(join(stageDir, PACKAGE_NAME, entry), join(linkPath, entry), { recursive: true })
    }
    process.stdout.write(`copied  ${humanBytes(measure(linkPath))} → ${linkPath}\n`)
  }
}

const patchEntry = `- insert:\n    - id: aikanban\n      name: '${PACKAGE_NAME}'`
process.stdout.write(`
next steps (these live outside the workspace and are the user's to run)
----------------------------------------------------------------------
1. Make the bundle a profile layer. The official flow appends it for you:

     dsh plugin --profile ${profileName} add ${isAbsolute(PACKAGE_DIR) ? PACKAGE_DIR : PACKAGE_DIR}

   It forwards to pnpm **inside the profile directory** and then appends the
   package to dsh.profile.bundles, because this package declares dsh.bundle.
   Do NOT run a bare \`pnpm install\` in a profile: for profiles/web that
   resolves the existing broken file: dependencies and can remove the working
   copies in its node_modules.

   If pnpm cannot be used for that profile, add the layer by hand instead —
   either append this to ${join(profileDir, 'cordis.patch.yml')}:

${patchEntry.split('\n').map((line) => `     ${line}`).join('\n')}

   ...or add '${PACKAGE_NAME}' to dsh.profile.bundles in
   ${join(profileDir, 'package.json')}.

2. Restart the profile's DSH process (the Electron app for profiles/desktop).
   A restart is the only way a new layer becomes active; this script never
   restarts anything, because for the live GUI that would end the user's
   session.

3. Confirm activation afterwards — either
     dsh --profile ${profileName} --dump-config | Select-String aikanban
   or, in the running app, call the tool \`aikanban_status\` (its presence in
   the tool list, and its activation id, are the observable marker), or grep
   the host log for:  [aikanban] active
`)
