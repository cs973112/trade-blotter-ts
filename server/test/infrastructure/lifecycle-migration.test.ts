import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '../../src/infrastructure/database/connection.ts'
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/infrastructure/database/migrate.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase, rawRows, schemaObjects } from '../support/database.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'
import { newTrade } from '../support/trades.ts'

/**
 * The trade lifecycle and audit migration (server/drizzle/*_trade_lifecycle_audit) on databases as
 * the previous release left them: only the first two migrations, with representative trades
 * written directly in SQL. Every database is a temporary file; none of the developer's is opened.
 */

let database: ReturnType<typeof createTestDatabase>
const tempDirs: string[] = []

beforeEach(() => {
  database = createTestDatabase()
})

afterEach(() => {
  database.dispose()
  for (const dir of tempDirs.splice(0)) removeTempDir(dir)
})

const LIFECYCLE = readdirSync(MIGRATIONS_FOLDER).sort().find((name) => name.endsWith('_trade_lifecycle_audit'))
const LEGACY_COLUMNS = 'booking_sequence, id, symbol, side, quantity, price, executed_at, created_at, updated_at'
const TRIGGERS = ['trade_audit_no_delete', 'trade_audit_no_update', 'trades_audit_delete', 'trades_audit_insert', 'trades_audit_update']

/** The migrations before the lifecycle migration, alone, and optionally a changed copy of it (and nothing after it). */
function migrationsFolder(options: { readonly withLifecycle?: (sql: string) => string } = {}): string {
  const folder = join(createTempDir(), 'drizzle')
  tempDirs.push(join(folder, '..'))
  // Only the migrations up to the lifecycle migration: later ones (such as the Executed-trade indexes) need its columns.
  for (const name of readdirSync(MIGRATIONS_FOLDER).sort().filter((candidate) => LIFECYCLE === undefined || candidate <= LIFECYCLE)) {
    if (name === LIFECYCLE && options.withLifecycle === undefined) continue
    cpSync(join(MIGRATIONS_FOLDER, name), join(folder, name), { recursive: true })
    if (name === LIFECYCLE && options.withLifecycle !== undefined) {
      const path = join(folder, name, 'migration.sql')
      writeFileSync(path, options.withLifecycle(readFileSync(path, 'utf8')))
    }
  }
  return folder
}

