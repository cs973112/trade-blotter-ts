import { cpSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toUtcTimestamp } from '../../src/domain/timestamp.ts'
import { validateTradePageQuery, validateTradeQuery } from '../../src/domain/trade-query.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/infrastructure/database/migrate.ts'
import { createDrizzleLifecycleRepository } from '../../src/infrastructure/drizzle-lifecycle-repository.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase, rawRows, schemaObjects } from '../support/database.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'
import { newTrade } from '../support/trades.ts'

/**
 * The partial indexes (server/drizzle/*_executed_trade_indexes, *_cancellation_unique_index,
 * *_logical_trade_indexes): on Executed trades, which keep the existing API's reads as fast as
 * before the lifecycle columns; on logical trades, which the trade lists read; and the unique index
 * on original_trade_id, holding only cancellation rows. The migrations on a database already
 * upgraded through M3, and the query plans of the repositories' own SQL, recorded as it runs.
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

const PARTIAL = ['trades_executed_price_order', 'trades_executed_quantity_order', 'trades_executed_symbol_trade_order', 'trades_executed_trade_order']
const LOGICAL = ['trades_logical_price_order', 'trades_logical_quantity_order', 'trades_logical_symbol_trade_order', 'trades_logical_trade_order']
const UNIQUE_BEFORE = 'CREATE UNIQUE INDEX `trades_original_trade_id` ON `trades` (`original_trade_id`)'
const UNIQUE_AFTER = `${UNIQUE_BEFORE} WHERE "trades"."original_trade_id" is not null`
const NOW = '2026-03-01T10:00:00.000Z'
const indexes = (db: Database) => (schemaObjects(db) as { type: string; name: string; sql: string }[]).filter((object) => object.type === 'index')

/** A connection to a database migrated through the named migration only. */
function migratedThrough(suffix: string): Database {
  const folder = join(createTempDir(), 'drizzle')
  tempDirs.push(join(folder, '..'))
  const names = readdirSync(MIGRATIONS_FOLDER).sort()
  const through = names.findIndex((name) => name.endsWith(suffix))
  for (const name of names.slice(0, through + 1)) cpSync(join(MIGRATIONS_FOLDER, name), join(folder, name), { recursive: true })
  const db = database.openUnmigrated()
  applyMigrations(db, folder)
  return db
}

/** Executed, Pending and cancelled trades with their cancellation rows, through the repositories. */
async function lifecycleRows(db: Database, prefix: string): Promise<void> {
  const repository = createDrizzleTradeRepository(db)
  for (let n = 0; n < 5; n++) await repository.add(newTrade({ id: `${prefix}-${String(n)}`, quantity: String(n + 1) }))
  const lifecycle = createDrizzleLifecycleRepository(db)
  for (let n = 0; n < 4; n++) {
    await lifecycle.book({ ...newTrade({ id: `${prefix}-p${String(n)}` }), status: 'Pending', executedAt: null, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null })
  }
  for (const n of [0, 2]) {
    const result = await lifecycle.cancel(`${prefix}-p${String(n)}`, { reason: 'Booked in error' }, { id: `${prefix}-c${String(n)}`, now: toUtcTimestamp(new Date(NOW)) })
    if (!result.ok) throw new Error(result.message)
  }
}

