import { describe, expect, it } from 'vitest'

import { Dec, decimalText } from '../../src/domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../../src/domain/symbol.ts'
import { parseTimestamp, type UtcTimestamp } from '../../src/domain/timestamp.ts'
import {
  compareTradeOrder,
  createTrade,
  notional,
  validateTradeRequest,
  type TradeRequest,
  type ValidTradeRequest,
} from '../../src/domain/trade.ts'
import { TRADE_REQUEST_SCENARIOS } from '../scenarios/trade-requests.ts'
import { parseTradeRequestBody } from '../support/request-body.ts'

const RULES = { symbolMaxLength: DEFAULT_SYMBOL_MAX_LENGTH }
const utc = (text: string): UtcTimestamp => parseTimestamp(text) ?? (() => { throw new Error(text) })()
const NOW = utc('2026-03-01T12:00:00.000Z')

const VALID: TradeRequest = { symbol: 'abc', side: 'buy', quantity: '3', price: '101.25', executedAt: '2026-01-01T09:00:00+01:00' }

function validated(request: TradeRequest): ValidTradeRequest {
  const result = validateTradeRequest(request, RULES)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('domain: trade request validation', () => {
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
    const trade = createTrade(result.value, { id: 'id', now: NOW })
    expect({
      symbol: trade.symbol,
      side: trade.side,
      quantity: decimalText(trade.quantity),
      price: decimalText(trade.price),
      notional: decimalText(notional(trade)),
      executedAt: trade.executedAt,
    }).toEqual({ ...expected, status: undefined, executedAt: expected.executedAt === 'server clock' ? NOW : expected.executedAt })
  })

  it('reports every invalid field at once, in field order, with a message each', () => {
    const result = validateTradeRequest({ executedAt: 'yesterday', price: '-1', quantity: '1e15', side: 'hold', symbol: ' ' }, RULES)

    expect(result).toEqual({
      ok: false,
      errors: {
        symbol: ['Symbol is required.'],
        side: ['Side must be Buy or Sell.'],
        quantity: ['Quantity must be less than 10^15 with at most 10 decimal places.'],
        price: ['Price must be greater than zero.'],
        executedAt: ['Execution time must be an RFC 3339 date-time with an offset, such as 2026-01-01T09:00:00Z.'],
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

  it('normalises the fields it accepts', () => {
    expect(validated(VALID)).toEqual({
      symbol: 'ABC',
      side: 'Buy',
      quantity: new Dec(3),
      price: new Dec('101.25'),
      executedAt: '2026-01-01T08:00:00.000Z',
    })
  })

  it('leaves executedAt undefined when it is omitted or null', () => {
    expect(validated({ ...VALID, executedAt: undefined }).executedAt).toBeUndefined()
    expect(validated({ ...VALID, executedAt: null }).executedAt).toBeUndefined()
  })
})

describe('domain: trade creation', () => {
  it('keeps a supplied execution time and stamps createdAt and updatedAt with the one clock reading', () => {
    const trade = createTrade(validated(VALID), { id: 't1', now: NOW })

    expect(trade.id).toBe('t1')
    expect(trade.executedAt).toBe('2026-01-01T08:00:00.000Z')
    expect(trade.createdAt).toBe(NOW)
    expect(trade.updatedAt).toBe(NOW)
  })

  it('uses the clock reading for executedAt when the request has none', () => {
    const trade = createTrade(validated({ ...VALID, executedAt: null }), { id: 't1', now: NOW })

    expect([trade.executedAt, trade.createdAt, trade.updatedAt]).toEqual([NOW, NOW, NOW])
  })

  it('accepts an execution time later than the clock', () => {
    const trade = createTrade(validated({ ...VALID, executedAt: '2027-01-01T00:00:00Z' }), { id: 't1', now: NOW })

    expect(trade.executedAt > trade.createdAt).toBe(true)
  })

  it('is immutable', () => {
    const trade = createTrade(validated(VALID), { id: 't1', now: NOW })

    expect(Object.isFrozen(trade)).toBe(true)
    expect(() => {
      Object.assign(trade, { executedAt: NOW })
    }).toThrow(TypeError)
  })

  it('computes an exact notional', () => {
    const trade = createTrade(validated({ ...VALID, quantity: '999999999999999.9999999999', price: '999999999999999.9999999999' }),
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
