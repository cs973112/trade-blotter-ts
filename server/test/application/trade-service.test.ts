import { describe, expect, it } from 'vitest'

import {
  ExecutionLimitError, ExecutionValidationError, TradeNotFoundError, TradeQueryValidationError, TradeStateError, TradeValidationError,
} from '../../src/application/errors.ts'
import type { LifecycleTradeRepository } from '../../src/application/ports.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { decimalText } from '../../src/domain/decimal.ts'
import type { ListedTrade } from '../../src/domain/trade-status.ts'
import { PositionLimitError } from '../../src/domain/position.ts'
import { notional, type TradeRequest } from '../../src/domain/trade.ts'
import { BOOKED, TRADE_REQUEST_SCENARIOS } from '../scenarios/trade-requests.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { createInMemoryLifecycleRepository } from '../support/in-memory-lifecycle-repository.ts'
import { parseTradeRequestBody } from '../support/request-body.ts'

const CLOCK_TIME = '2026-03-01T12:00:00.000Z'

function setup(options: { symbolMaxLength?: number } = {}) {
  const trades = createInMemoryLifecycleRepository()
  const clock = createFixedClock(CLOCK_TIME)
  const service = createTradeService({ trades, clock, ids: createSequentialIds(), ...options })
  return { trades, clock, service }
}

const request = (overrides: TradeRequest = {}): TradeRequest =>
  ({ symbol: 'ABC', side: 'Buy', quantity: '1', price: '1', ...overrides })

/** Books a trade and executes it with the clock reading `at` for both. */
async function executed(context: ReturnType<typeof setup>, body: TradeRequest, at: string): Promise<ListedTrade> {
  context.clock.set(at)
  const booked = await context.service.createTrade(body)
  return context.service.executeTrade(booked.id, undefined)
}

/** A service over `trades` that calls `read` before every read of the repository. */
function countingReads(trades: LifecycleTradeRepository, read: () => void) {
  return createTradeService({
    trades: {
      ...trades,
      listForPositions: () => { read(); return trades.listForPositions() },
      list: (query) => { read(); return trades.list(query) },
      listPage: (query, page) => { read(); return trades.listPage(query, page) },
    },
    clock: createFixedClock(CLOCK_TIME),
    ids: createSequentialIds(),
  })
}

async function rejection(promise: Promise<unknown>): Promise<TradeValidationError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TradeValidationError) return error
    throw error
  }
  throw new Error('Expected a TradeValidationError.')
}

