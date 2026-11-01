import { describe, expect, it } from 'vitest'

import { TradeValidationError } from '../../src/application/errors.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { decimalText } from '../../src/domain/decimal.ts'
import { notional, type Trade, type TradeRequest } from '../../src/domain/trade.ts'
import { TRADE_REQUEST_SCENARIOS } from '../scenarios/trade-requests.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { createInMemoryTradeRepository } from '../support/in-memory-trade-repository.ts'
import { parseTradeRequestBody } from '../support/request-body.ts'

const CLOCK_TIME = '2026-03-01T12:00:00.000Z'

function setup(options: { symbolMaxLength?: number } = {}) {
  const trades = createInMemoryTradeRepository()
  const clock = createFixedClock(CLOCK_TIME)
  const service = createTradeService({ trades, clock, ids: createSequentialIds(), ...options })
  return { trades, clock, service }
}

const request = (overrides: TradeRequest = {}): TradeRequest =>
  ({ symbol: 'ABC', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-01-01T09:00:00Z', ...overrides })

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
      executedAt: trade.executedAt,
    }).toEqual({ ...expected, status: undefined, executedAt: expected.executedAt === 'server clock' ? CLOCK_TIME : expected.executedAt })
    expect([trade.createdAt, trade.updatedAt]).toEqual([CLOCK_TIME, CLOCK_TIME])
    expect(trades.stored).toEqual([trade])
  })

  it('assigns the id, the booking sequence and the server timestamps', async () => {
    const { service } = setup()

    const trade = await service.createTrade(request())

    expect(trade).toMatchObject({
      id: 'trade-1',
      bookingSequence: 1,
      executedAt: '2026-01-01T09:00:00.000Z',
      createdAt: CLOCK_TIME,
      updatedAt: CLOCK_TIME,
    })
  })

  it('reads the clock once per trade, so a defaulted executedAt equals createdAt and updatedAt', async () => {
    const { clock, service } = setup()

    const trade = await service.createTrade(request({ executedAt: undefined }))

    expect(clock.reads).toBe(1)
    expect([trade.executedAt, trade.createdAt, trade.updatedAt]).toEqual([CLOCK_TIME, CLOCK_TIME, CLOCK_TIME])
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

describe('application: listing trades', () => {
  it('lists newest execution first, and later bookings first among equal execution times', async () => {
    const { clock, service } = setup()
    const book = async (executedAt: string, symbol: string): Promise<Trade> => service.createTrade(request({ symbol, executedAt }))

    await book('2026-01-01T09:00:00Z', 'A')
    await book('2026-01-01T10:00:00Z', 'B')
    // Recorded later but executed earlier: the blotter follows execution time, not recording time.
    clock.set('2026-03-02T00:00:00Z')
    await book('2026-01-01T08:00:00Z', 'C')
    await book('2026-01-01T09:00:00Z', 'D')

    expect((await service.listTrades()).map((trade) => trade.symbol)).toEqual(['B', 'D', 'A', 'C'])
  })

  it('lists nothing when no trades are booked', async () => {
    expect(await setup().service.listTrades()).toEqual([])
  })
})
