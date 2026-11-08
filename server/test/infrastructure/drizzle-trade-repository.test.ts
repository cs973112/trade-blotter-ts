import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPositionService } from '../../src/application/position-service.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { decimalText } from '../../src/domain/decimal.ts'
import { PositionLimitError } from '../../src/domain/position.ts'
import type { Trade } from '../../src/domain/trade.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository, planPageRead } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase, rawRows } from '../support/database.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { newTrade, utc } from '../support/trades.ts'

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

describe('infrastructure: Drizzle trade repository filters', () => {
  /** Stores the trades in the order given and returns the repository. */
  async function seeded(trades: readonly Parameters<typeof newTrade>[0][]) {
    const repository = createDrizzleTradeRepository(db)
    for (const trade of trades) await repository.add(newTrade(trade))
    return repository
  }

  const ids = (trades: readonly Trade[]): string[] => trades.map((trade) => trade.id)

  const HISTORY = [
    { id: 'msft-buy', symbol: 'MSFT', side: 'Buy', executedAt: '2026-01-01T09:00:00.000Z' },
    { id: 'msf-sell', symbol: 'MSF', side: 'Sell', executedAt: '2026-01-01T10:00:00.000Z' },
    { id: 'aapl-buy', symbol: 'AAPL', side: 'Buy', executedAt: '2026-01-02T09:00:00.000Z' },
    { id: 'xmsftx-sell', symbol: 'XMSFTX', side: 'Sell', executedAt: '2026-01-02T09:00:00.000Z' },
    { id: 'brk-buy', symbol: 'BRK.B', side: 'Buy', executedAt: '2026-01-03T00:00:00.000Z' },
  ] as const

  it('lists every trade in trade order with no filter or an empty one', async () => {
    const repository = await seeded(HISTORY)
    const all = ['msft-buy', 'msf-sell', 'aapl-buy', 'xmsftx-sell', 'brk-buy']

    expect(ids(await repository.listInTradeOrder())).toEqual(all)
    expect(ids(await repository.listInTradeOrder({}))).toEqual(all)
  })

  it.each([
    ['a whole symbol, also matching longer symbols that contain it', 'MSFT', ['msft-buy', 'xmsftx-sell']],
    ['the start of a symbol', 'MS', ['msft-buy', 'msf-sell', 'xmsftx-sell']],
    ['the middle of a symbol', 'SF', ['msft-buy', 'msf-sell', 'xmsftx-sell']],
    ['the end of a symbol', 'PL', ['aapl-buy']],
    ['punctuation', '.', ['brk-buy']],
    ['text no symbol contains', 'ZZZ', []],
  ])('matches %s', async (_name, symbolContains, expected) => {
    const repository = await seeded(HISTORY)

    expect(ids(await repository.listInTradeOrder({ symbolContains }))).toEqual(expected)
  })

  it('treats LIKE wildcards in the search as plain characters', async () => {
    const repository = await seeded([
      { id: 'percent', symbol: 'A%B' }, { id: 'underscore', symbol: 'A_B' }, { id: 'plain', symbol: 'AXB' },
    ])

    expect(ids(await repository.listInTradeOrder({ symbolContains: '%' }))).toEqual(['percent'])
    expect(ids(await repository.listInTradeOrder({ symbolContains: '_' }))).toEqual(['underscore'])
    expect(ids(await repository.listInTradeOrder({ symbolContains: 'A_B' }))).toEqual(['underscore'])
  })

  it('matches symbols outside ASCII exactly, as stored', async () => {
    const repository = await seeded([{ id: 'accented', symbol: 'ÉCOLE' }, { id: 'plain', symbol: 'ECOLE' }, { id: 'cjk', symbol: '株式' }])

    expect(ids(await repository.listInTradeOrder({ symbolContains: 'ÉCO' }))).toEqual(['accented'])
    expect(ids(await repository.listInTradeOrder({ symbolContains: 'ECO' }))).toEqual(['plain'])
    expect(ids(await repository.listInTradeOrder({ symbolContains: '式' }))).toEqual(['cjk'])
  })

  it('filters by side', async () => {
    const repository = await seeded(HISTORY)

    expect(ids(await repository.listInTradeOrder({ side: 'Buy' }))).toEqual(['msft-buy', 'aapl-buy', 'brk-buy'])
    expect(ids(await repository.listInTradeOrder({ side: 'Sell' }))).toEqual(['msf-sell', 'xmsftx-sell'])
  })

  it('includes trades executed exactly at either bound, to the millisecond', async () => {
    const repository = await seeded([
      { id: 'before', executedAt: '2026-01-01T08:59:59.999Z' },
      { id: 'at-start', executedAt: '2026-01-01T09:00:00.000Z' },
      { id: 'inside', executedAt: '2026-01-01T12:00:00.000Z' },
      { id: 'at-end', executedAt: '2026-01-01T17:00:00.000Z' },
      { id: 'after', executedAt: '2026-01-01T17:00:00.001Z' },
    ])
    const bounds = { executedFrom: utc('2026-01-01T09:00:00.000Z'), executedTo: utc('2026-01-01T17:00:00.000Z') }

    expect(ids(await repository.listInTradeOrder(bounds))).toEqual(['at-start', 'inside', 'at-end'])
    expect(ids(await repository.listInTradeOrder({ executedFrom: bounds.executedFrom }))).toEqual(['at-start', 'inside', 'at-end', 'after'])
    expect(ids(await repository.listInTradeOrder({ executedTo: bounds.executedTo }))).toEqual(['before', 'at-start', 'inside', 'at-end'])
    expect(ids(await repository.listInTradeOrder({ executedFrom: bounds.executedTo, executedTo: bounds.executedTo }))).toEqual(['at-end'])
  })

  it('combines every filter with AND', async () => {
    const repository = await seeded(HISTORY)
    const filter = {
      symbolContains: 'MSF', side: 'Sell', executedFrom: utc('2026-01-01T09:30:00Z'), executedTo: utc('2026-01-02T09:00:00Z'),
    } as const

    expect(ids(await repository.listInTradeOrder(filter))).toEqual(['msf-sell', 'xmsftx-sell'])
    expect(ids(await repository.listInTradeOrder({ ...filter, side: 'Buy' }))).toEqual([])
    expect(ids(await repository.listInTradeOrder({ ...filter, executedTo: utc('2026-01-01T23:59:59.999Z') }))).toEqual(['msf-sell'])
  })

  it('returns trades with decimals and timestamps exactly as stored, and changes no row', async () => {
    const repository = await seeded([{ id: 'exact', symbol: 'MSFT', quantity: '123456789012345.1234567891', price: '0.0000000001' }])
    const before = rawRows(db)

    const [found] = await repository.listInTradeOrder({ symbolContains: 'SF', side: 'Buy', executedFrom: utc('2026-01-01T09:00:00Z') })

    expect(found === undefined ? undefined : view(found))
      .toMatchObject({ id: 'exact', quantity: '123456789012345.1234567891', price: '0.0000000001' })
    expect(rawRows(db)).toEqual(before)
  })

  it('binds the search as a value, never as SQL', async () => {
    const repository = await seeded(HISTORY)

    expect(await repository.listInTradeOrder({ symbolContains: "') > 0 OR 1=1 --" })).toEqual([])
    expect(count()).toBe(HISTORY.length)
  })
})

