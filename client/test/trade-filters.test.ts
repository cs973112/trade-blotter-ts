import { describe, expect, it } from 'vitest'

import type { Trade } from '../src/api/contracts.ts'
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TRADE_FILTERS,
  DEFAULT_TRADE_SORT,
  directionLabel,
  narrowsList,
  nextSort,
  PAGE_SIZES,
  SORT_FIELDS,
  sortDirections,
  toTradeQuery,
  tradeMatchesFilters,
  type TradeFilters,
} from '../src/lib/trade-filters.ts'
import type { OffsetAt } from '../src/lib/timestamps.ts'
import { zoneOffsetAt } from './support/time-zones.ts'

const NEW_YORK = zoneOffsetAt('America/New_York')

const filters = (overrides: Partial<TradeFilters>): TradeFilters => ({ ...DEFAULT_TRADE_FILTERS, ...overrides })

function query(overrides: Partial<TradeFilters>, offsetAt: OffsetAt = NEW_YORK) {
  const result = toTradeQuery(filters(overrides), offsetAt)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.query
}

function errors(overrides: Partial<TradeFilters>, offsetAt: OffsetAt = NEW_YORK) {
  const result = toTradeQuery(filters(overrides), offsetAt)
  if (result.ok) throw new Error('Expected the filters to be refused.')
  return result.errors
}

describe('trade filters: building the query', () => {
  it('gives an empty query for the defaults: no filter', () => {
    expect(DEFAULT_TRADE_FILTERS).toEqual({ symbol: '', side: '', fromDate: '', toDate: '' })
    expect(query({})).toEqual({})
  })

  it('sends the symbol search trimmed, in the case typed, and leaves a blank one out', () => {
    expect(query({ symbol: '  sF ' })).toEqual({ symbol: 'sF' })
    expect(query({ symbol: '   ' })).toEqual({})
  })

  it.each([['Buy'], ['Sell']] as const)('sends side %s, and no side for All', (side) => {
    expect(query({ side })).toEqual({ side })
    expect(query({ side: '' })).toEqual({})
  })

  it('turns From into the start of that local day and To into its last millisecond, in UTC', () => {
    expect(query({ fromDate: '2026-01-15', toDate: '2026-01-15' }))
      .toEqual({ executedFrom: '2026-01-15T05:00:00.000Z', executedTo: '2026-01-16T04:59:59.999Z' })
    expect(query({ fromDate: '2026-07-15' })).toEqual({ executedFrom: '2026-07-15T04:00:00.000Z' })
    expect(query({ toDate: '2026-07-15' })).toEqual({ executedTo: '2026-07-16T03:59:59.999Z' })
  })

  it('covers the 23-hour day when the clocks go forward and the 25-hour day when they go back', () => {
    expect(query({ fromDate: '2026-03-08', toDate: '2026-03-08' }))
      .toEqual({ executedFrom: '2026-03-08T05:00:00.000Z', executedTo: '2026-03-09T03:59:59.999Z' })
    expect(query({ fromDate: '2026-11-01', toDate: '2026-11-01' }))
      .toEqual({ executedFrom: '2026-11-01T04:00:00.000Z', executedTo: '2026-11-02T04:59:59.999Z' })
    // A range across both changes starts in standard time, ends in standard time, and spans summer.
    expect(query({ fromDate: '2026-03-01', toDate: '2026-11-30' }))
      .toEqual({ executedFrom: '2026-03-01T05:00:00.000Z', executedTo: '2026-12-01T04:59:59.999Z' })
  })

  it('uses the time zone it is given', () => {
    expect(query({ fromDate: '2026-01-15', toDate: '2026-01-15' }, () => 330))
      .toEqual({ executedFrom: '2026-01-14T18:30:00.000Z', executedTo: '2026-01-15T18:29:59.999Z' })
  })

  it('combines every filter, and never includes a sort: the column headers set it', () => {
    expect(query({ symbol: 'ms', side: 'Sell', fromDate: '2026-03-08', toDate: '2026-11-01' }))
      .toEqual({ symbol: 'ms', side: 'Sell', executedFrom: '2026-03-08T05:00:00.000Z', executedTo: '2026-11-02T04:59:59.999Z' })
  })
})

