import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPositionService } from '../../src/application/position-service.ts'
import { Dec, NET_QUANTITY_LIMIT } from '../../src/domain/decimal.ts'
import { calculatePositions, PositionLimitError } from '../../src/domain/position.ts'
import { calculateStatusPositions } from '../../src/domain/position-summary.ts'
import type { UtcTimestamp } from '../../src/domain/timestamp.ts'
import type { NewLifecycleTrade } from '../../src/domain/trade-status.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleLifecycleRepository, LifecycleRowError } from '../../src/infrastructure/drizzle-lifecycle-repository.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { isolatedEnv, startNode } from '../support/child-process.ts'
import { createTestDatabase, rawRows } from '../support/database.ts'
import { newTrade, utc } from '../support/trades.ts'

/**
 * The trade lifecycle's persistence (drizzle-lifecycle-repository.ts) on real SQLite files:
 * bookings under the two position-limit rules, execution as one transaction updating the trade's
 * own row, cancellation as one transaction writing the original's update and the cancellation row,
 * what the audit triggers record for them, races between separate processes, and the constraints
 * that hold even against writes made directly in SQL.
 */

let database: ReturnType<typeof createTestDatabase>
let db: Database

beforeEach(() => {
  database = createTestDatabase()
  db = database.open()
})

afterEach(() => {
  database.dispose()
})

const BOOKED = utc('2026-01-05T14:00:00.000Z')
const NOW = utc('2026-02-01T10:00:00.000Z')
const lifecycle = () => createDrizzleLifecycleRepository(db)
const pending = (overrides: Partial<NewLifecycleTrade> = {}): NewLifecycleTrade => ({
  id: 'p-1', symbol: 'MSFT', side: 'Buy', quantity: new Dec('12.5'), price: new Dec('301.25'), status: 'Pending', executedAt: null,
  createdAt: BOOKED, updatedAt: BOOKED, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null, ...overrides,
})
const executed = (overrides: Partial<NewLifecycleTrade> = {}): NewLifecycleTrade => pending({ id: 'e-1', status: 'Executed', executedAt: utc('2026-01-05T13:00:00.000Z'), ...overrides })
type Row = Record<string, unknown>
const audit = (): Row[] => db.$client.prepare('select * from trade_audit order by audit_id').all()
const row = (id: string): Row | undefined => db.$client.prepare('select * from trades where id = ?').get(id)
const META = ['audit_id', 'audit_action', 'audit_on', 'audit_by']
const snapshot = (entry: Row | undefined): Row => Object.fromEntries(Object.entries(entry ?? {}).filter(([name]) => !META.includes(name)))

describe('infrastructure: booking Pending and Executed trades', () => {
  it('stores a Pending trade with no execution time, by User, and an Executed one with its time', async () => {
    const stored = await lifecycle().book(pending())
    await lifecycle().book(executed())

    expect(stored).toMatchObject({ id: 'p-1', bookingSequence: 1, status: 'Pending', executedAt: null, createdBy: 'User', originalTradeId: null })
    expect(row('p-1')).toMatchObject({ status: 'Pending', executed_at: null, created_by: 'User', updated_by: 'User', original_trade_id: null, cancellation_reason: null })
    expect(row('e-1')).toMatchObject({ status: 'Executed', executed_at: '2026-01-05T13:00:00.000Z' })
  })

  it('refuses a Cancelled booking, a cancellation row and a row that breaks the lifecycle rules, storing nothing', async () => {
    await expect(lifecycle().book(pending({ status: 'Cancelled' }))).rejects.toThrow(LifecycleRowError)
    await expect(lifecycle().book(pending({ originalTradeId: 'x' }))).rejects.toThrow(LifecycleRowError)
    await expect(lifecycle().book(pending({ executedAt: BOOKED }))).rejects.toThrow(/A Pending row has no execution time/)
    expect(rawRows(db)).toEqual([])
    expect(audit()).toEqual([])
  })

  it('refuses a Pending booking whose final projected position reaches the limit, storing and auditing nothing', async () => {
    const below = (amount: string) => new Dec(NET_QUANTITY_LIMIT).minus(amount)
    await lifecycle().book(executed({ quantity: below('10') }))
    await lifecycle().book(pending({ id: 'p-a', quantity: new Dec('5') }))
    const before = { rows: rawRows(db), audit: audit() }

    // Compared as a value, so a booking that is wrongly stored fails this assertion.
    const outcome = await lifecycle().book(pending({ id: 'p-b', quantity: new Dec('5') })).then(() => 'stored', (error: unknown) => error instanceof PositionLimitError ? 'refused' : error)
    expect(outcome).toBe('refused')
    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
    // An offsetting Pending Sell is accepted, and then the Buy fits.
    await lifecycle().book(pending({ id: 'p-c', side: 'Sell', quantity: new Dec('3') }))
    await expect(lifecycle().book(pending({ id: 'p-d', quantity: new Dec('5') }))).resolves.toMatchObject({ id: 'p-d' })
  })

  it('refuses an Executed booking by the existing rule: every intermediate Executed step', async () => {
    const near = new Dec(NET_QUANTITY_LIMIT).minus(1)
    await lifecycle().book(executed({ id: 'e-a', quantity: near, executedAt: utc('2026-01-01T10:00:00.000Z') }))
    await lifecycle().book(executed({ id: 'e-b', side: 'Sell', quantity: near, executedAt: utc('2026-01-01T12:00:00.000Z') }))

    await expect(lifecycle().book(executed({ id: 'e-c', quantity: new Dec('1'), executedAt: utc('2026-01-01T11:00:00.000Z') }))).rejects.toThrow(PositionLimitError)
    // Pending trades are not part of that history.
    await lifecycle().book(pending({ id: 'p-big', quantity: near.minus(1) }))
    await expect(lifecycle().book(executed({ id: 'e-d', quantity: new Dec('1'), executedAt: utc('2026-01-01T13:00:00.000Z') }))).resolves.toMatchObject({ id: 'e-d' })
  })
})