describe('infrastructure: Drizzle trade repository pages', () => {
  const NEWEST_FIRST = { filter: {}, sort: { field: 'executedAt', direction: 'desc' } } as const

  it('answers an empty table with no trades and a count of zero', async () => {
    const repository = createDrizzleTradeRepository(db)

    expect(await repository.listPage(NEWEST_FIRST, { page: 1, pageSize: 50 })).toEqual({ trades: [], totalCount: 0 })
  })

  it('answers a page past the last, even the highest page number, without reading any trade', async () => {
    const repository = createDrizzleTradeRepository(db)
    for (const id of ['a', 'b', 'c']) await repository.add(newTrade({ id }))

    expect(await repository.listPage(NEWEST_FIRST, { page: 2, pageSize: 3 })).toEqual({ trades: [], totalCount: 3 })
    expect(await repository.listPage(NEWEST_FIRST, { page: Number.MAX_SAFE_INTEGER, pageSize: 100 })).toEqual({ trades: [], totalCount: 3 })
  })

  it('reads in a transaction it always ends, and changes no row', async () => {
    const repository = createDrizzleTradeRepository(db)
    for (const id of ['a', 'b', 'c']) await repository.add(newTrade({ id, executedAt: `2026-01-0${id === 'a' ? '1' : id === 'b' ? '2' : '3'}T00:00:00Z` }))
    const before = rawRows(db)

    const page = await repository.listPage(NEWEST_FIRST, { page: 2, pageSize: 2 })

    expect(page.trades.map((trade) => trade.id)).toEqual(['a'])
    expect(page.totalCount).toBe(3)
    expect(db.$client.isTransaction).toBe(false)
    expect(rawRows(db)).toEqual(before)
  })

  it('counts and lists trades another connection booked since the last page', async () => {
    const reader = createDrizzleTradeRepository(database.open())
    const writer = createDrizzleTradeRepository(db)
    await writer.add(newTrade({ id: 'first', executedAt: '2026-01-01T00:00:00Z' }))
    expect(await reader.listPage(NEWEST_FIRST, { page: 1, pageSize: 1 })).toMatchObject({ totalCount: 1 })

    await writer.add(newTrade({ id: 'second', executedAt: '2026-01-02T00:00:00Z' }))
    const page = await reader.listPage(NEWEST_FIRST, { page: 1, pageSize: 1 })

    expect([page.totalCount, page.trades.map((trade) => trade.id)]).toEqual([2, ['second']])
  })
})