describe('trade filters: invalid dates', () => {
  it('refuses a From date later than the To date, and accepts the same date for both', () => {
    expect(errors({ fromDate: '2026-03-09', toDate: '2026-03-08' }))
      .toEqual({ toDate: 'The From date is later than the To date. Choose a To date on or after the From date.' })
    expect(errors({ fromDate: '2027-01-01', toDate: '2026-12-31' })).toHaveProperty('toDate')
    expect(query({ fromDate: '2026-03-08', toDate: '2026-03-08' })).toHaveProperty('executedTo')
  })

  it('refuses a date that is not a complete calendar date', () => {
    expect(errors({ fromDate: '2026-02-30' })).toEqual({ fromDate: 'Enter a complete From date between the years 0001 and 9999, or clear it.' })
    expect(errors({ toDate: '2026-13' })).toEqual({ toDate: 'Enter a complete To date between the years 0001 and 9999, or clear it.' })
    expect(Object.keys(errors({ fromDate: 'x', toDate: 'y' }))).toEqual(['fromDate', 'toDate'])
  })

  it('refuses a date whose boundary falls outside the years the API accepts', () => {
    expect(errors({ toDate: '9999-12-31' })).toHaveProperty('toDate')
    expect(errors({ fromDate: '0001-01-01' }, () => 60)).toHaveProperty('fromDate')
  })

  it('refuses a range made only of a calendar date the time zone skipped', () => {
    expect(errors({ fromDate: '2011-12-30', toDate: '2011-12-30' }, zoneOffsetAt('Pacific/Apia')))
      .toEqual({ toDate: 'Your time zone has no time between these dates. Choose other dates.' })
  })
})

describe('trade filters: labels', () => {
  it('names the sort fields as the page shows them', () => {
    expect(SORT_FIELDS.map((field) => [field.value, field.label])).toEqual([
      ['executedAt', 'Execution date'], ['symbol', 'Symbol'], ['quantity', 'Quantity'], ['price', 'Price'],
    ])
  })

  it('offers newest or oldest first for the execution date, and ascending or descending otherwise', () => {
    expect(sortDirections('executedAt')).toEqual([{ value: 'desc', label: 'Newest first' }, { value: 'asc', label: 'Oldest first' }])
    for (const field of ['symbol', 'quantity', 'price'] as const) {
      expect(sortDirections(field)).toEqual([{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }])
    }
  })

  it('tells a query that leaves trades out from one that only reorders them', () => {
    expect(narrowsList({})).toBe(false)
    expect(narrowsList({ sortBy: 'price', sortDirection: 'asc' })).toBe(false)
    expect(narrowsList({ symbol: 'A' })).toBe(true)
    expect(narrowsList({ side: 'Buy' })).toBe(true)
    expect(narrowsList({ executedFrom: '2026-01-01T00:00:00.000Z' })).toBe(true)
    expect(narrowsList({ executedTo: '2026-01-01T00:00:00.000Z' })).toBe(true)
  })
})