describe('infrastructure: cancelling a Pending trade', () => {
  it('updates the original and inserts the cancellation row in the trades table, and audits exactly those two writes', async () => {
    await lifecycle().book(pending())
    const auditBefore = audit()

    const result = await lifecycle().cancel('p-1', { reason: '  Client withdrew  ' }, { id: 'c-1', now: NOW })

    if (!result.ok) throw new Error(result.message)
    expect(row('p-1')).toMatchObject({ booking_sequence: 1, status: 'Cancelled', updated_by: 'Admin', updated_at: NOW, created_by: 'User', created_at: BOOKED, quantity: '12.5', executed_at: null })
    expect(row('c-1')).toMatchObject({
      booking_sequence: 2, status: 'Cancelled', original_trade_id: 'p-1', cancellation_reason: 'Client withdrew', symbol: 'MSFT', side: 'Buy', quantity: '12.5', price: '301.25',
      executed_at: null, created_by: 'Admin', updated_by: 'Admin', created_at: NOW, updated_at: NOW,
    })
    const added = audit().slice(auditBefore.length)
    expect(added.map((entry) => [entry['audit_action'], entry['id']])).toEqual([['Updated', 'p-1'], ['Inserted', 'c-1']])
    expect(snapshot(added[0])).toEqual(row('p-1'))
    expect(snapshot(added[1])).toEqual(row('c-1'))
    expect(added.every((entry) => entry['audit_by'] === 'System')).toBe(true)
  })

  it('refuses, writing and auditing nothing: an Executed trade, an unknown id, a cancellation row, a second cancellation', async () => {
    await lifecycle().book(executed())
    await lifecycle().book(pending())
    await lifecycle().cancel('p-1', { reason: 'first' }, { id: 'c-1', now: NOW })
    const before = { rows: rawRows(db), audit: audit() }

    expect(await lifecycle().cancel('e-1', { reason: 'x' }, { id: 'c-2', now: NOW })).toMatchObject({ ok: false, problem: 'not-pending' })
    expect(await lifecycle().cancel('nope', { reason: 'x' }, { id: 'c-3', now: NOW })).toMatchObject({ ok: false, problem: 'not-found' })
    expect(await lifecycle().cancel('c-1', { reason: 'x' }, { id: 'c-4', now: NOW })).toMatchObject({ ok: false, problem: 'cancellation-record' })
    expect(await lifecycle().cancel('p-1', { reason: 'again' }, { id: 'c-5', now: NOW })).toMatchObject({ ok: false, problem: 'already-cancelled' })
    expect(await lifecycle().cancel('p-1', {}, { id: 'c-6', now: NOW })).toMatchObject({ ok: false })
    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
  })

  it('leaves no partial change and no partial audit when a write inside the transaction fails', async () => {
    await lifecycle().book(pending())
    await lifecycle().book(executed())
    const before = { rows: rawRows(db), audit: audit() }

    // The cancellation row's id is taken by another trade: the insert fails after the original's update.
    const error = await lifecycle().cancel('p-1', { reason: 'x' }, { id: 'e-1', now: NOW }).catch((caught: unknown) => caught)
    // Drizzle wraps SQLite's error; SQLite's own reason is its cause.
    expect(((error as Error).cause as Error | undefined)?.message).toMatch(/UNIQUE constraint failed: trades\.id/)

    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
    expect(row('p-1')).toMatchObject({ status: 'Pending', updated_by: 'User' })
  })

  it('allows one cancellation row per original, even written directly in SQL', async () => {
    await lifecycle().book(pending())
    await lifecycle().cancel('p-1', { reason: 'first' }, { id: 'c-1', now: NOW })

    expect(() => db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by, original_trade_id, cancellation_reason)
      values ('c-2', 'MSFT', 'Buy', '12.5', '301.25', null, ?, ?, 'Cancelled', 'Admin', 'Admin', 'p-1', 'second')`).run(NOW, NOW)).toThrow(/UNIQUE constraint failed: trades\.original_trade_id/)
  })

  it('lets exactly one of several concurrent cancellations succeed', async () => {
    await lifecycle().book(pending())
    const startAt = Date.now() + 1_500
    const workers = Array.from({ length: 5 }, (_, index) => startNode(
      [join(import.meta.dirname, '../support/cancel-worker.ts'), database.path, 'p-1', `race-${String(index)}`, NOW, String(startAt)],
      isolatedEnv({ DATABASE_PATH: database.path }),
    ))
    const results = await Promise.all(workers.map((worker) => new Promise<unknown>((resolve) => {
      let out = ''
      worker.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
      worker.once('exit', () => { resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')) })
    })))

    expect(results.filter((result) => (result as { ok: boolean }).ok)).toHaveLength(1)
    expect(results.filter((result) => !(result as { ok: boolean }).ok)).toEqual(Array(4).fill({ ok: false, problem: 'already-cancelled' }))
    expect(db.$client.prepare(`select count(*) as n from trades where original_trade_id = 'p-1'`).get()).toEqual({ n: 1 })
    expect(audit().map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated', 'Inserted'])
  }, 60_000)
})

/** Runs lifecycle-race-worker.ts in `count` processes that start together, and returns what each printed. */
async function race(operations: readonly (readonly [operation: 'execute' | 'cancel', id: string])[], tradeId: string): Promise<{ ok: boolean; operation: string; problem?: string }[]> {
  const startAt = Date.now() + 1_500
  const workers = operations.map(([operation, id]) => startNode(
    [join(import.meta.dirname, '../support/lifecycle-race-worker.ts'), database.path, operation, tradeId, id, NOW, String(startAt)],
    isolatedEnv({ DATABASE_PATH: database.path }),
  ))
  return Promise.all(workers.map((worker) => new Promise<{ ok: boolean; operation: string; problem?: string }>((resolve) => {
    let out = ''
    worker.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    worker.once('exit', () => { resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { ok: boolean; operation: string }) })
  })))
}

describe('infrastructure: executing a Pending trade', () => {
  it('updates the trade\'s own row to Executed at the time given, adds no row, and audits exactly that update', async () => {
    await lifecycle().book(pending())
    const before = row('p-1')

    const result = await lifecycle().execute('p-1', () => NOW)

    expect(result).toMatchObject({ ok: true, trade: { id: 'p-1', bookingSequence: 1, status: 'Executed', executedAt: NOW, updatedAt: NOW, updatedBy: 'User', createdAt: BOOKED, createdBy: 'User' } })
    expect(row('p-1')).toEqual({ ...before, status: 'Executed', executed_at: NOW, updated_at: NOW, updated_by: 'User' })
    expect(rawRows(db)).toHaveLength(1)
    expect(audit().map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated'])
    expect(snapshot(audit()[1])).toEqual(row('p-1'))
  })

  it('reads the execution time inside the transaction, once the write lock is held', async () => {
    await lifecycle().book(pending())
    const other = new DatabaseSync(database.path)
    other.exec('pragma busy_timeout = 0')
    let observed: { inTransaction: boolean; otherWriter: string } | undefined
    try {
      await lifecycle().execute('p-1', () => {
        let otherWriter = 'wrote'
        try {
          other.exec(`update trades set updated_by = 'Admin' where id = 'nobody'`)
        } catch (error) {
          otherWriter = (error as Error).message
        }
        observed = { inTransaction: db.$client.isTransaction, otherWriter }
        return NOW
      })
    } finally {
      other.close()
    }

    expect(observed).toEqual({ inTransaction: true, otherWriter: expect.stringMatching(/database is locked/) as unknown })
  })

  it('refuses, writing and auditing nothing: an unknown id, an Executed trade, a Cancelled trade, a cancellation row', async () => {
    await lifecycle().book(executed())
    await lifecycle().book(pending({ id: 'p-2' }))
    await lifecycle().cancel('p-2', { reason: 'x' }, { id: 'c-2', now: NOW })
    const before = { rows: rawRows(db), audit: audit() }

    expect(await lifecycle().execute('nope', () => NOW)).toMatchObject({ ok: false, problem: 'not-found' })
    expect(await lifecycle().execute('e-1', () => NOW)).toMatchObject({ ok: false, problem: 'already-executed' })
    expect(await lifecycle().execute('p-2', () => NOW)).toMatchObject({ ok: false, problem: 'already-cancelled' })
    expect(await lifecycle().execute('c-2', () => NOW)).toMatchObject({ ok: false, problem: 'cancellation-record' })
    expect(await lifecycle().cancel('e-1', { reason: 'x' }, { id: 'c-3', now: NOW })).toMatchObject({ ok: false, problem: 'not-pending' })
    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
  })

  it('refuses an execution that takes the Executed position to the limit, by the Executed rule, writing and auditing nothing', async () => {
    await lifecycle().book(executed({ quantity: new Dec(NET_QUANTITY_LIMIT).minus('10') }))
    await lifecycle().book(pending({ id: 'p-sell', side: 'Sell', quantity: new Dec('10') }))
    await lifecycle().book(pending({ id: 'p-buy', quantity: new Dec('15') }))
    const before = { rows: rawRows(db), audit: audit() }

    // Compared as a value, so an execution that is wrongly allowed fails this assertion.
    const outcome = await lifecycle().execute('p-buy', () => NOW).then((value) => value, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(PositionLimitError)
    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
    expect(await lifecycle().execute('p-sell', () => NOW)).toMatchObject({ ok: true })
    expect(await lifecycle().execute('p-buy', () => NOW)).toMatchObject({ ok: true })
  })

  it('leaves no partial change and no partial audit when the update fails inside the transaction', async () => {
    await lifecycle().book(pending())
    db.$client.exec(`create trigger refuse_execution before update on trades when new.status = 'Executed' begin select raise(abort, 'refused'); end`)
    const before = { rows: rawRows(db), audit: audit() }

    await expect(lifecycle().execute('p-1', () => NOW)).rejects.toThrow()
    expect({ rows: rawRows(db), audit: audit() }).toEqual(before)
    expect(row('p-1')).toMatchObject({ status: 'Pending', executed_at: null })
  })

  it('refuses a time that is not canonical UTC, or before the trade last changed, writing nothing', async () => {
    await lifecycle().book(pending())

    expect(await lifecycle().execute('p-1', () => '2026-02-01T10:00:00Z' as UtcTimestamp)).toMatchObject({ ok: false, problem: 'invalid-time' })
    expect(await lifecycle().execute('p-1', () => utc('2026-01-05T13:59:59.999Z'))).toMatchObject({ ok: false, problem: 'invalid-time' })
    expect(row('p-1')).toMatchObject({ status: 'Pending' })
    expect(audit()).toHaveLength(1)
  })

  it('lets exactly one of several concurrent executions in separate processes succeed', async () => {
    await lifecycle().book(pending())

    const results = await race(Array.from({ length: 5 }, () => ['execute', '-'] as const), 'p-1')

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual(Array(4).fill({ ok: false, operation: 'execute', problem: 'already-executed' }))
    expect(row('p-1')).toMatchObject({ status: 'Executed', executed_at: NOW })
    expect(audit().map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated'])
  }, 60_000)

  it('lets exactly one of concurrent executions and cancellations in separate processes succeed', async () => {
    await lifecycle().book(pending())

    const results = await race([['execute', '-'], ['cancel', 'c-1'], ['execute', '-'], ['cancel', 'c-2']], 'p-1')

    const winners = results.filter((result) => result.ok)
    expect(winners).toHaveLength(1)
    const final = row('p-1')
    if (winners[0]?.operation === 'execute') {
      expect(final).toMatchObject({ status: 'Executed', executed_at: NOW })
      expect(rawRows(db)).toHaveLength(1)
      expect(audit().map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated'])
    } else {
      expect(final).toMatchObject({ status: 'Cancelled', executed_at: null })
      expect(rawRows(db)).toHaveLength(2)
      expect(audit().map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated', 'Inserted'])
    }
    for (const loser of results.filter((result) => !result.ok)) expect(['already-executed', 'already-cancelled', 'not-pending']).toContain(loser.problem)
  }, 60_000)
})

describe('infrastructure: foreign keys are enforced', () => {
  it('is on for every connection', () => {
    expect(db.$client.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('refuses a cancellation row naming a trade that does not exist, and the removal of an original that has one', async () => {
    expect(() => db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by, original_trade_id, cancellation_reason)
      values ('orphan', 'MSFT', 'Buy', '1', '1', null, ?, ?, 'Cancelled', 'Admin', 'Admin', 'missing', 'x')`).run(NOW, NOW)).toThrow(/FOREIGN KEY constraint failed/)
    await lifecycle().book(pending())
    await lifecycle().cancel('p-1', { reason: 'x' }, { id: 'c-1', now: NOW })

    expect(() => { db.$client.exec(`delete from trades where id = 'p-1'`); }).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => { db.$client.exec(`update trades set id = 'renamed' where id = 'p-1'`); }).toThrow(/FOREIGN KEY constraint failed/)
    expect(row('p-1')).toBeDefined()
  })
})

