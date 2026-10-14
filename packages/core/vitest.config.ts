/**
 * Package Vitest config: inherits the workspace config (so the toolchain stays
 * decided in one place) and narrows the include globs to this package, which is
 * what makes `pnpm -r run test` deterministic.
 */
import { mergeConfig } from 'vitest/config'
import rootConfig from '../../vitest.config.ts'

export default mergeConfig(rootConfig, {
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
  },
})
