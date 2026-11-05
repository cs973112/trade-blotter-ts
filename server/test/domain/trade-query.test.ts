import { describe, expect, it } from 'vitest'

import { Dec } from '../../src/domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../../src/domain/symbol.ts'
import {
  compareTrades,
  DEFAULT_TRADE_SORT,
  SORT_DIRECTIONS,
  TRADE_SORT_FIELDS,
  validateTradeQuery,
  type TradeQuery,
  type TradeQueryRequest,
  type TradeSort,
} from '../../src/domain/trade-query.ts'
import type { Trade } from '../../src/domain/trade.ts'
import { newTrade } from '../support/trades.ts'

const RULES = { symbolMaxLength: DEFAULT_SYMBOL_MAX_LENGTH }

function validated(request: TradeQueryRequest): TradeQuery {
  const result = validateTradeQuery(request, RULES)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

function errorsOf(request: TradeQueryRequest, rules = RULES): Record<string, readonly string[] | undefined> {
  const result = validateTradeQuery(request, rules)
  if (result.ok) throw new Error('Expected the query to be invalid.')
  return result.errors
}

const TIMESTAMP_MESSAGE = (name: string) =>
  `${name} must be an RFC 3339 date-time with Z or an offset, such as 2026-01-01T09:00:00Z; write + in an offset as %2B.`

describe('domain: trade query validation', () => {
  it('reads no parameters as every trade in the default order: newest execution first', () => {
    expect(validated({})).toEqual({ filter: {}, sort: { field: 'executedAt', direction: 'desc' } })
    expect(DEFAULT_TRADE_SORT).toEqual({ field: 'executedAt', direction: 'desc' })
  })

  it('treats every empty parameter as omitted', () => {
    expect(validated({ symbol: '', side: '', executedFrom: '', executedTo: '', sortBy: '', sortDirection: '' }))
      .toEqual(validated({}))
  })

  it('ignores members that are not query parameters', () => {
    const request = { symbol: 'a', page: '2', limit: 'x', id: 'y' } as TradeQueryRequest

    expect(validated(request)).toEqual(validated({ symbol: 'a' }))
  })

  it.each([
    ['msft', 'MSFT'],
    ['MsFt', 'MSFT'],
    ['sf', 'SF'],
    ['  sf  ', 'SF'],
    ['brk.b', 'BRK.B'],
    ['%', '%'],
    ['_', '_'],
    ['straße', 'STRASSE'],
    ['e\u0301', '\u00c9'],
  ])('normalises the symbol search %j like a symbol, to %j', (symbol, symbolContains) => {
    expect(validated({ symbol }).filter).toEqual({ symbolContains })
  })

  it('treats a blank symbol search as no filter', () => {
    expect(validated({ symbol: '   ' }).filter).toEqual({})
  })

  it('refuses a symbol search longer than any symbol, or with invisible characters', () => {
    expect(errorsOf({ symbol: 'A'.repeat(DEFAULT_SYMBOL_MAX_LENGTH + 1) })).toEqual({ symbol: ['symbol must be at most 64 characters.'] })
    expect(errorsOf({ symbol: 'AB' }, { symbolMaxLength: 1 })).toEqual({ symbol: ['symbol must be at most 1 characters.'] })
    expect(errorsOf({ symbol: 'A\u200bB' })).toEqual({ symbol: ['symbol must not contain control or invisible characters.'] })
    expect(validated({ symbol: 'A'.repeat(DEFAULT_SYMBOL_MAX_LENGTH) }).filter.symbolContains).toHaveLength(64)
  })

  it.each([['Buy', 'Buy'], ['buy', 'Buy'], ['BUY', 'Buy'], [' sell ', 'Sell'], ['SELL', 'Sell']])(
    'reads side %j as %s', (side, expected) => {
      expect(validated({ side }).filter).toEqual({ side: expected })
    })

  it.each(['all', 'Both', 'B', 'S', ' ', 'Buy,Sell'])('refuses side %j', (side) => {
    expect(errorsOf({ side })).toEqual({ side: ['side must be Buy or Sell.'] })
  })

  it.each([
    ['2026-01-01T09:00:00Z', '2026-01-01T09:00:00.000Z'],
    ['2026-01-01T09:00:00.5+05:30', '2026-01-01T03:30:00.500Z'],
    ['2026-01-01T23:30:00-08:00', '2026-01-02T07:30:00.000Z'],
    ['2026-01-01t09:00:00.999z', '2026-01-01T09:00:00.999Z'],
    ['2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T00:00:00-00:00', '2026-01-01T00:00:00.000Z'],
  ])('normalises the execution bound %s to UTC as %s', (text, expected) => {
    expect(validated({ executedFrom: text, executedTo: text }).filter).toEqual({ executedFrom: expected, executedTo: expected })
  })

  it.each([
    ['a date alone', '2026-01-01'],
    ['no offset', '2026-01-01T09:00:00'],
    ['no seconds', '2026-01-01T09:00Z'],
    ['an offset whose + became a space in the URL', '2026-01-01T09:00:00 05:00'],
    ['a space instead of T', '2026-01-01 09:00:00Z'],
    ['more than millisecond precision', '2026-01-01T09:00:00.0001Z'],
    ['a day that does not exist', '2026-02-29T09:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['a leap second', '2026-12-31T23:59:60Z'],
    ['an offset without a colon', '2026-01-01T09:00:00+0500'],
    ['a compact form', '20260101T090000Z'],
    ['epoch milliseconds', '1767258000000'],
    ['words', 'yesterday'],
    ['surrounding spaces', ' 2026-01-01T09:00:00Z'],
  ])('refuses %s as an execution bound, rather than guessing', (_name, text) => {
    expect(errorsOf({ executedFrom: text, executedTo: text }))
      .toEqual({ executedFrom: [TIMESTAMP_MESSAGE('executedFrom')], executedTo: [TIMESTAMP_MESSAGE('executedTo')] })
  })

  it('accepts a start equal to the end and refuses a start after the end, comparing instants across offsets', () => {
    expect(validated({ executedFrom: '2026-01-01T09:00:00Z', executedTo: '2026-01-01T04:00:00-05:00' }).filter)
      .toEqual({ executedFrom: '2026-01-01T09:00:00.000Z', executedTo: '2026-01-01T09:00:00.000Z' })
    // 10:00+02:00 is 08:00Z: later as text, earlier as an instant.
    expect(errorsOf({ executedFrom: '2026-01-01T09:00:00Z', executedTo: '2026-01-01T10:00:00+02:00' }))
      .toEqual({ executedTo: ['executedTo must not be earlier than executedFrom.'] })
    expect(errorsOf({ executedFrom: '2026-01-01T09:00:00.001Z', executedTo: '2026-01-01T09:00:00Z' }))
      .toEqual({ executedTo: ['executedTo must not be earlier than executedFrom.'] })
  })

  it('accepts either bound alone', () => {
    expect(validated({ executedFrom: '2026-01-01T09:00:00Z' }).filter).toEqual({ executedFrom: '2026-01-01T09:00:00.000Z' })
    expect(validated({ executedTo: '2026-01-01T09:00:00Z' }).filter).toEqual({ executedTo: '2026-01-01T09:00:00.000Z' })
  })

  it('reads every sort field and direction, each defaulting separately', () => {
    for (const field of TRADE_SORT_FIELDS) {
      for (const direction of SORT_DIRECTIONS) {
        expect(validated({ sortBy: field, sortDirection: direction }).sort).toEqual({ field, direction })
      }
    }
    expect(validated({ sortBy: 'price' }).sort).toEqual({ field: 'price', direction: 'desc' })
    expect(validated({ sortDirection: 'asc' }).sort).toEqual({ field: 'executedAt', direction: 'asc' })
  })

  it.each([['Price'], ['PRICE'], ['notional'], ['side'], ['bookingSequence'], ['createdAt'], [' price']])(
    'refuses sortBy %j', (sortBy) => {
      expect(errorsOf({ sortBy })).toEqual({ sortBy: ['sortBy must be one of executedAt, symbol, quantity, price.'] })
    })

  it.each([['ASC'], ['Desc'], ['ascending'], ['up'], ['1'], ['-1']])('refuses sortDirection %j', (sortDirection) => {
    expect(errorsOf({ sortDirection })).toEqual({ sortDirection: ['sortDirection must be one of asc, desc.'] })
  })

  it('refuses a repeated parameter instead of choosing one of its values', () => {
    const repeated = { symbol: ['A', 'B'], side: ['Buy', 'Buy'], executedFrom: ['x', 'y'], executedTo: ['x', 'y'],
      sortBy: ['price', 'symbol'], sortDirection: ['asc', 'desc'] }

    expect(errorsOf(repeated)).toEqual({
      symbol: ['symbol must be given at most once.'],
      side: ['side must be given at most once.'],
      executedFrom: ['executedFrom must be given at most once.'],
      executedTo: ['executedTo must be given at most once.'],
      sortBy: ['sortBy must be given at most once.'],
      sortDirection: ['sortDirection must be given at most once.'],
    })
  })

  it('reports every invalid parameter at once, in parameter order', () => {
    const errors = errorsOf({ sortDirection: 'up', sortBy: 'x', executedTo: 'y', executedFrom: 'z', side: 'hold', symbol: '\u0000' })

    expect(Object.keys(errors)).toEqual(['symbol', 'side', 'executedFrom', 'executedTo', 'sortBy', 'sortDirection'])
  })

  it('combines every filter and the sort', () => {
    expect(validated({
      symbol: 'ms', side: 'sell', executedFrom: '2026-01-01T00:00:00+01:00', executedTo: '2026-01-31T23:59:59.999-05:00',
      sortBy: 'quantity', sortDirection: 'asc',
    })).toEqual({
      filter: { symbolContains: 'MS', side: 'Sell', executedFrom: '2025-12-31T23:00:00.000Z', executedTo: '2026-02-01T04:59:59.999Z' },
      sort: { field: 'quantity', direction: 'asc' },
    })
  })
})

let sequence = 0

/** A booked trade; booking sequences increase in the order trades are made. */
const booked = (overrides: Parameters<typeof newTrade>[0] = {}): Trade => ({ ...newTrade(overrides), bookingSequence: ++sequence })

const sorted = (trades: readonly Trade[], sort: TradeSort): string[] => [...trades].sort(compareTrades(sort)).map((trade) => trade.id)

describe('domain: trade sort order', () => {
  it('compares quantities and prices by exact value, where text order would be wrong', () => {
    const values = ['10', '9', '0.5', '100.25', '100.2', '0.0000000001', '999999999999999.9999999999', '999999999999999.9999999998', '2']
    const trades = values.map((value) => booked({ id: value, quantity: value, price: value }))
    const ascending = ['0.0000000001', '0.5', '2', '9', '10', '100.2', '100.25', '999999999999999.9999999998', '999999999999999.9999999999']

    for (const field of ['quantity', 'price'] as const) {
      expect(sorted(trades, { field, direction: 'asc' })).toEqual(ascending)
      expect(sorted(trades, { field, direction: 'desc' })).toEqual([...ascending].reverse())
    }
    // The text order, which the comparison must not follow.
    expect([...values].sort()).not.toEqual(ascending)
  })

  it('distinguishes decimals that are equal as JavaScript numbers', () => {
    const low = booked({ id: 'low', price: '123456789012345.1234567890' })
    const high = booked({ id: 'high', price: '123456789012345.1234567891' })

    expect(Number(low.price.toFixed())).toBe(Number(high.price.toFixed()))
    expect(sorted([high, low], { field: 'price', direction: 'asc' })).toEqual(['low', 'high'])
  })

  it('sorts symbols by Unicode code point, independent of locale', () => {
    const trades = ['MSFT', 'AAPL', 'A', 'ÉCOLE', 'BRK.B', 'BRK-B', 'Z'].map((symbol) => booked({ id: symbol, symbol }))

    expect(sorted(trades, { field: 'symbol', direction: 'asc' })).toEqual(['A', 'AAPL', 'BRK-B', 'BRK.B', 'MSFT', 'Z', 'ÉCOLE'])
    expect(sorted(trades, { field: 'symbol', direction: 'desc' })).toEqual(['ÉCOLE', 'Z', 'MSFT', 'BRK.B', 'BRK-B', 'AAPL', 'A'])
  })

  it('sorts by execution time, breaking ties by booking sequence in the same direction', () => {
    const trades = [
      booked({ id: 'late', executedAt: '2026-01-02T00:00:00Z' }),
      booked({ id: 'tie-1', executedAt: '2026-01-01T00:00:00Z' }),
      booked({ id: 'early', executedAt: '2025-12-31T00:00:00Z' }),
      booked({ id: 'tie-2', executedAt: '2026-01-01T00:00:00Z' }),
    ]

    expect(sorted(trades, { field: 'executedAt', direction: 'asc' })).toEqual(['early', 'tie-1', 'tie-2', 'late'])
    expect(sorted(trades, { field: 'executedAt', direction: 'desc' })).toEqual(['late', 'tie-2', 'tie-1', 'early'])
  })

  it.each(TRADE_SORT_FIELDS)('breaks ties on %s by execution time, then booking sequence, in the sort direction', (field) => {
    // Every trade has the same symbol, quantity and price; two share an execution time too.
    const trades = [
      booked({ id: 'second', executedAt: '2026-01-02T00:00:00Z' }),
      booked({ id: 'first', executedAt: '2026-01-01T00:00:00Z' }),
      booked({ id: 'third-a', executedAt: '2026-01-03T00:00:00Z' }),
      booked({ id: 'third-b', executedAt: '2026-01-03T00:00:00Z' }),
    ]

    expect(sorted(trades, { field, direction: 'asc' })).toEqual(['first', 'second', 'third-a', 'third-b'])
    expect(sorted(trades, { field, direction: 'desc' })).toEqual(['third-b', 'third-a', 'second', 'first'])
  })

  it.each(TRADE_SORT_FIELDS)('gives one order for %s whatever order the trades arrive in, and desc is asc reversed', (field) => {
    const trades = ['B', 'A', 'B', 'C', 'A'].flatMap((symbol, index) => ['1', '1.0', '2'].map((value) => booked({
      id: `${symbol}-${String(index)}-${value}`, symbol, quantity: value, price: value,
      executedAt: `2026-01-0${String(1 + (index % 2))}T00:00:00Z`,
    })))
    const ascending = sorted(trades, { field, direction: 'asc' })

    expect(sorted([...trades].reverse(), { field, direction: 'asc' })).toEqual(ascending)
    expect(sorted(trades, { field, direction: 'desc' })).toEqual([...ascending].reverse())
    expect(new Set(ascending).size).toBe(trades.length)
  })

  it('treats equal decimals written differently as equal, leaving the tie to trade order', () => {
    const a = booked({ id: 'a', price: '1.5' })
    const b = { ...booked({ id: 'b' }), price: new Dec('1.50') }

    expect(compareTrades({ field: 'price', direction: 'asc' })(a, b)).toBeLessThan(0)
    expect(sorted([b, a], { field: 'price', direction: 'asc' })).toEqual(['a', 'b'])
  })
})
