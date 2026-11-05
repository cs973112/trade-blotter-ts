import { defineConfig } from 'vitest/config'

// Each test file runs in its own forked Node process so node:sqlite, process-level state and
// temporary databases never leak between files.
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    execArgv: ['--disable-warning=ExperimentalWarning'],
    // Names this run's temporary folders and fails the run if any are left behind.
    globalSetup: ['test/support/global-setup.ts'],
    // The tool tests (test/scripts) start background applications, PowerShell and large seeds,
    // which load every core. They run after the rest, so tests that hold a child process to a
    // deadline (platform/compiled-server, api/startup) never compete with them for the CPU.
    projects: [
      { extends: true, test: { name: 'app', include: ['test/**/*.test.ts'], exclude: ['test/scripts/**'], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'scripts', include: ['test/scripts/**/*.test.ts'], sequence: { groupOrder: 1 } } },
    ],
  },
})