describe('infrastructure: the partial-index migrations', () => {
  it('add the Executed and logical partial indexes and make the cancellation index partial, on a database upgraded through M3, changing no row', async () => {
    const db = migratedThrough('_trade_lifecycle_audit')
    await lifecycleRows(db, 'm3')
    db.$client.exec(`update trades set updated_at = '2026-02-01T00:00:00.000Z' where id = 'm3-0'`)
    const before = { trades: rawRows(db), audit: rawRows(db, 'trade_audit'), sequence: rawRows(db, 'sqlite_sequence'), indexes: indexes(db) }
    expect(before.indexes.find((index) => index.name === 'trades_original_trade_id')?.sql).toBe(UNIQUE_BEFORE)

    applyMigrations(db)

    expect(rawRows(db)).toEqual(before.trades)
    expect(rawRows(db, 'trade_audit')).toEqual(before.audit)
    expect(rawRows(db, 'sqlite_sequence')).toEqual(before.sequence)
    const after = indexes(db)
    // Every other index exactly as it was; the cancellation index replaced, under its own name.
    for (const index of before.indexes.filter((item) => item.name !== 'trades_original_trade_id')) expect(after).toContainEqual(index)
    expect(after.find((index) => index.name === 'trades_original_trade_id')?.sql).toBe(UNIQUE_AFTER)
    expect(after.map((index) => index.name).filter((name) => !before.indexes.some((index) => index.name === name))).toEqual([...PARTIAL, ...LOGICAL])
    for (const index of after.filter((item) => PARTIAL.includes(item.name))) expect(index.sql).toMatch(/ WHERE "trades"\."status" = 'Executed'$/)
    for (const index of after.filter((item) => LOGICAL.includes(item.name))) expect(index.sql).toMatch(/ WHERE "trades"\."original_trade_id" is null$/)
    expect(db.$client.prepare(`select count(*) as n from sqlite_master where type = 'trigger'`).get()).toEqual({ n: 5 })
    expect(db.$client.prepare('pragma integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.$client.prepare('pragma foreign_key_check').all()).toEqual([])

    applyMigrations(db)
    expect({ trades: rawRows(db), audit: rawRows(db, 'trade_audit'), indexes: indexes(db) }).toEqual({ trades: before.trades, audit: before.audit, indexes: after })
  })

  it('add only the four logical-trade indexes to a database with the partial cancellation index, changing no row, constraint or trigger', async () => {
    const db = migratedThrough('_cancellation_unique_index')
    await lifecycleRows(db, 'm4')
    const tables = () => db.$client.prepare(`select name, sql from sqlite_master where type in ('table', 'trigger') order by name`).all()
    const before = { trades: rawRows(db), audit: rawRows(db, 'trade_audit'), sequence: rawRows(db, 'sqlite_sequence'), indexes: indexes(db), tables: tables() }
    expect(before.indexes.find((index) => index.name === 'trades_original_trade_id')?.sql).toBe(UNIQUE_AFTER)

    applyMigrations(db)

    expect(rawRows(db)).toEqual(before.trades)
    expect(rawRows(db, 'trade_audit')).toEqual(before.audit)
    expect(rawRows(db, 'sqlite_sequence')).toEqual(before.sequence)
    // Tables (with their CHECK and foreign key constraints) and triggers exactly as they were: no rebuild.
    expect(tables()).toEqual(before.tables)
    const after = indexes(db)
    for (const index of before.indexes) expect(after).toContainEqual(index)
    const added = after.filter((index) => !before.indexes.some((item) => item.name === index.name))
    expect(added.map((index) => index.name)).toEqual(LOGICAL)
    for (const index of added) expect(index.sql).toMatch(/^CREATE INDEX `trades_logical_\w+` ON `trades` \([^)]+\) WHERE "trades"\."original_trade_id" is null$/)
    expect(db.$client.prepare('pragma integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.$client.prepare('pragma foreign_key_check').all()).toEqual([])
    // Each holds exactly the logical trades: every row but the two cancellation rows.
    for (const name of LOGICAL) {
      expect(db.$client.prepare(`select count(*) as n from trades indexed by ${name} where original_trade_id is null`).get()).toEqual({ n: 9 })
    }

    applyMigrations(db)
    expect({ trades: rawRows(db), audit: rawRows(db, 'trade_audit'), indexes: indexes(db), tables: tables() }).toEqual({ trades: before.trades, audit: before.audit, indexes: after, tables: before.tables })
  })

  it('still allows one cancellation row per original trade, and the foreign key still protects the original, after the migration', async () => {
    const db = migratedThrough('_trade_lifecycle_audit')
    await lifecycleRows(db, 'm3')
    applyMigrations(db)
    const audit = rawRows(db, 'trade_audit')

    // A second cancellation row for a cancelled trade, and the first for another trade (p1 is Pending).
    const second = (id: string, original: string) => () => db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by, original_trade_id, cancellation_reason)
      values (?, 'AAPL', 'Buy', '1', '1', null, ?, ?, 'Cancelled', 'Admin', 'Admin', ?, 'again')`).run(id, NOW, NOW, original)
    expect(second('dup', 'm3-p0')).toThrow(/UNIQUE constraint failed: trades\.original_trade_id/)
    expect(rawRows(db, 'trade_audit')).toEqual(audit)
    // The ordinary trades' NULLs were never in the index, and many still may be.
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'after-1' }))
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'after-2' }))
    // The original of a cancellation row cannot be deleted: SQLite finds the row through the partial index.
    expect(() => db.$client.prepare(`delete from trades where id = 'm3-p0'`).run()).toThrow(/FOREIGN KEY constraint failed/)
    // And the repository still cancels, through the same index.
    const lifecycle = createDrizzleLifecycleRepository(db)
    expect(await lifecycle.cancel('m3-p1', { reason: 'Late' }, { id: 'm3-c1', now: toUtcTimestamp(new Date(NOW)) })).toMatchObject({ ok: true })
    expect(await lifecycle.cancel('m3-p1', { reason: 'Again' }, { id: 'm3-c1b', now: toUtcTimestamp(new Date(NOW)) })).toMatchObject({ ok: false, problem: 'already-cancelled' })
  })

  it('looks up cancellations through the partial unique index, and never serves "original_trade_id is null" from it', () => {
    const db = database.open()
    const plan = (sql: string, ...params: string[]) => db.$client.prepare(`explain query plan ${sql}`).all(...params).map((row) => String(row['detail'])).join(' / ')

    expect(plan('select id from trades where original_trade_id = ?', 'x')).toMatch(/USING (COVERING )?INDEX trades_original_trade_id \(original_trade_id=\?\)/)
    expect(plan('select id from trades where original_trade_id in (?, ?)', 'x', 'y')).toMatch(/USING (COVERING )?INDEX trades_original_trade_id/)
    expect(plan('select id from trades where original_trade_id is not null')).toMatch(/USING (COVERING )?INDEX trades_original_trade_id/)
    expect(plan('select count(*) from trades where original_trade_id is null')).not.toMatch(/trades_original_trade_id/)
  })
})

/** Records every statement the repository runs on this connection, with its parameters. */
function recordStatements(db: Database): { sql: string; params: unknown[] }[] {
  const seen: { sql: string; params: unknown[] }[] = []
  const client = db.$client
  const prepare = client.prepare.bind(client)
  Object.defineProperty(client, 'prepare', {
    configurable: true,
    value: (sql: string) => new Proxy(prepare(sql), {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        const method = value as (...args: unknown[]) => unknown
        if (key === 'all' || key === 'get' || key === 'run') return (...params: unknown[]) => { seen.push({ sql, params }); return method.apply(target, params) }
        return method.bind(target)
      },
    }),
  })
  return seen
}

describe('infrastructure: the existing API\'s reads use the partial indexes', () => {
  it('reads trades only through a partial index on Executed trades, for every page, list, count and history', async () => {
    const db = database.open()
    const repository = createDrizzleTradeRepository(db)
    for (let n = 0; n < 30; n++) await repository.add(newTrade({ id: `t-${String(n)}`, symbol: ['MSFT', 'MS', 'AAPL'][n % 3] ?? 'A', side: n % 2 === 0 ? 'Buy' : 'Sell', quantity: String(n + 1) }))
    const seen = recordStatements(db)
    const page = (request: Record<string, string>) => {
      const result = validateTradePageQuery(request, { symbolMaxLength: 64 })
      if (!result.ok) throw new Error('invalid')
      return repository.listPage(result.value.query, result.value.page)
    }
    const list = (request: Record<string, string>) => {
      const result = validateTradeQuery(request, { symbolMaxLength: 64 })
      if (!result.ok) throw new Error('invalid')
      return repository.list(result.value)
    }

    await page({ page: '2', pageSize: '10' })
    for (const sortBy of ['symbol', 'quantity', 'price', 'executedAt']) for (const sortDirection of ['asc', 'desc']) await page({ sortBy, sortDirection, page: '2', pageSize: '10' })
    await page({ side: 'Buy', sortBy: 'quantity', page: '2', pageSize: '5' })
    await page({ symbol: 'ms', sortBy: 'price' })
    await page({ symbol: 'MSFT', symbolMatch: 'exact', page: '2', pageSize: '3' })
    await page({ page: '99' })
    await list({})
    await list({ symbol: 'ms', sortBy: 'price' })
    await repository.listInTradeOrder()
    await repository.add(newTrade({ id: 'checked' }))

    const reads = [...new Map(seen.filter((statement) => /\bfrom "trades"/i.test(statement.sql)).map((statement) => [statement.sql, statement])).values()]
    expect(reads.length).toBeGreaterThan(10)
    for (const statement of reads) {
      const plan = db.$client.prepare(`explain query plan ${statement.sql}`).all(...(statement.params as never[])).map((row) => String(row['detail']))
      const tradeSteps = plan.filter((step) => /^(SCAN|SEARCH) trades\b/.test(step))
      expect(tradeSteps.length, statement.sql).toBeGreaterThan(0)
      for (const step of tradeSteps) expect(step, statement.sql).toMatch(/USING (COVERING )?INDEX trades_executed_/)
    }
  })

  it('writes the Executed condition as a fixed literal, and every input as a bound parameter', async () => {
    const db = database.open()
    const repository = createDrizzleTradeRepository(db)
    const seen = recordStatements(db)
    const result = validateTradeQuery({ symbol: "x' or 1=1 --", side: 'Buy' }, { symbolMaxLength: 64 })
    if (!result.ok) throw new Error('invalid')

    await repository.list(result.value)

    const [read] = seen
    expect(read?.sql).toContain(`"trades"."status" = 'Executed'`)
    expect(read?.sql).not.toContain('or 1=1')
    expect(read?.params).toEqual(expect.arrayContaining(["X' OR 1=1 --", 'Buy']))
  })
})

describe('infrastructure: the trade lists of logical trades use the partial indexes', () => {
  /** Executed, Pending and cancelled trades with their cancellation rows, and every statement run after. */
  async function mixedTrades() {
    const db = database.open()
    const repository = createDrizzleTradeRepository(db)
    for (let n = 0; n < 30; n++) await repository.add(newTrade({ id: `t-${String(n)}`, symbol: ['MSFT', 'MS', 'AAPL'][n % 3] ?? 'A', side: n % 2 === 0 ? 'Buy' : 'Sell', quantity: String(n + 1) }))
    const lifecycle = createDrizzleLifecycleRepository(db)
    for (let n = 0; n < 8; n++) {
      await lifecycle.book({ ...newTrade({ id: `p-${String(n)}` }), status: 'Pending', executedAt: null, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null })
    }
    for (const n of [1, 4, 6]) {
      const result = await lifecycle.cancel(`p-${String(n)}`, { reason: 'Booked in error' }, { id: `c-${String(n)}`, now: toUtcTimestamp(new Date(NOW)) })
      if (!result.ok) throw new Error(result.message)
    }
    const seen = recordStatements(db)
    /** The trade-table steps of each statement's plan, by statement. */
    const plans = () => seen.filter((statement) => /^\s*select\b/i.test(statement.sql)).map((statement) => ({
      sql: statement.sql,
      steps: db.$client.prepare(`explain query plan ${statement.sql}`).all(...(statement.params as never[])).map((row) => String(row['detail'])),
    }))
    return { lifecycle, seen, plans }
  }
  const tradeSteps = (steps: string[]) => steps.filter((step) => /^(SCAN|SEARCH) trades\b/.test(step))
  const isCancellationLookup = (sql: string) => /"original_trade_id" (in \(|is not null)/i.test(sql)

  it('reads each page through a logical-trade index (or the Executed one for status=Executed), never the unique index or a full scan', async () => {
    const { lifecycle, seen, plans } = await mixedTrades()
    const page = async (request: Record<string, string>) => {
      const result = validateTradePageQuery(request, { symbolMaxLength: 64 })
      if (!result.ok) throw new Error('invalid')
      seen.length = 0
      await lifecycle.listPage(result.value.query, result.value.page)
      // The page itself: the statement with a LIMIT.
      const read = plans().find((statement) => /\blimit\b/i.test(statement.sql))
      if (read === undefined) throw new Error('no page read')
      return read.steps
    }

    for (const sortBy of ['executedAt', 'symbol', 'quantity', 'price']) {
      for (const sortDirection of ['asc', 'desc']) {
        for (const pageNumber of ['1', '2', '4']) {
          const steps = await page({ sortBy, sortDirection, page: pageNumber, pageSize: '10' })
          for (const step of tradeSteps(steps)) expect(step, `${sortBy} ${sortDirection} page ${pageNumber}`).toMatch(/USING (COVERING )?INDEX trades_logical_/)
          // Served in order by the index: no sort of the matching trades.
          expect(steps.join(' / '), `${sortBy} ${sortDirection} page ${pageNumber}`).not.toMatch(/TEMP B-TREE/)
        }
      }
    }
    for (const step of tradeSteps(await page({ status: 'Pending', page: '1', pageSize: '10' }))) expect(step).toMatch(/USING (COVERING )?INDEX trades_logical_/)
    for (const step of tradeSteps(await page({ status: 'Cancelled', page: '1', pageSize: '2' }))) expect(step).toMatch(/USING (COVERING )?INDEX trades_logical_/)
    for (const step of tradeSteps(await page({ status: 'Executed', sortBy: 'price', page: '2', pageSize: '10' }))) expect(step).toMatch(/USING (COVERING )?INDEX trades_executed_/)
    for (const step of tradeSteps(await page({ symbol: 'MSFT', symbolMatch: 'exact', page: '1', pageSize: '3' }))) expect(step).toMatch(/USING (COVERING )?INDEX trades_logical_symbol_trade_order/)
    for (const step of tradeSteps(await page({ side: 'Buy', sortBy: 'quantity', sortDirection: 'desc', page: '2', pageSize: '5' }))) expect(step).toMatch(/USING (COVERING )?INDEX trades_logical_/)
    for (const step of tradeSteps(await page({ symbol: 'ms', side: 'Sell', sortBy: 'price' }))) expect(step).not.toMatch(/trades_original_trade_id/)
  })

  it('counts, lists in full and finds cancellations through the partial indexes: the unique index only for cancellation rows', async () => {
    const { lifecycle, seen, plans } = await mixedTrades()
    const page = (request: Record<string, string>) => {
      const result = validateTradePageQuery(request, { symbolMaxLength: 64 })
      if (!result.ok) throw new Error('invalid')
      return lifecycle.listPage(result.value.query, result.value.page)
    }
    const list = (request: Record<string, string>) => {
      const result = validateTradeQuery(request, { symbolMaxLength: 64 })
      if (!result.ok) throw new Error('invalid')
      return lifecycle.list(result.value)
    }

    // The count of every logical trade, for a default page: through a logical-trade index.
    seen.length = 0
    await page({})
    const [count] = plans().filter((statement) => /^\s*select count/i.test(statement.sql))
    for (const step of tradeSteps(count?.steps ?? [])) expect(step).toMatch(/USING (COVERING )?INDEX trades_logical_/)
    // The full list in trade order: walked in order through a logical-trade index.
    seen.length = 0
    await list({})
    const [read] = plans().filter((statement) => !isCancellationLookup(statement.sql))
    expect(read?.steps.join(' / ')).toMatch(/^SCAN trades USING INDEX trades_logical_trade_order$/)

    // Every read: a cancellation lookup uses the unique index, nothing else does.
    seen.length = 0
    await page({ sortBy: 'symbol', page: '1', pageSize: '50' })
    await page({ symbol: 'ms', side: 'Buy' })
    await page({ status: 'Cancelled' })
    await list({ symbol: 'ms', sortBy: 'price' })
    const reads = plans()
    expect(reads.filter((statement) => isCancellationLookup(statement.sql))).not.toHaveLength(0)
    for (const statement of reads) {
      for (const step of tradeSteps(statement.steps)) {
        if (isCancellationLookup(statement.sql)) expect(step, statement.sql).toMatch(/USING (COVERING )?INDEX trades_original_trade_id/)
        else expect(step, statement.sql).not.toMatch(/trades_original_trade_id/)
      }
    }
  })
})
