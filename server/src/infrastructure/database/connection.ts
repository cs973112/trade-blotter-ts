import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { drizzle } from 'drizzle-orm/node-sqlite'

/** A Drizzle database on one node:sqlite connection. */
export type Database = ReturnType<typeof openDatabase>

/**
 * Opens (or creates) the SQLite database file, creating its folder if needed, and configures the
 * connection. An existing file is opened as it is: never deleted, truncated or recreated.
 */
export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const client = new DatabaseSync(path)
  try {
    // Wait up to 5 s for another connection's write lock instead of failing at once.
    client.exec('pragma busy_timeout = 5000')
    // Readers do not block the writer, and the writer does not block readers.
    client.exec('pragma journal_mode = wal')
    client.exec('pragma foreign_keys = on')
  } catch (error) {
    client.close()
    throw error
  }
  return drizzle({ client })
}

export function closeDatabase(db: Database): void {
  if (db.$client.isOpen) db.$client.close()
}
