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
      'trades_price_order',
      'trades_quantity_order',
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

describe('infrastructure: upgrading a populated database to the exact decimal sort keys', () => {
  const V2_COLUMNS = 'booking_sequence, id, symbol, side, quantity, price, executed_at, created_at, updated_at'

  /** A database as the first release left it: only the first migration, applied by the same migrator. */
  function firstReleaseDatabase() {
    const [first] = readdirSync(MIGRATIONS_FOLDER).sort()
    if (first === undefined) throw new Error('No migrations.')
    const folder = join(createTempDir(), 'drizzle')
    tempDirs.push(join(folder, '..'))
    cpSync(join(MIGRATIONS_FOLDER, first), join(folder, first), { recursive: true })
    const db = database.openUnmigrated()
    applyMigrations(db, folder)
    // Rows written directly, so the history does not depend on today's repository.
    const insert = db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    const values = ['10', '9.5', '0.0000000001', '999999999999999.9999999999', '123456789012345.1234567891', '123456789012345.123456789', '1', '100.25']
    values.forEach((value, index) => {
      insert.run(`v2-${String(index)}`, ['MSFT', 'ÉCOLE', 'BRK.B', '株式'][index % 4] ?? 'A', index % 2 === 0 ? 'Buy' : 'Sell', value,
        values[values.length - 1 - index] ?? '1', `2026-03-0${String(1 + (index % 3))}T09:00:00.000Z`)
    })
    // A deleted trade leaves the booking sequence's high-water mark above every stored row.
    db.$client.exec(`delete from trades where id = 'v2-7'`)
    return db
  }

  const snapshot = (db: ReturnType<typeof database.openUnmigrated>) => ({
    rows: db.$client.prepare(`select ${V2_COLUMNS} from trades order by booking_sequence`).all(),
    sequence: rawRows(db, 'sqlite_sequence'),
    objects: schemaObjects(db).filter((object) => (object as { name: string }).name !== '__drizzle_migrations'),
  })

  it('keeps every row, decimal, index and the booking sequence, and adds only the keys and their indexes', () => {
    const db = firstReleaseDatabase()
    const before = snapshot(db)
    expect(names(before.objects)).toEqual(['trades_symbol_trade_order', 'trades_trade_order', 'trades'])

    applyMigrations(db)

    const after = snapshot(db)
    expect(after.rows).toEqual(before.rows)
    expect(after.sequence).toEqual(before.sequence)
    expect(after.sequence).toEqual([{ name: 'trades', seq: 8 }])
    expect(names(after.objects)).toEqual(['trades_price_order', 'trades_quantity_order', 'trades_symbol_trade_order', 'trades_trade_order', 'trades'])
    // The existing indexes are exactly as they were.
    for (const object of before.objects.filter((item) => (item as { type: string }).type === 'index')) expect(after.objects).toContainEqual(object)
    expect(db.$client.prepare('pragma integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(rawRows(db, '__drizzle_migrations')).toHaveLength(readdirSync(MIGRATIONS_FOLDER).length)
  })

  it('computes the keys for the rows already stored, and lists and books through the upgraded table', async () => {
    const db = firstReleaseDatabase()
    applyMigrations(db)
    const repository = createDrizzleTradeRepository(db)

    const byQuantity = await repository.list({ filter: {}, sort: { field: 'quantity', direction: 'asc' } })
    expect(byQuantity.map((trade) => trade.quantity.toFixed()))
      .toEqual(['0.0000000001', '1', '9.5', '10', '123456789012345.123456789', '123456789012345.1234567891', '999999999999999.9999999999'])
    const page = await repository.listPage({ filter: {}, sort: { field: 'price', direction: 'desc' } }, { page: 2, pageSize: 3 })
    expect(page.totalCount).toBe(7)
    expect(page.trades.map((trade) => trade.price.toFixed())).toEqual(['100.25', '9.5', '1'])
    expect((await repository.add(newTrade({ id: 'after-upgrade' }))).bookingSequence).toBe(9)
  })
})
