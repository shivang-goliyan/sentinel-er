import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/core/test/**/*.test.ts', 'apps/console/test/**/*.test.ts'],
  },
})
