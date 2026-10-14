/**
 * Browser-half UI Vitest config.
 *
 * `root` is pinned to this package so the include globs are package relative,
 * while defaults are inherited from the workspace root config.
 */
import { defineConfig, mergeConfig } from 'vitest/config'

import rootConfig from '../../vitest.config.js'

export default mergeConfig(rootConfig, defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
}))
