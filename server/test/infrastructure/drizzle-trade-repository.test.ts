import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPositionService } from '../../src/application/position-service.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { decimalText } from '../../src/domain/decimal.ts'
import { PositionLimitError } from '../../src/domain/position.ts'
import type { Trade } from '../../src/domain/trade.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase, rawRows } from '../support/database.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { newTrade } from '../support/trades.ts'

let database: ReturnType<typeof createTestDatabase>
let db: Database

beforeEach(() => {
  database = createTestDatabase()
  db = database.open()
})

afterEach(() => {
  database.dispose()
})

/** A trade as plain text, for exact comparisons. */
const view = (trade: Trade) => ({
  id: trade.id,
  bookingSequence: trade.bookingSequence,
  symbol: trade.symbol,
  side: trade.side,
  quantity: decimalText(trade.quantity),
  price: decimalText(trade.price),
  executedAt: trade.executedAt,
  createdAt: trade.createdAt,
  updatedAt: trade.updatedAt,
})

const count = (): number => rawRows(db).length

describe('infrastructure: Drizzle trade repository', () => {
  it('stores a trade and reads it back unchanged, with the booking sequence SQLite assigned', async () => {
    const repository = createDrizzleTradeRepository(db)
    const trade = newTrade({ id: 'a', symbol: 'MSFT', side: 'Sell', quantity: '12.5', price: '301.25' })

    const stored = await repository.add(trade)

    expect(view(stored)).toEqual({ ...view({ ...trade, bookingSequence: 1 }) })
    expect((await repository.listInTradeOrder()).map(view)).toEqual([view(stored)])
    expect(Object.isFrozen(stored)).toBe(true)
  })

  it('stores decimals as canonical text and reads them back exactly', async () => {
    const repository = createDrizzleTradeRepository(db)
    const values = [
      ['999999999999999.9999999999', '999999999999999.9999999999'],
      ['0.0000000001', '0.0000000001'],
      ['123456789012345.1234567891', '0.1'],
      ['10.5', '100'],
    ] as const

    for (const [quantity, price] of values) await repository.add(newTrade({ quantity, price }))

    const rows = rawRows(db) as Record<string, unknown>[]
    expect(rows.map((row) => [row['quantity'], row['price']])).toEqual(values)
    expect((await repository.listInTradeOrder()).map((trade) => [decimalText(trade.quantity), decimalText(trade.price)])).toEqual(values)
  })

  it('stores timestamps as canonical UTC text with milliseconds and reads them back exactly', async () => {
    const repository = createDrizzleTradeRepository(db)
    const timestamps = [
      ['0001-01-01T00:00:00.000Z', '2026-03-01T12:00:00.001Z', '2026-03-01T12:00:00.001Z'],
      ['9999-12-31T23:59:59.999Z', '2026-03-01T12:00:00.002Z', '2026-03-02T00:00:00.000Z'],
    ] as const

    for (const [executedAt, createdAt, updatedAt] of timestamps) await repository.add(newTrade({ executedAt, createdAt, updatedAt }))

    const rows = rawRows(db) as Record<string, unknown>[]
    expect(rows.map((row) => [row['executed_at'], row['created_at'], row['updated_at']])).toEqual(timestamps)
    expect((await repository.listInTradeOrder()).map((trade) => [trade.executedAt, trade.createdAt, trade.updatedAt]))
      .toEqual(timestamps)
  })

  it('assigns increasing booking sequences in the order trades are added', async () => {
    const repository = createDrizzleTradeRepository(db)

    const sequences = []
    for (const executedAt of ['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']) {
      sequences.push((await repository.add(newTrade({ executedAt }))).bookingSequence)
    }

    expect(sequences).toEqual([1, 2, 3])
  })

  it('never reuses a booking sequence, even after a row is deleted', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ id: 'a' }))
    await repository.add(newTrade({ id: 'b' }))
    // There is no delete operation; this simulates one directly in SQLite.
    db.$client.exec(`delete from trades where id = 'b'`)

    expect((await repository.add(newTrade({ id: 'c' }))).bookingSequence).toBe(3)
  })

  it('lists trades with the same execution time in booking order', async () => {
    const repository = createDrizzleTradeRepository(db)
    // createdAt runs backwards and ids sort the other way, so ordering by either would be wrong.
    const bookings = [['c', '2026-01-01T09:00:09.000Z'], ['b', '2026-01-01T09:00:08.000Z'], ['a', '2026-01-01T09:00:07.000Z']] as const
    for (const [id, createdAt] of bookings) await repository.add(newTrade({ id, executedAt: '2026-01-01T09:00:00Z', createdAt }))

    expect((await repository.listInTradeOrder()).map((trade) => trade.id)).toEqual(['c', 'b', 'a'])
  })

  it('lists trades by execution time, not by the order they were added', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ id: 'noon', executedAt: '2026-01-01T12:00:00Z' }))
    await repository.add(newTrade({ id: 'nine', executedAt: '2026-01-01T09:00:00Z' }))
    await repository.add(newTrade({ id: 'ten-utc', executedAt: '2026-01-01T11:00:00+01:00' }))
    await repository.add(newTrade({ id: 'noon-again', executedAt: '2026-01-01T12:00:00Z' }))

    expect((await repository.listInTradeOrder()).map((trade) => trade.id)).toEqual(['nine', 'ten-utc', 'noon', 'noon-again'])
  })

  it('derives positions for several symbols from out-of-order trades through the real services', async () => {
    const trades = createDrizzleTradeRepository(db)
    const clock = createFixedClock('2026-03-01T12:00:00.000Z')
    const tradeService = createTradeService({ trades, clock, ids: createSequentialIds() })
    const positionService = createPositionService({ trades })

    await tradeService.createTrade({ symbol: 'msft', side: 'Buy', quantity: '100', price: '10', executedAt: '2026-01-01T09:00:00Z' })
    await tradeService.createTrade({ symbol: 'MSFT', side: 'Sell', quantity: '100', price: '12', executedAt: '2026-01-01T11:00:00Z' })
    await tradeService.createTrade({ symbol: 'AAPL', side: 'Sell', quantity: '1', price: '1', executedAt: '2026-01-01T09:00:00Z' })
    await tradeService.createTrade({ symbol: 'AAPL', side: 'Sell', quantity: '2', price: '2', executedAt: '2026-01-01T09:00:00Z' })
    // Executed between the MSFT trades, recorded later: it raises the long before the sale.
    await tradeService.createTrade({ symbol: 'MSFT', side: 'Buy', quantity: '100', price: '20', executedAt: '2026-01-01T10:00:00Z' })

    const positions = (await positionService.listPositions())
      .map((position) => [position.symbol, decimalText(position.netQuantity), decimalText(position.averageCost)])
    expect(positions).toEqual([['AAPL', '-3', `1.${'6'.repeat(48)}7`], ['MSFT', '100', '15']])
    expect((await tradeService.listTrades()).map((trade) => trade.bookingSequence)).toEqual([2, 5, 4, 3, 1])
  })
})

