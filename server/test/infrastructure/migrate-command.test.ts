import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isolatedEnv, runNode } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/** `npm run db:migrate` runs this script; the test runs it the same way, against a temporary file. */

let dir: string

beforeEach(() => {
  dir = createTempDir()
})

afterEach(() => {
  removeTempDir(dir)
})

function runMigrate(databasePath: string) {
  const result = runNode(['src/migrate.ts'], isolatedEnv({ DATABASE_PATH: databasePath }))
  expect(result.timedOut, `db:migrate was still running at its deadline and was stopped.\n${result.stderr}`).toBe(false)
  return result
}

function tables(databasePath: string): unknown[] {
  const db = new DatabaseSync(databasePath)
  try {
    return db.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all()
  } finally {
    db.close()
  }
}

describe('infrastructure: the db:migrate command', () => {
  it('creates the database file and its folder, then reports success', () => {
    const path = join(dir, 'nested', 'folder', 'trade-blotter.db')

    const result = runMigrate(path)

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Database is up to date: ${path}`)
    expect(tables(path)).toEqual([{ name: '__drizzle_migrations' }, { name: 'trades' }])
  })

  it('succeeds again when nothing is pending', () => {
    const path = join(dir, 'trade-blotter.db')

    expect(runMigrate(path).status).toBe(0)
    expect(runMigrate(path).status).toBe(0)
    expect(tables(path)).toEqual([{ name: '__drizzle_migrations' }, { name: 'trades' }])
  })

  it('exits with an error and leaves the database alone when a migration fails', () => {
    const path = join(dir, 'other.db')
    const existing = new DatabaseSync(path)
    existing.exec(`create table trades (note text); insert into trades values ('keep me')`)
    existing.close()

    const result = runMigrate(path)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Database migration failed; no migration was applied.')
    const check = new DatabaseSync(path)
    expect(check.prepare('select note from trades').all()).toEqual([{ note: 'keep me' }])
    check.close()
  })
})