/** A database as the previous release left it, with trades written directly, and the last one deleted. */
function legacyDatabase(): Database {
  const db = database.openUnmigrated()
  applyMigrations(db, migrationsFolder())
  const insert = db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
  const rows: [string, string, string, string, string, string, string, string][] = [
    ['a-1', 'MSFT', 'Buy', '100', '301.25', '2026-01-02T14:30:00.000Z', '2026-01-02T14:30:01.000Z', '2026-01-02T14:30:01.000Z'],
    ['a-2', 'ÉCOLE', 'Sell', '0.0000000001', '999999999999999.9999999999', '2025-12-31T23:59:59.999Z', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'],
    ['a-3', '株式', 'Buy', '123456789012345.1234567891', '0.5', '0001-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
    ['a-4', 'BRK.B', 'Sell', '2.75', '3547.55', '2026-01-02T14:30:00.000Z', '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z'],
    ['a-5', 'ZZ', 'Buy', '1', '1', '9999-12-31T23:59:59.999Z', '2026-01-07T00:00:00.000Z', '2026-01-07T00:00:00.000Z'],
  ]
  for (const row of rows) insert.run(...row)
  // A deleted trade leaves the high-water mark above every stored booking sequence.
  db.$client.exec(`delete from trades where id = 'a-5'`)
  return db
}

const objects = (db: Database, type: string) => (schemaObjects(db) as { type: string; name: string; sql: string | null }[]).filter((object) => object.type === type)

describe('infrastructure: the trade lifecycle migration on an existing database', () => {
  it('keeps every trade, id, booking sequence, economic value and timestamp, as an Executed trade by User', () => {
    const db = legacyDatabase()
    const before = db.$client.prepare(`select ${LEGACY_COLUMNS}, quantity_key, price_key from trades order by booking_sequence`).all()

    applyMigrations(db)

    expect(db.$client.prepare(`select ${LEGACY_COLUMNS}, quantity_key, price_key from trades order by booking_sequence`).all()).toEqual(before)
    expect(db.$client.prepare(`select id, status, created_by, updated_by, original_trade_id, cancellation_reason from trades order by booking_sequence`).all()).toEqual(
      ['a-1', 'a-2', 'a-3', 'a-4'].map((id) => ({ id, status: 'Executed', created_by: 'User', updated_by: 'User', original_trade_id: null, cancellation_reason: null })))
    expect(before.map((row) => (row as { booking_sequence: number }).booking_sequence)).toEqual([1, 2, 3, 4])
  })

  it('keeps the booking sequence\'s high-water mark, so a deleted trade\'s sequence is never reused', async () => {
    const db = legacyDatabase()
    expect(rawRows(db, 'sqlite_sequence')).toEqual([{ name: 'trades', seq: 5 }])

    applyMigrations(db)

    expect(rawRows(db, 'sqlite_sequence')).toEqual([{ name: 'trades', seq: 5 }])
    expect((await createDrizzleTradeRepository(db).add(newTrade({ id: 'after' }))).bookingSequence).toBe(6)
  })

  it('keeps the high-water mark of a table whose every trade was deleted', async () => {
    const db = legacyDatabase()
    db.$client.exec('delete from trades')

    applyMigrations(db)

    expect(rawRows(db)).toEqual([])
    expect((await createDrizzleTradeRepository(db).add(newTrade({ id: 'first-again' }))).bookingSequence).toBe(6)
  })

  it('invents no audit history: the copied trades have no audit entries', () => {
    const db = legacyDatabase()

    applyMigrations(db)

    expect(rawRows(db, 'trade_audit')).toEqual([])
  })

  it('keeps every existing index exactly as it was, and adds the cancellation index and the audit objects', () => {
    const db = legacyDatabase()
    const before = objects(db, 'index')

    applyMigrations(db)

    const after = objects(db, 'index')
    for (const index of before) expect(after).toContainEqual(index)
    // Every migration is applied: the lifecycle migration's indexes, and the later partial indexes (Executed and logical trades).
    const partial = ['trades_executed_price_order', 'trades_executed_quantity_order', 'trades_executed_symbol_trade_order', 'trades_executed_trade_order',
      'trades_logical_price_order', 'trades_logical_quantity_order', 'trades_logical_symbol_trade_order', 'trades_logical_trade_order']
    expect(after.map((index) => index.name)).toEqual(['trade_audit_trade', 'trades_original_trade_id', ...partial, ...before.map((index) => index.name)].sort())
    // Created over every row by the lifecycle migration, made partial by a later one (M4).
    expect(after.find((index) => index.name === 'trades_original_trade_id')?.sql)
      .toBe('CREATE UNIQUE INDEX `trades_original_trade_id` ON `trades` (`original_trade_id`) WHERE "trades"."original_trade_id" is not null')
    expect(objects(db, 'trigger').map((trigger) => trigger.name)).toEqual(TRIGGERS)
  })

  it('keeps every existing constraint, adds the lifecycle ones and the foreign key, and leaves a consistent database', () => {
    const db = legacyDatabase()
    const before = objects(db, 'table').find((table) => table.name === 'trades')?.sql ?? ''

    applyMigrations(db)

    const after = objects(db, 'table').find((table) => table.name === 'trades')?.sql ?? ''
    for (const name of ['trades_id', 'trades_symbol', 'trades_side', 'trades_quantity', 'trades_price', 'trades_created_at', 'trades_updated_at']) {
      // The same text, constraint by constraint.
      const of = (sql: string) => new RegExp(`CONSTRAINT "${name}" CHECK\\([\\s\\S]*?\\)(?=,\\n|\\n\\))`).exec(sql)?.[0]
      expect(of(after), name).toBe(of(before))
    }
    for (const name of ['trades_executed_at', 'trades_status', 'trades_actors', 'trades_cancellation']) expect(after, name).toContain(`CONSTRAINT "${name}" CHECK`)
    expect(after).toContain('FOREIGN KEY (`original_trade_id`) REFERENCES `trades`(`id`)')
    expect(db.$client.prepare('pragma foreign_key_list(trades)').all()).toMatchObject([{ table: 'trades', from: 'original_trade_id', to: 'id' }])
    expect(db.$client.prepare('pragma foreign_key_check').all()).toEqual([])
    expect(db.$client.prepare('pragma integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.$client.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('lists, pages and books through the migrated table exactly as before', async () => {
    const db = legacyDatabase()
    applyMigrations(db)
    const repository = createDrizzleTradeRepository(db)

    expect((await repository.listInTradeOrder()).map((trade) => trade.id)).toEqual(['a-3', 'a-2', 'a-1', 'a-4'])
    expect((await repository.listPage({ filter: {}, sort: { field: 'price', direction: 'desc' } }, { page: 1, pageSize: 2 })).trades.map((trade) => trade.id)).toEqual(['a-2', 'a-4'])
  })
})

describe('infrastructure: the trade lifecycle migration fails as a whole', () => {
  it('rolls back every step when one fails, leaving the previous schema, the trades and the sequence as they were', () => {
    const db = legacyDatabase()
    const trades = rawRows(db)
    const sequence = rawRows(db, 'sqlite_sequence')
    const schema = schemaObjects(db)
    const applied = rawRows(db, '__drizzle_migrations')
    // A failure after the table has been rebuilt and the triggers created.
    const broken = migrationsFolder({ withLifecycle: (sql) => `${sql}\n--> statement-breakpoint\ninsert into missing_table values (1);\n` })

    expect(() => { applyMigrations(db, broken) }).toThrow(/no such table: missing_table/)

    expect(rawRows(db)).toEqual(trades)
    expect(rawRows(db, 'sqlite_sequence')).toEqual(sequence)
    expect(schemaObjects(db)).toEqual(schema)
    expect(rawRows(db, '__drizzle_migrations')).toEqual(applied)
    expect(objects(db, 'table').map((table) => table.name)).not.toContain('trade_audit')
  })

  it('refuses a legacy row the new constraints cannot hold, and changes nothing', () => {
    const db = legacyDatabase()
    const trades = rawRows(db)
    // A row the old schema allowed but the lifecycle migration refuses: here, a migration that copies one with no execution time.
    const broken = migrationsFolder({ withLifecycle: (sql) => sql.replace("SELECT `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`,", "SELECT `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, NULL,") })

    expect(() => { applyMigrations(db, broken) }).toThrow(/CHECK constraint failed: trades_executed_at/)
    expect(rawRows(db)).toEqual(trades)
  })
})

describe('infrastructure: initialising a migrated database again', () => {
  it('duplicates no data, audit entry, trigger or migration', async () => {
    const db = database.open()
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'once' }))
    const state = () => ({ trades: rawRows(db), audit: rawRows(db, 'trade_audit'), schema: schemaObjects(db), applied: rawRows(db, '__drizzle_migrations') })
    const before = state()

    applyMigrations(db)
    applyMigrations(db)
    expect(state()).toEqual(before)
    const reopened = database.reopen()

    expect(rawRows(reopened, 'trade_audit')).toHaveLength(1)
    expect(objects(reopened, 'trigger').map((trigger) => trigger.name)).toEqual(TRIGGERS)
  })
})
