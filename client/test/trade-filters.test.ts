import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TRADE_FILTERS,
  narrowsList,
  SORT_FIELDS,
  sortDirections,
  toTradeQuery,
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
  it('gives an empty query for the defaults, so the list is requested exactly as before', () => {
    expect(DEFAULT_TRADE_FILTERS).toEqual({ symbol: '', side: '', fromDate: '', toDate: '', sortBy: 'executedAt', sortDirection: 'desc' })
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

  it('sends the sort only when it is not the default, and then both its field and direction', () => {
    expect(query({ sortBy: 'executedAt', sortDirection: 'desc' })).toEqual({})
    expect(query({ sortBy: 'executedAt', sortDirection: 'asc' })).toEqual({ sortBy: 'executedAt', sortDirection: 'asc' })
    for (const field of ['symbol', 'quantity', 'price'] as const) {
      expect(query({ sortBy: field, sortDirection: 'asc' })).toEqual({ sortBy: field, sortDirection: 'asc' })
      expect(query({ sortBy: field, sortDirection: 'desc' })).toEqual({ sortBy: field, sortDirection: 'desc' })
    }
  })

  it('combines every filter and the sort', () => {
    expect(query({ symbol: 'ms', side: 'Sell', fromDate: '2026-03-08', toDate: '2026-11-01', sortBy: 'price', sortDirection: 'asc' }))
      .toEqual({
        symbol: 'ms', side: 'Sell', executedFrom: '2026-03-08T05:00:00.000Z', executedTo: '2026-11-02T04:59:59.999Z',
        sortBy: 'price', sortDirection: 'asc',
      })
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
