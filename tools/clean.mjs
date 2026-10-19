#!/usr/bin/env node
/**
 * Remove every generated artifact in the workspace.
 *
 * Only paths this repository creates are touched, each one resolved and checked
 * to live under the workspace root before deletion — a build script that can
 * `rm -rf` an arbitrary path is not worth having.
 *
 * ```sh
 * node tools/clean.mjs [--keep-probe-home]
 * ```
 *
 * @module tools/clean
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Package directories that own a `lib/` and a `dist/` output. */
const PACKAGE_DIRS = ['packages/core', 'packages/plugin', 'packages/plugin-client']

/** Workspace-relative artifact paths, in deletion order. */
const ARTIFACTS = [
  ...PACKAGE_DIRS.flatMap((dir) => [`${dir}/lib`, `${dir}/dist`, `${dir}/coverage`]),
  'node_modules/.cache',
]

/**
 * Assert a path is inside the workspace before removing it.
 *
 * @param {string} absolute - the candidate path.
 * @returns {string} the same path, once proven safe.
 */
function assertInsideWorkspace(absolute) {
  const rel = relative(WORKSPACE_ROOT, absolute)
  if (rel.startsWith('..') || resolve(WORKSPACE_ROOT, rel) !== absolute) {
    throw new Error(`refusing to delete outside the workspace: ${absolute}`)
  }
  return absolute
}

/**
 * Recursively sum the bytes under a path (best effort; symlinks are skipped).
 *
 * @param {string} path - the path to measure.
 * @returns {number} total bytes.
 */
function measure(path) {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += measure(child)
    else if (entry.isFile()) total += statSync(child).size
  }
  return total
}

/**
 * Format a byte count for the report.
 *
 * @param {number} bytes - the size.
 * @returns {string} a short human string.
 */
function humanBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const argv = process.argv.slice(2)
const keepProbeHome = argv.includes('--keep-probe-home')
const unknown = argv.filter((arg) => arg !== '--keep-probe-home')
if (unknown.length > 0) {
  process.stderr.write(`clean: unexpected argument(s): ${unknown.join(' ')}\n`)
  process.exit(2)
}

let removed = 0
const targets = [...ARTIFACTS]
if (!keepProbeHome) targets.push('.probe-home-scaffold', '.probe-out-scaffold', '.probe-home', '.probe-out')
for (const target of targets) {
  const absolute = assertInsideWorkspace(resolve(WORKSPACE_ROOT, target))
  if (!existsSync(absolute)) continue
  const bytes = statSync(absolute).isDirectory() ? measure(absolute) : statSync(absolute).size
  rmSync(absolute, { recursive: true, force: true })
  removed += 1
  process.stdout.write(`removed ${relative(WORKSPACE_ROOT, absolute).replaceAll('\\', '/')} (${humanBytes(bytes)})\n`)
}

process.stdout.write(removed === 0 ? 'nothing to clean\n' : `cleaned ${String(removed)} path(s)\n`)
