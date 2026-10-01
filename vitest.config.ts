import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Electron APIs are mocked in tests; see tests/mocks/electron.ts
    alias: { electron: resolve(__dirname, 'tests/mocks/electron.ts') },
  },
})
