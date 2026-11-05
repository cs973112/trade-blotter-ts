import type { Side, SortDirection, SortField, TradeQuery } from '../api/contracts.ts'
import { localDayEnd, localDayStart } from './local-dates.ts'
import { browserOffsetAt, type OffsetAt } from './timestamps.ts'

/**
 * The trade list's search, filter and sort controls as the user sets them, and their translation
 * into GET /trades query parameters. Dates are local calendar dates; both are included.
 */
export interface TradeFilters {
  symbol: string
  /** Empty: both sides. */
  side: Side | ''
  /** Local calendar dates from <input type="date">, such as "2026-03-08"; empty for no bound. */
  fromDate: string
  toDate: string
  sortBy: SortField
  sortDirection: SortDirection
}

/** No filter, newest execution first: the list as it is without any query. */
export const DEFAULT_TRADE_FILTERS: Readonly<TradeFilters> = Object.freeze({
  symbol: '', side: '', fromDate: '', toDate: '', sortBy: 'executedAt', sortDirection: 'desc',
})

export const SORT_FIELDS: readonly { readonly value: SortField; readonly label: string }[] = [
  { value: 'executedAt', label: 'Execution date' },
  { value: 'symbol', label: 'Symbol' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'price', label: 'Price' },
]

/** The directions for a sort field, named for that field: newest or oldest first for dates. */
export function sortDirections(field: SortField): readonly { readonly value: SortDirection; readonly label: string }[] {
  return field === 'executedAt'
    ? [{ value: 'desc', label: 'Newest first' }, { value: 'asc', label: 'Oldest first' }]
    : [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]
}

export type DateFilterErrors = Partial<Record<'fromDate' | 'toDate', string>>

/** For a date that is not a complete calendar date the API can accept, including one only partly typed. */
export const INCOMPLETE_DATE_MESSAGES: Readonly<Record<keyof DateFilterErrors, string>> = {
  fromDate: 'Enter a complete From date between the years 0001 and 9999, or clear it.',
  toDate: 'Enter a complete To date between the years 0001 and 9999, or clear it.',
}

export type TradeQueryResult =
  | { readonly ok: true; readonly query: TradeQuery }
  | { readonly ok: false; readonly errors: DateFilterErrors }

/**
 * Builds the query for a set of filters. Only what narrows or reorders the list is included: an
 * empty symbol or side, a missing date and the default sort are left out, so the default filters
 * give an empty query. Refuses an invalid date, or a From date after the To date, without
 * guessing.
 */
export function toTradeQuery(filters: TradeFilters, offsetAt: OffsetAt = browserOffsetAt): TradeQueryResult {
  const errors: DateFilterErrors = {}
  const executedFrom = filters.fromDate === '' ? undefined : localDayStart(filters.fromDate, offsetAt)
  const executedTo = filters.toDate === '' ? undefined : localDayEnd(filters.toDate, offsetAt)
  if (filters.fromDate !== '' && executedFrom === undefined) errors.fromDate = INCOMPLETE_DATE_MESSAGES.fromDate
  if (filters.toDate !== '' && executedTo === undefined) errors.toDate = INCOMPLETE_DATE_MESSAGES.toDate
  if (executedFrom !== undefined && executedTo !== undefined) {
    if (filters.fromDate > filters.toDate) {
      errors.toDate = 'The From date is later than the To date. Choose a To date on or after the From date.'
    } else if (executedTo < executedFrom) {
      // Only possible for a calendar date the time zone skipped entirely.
      errors.toDate = 'Your time zone has no time between these dates. Choose other dates.'
    }
  }
  if (errors.fromDate !== undefined || errors.toDate !== undefined) return { ok: false, errors }

  const symbol = filters.symbol.trim()
  const sorted = filters.sortBy !== DEFAULT_TRADE_FILTERS.sortBy || filters.sortDirection !== DEFAULT_TRADE_FILTERS.sortDirection
  return {
    ok: true,
    query: {
      ...(symbol === '' ? {} : { symbol }),
      ...(filters.side === '' ? {} : { side: filters.side }),
      ...(executedFrom === undefined ? {} : { executedFrom }),
      ...(executedTo === undefined ? {} : { executedTo }),
      ...(sorted ? { sortBy: filters.sortBy, sortDirection: filters.sortDirection } : {}),
    },
  }
}

/** Whether a query leaves out any trades, as opposed to only reordering them. */
export function narrowsList(query: TradeQuery): boolean {
  return query.symbol !== undefined || query.side !== undefined || query.executedFrom !== undefined || query.executedTo !== undefined
}