describe('infrastructure: the existing API\'s trades and positions are unchanged by lifecycle rows', () => {
  it('lists and calculates from Executed trades only, as before', async () => {
    const trades = createDrizzleTradeRepository(db)
    await trades.add(newTrade({ id: 'x-1', symbol: 'MSFT', quantity: '10', price: '100', executedAt: '2026-01-01T09:00:00.000Z' }))
    await trades.add(newTrade({ id: 'x-2', symbol: 'MSFT', side: 'Sell', quantity: '4', price: '110', executedAt: '2026-01-01T10:00:00.000Z' }))
    await lifecycle().book(pending({ id: 'p-a', symbol: 'MSFT', quantity: new Dec('1000') }))
    await lifecycle().book(pending({ id: 'p-b', symbol: 'NEW' }))
    await lifecycle().cancel('p-b', { reason: 'x' }, { id: 'c-b', now: NOW })

    const ids = await trades.listInTradeOrder().then((list) => list.map((trade) => trade.id), (error: unknown) => [String(error)])
    expect(ids).toEqual(['x-1', 'x-2'])
    const listed = await trades.listInTradeOrder()
    expect((await trades.listPage({ filter: {}, sort: { field: 'executedAt', direction: 'desc' } }, { page: 1, pageSize: 50 })).totalCount).toBe(2)
    // Positions (M4) count the Pending trade apart; the Executed Net and average cost are as before.
    const positions = await createPositionService({ trades: lifecycle() }).listPositions()
    expect(positions.map((position) => [position.symbol, position.executedNet.toFixed(), position.pendingNet.toFixed(), position.averageCost.toFixed()])).toEqual([['MSFT', '6', '1000', '100']])
    expect(positions.map((position) => [position.symbol, position.executedNet, position.averageCost])).toEqual(calculatePositions(listed).map((position) => [position.symbol, position.netQuantity, position.averageCost]))
    // The lifecycle's own view counts the Pending trade, and nothing cancelled.
    const all = await lifecycle().listAll()
    expect(calculateStatusPositions(all).map((position) => [position.symbol, position.executedNet.toFixed(), position.pendingNet.toFixed()])).toEqual([['MSFT', '6', '1000']])
  })

  it('books through the existing repository as an Executed trade by User, audited as an insert', async () => {
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'legacy' }))

    expect(row('legacy')).toMatchObject({ status: 'Executed', created_by: 'User', updated_by: 'User', original_trade_id: null, cancellation_reason: null })
    expect(audit().map((entry) => [entry['audit_action'], entry['id']])).toEqual([['Inserted', 'legacy']])
  })
})

describe('infrastructure: cancellation timestamps', () => {
  it('stores one canonical UTC time on both rows and refuses one that is not canonical', async () => {
    await lifecycle().book(pending())

    expect(await lifecycle().cancel('p-1', { reason: 'x' }, { id: 'c-1', now: '2026-02-01T10:00:00Z' as UtcTimestamp })).toMatchObject({ ok: false, problem: 'invalid-time' })
    await lifecycle().cancel('p-1', { reason: 'x' }, { id: 'c-1', now: NOW })
    expect([row('p-1')?.['updated_at'], row('c-1')?.['created_at'], row('c-1')?.['updated_at']]).toEqual([NOW, NOW, NOW])
  })
})
