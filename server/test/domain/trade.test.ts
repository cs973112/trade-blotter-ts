import { describe, expect, it } from 'vitest'

import { Dec, decimalText } from '../../src/domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../../src/domain/symbol.ts'
import { parseTimestamp, type UtcTimestamp } from '../../src/domain/timestamp.ts'
import {
  compareTradeOrder,
  createTrade,
  notional,
  validateExecutedTradeRequest,
  validateTradeRequest,
  type TradeRequest,
  type ValidExecutedTradeRequest,
  type ValidTradeRequest,
} from '../../src/domain/trade.ts'
import { bookTrade } from '../../src/domain/trade-status.ts'
import { BOOKED, EXECUTED_AT_CASES, TRADE_REQUEST_SCENARIOS } from '../scenarios/trade-requests.ts'
import { parseTradeRequestBody } from '../support/request-body.ts'

const RULES = { symbolMaxLength: DEFAULT_SYMBOL_MAX_LENGTH }
const utc = (text: string): UtcTimestamp => parseTimestamp(text) ?? (() => { throw new Error(text) })()
const NOW = utc('2026-03-01T12:00:00.000Z')

const VALID: TradeRequest = { symbol: 'abc', side: 'buy', quantity: '3', price: '101.25' }
/** A historical Executed trade's request, as the datasets write them. */
const HISTORICAL: TradeRequest = { ...VALID, executedAt: '2026-01-01T09:00:00+01:00' }
const BOOKING_EXECUTED_AT = 'A trade is booked as Pending, with no execution time: omit executedAt. The server sets it when the trade is executed.'