describe('trade filters: sorting by a column', () => {
  it('starts newest execution first', () => {
    expect(DEFAULT_TRADE_SORT).toEqual({ sortBy: 'executedAt', sortDirection: 'desc' })
  })

  it('starts another column in its first direction: ascending, or newest first for the execution date', () => {
    expect(nextSort(DEFAULT_TRADE_SORT, 'symbol')).toEqual({ sortBy: 'symbol', sortDirection: 'asc' })
    expect(nextSort(DEFAULT_TRADE_SORT, 'quantity')).toEqual({ sortBy: 'quantity', sortDirection: 'asc' })
    expect(nextSort({ sortBy: 'price', sortDirection: 'desc' }, 'executedAt')).toEqual({ sortBy: 'executedAt', sortDirection: 'desc' })
    expect(nextSort({ sortBy: 'quantity', sortDirection: 'desc' }, 'price')).toEqual({ sortBy: 'price', sortDirection: 'asc' })
  })

  it('reverses the active column, back and forth', () => {
    expect(nextSort(DEFAULT_TRADE_SORT, 'executedAt')).toEqual({ sortBy: 'executedAt', sortDirection: 'asc' })
    expect(nextSort({ sortBy: 'executedAt', sortDirection: 'asc' }, 'executedAt')).toEqual(DEFAULT_TRADE_SORT)
    expect(nextSort({ sortBy: 'price', sortDirection: 'asc' }, 'price')).toEqual({ sortBy: 'price', sortDirection: 'desc' })
    expect(nextSort({ sortBy: 'price', sortDirection: 'desc' }, 'price')).toEqual({ sortBy: 'price', sortDirection: 'asc' })
  })

  it('names each direction for its field', () => {
    expect([directionLabel('executedAt', 'desc'), directionLabel('executedAt', 'asc'), directionLabel('price', 'asc'), directionLabel('symbol', 'desc')])
      .toEqual(['Newest first', 'Oldest first', 'Ascending', 'Descending'])
  })

  it('offers pages of 25, 50 and 100 trades, 50 to begin with', () => {
    expect([...PAGE_SIZES]).toEqual([25, 50, 100])
    expect(DEFAULT_PAGE_SIZE).toBe(50)
  })
})

describe('trade filters: whether a booked trade matches the applied filters', () => {
  const trade = (overrides: Partial<Trade> = {}): Trade => ({
    id: 't', bookingSequence: 1, symbol: 'BRK.B', side: 'Buy', quantity: '1', price: '1', notional: '1',
    executedAt: '2026-03-08T05:00:00.000Z', createdAt: '2026-03-08T05:00:00.000Z', updatedAt: '2026-03-08T05:00:00.000Z', ...overrides,
  })

  it('matches everything without filters, and ignores the sort', () => {
    expect(tradeMatchesFilters(trade(), {})).toBe(true)
    expect(tradeMatchesFilters(trade(), { sortBy: 'price', sortDirection: 'asc' })).toBe(true)
  })

  it('matches the symbol search anywhere, normalised as the API does: trimmed, NFC and upper case', () => {
    for (const symbol of ['brk', ' rk.b ', 'K.', 'BRK.B']) expect(tradeMatchesFilters(trade(), { symbol })).toBe(true)
    expect(tradeMatchesFilters(trade(), { symbol: 'brkb' })).toBe(false)
    // "e" followed by a combining acute accent composes to the É the API stores.
    expect(tradeMatchesFilters(trade({ symbol: 'ÉCOLE' }), { symbol: `e${String.fromCodePoint(0x301)}co` })).toBe(true)
    expect(tradeMatchesFilters(trade({ symbol: 'ECOLE' }), { symbol: 'É' })).toBe(false)
  })

  it('matches the side exactly', () => {
    expect(tradeMatchesFilters(trade(), { side: 'Buy' })).toBe(true)
    expect(tradeMatchesFilters(trade(), { side: 'Sell' })).toBe(false)
  })

  it('includes both execution-time bounds, to the millisecond', () => {
    const at = '2026-03-08T05:00:00.000Z'
    expect(tradeMatchesFilters(trade(), { executedFrom: at, executedTo: at })).toBe(true)
    expect(tradeMatchesFilters(trade(), { executedFrom: '2026-03-08T05:00:00.001Z' })).toBe(false)
    expect(tradeMatchesFilters(trade(), { executedTo: '2026-03-08T04:59:59.999Z' })).toBe(false)
  })

  it('requires every filter at once', () => {
    expect(tradeMatchesFilters(trade(), { symbol: 'brk', side: 'Buy', executedFrom: '2026-01-01T00:00:00.000Z' })).toBe(true)
    expect(tradeMatchesFilters(trade(), { symbol: 'brk', side: 'Sell', executedFrom: '2026-01-01T00:00:00.000Z' })).toBe(false)
  })
})
