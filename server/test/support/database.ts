import { join } from 'node:path'

import { closeDatabase, openDatabase, type Database } from '../../src/infrastructure/database/connection.ts'
import { applyMigrations } from '../../src/infrastructure/database/migrate.ts'
import { createTempDir, removeTempDir } from './temp-dir.ts'

/**
 * A database file in its own temporary folder. `open()` connects and applies migrations, as the
 * server will at startup; `reopen()` closes every connection first, like a restart. `dispose()`
 * closes everything and removes the folder.
 */
export function createTestDatabase() {
  const dir = createTempDir()
  const path = join(dir, 'trade-blotter.db')
  const connections: Database[] = []

  const connect = (migrate: boolean): Database => {
    const db = openDatabase(path)
    connections.push(db)
    if (migrate) applyMigrations(db)
    return db
  }

  return {
    path,
    /** Opens a connection and applies migrations. */
    open: (): Database => connect(true),
    /** Opens a connection without applying migrations. */
    openUnmigrated: (): Database => connect(false),
    /** Closes every open connection, then opens and migrates a new one. */
    reopen(): Database {
      for (const db of connections) closeDatabase(db)
      return connect(true)
    },
    dispose(): void {
      for (const db of connections) closeDatabase(db)
      removeTempDir(dir)
    },
  }
}

/** Every row of a table, in rowid order, exactly as SQLite stores it. */
export function rawRows(db: Database, table = 'trades'): unknown[] {
  return db.$client.prepare(`select * from "${table}" order by rowid`).all()
}

/** Names of the tables, indexes and other objects in the schema, with their SQL. */
export function schemaObjects(db: Database): unknown[] {
  return db.$client.prepare(`select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`).all()
}
