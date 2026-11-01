import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Set by the global setup to this test run's id; part of every temporary folder's name. */
export const RUN_VARIABLE = 'TRADE_BLOTTER_TEST_RUN'

/** `trade-blotter-<run id>-`, so the global teardown can find the folders this run created. */
export function tempDirPrefix(): string {
  return `trade-blotter-${process.env[RUN_VARIABLE] ?? 'adhoc'}-`
}

/** A fresh directory under the OS temp folder, for databases and other per-test files. */
export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), tempDirPrefix()))
}

/**
 * Removes a temp directory. Retries because Windows can briefly keep SQLite's -wal and -shm
 * files locked after the connection is closed.
 */
export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