describe('infrastructure: how a page is read', () => {
  const never = (): number => {
    throw new Error('The number of trades was not needed.')
  }

  it('reads a page in the first half from the start, without asking how many trades there are', () => {
    expect(planPageRead({ offset: 0, limit: 50 }, 25_000, 'quantity', {}, never)).toEqual({ fromEnd: false, skip: 0, useSortIndex: true })
    expect(planPageRead({ offset: 100, limit: 50 }, 250, 'quantity', {}, never)).toEqual({ fromEnd: false, skip: 100, useSortIndex: true })
  })

  it('reads a page in the second half from the end, skipping the rows after it', () => {
    expect(planPageRead({ offset: 24_950, limit: 50 }, 25_000, 'quantity', {}, never)).toEqual({ fromEnd: true, skip: 0, useSortIndex: true })
    expect(planPageRead({ offset: 100, limit: 20 }, 120, 'quantity', {}, never)).toEqual({ fromEnd: true, skip: 0, useSortIndex: true })
    expect(planPageRead({ offset: 150, limit: 50 }, 250, 'quantity', {}, never)).toEqual({ fromEnd: true, skip: 50, useSortIndex: true })
  })

  it('walks the sort index for date filters, which an index serves, however deep the page', () => {
    const dates = { executedFrom: utc('2025-01-01T00:00:00Z'), executedTo: utc('2026-01-01T00:00:00Z') }

    expect(planPageRead({ offset: 7_000, limit: 50 }, 15_000, 'quantity', dates, never).useSortIndex).toBe(true)
  })

  it('walks to a first or last page among few matches, and sorts the matches for a page deep among them', () => {
    const few = { symbolContains: 'BRK' }

    expect(planPageRead({ offset: 0, limit: 50 }, 1_017, 'quantity', few, () => 25_000).useSortIndex).toBe(true)
    expect(planPageRead({ offset: 1_000, limit: 17 }, 1_017, 'quantity', few, () => 25_000)).toEqual({ fromEnd: true, skip: 0, useSortIndex: true })
    expect(planPageRead({ offset: 500, limit: 50 }, 1_017, 'quantity', few, () => 25_000).useSortIndex).toBe(false)
    expect(planPageRead({ offset: 250, limit: 50 }, 1_017, 'quantity', few, () => 25_000).useSortIndex).toBe(false)
  })

  it('keeps walking when half the trades match, where walking measured no dearer than sorting', () => {
    expect(planPageRead({ offset: 6_200, limit: 50 }, 12_441, 'quantity', { side: 'Buy' }, () => 25_000).useSortIndex).toBe(true)
  })

  it('always walks the execution-time index, which lists trades in about the order they are stored', () => {
    for (const filter of [{ symbolContains: 'BRK' }, { side: 'Buy' as const }]) {
      expect(planPageRead({ offset: 500, limit: 50 }, 1_017, 'executedAt', filter, never).useSortIndex).toBe(true)
    }
  })

  it('weighs symbol sorts like quantity and price: the symbol index is not in stored order either', () => {
    expect(planPageRead({ offset: 500, limit: 50 }, 1_017, 'symbol', { side: 'Sell' }, () => 25_000).useSortIndex).toBe(false)
  })
})
