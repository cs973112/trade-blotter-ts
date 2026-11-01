import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * S1: node:sqlite works inside Vitest's forked workers, against a real file database, with the
 * features the persistence layer relies on beneath the ORM: WAL journaling, exact TEXT
 * round-trips for decimals and timestamps, and ordering by fixed-width UTC timestamp text
 * (millisecond precision), which sorts chronologically.
 */
describe('platform: node:sqlite', () => {
  let dir: string
  let db: DatabaseSync | undefined

  beforeEach(() => {
    dir = createTempDir()
  })

  afterEach(() => {
    if (db?.isOpen) db.close()
    removeTempDir(dir)
  })

  it('opens a file database in WAL mode with a STRICT table and round-trips exact text', () => {
    const path = join(dir, 'platform.db')
    db = new DatabaseSync(path)

    const version = db.prepare('select sqlite_version() as version').get() as { version: string }
    const [major = 0, minor = 0] = version.version.split('.').map(Number)
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(3037) // STRICT tables need 3.37

    const mode = db.prepare('pragma journal_mode = wal').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')

    db.exec(`
      create table trades (
        id text primary key not null,
        quantity text not null,
        executed_at text not null
      ) strict
    `)

    const insert = db.prepare('insert into trades (id, quantity, executed_at) values (?, ?, ?)')
    insert.run('b', '0.0000000001', '2026-01-01T09:00:00.000Z')
    insert.run('a', '999999999999999.9999999999', '2026-01-01T09:00:00.000Z')
    insert.run('c', '123456789012345.1234567891', '2026-01-01T08:59:59.999Z')

    const rows = db.prepare('select id, quantity, executed_at from trades order by executed_at, id').all()

    expect(rows).toEqual([
      { id: 'c', quantity: '123456789012345.1234567891', executed_at: '2026-01-01T08:59:59.999Z' },
      { id: 'a', quantity: '999999999999999.9999999999', executed_at: '2026-01-01T09:00:00.000Z' },
      { id: 'b', quantity: '0.0000000001', executed_at: '2026-01-01T09:00:00.000Z' },
    ])
    expect(existsSync(`${path}-wal`)).toBe(true)
  })

  it('persists across connections and leaves no files behind once closed and removed', () => {
    const path = join(dir, 'durable.db')
    db = new DatabaseSync(path)
    db.exec('pragma journal_mode = wal; create table t (v text not null) strict')
    db.prepare('insert into t (v) values (?)').run('kept')
    db.close()

    db = new DatabaseSync(path)
    expect(db.prepare('select v from t').all()).toEqual([{ v: 'kept' }])
    db.close()

    removeTempDir(dir)
    expect(existsSync(dir)).toBe(false)
    dir = createTempDir()
    expect(readdirSync(dir)).toEqual([])
  })
})
