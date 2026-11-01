import { defineConfig } from 'vitest/config'

// Each test file runs in its own forked Node process so node:sqlite, process-level state and
// temporary databases never leak between files.
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    execArgv: ['--disable-warning=ExperimentalWarning'],
    include: ['test/**/*.test.ts'],
    // Names this run's temporary folders and fails the run if any are left behind.
    globalSetup: ['test/support/global-setup.ts'],
  },
})