describe('infrastructure: Drizzle trade repository transactions', () => {
  const NEAR_LIMIT = '999999999999999000000000000001'

  it('refuses a trade that would breach the position limit and leaves the database unchanged', async () => {
    const repository = createDrizzleTradeRepository(db)
    // Reaching 10^30 takes about 10^15 maximum-size trades, so one oversized trade is stored directly.
    await repository.add(newTrade({ id: 'big', symbol: 'BIG', quantity: NEAR_LIMIT }))
    await repository.add(newTrade({ id: 'other', symbol: 'OTHER', quantity: '5' }))
    const before = rawRows(db)

    await expect(repository.add(newTrade({ id: 'breach', symbol: 'BIG', quantity: '999999999999999' })))
      .rejects.toThrow(PositionLimitError)

    expect(rawRows(db)).toEqual(before)
    // The rolled-back insert did not consume a booking sequence.
    expect((await repository.add(newTrade({ id: 'next', symbol: 'BIG', side: 'Sell', quantity: '1' }))).bookingSequence).toBe(3)
  })

  it('checks a trade executed in the past against the trades executed after it', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ id: 'open', symbol: 'BIG', quantity: NEAR_LIMIT, executedAt: '2026-01-01T09:00:00Z' }))
    await repository.add(newTrade({ id: 'close', symbol: 'BIG', side: 'Sell', quantity: NEAR_LIMIT, executedAt: '2026-01-01T11:00:00Z' }))
    const before = rawRows(db)

    // Booked last but executed while the long was open: the position would pass the limit at 10:00.
    await expect(repository.add(newTrade({ symbol: 'BIG', quantity: '999999999999999', executedAt: '2026-01-01T10:00:00Z' })))
      .rejects.toThrow(PositionLimitError)
    expect(rawRows(db)).toEqual(before)

    // The same trade executed after the close is fine.
    const accepted = await repository.add(newTrade({ symbol: 'BIG', quantity: '999999999999999', executedAt: '2026-01-01T12:00:00Z' }))
    expect(accepted.bookingSequence).toBe(3)
  })

  it('checks only the trade\'s own symbol', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ symbol: 'BIG', quantity: NEAR_LIMIT }))

    await expect(repository.add(newTrade({ symbol: 'SMALL', quantity: '999999999999999' }))).resolves.toBeDefined()
    expect(count()).toBe(2)
  })

  it('rolls back when the insert fails after the history was read', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ id: 'dup' }))
    const before = rawRows(db)

    const failure: unknown = await repository.add(newTrade({ id: 'dup', quantity: '2' })).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).cause)).toMatch(/UNIQUE constraint failed: trades.id/)

    expect(rawRows(db)).toEqual(before)
    expect(db.$client.isTransaction).toBe(false)
    expect((await repository.add(newTrade({ id: 'after' }))).bookingSequence).toBe(2)
  })

  it('keeps working after a rejected trade', async () => {
    const repository = createDrizzleTradeRepository(db)
    await repository.add(newTrade({ symbol: 'BIG', quantity: NEAR_LIMIT }))
    await expect(repository.add(newTrade({ symbol: 'BIG', quantity: '999999999999999' }))).rejects.toThrow(PositionLimitError)

    await repository.add(newTrade({ symbol: 'ABC' }))

    expect((await repository.listInTradeOrder()).map((trade) => trade.bookingSequence)).toEqual([1, 2])
  })
})

describe('infrastructure: Drizzle trade repository across restarts', () => {
  it('reads the same trades after the database is closed and reopened, and continues the booking sequence', async () => {
    const first = createDrizzleTradeRepository(db)
    await first.add(newTrade({ id: 'a', quantity: '0.1', executedAt: '2026-01-01T10:00:00Z' }))
    await first.add(newTrade({ id: 'b', quantity: '0.2', executedAt: '2026-01-01T09:00:00Z' }))
    const before = (await first.listInTradeOrder()).map(view)

    db = database.reopen()
    const second = createDrizzleTradeRepository(db)

    expect((await second.listInTradeOrder()).map(view)).toEqual(before)
    expect((await second.add(newTrade({ id: 'c' }))).bookingSequence).toBe(3)
  })

  it('sees trades written by another connection to the same file', async () => {
    const writer = createDrizzleTradeRepository(db)
    const reader = createDrizzleTradeRepository(database.open())

    await writer.add(newTrade({ id: 'shared' }))

    expect((await reader.listInTradeOrder()).map((trade) => trade.id)).toEqual(['shared'])
  })
})