describe('application: creating trades', () => {
  const objectScenarios = TRADE_REQUEST_SCENARIOS.flatMap((scenario) => {
    const body = parseTradeRequestBody(scenario.body)
    return body === undefined ? [] : [[scenario.name, body, scenario.expected] as const]
  })

  it.each(objectScenarios)('scenario: %s', async (_name, body, expected) => {
    const { trades, service } = setup()

    if (expected.status === 400) {
      const error = await rejection(service.createTrade(body))
      expect(Object.keys(error.errors)).toEqual(expected.fields)
      expect(trades.stored).toEqual([])
      return
    }
    const trade = await service.createTrade(body)
    expect({
      symbol: trade.symbol,
      side: trade.side,
      quantity: decimalText(trade.quantity),
      price: decimalText(trade.price),
      notional: decimalText(notional(trade)),
    }).toEqual({ ...expected, status: undefined })
    expect(trade).toMatchObject(BOOKED)
    expect([trade.createdAt, trade.updatedAt]).toEqual([CLOCK_TIME, CLOCK_TIME])
    expect(trades.stored).toHaveLength(1)
    expect({ ...trades.stored[0], cancellation: null }).toEqual(trade)
  })

  it('assigns the id, the booking sequence and the server timestamps', async () => {
    const { service } = setup()

    const trade = await service.createTrade(request())

    expect(trade).toMatchObject({
      id: 'trade-1',
      bookingSequence: 1,
      status: 'Pending',
      executedAt: null,
      createdAt: CLOCK_TIME,
      updatedAt: CLOCK_TIME,
    })
  })

  it('reads the clock once per booking: createdAt and updatedAt; a booking has no executedAt', async () => {
    const { clock, service } = setup()

    const trade = await service.createTrade(request())

    expect(clock.reads).toBe(1)
    expect([trade.executedAt, trade.createdAt, trade.updatedAt]).toEqual([null, CLOCK_TIME, CLOCK_TIME])
  })

  it('refuses a booking as Executed or with an execution time, without reading the clock or storing anything', async () => {
    const { clock, service, trades } = setup()

    expect(Object.keys((await rejection(service.createTrade(request({ status: 'Executed' })))).errors)).toEqual(['status'])
    expect(Object.keys((await rejection(service.createTrade(request({ executedAt: '2026-01-01T09:00:00Z' })))).errors)).toEqual(['executedAt'])
    expect(clock.reads).toBe(0)
    expect(trades.stored).toEqual([])
  })

  it('takes createdAt and updatedAt from the clock even when the request supplies them', async () => {
    const { service } = setup()
    const body = { ...request(), createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z' }

    const trade = await service.createTrade(body)

    expect([trade.createdAt, trade.updatedAt]).toEqual([CLOCK_TIME, CLOCK_TIME])
  })

  it('normalises the clock reading to canonical UTC with milliseconds', async () => {
    const { clock, service } = setup()
    clock.set('2026-03-01T13:00:00+01:00')

    const trade = await service.createTrade(request({ executedAt: null }))

    expect(trade.createdAt).toBe(CLOCK_TIME)
  })

  it('does not read the clock, use an id or store anything when the request is invalid', async () => {
    const { clock, service, trades } = setup()

    const error = await rejection(service.createTrade(request({ symbol: '', quantity: '0' })))

    expect(error.errors).toEqual({ symbol: ['Symbol is required.'], quantity: ['Quantity must be greater than zero.'] })
    expect(error.message).toBe('Symbol is required.')
    expect(clock.reads).toBe(0)
    expect(trades.stored).toEqual([])
    expect((await service.createTrade(request())).id).toBe('trade-1')
  })

  it('applies a configured maximum symbol length', async () => {
    const { service } = setup({ symbolMaxLength: 3 })

    expect((await rejection(service.createTrade(request({ symbol: 'ABCD' })))).errors)
      .toEqual({ symbol: ['Symbol must be at most 3 characters.'] })
  })

  it.each([0, 256, 1.5, Number.NaN])('refuses a maximum symbol length of %s', (symbolMaxLength) => {
    expect(() => setup({ symbolMaxLength })).toThrow(RangeError)
  })
})

describe('application: executing a trade', () => {
  it('executes a Pending trade at one clock reading, as User, keeping its booking', async () => {
    const context = setup()
    const booked = await context.service.createTrade(request({ quantity: '5' }))
    context.clock.set('2026-03-01T13:00:00+01:00')
    const reads = context.clock.reads

    const trade = await context.service.executeTrade(booked.id, {})

    expect(context.clock.reads).toBe(reads + 1)
    expect(trade).toEqual({ ...booked, status: 'Executed', executedAt: CLOCK_TIME, updatedAt: CLOCK_TIME, updatedBy: 'User', cancellation: null })
    expect(context.trades.stored).toHaveLength(1)
    expect(context.trades.auditTrail.map((entry) => [entry.auditAction, entry.trade.status])).toEqual([['Inserted', 'Pending'], ['Updated', 'Executed']])
  })

  it('refuses a body with members, or that is not an object, before reading the clock or the trade', async () => {
    const context = setup()
    const booked = await context.service.createTrade(request())
    const reads = context.clock.reads

    for (const body of [{ executedAt: '2026-01-01T00:00:00Z' }, { updatedBy: 'Admin' }, [], 'now', 1]) {
      await expect(context.service.executeTrade(booked.id, body), JSON.stringify(body)).rejects.toBeInstanceOf(ExecutionValidationError)
    }
    expect(context.clock.reads).toBe(reads)
    expect(context.trades.stored[0]?.status).toBe('Pending')
  })

  it('refuses an unknown trade, and a trade that is Executed, Cancelled or a cancellation record', async () => {
    const context = setup()
    const done = await executed(context, request(), CLOCK_TIME)
    const pending = await context.service.createTrade(request())
    const { cancellationRecord } = await context.service.cancelTrade(pending.id, { reason: 'Withdrawn' })

    await expect(context.service.executeTrade('nope', undefined)).rejects.toBeInstanceOf(TradeNotFoundError)
    await expect(context.service.executeTrade(done.id, undefined)).rejects.toMatchObject({ name: 'TradeStateError', reason: 'already-executed' })
    await expect(context.service.executeTrade(pending.id, undefined)).rejects.toMatchObject({ name: 'TradeStateError', reason: 'already-cancelled' })
    await expect(context.service.executeTrade(cancellationRecord.id, undefined)).rejects.toBeInstanceOf(TradeStateError)
  })

  it('turns a position-limit breach into an ExecutionLimitError naming the trade and the symbol', async () => {
    const trades = createInMemoryLifecycleRepository()
    const service = createTradeService({ trades: { ...trades, execute: () => Promise.reject(new PositionLimitError('BIG')) }, clock: createFixedClock(CLOCK_TIME), ids: createSequentialIds() })

    await expect(service.executeTrade('t1', undefined)).rejects.toEqual(expect.objectContaining({ name: 'ExecutionLimitError', tradeId: 't1', symbol: 'BIG' }))
    await expect(service.executeTrade('t1', undefined)).rejects.toBeInstanceOf(ExecutionLimitError)
  })
})

describe('application: listing trades', () => {
  it('lists newest execution first, and later bookings first among equal execution times', async () => {
    const context = setup()
    const book = async (executedAt: string, symbol: string): Promise<ListedTrade> => executed(context, request({ symbol }), executedAt)

    await book('2026-01-01T09:00:00Z', 'A')
    await book('2026-01-01T10:00:00Z', 'B')
    // Booked later but executed earlier: the blotter follows execution time, not booking order.
    await book('2026-01-01T08:00:00Z', 'C')
    await book('2026-01-01T09:00:00Z', 'D')

    expect((await context.service.listTrades()).map((trade) => trade.symbol)).toEqual(['B', 'D', 'A', 'C'])
  })

  it('lists nothing when no trades are booked', async () => {
    expect(await setup().service.listTrades()).toEqual([])
  })
})

describe('application: searching, filtering and sorting trades', () => {
  async function booked() {
    const context = setup()
    const book = (symbol: string, side: string, quantity: string, price: string, executedAt: string) =>
      executed(context, { symbol, side, quantity, price }, executedAt)
    await book('msft', 'Buy', '10', '9', '2026-01-01T09:00:00Z') // trade-1
    await book('AAPL', 'Sell', '9', '10', '2026-01-02T09:00:00Z') // trade-2
    await book('xmsftx', 'Sell', '100', '0.5', '2026-01-03T09:00:00Z') // trade-3
    await book('MSFT', 'Buy', '2', '100.25', '2026-01-03T09:00:00Z') // trade-4
    return context
  }

  const ids = (trades: readonly ListedTrade[]): string[] => trades.map((trade) => trade.id)

  it('lists every trade newest first with no query, or an empty one, exactly as before', async () => {
    const { service } = await booked()

    const newestFirst = ['trade-4', 'trade-3', 'trade-2', 'trade-1']

    expect(ids(await service.listTrades())).toEqual(newestFirst)
    expect(ids(await service.listTrades({}))).toEqual(newestFirst)
    expect(ids(await service.listTrades({ sortBy: 'executedAt', sortDirection: 'desc' }))).toEqual(newestFirst)
  })

  it('filters with the normalised query, then sorts', async () => {
    const { service } = await booked()

    expect(ids(await service.listTrades({ symbol: 'Sf' }))).toEqual(['trade-4', 'trade-3', 'trade-1'])
    expect(ids(await service.listTrades({ symbol: 'sf', side: 'buy', sortBy: 'price', sortDirection: 'asc' }))).toEqual(['trade-1', 'trade-4'])
    expect(ids(await service.listTrades({ executedFrom: '2026-01-02T04:00:00-05:00', executedTo: '2026-01-03T09:00:00Z' })))
      .toEqual(['trade-4', 'trade-3', 'trade-2'])
    expect(ids(await service.listTrades({ symbol: 'ZZZ' }))).toEqual([])
  })

  it('sorts quantity and price by exact value', async () => {
    const { service } = await booked()

    expect(ids(await service.listTrades({ sortBy: 'quantity', sortDirection: 'asc' }))).toEqual(['trade-4', 'trade-2', 'trade-1', 'trade-3'])
    expect(ids(await service.listTrades({ sortBy: 'price', sortDirection: 'desc' }))).toEqual(['trade-4', 'trade-2', 'trade-1', 'trade-3'])
  })

  it('refuses an invalid query with every problem at once, before reading any trade', async () => {
    const { service, trades } = await booked()
    let reads = 0
    const counting = countingReads(trades, () => { reads++ })

    const error = await counting.listTrades({ side: 'hold', sortBy: 'notional' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TradeQueryValidationError)
    expect((error as TradeQueryValidationError).errors).toEqual({
      side: ['side must be Buy or Sell.'],
      sortBy: ['sortBy must be one of executedAt, symbol, quantity, price.'],
    })
    expect((error as TradeQueryValidationError).message).toBe('side must be Buy or Sell.')
    expect(reads).toBe(0)
    expect(ids(await service.listTrades())).toHaveLength(4)
  })

  it('applies the configured maximum symbol length to the search', async () => {
    const { service } = setup({ symbolMaxLength: 3 })

    await expect(service.listTrades({ symbol: 'ABCD' })).rejects.toThrow('symbol must be at most 3 characters.')
    expect(await service.listTrades({ symbol: 'ABC' })).toEqual([])
  })

  it('never changes what is stored', async () => {
    const { service, trades } = await booked()
    const before = trades.stored

    await service.listTrades({ symbol: 'msft', side: 'Sell', sortBy: 'symbol', sortDirection: 'asc' })
    await service.listTrades({ sortBy: 'price' })

    expect(trades.stored).toEqual(before)
  })
})

describe('application: listing a page of trades', () => {
  async function bookedMany(count: number) {
    const context = setup()
    for (let index = 0; index < count; index++) {
      await executed(context, request({ symbol: index % 2 === 0 ? 'EVEN' : 'ODD', price: `1.${String(index)}` }),
        `2026-01-01T09:${String(index % 60).padStart(2, '0')}:00Z`)
    }
    return context
  }

  const ids = (trades: readonly ListedTrade[]): string[] => trades.map((trade) => trade.id)

  it('answers the first page of 50 by default, with the totals', async () => {
    const { service } = await bookedMany(60)

    const page = await service.listTradePage()

    expect({ ...page, trades: page.trades.length }).toEqual({ trades: 50, page: 1, pageSize: 50, totalCount: 60, totalPages: 2 })
    expect(ids(page.trades)).toEqual(ids(await service.listTrades()).slice(0, 50))
  })

  it('pages through exactly what listTrades lists for the same query', async () => {
    const { service } = await bookedMany(23)
    const query = { symbol: 'odd', sortBy: 'price', sortDirection: 'asc' }
    const listed = ids(await service.listTrades(query))

    const pages = [1, 2, 3].map((page) => service.listTradePage({ ...query, page: String(page), pageSize: '4' }))
    const resolved = await Promise.all(pages)

    expect(resolved.map((page) => [page.page, page.totalCount, page.totalPages])).toEqual([[1, 11, 3], [2, 11, 3], [3, 11, 3]])
    expect(resolved.flatMap((page) => ids(page.trades))).toEqual(listed)
  })

  it('answers a page past the last with no trades and the real totals', async () => {
    const { service } = await bookedMany(5)

    expect(await service.listTradePage({ page: '2', pageSize: '5' }))
      .toEqual({ trades: [], page: 2, pageSize: 5, totalCount: 5, totalPages: 1 })
    expect(await service.listTradePage({ symbol: 'none', page: '9007199254740991' }))
      .toEqual({ trades: [], page: 9007199254740991, pageSize: 50, totalCount: 0, totalPages: 0 })
  })

  it('refuses invalid page parameters with every problem at once, before reading any trade', async () => {
    const { trades } = await bookedMany(1)
    let reads = 0
    const counting = countingReads(trades, () => { reads++ })

    const error = await counting.listTradePage({ side: 'hold', page: '0', pageSize: '101' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TradeQueryValidationError)
    expect((error as TradeQueryValidationError).errors).toEqual({
      side: ['side must be Buy or Sell.'],
      page: ['page must be a whole number from 1 to 9007199254740991.'],
      pageSize: ['pageSize must be a whole number from 1 to 100.'],
    })
    expect(reads).toBe(0)
  })

  it('reads the page and the count with one repository call', async () => {
    const { trades } = await bookedMany(3)
    let reads = 0
    const counting = countingReads(trades, () => { reads++ })

    await counting.listTradePage({ pageSize: '2', page: '2' })

    expect(reads).toBe(1)
  })
})
