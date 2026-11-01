import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/infrastructure/database/migrate.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase, rawRows, schemaObjects } from '../support/database.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'
import { newTrade } from '../support/trades.ts'

let database: ReturnType<typeof createTestDatabase>
const tempDirs: string[] = []

beforeEach(() => {
  database = createTestDatabase()
})

afterEach(() => {
  database.dispose()
  for (const dir of tempDirs.splice(0)) removeTempDir(dir)
})

const names = (objects: unknown[]): string[] => objects.map((object) => (object as { name: string }).name)

describe('infrastructure: migrations', () => {
  it('ships its migrations in server/drizzle, one folder per migration', () => {
    const folders = readdirSync(MIGRATIONS_FOLDER)

    expect(folders.length).toBeGreaterThan(0)
    for (const folder of folders) {
      expect(folder).toMatch(/^\d{14}_[a-z0-9_]+$/)
      expect(existsSync(join(MIGRATIONS_FOLDER, folder, 'migration.sql'))).toBe(true)
    }
  })

  it('creates the schema in an empty database', () => {
    const db = database.openUnmigrated()
    expect(schemaObjects(db)).toEqual([])

    applyMigrations(db)

    expect(names(schemaObjects(db))).toEqual([
      'trades_symbol_trade_order',
      'trades_trade_order',
      '__drizzle_migrations',
      'trades',
    ])
    expect(rawRows(db, '__drizzle_migrations')).toHaveLength(readdirSync(MIGRATIONS_FOLDER).length)
  })

  it('changes nothing when the migrations are applied again', async () => {
    const db = database.open()
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'kept' }))
    const schema = schemaObjects(db)
    const applied = rawRows(db, '__drizzle_migrations')
    const trades = rawRows(db)

    applyMigrations(db)
    applyMigrations(db)

    expect(schemaObjects(db)).toEqual(schema)
    expect(rawRows(db, '__drizzle_migrations')).toEqual(applied)
    expect(rawRows(db)).toEqual(trades)
  })

  it('keeps existing data when the server restarts and migrates again', async () => {
    await createDrizzleTradeRepository(database.open()).add(newTrade({ id: 'persisted', quantity: '0.3' }))

    const reopened = database.reopen()

    expect((await createDrizzleTradeRepository(reopened).listInTradeOrder()).map((trade) => trade.id)).toEqual(['persisted'])
  })

  it('fails clearly, and leaves an existing database untouched, when a migration cannot be applied', () => {
    const db = database.openUnmigrated()
    // A database that already holds an unrelated trades table.
    db.$client.exec(`create table trades (note text); insert into trades values ('keep me')`)

    expect(() => {
      applyMigrations(db)
    }).toThrow(/^Database migration failed; no migration was applied\. table `trades` already exists$/)
    expect(rawRows(db)).toEqual([{ note: 'keep me' }])
    expect(rawRows(db, '__drizzle_migrations')).toEqual([])
  })

  it('applies pending migrations all or nothing', () => {
    const folder = join(createTempDir(), 'drizzle')
    tempDirs.push(join(folder, '..'))
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
    mkdirSync(join(folder, '29991231000000_broken'))
    writeFileSync(join(folder, '29991231000000_broken', 'migration.sql'), 'insert into missing_table values (1);')
    const db = database.openUnmigrated()

    expect(() => {
      applyMigrations(db, folder)
    }).toThrow(/no such table: missing_table/)
    // The valid first migration was rolled back with the broken one.
    expect(names(schemaObjects(db))).toEqual(['__drizzle_migrations'])
    expect(rawRows(db, '__drizzle_migrations')).toEqual([])
  })
})