function validated(request: TradeRequest): ValidTradeRequest {
  const result = validateTradeRequest(request, RULES)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

function historical(request: TradeRequest): ValidExecutedTradeRequest {
  const result = validateExecutedTradeRequest(request, RULES)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('domain: booking request validation', () => {
  const objectScenarios = TRADE_REQUEST_SCENARIOS.flatMap((scenario) => {
    const request = parseTradeRequestBody(scenario.body)
    return request === undefined ? [] : [[scenario.name, request, scenario.expected] as const]
  })

  it.each(objectScenarios)('scenario: %s', (_name, request, expected) => {
    const result = validateTradeRequest(request, RULES)

    if (expected.status === 400) {
      expect(result.ok).toBe(false)
      expect(result.ok ? [] : Object.keys(result.errors)).toEqual(expected.fields)
      return
    }
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const trade = bookTrade(result.value, { id: 'id', now: NOW })
    expect({
      symbol: trade.symbol,
      side: trade.side,
      quantity: decimalText(trade.quantity),
      price: decimalText(trade.price),
      notional: decimalText(notional(trade)),
    }).toEqual({ ...expected, status: undefined })
    expect(trade).toMatchObject({ ...BOOKED, createdAt: NOW, updatedAt: NOW })
  })

  it('reports every invalid field at once, in field order, with a message each', () => {
    const result = validateTradeRequest({ status: 'Executed', executedAt: 'yesterday', price: '-1', quantity: '1e15', side: 'hold', symbol: ' ' }, RULES)

    expect(result).toEqual({
      ok: false,
      errors: {
        symbol: ['Symbol is required.'],
        side: ['Side must be Buy or Sell.'],
        quantity: ['Quantity must be less than 10^15 with at most 10 decimal places.'],
        price: ['Price must be greater than zero.'],
        executedAt: [BOOKING_EXECUTED_AT],
        status: ['A trade cannot be booked as Executed: it is booked as Pending, then executed (POST /trades/{id}/execution).'],
      },
    })
  })

  it.each([
    [{ symbol: 1 }, 'symbol', 'Symbol must be a string.'],
    [{ symbol: 'L'.repeat(65) }, 'symbol', 'Symbol must be at most 64 characters.'],
    [{ symbol: `A${String.fromCodePoint(0x200b)}` }, 'symbol', 'Symbol must not contain control or invisible characters.'],
    [{ quantity: undefined }, 'quantity', 'Quantity is required.'],
    [{ quantity: 'ten' }, 'quantity', 'Quantity must be a number.'],
    [{ price: 1 }, 'price', 'Price must be a number.'],
    [{ price: '0.00000000001' }, 'price', 'Price must be less than 10^15 with at most 10 decimal places.'],
  ] as const)('explains %o', (override, field, message) => {
    const result = validateTradeRequest({ ...VALID, ...override }, RULES)

    expect(result.ok ? {} : result.errors).toEqual({ [field]: [message] })
  })

  it('applies the configured symbol length', () => {
    expect(validateTradeRequest({ ...VALID, symbol: 'ABCDE' }, { symbolMaxLength: 4 })).toEqual({
      ok: false,
      errors: { symbol: ['Symbol must be at most 4 characters.'] },
    })
  })

  it('normalises the fields it accepts, always as Pending', () => {
    const expected = { symbol: 'ABC', side: 'Buy', quantity: new Dec(3), price: new Dec('101.25'), status: 'Pending' }
    expect(validated(VALID)).toEqual(expected)
    expect(validated({ ...VALID, status: ' PENDING ', executedAt: null })).toEqual(expected)
  })

  it('refuses every execution time, valid or not; null is none', () => {
    for (const executedAt of ['2026-01-01T09:00:00Z', 'yesterday', '', 0, false, {}]) {
      expect(validateTradeRequest({ ...VALID, executedAt }, RULES), JSON.stringify(executedAt)).toEqual({ ok: false, errors: { executedAt: [BOOKING_EXECUTED_AT] } })
    }
    expect(validateTradeRequest({ ...VALID, executedAt: null }, RULES).ok).toBe(true)
  })
})

describe('domain: historical Executed trade validation (datasets only)', () => {
  it.each(EXECUTED_AT_CASES)('reads executedAt: %s', (_name, text, utc) => {
    const result = validateExecutedTradeRequest({ ...VALID, executedAt: text }, RULES)
    expect(result).toEqual(utc === undefined
      ? { ok: false, errors: { executedAt: ['Execution time must be an RFC 3339 date-time with an offset, such as 2026-01-01T09:00:00Z.'] } }
      : { ok: true, value: { symbol: 'ABC', side: 'Buy', quantity: new Dec(3), price: new Dec('101.25'), executedAt: utc } })
  })

  it('reads no status, leaves a missing or null executedAt undefined, and checks the other fields as a booking does', () => {
    expect(historical({ ...HISTORICAL, status: 'Executed' })).toEqual({ symbol: 'ABC', side: 'Buy', quantity: new Dec(3), price: new Dec('101.25'), executedAt: '2026-01-01T08:00:00.000Z' })
    expect(historical({ ...VALID, executedAt: undefined }).executedAt).toBeUndefined()
    expect(historical({ ...VALID, executedAt: null }).executedAt).toBeUndefined()
    expect(validateExecutedTradeRequest({ symbol: ' ', side: 'hold', quantity: '0', price: '-1', executedAt: 1 }, RULES)).toMatchObject({
      ok: false, errors: { symbol: ['Symbol is required.'], side: ['Side must be Buy or Sell.'], quantity: ['Quantity must be greater than zero.'], price: ['Price must be greater than zero.'] },
    })
  })
})

describe('domain: historical trade creation', () => {
  it('keeps a supplied execution time and stamps createdAt and updatedAt with the one clock reading', () => {
    const trade = createTrade(historical(HISTORICAL), { id: 't1', now: NOW })

    expect(trade.id).toBe('t1')
    expect(trade.executedAt).toBe('2026-01-01T08:00:00.000Z')
    expect(trade.createdAt).toBe(NOW)
    expect(trade.updatedAt).toBe(NOW)
  })

  it('uses the clock reading for executedAt when the request has none', () => {
    const trade = createTrade(historical({ ...VALID, executedAt: null }), { id: 't1', now: NOW })

    expect([trade.executedAt, trade.createdAt, trade.updatedAt]).toEqual([NOW, NOW, NOW])
  })

  it('accepts an execution time later than the clock', () => {
    const trade = createTrade(historical({ ...VALID, executedAt: '2027-01-01T00:00:00Z' }), { id: 't1', now: NOW })

    expect(trade.executedAt > trade.createdAt).toBe(true)
  })

  it('is immutable', () => {
    const trade = createTrade(historical(HISTORICAL), { id: 't1', now: NOW })

    expect(Object.isFrozen(trade)).toBe(true)
    expect(() => {
      Object.assign(trade, { executedAt: NOW })
    }).toThrow(TypeError)
  })

  it('computes an exact notional', () => {
    const trade = createTrade(historical({ ...VALID, quantity: '999999999999999.9999999999', price: '999999999999999.9999999999' }),
      { id: 't1', now: NOW })

    expect(decimalText(notional(trade))).toBe('999999999999999999999999800000.00000000000000000001')
  })
})

describe('domain: trade order', () => {
  it('orders by execution time, then booking sequence', () => {
    const trades = [
      { executedAt: utc('2026-01-01T09:00:00Z'), bookingSequence: 3 },
      { executedAt: utc('2026-01-01T09:00:00Z'), bookingSequence: 1 },
      { executedAt: utc('2026-01-01T08:59:59.999Z'), bookingSequence: 2 },
      { executedAt: utc('2025-12-31T23:00:00Z'), bookingSequence: 4 },
    ]

    expect([...trades].sort(compareTradeOrder).map((trade) => trade.bookingSequence)).toEqual([4, 2, 1, 3])
  })
})
