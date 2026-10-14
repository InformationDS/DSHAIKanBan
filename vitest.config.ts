/**
 * Root Vitest config.
 *
 * Package-level configs inherit this file (`mergeConfig`) so include globs stay
 * relative to each package, but a single root config keeps `pnpm -r run test`
 * deterministic and lets the source-only loader test run from anywhere.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node's own test reporter noise is off; failures must be loud.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The loader test imports a *built* artifact; a stale lib/ must fail, not
    // silently pass against yesterday's bundle.
    reporters: ['default'],
    // Hermetic: no network, no DSH host, no writes outside the workspace.
    clearMocks: true,
    restoreMocks: true,
  },
})
