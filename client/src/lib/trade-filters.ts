import type { Side, SortDirection, SortField, Trade, TradeQuery } from '../api/contracts.ts'
import { localDayEnd, localDayStart } from './local-dates.ts'
import { browserOffsetAt, type OffsetAt } from './timestamps.ts'

/**
 * The trade list's search and filter controls as the user sets them, their translation into
 * GET /trades/page query parameters, and the list's sort and page sizes. Dates are local calendar
 * dates; both are included.
 */
export interface TradeFilters {
  symbol: string
  /** Empty: both sides. */
  side: Side | ''
  /** Local calendar dates from <input type="date">, such as "2026-03-08"; empty for no bound. */
  fromDate: string
  toDate: string
}

/** No filter: every trade. */
export const DEFAULT_TRADE_FILTERS: Readonly<TradeFilters> = Object.freeze({ symbol: '', side: '', fromDate: '', toDate: '' })

/** The filter members of a query: what narrows the list. */
export type TradeFilterQuery = Pick<TradeQuery, 'symbol' | 'side' | 'executedFrom' | 'executedTo'>

export interface TradeSort {
  readonly sortBy: SortField
  readonly sortDirection: SortDirection
}

/** Newest execution first: the list's order until a column is chosen, and again after Clear. */
export const DEFAULT_TRADE_SORT: TradeSort = Object.freeze({ sortBy: 'executedAt', sortDirection: 'desc' })

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

/** The name of a direction for a field, such as "Newest first" or "Ascending". */
export function directionLabel(field: SortField, direction: SortDirection): string {
  return sortDirections(field).find((option) => option.value === direction)?.label ?? direction
}

/**
 * The sort after choosing a column: the active column reverses; another column starts in its first
 * direction, newest first for the execution date and ascending for the others.
 */
export function nextSort(current: TradeSort, field: SortField): TradeSort {
  if (current.sortBy === field) return { sortBy: field, sortDirection: current.sortDirection === 'asc' ? 'desc' : 'asc' }
  return { sortBy: field, sortDirection: sortDirections(field)[0]?.value ?? 'asc' }
}

/** Page sizes the list offers, and the one it starts with. */
export const PAGE_SIZES = [25, 50, 100] as const

export const DEFAULT_PAGE_SIZE = 50

export type DateFilterErrors = Partial<Record<'fromDate' | 'toDate', string>>

/** For a date that is not a complete calendar date the API can accept, including one only partly typed. */
export const INCOMPLETE_DATE_MESSAGES: Readonly<Record<keyof DateFilterErrors, string>> = {
  fromDate: 'Enter a complete From date between the years 0001 and 9999, or clear it.',
  toDate: 'Enter a complete To date between the years 0001 and 9999, or clear it.',
}

export type TradeQueryResult =
  | { readonly ok: true; readonly query: TradeFilterQuery }
  | { readonly ok: false; readonly errors: DateFilterErrors }

/**
 * Builds the filter query for a set of filters. Only what narrows the list is included: an empty
 * symbol or side and a missing date are left out, so the default filters give an empty query.
 * Refuses an invalid date, or a From date after the To date, without guessing.
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
  return {
    ok: true,
    query: {
      ...(symbol === '' ? {} : { symbol }),
      ...(filters.side === '' ? {} : { side: filters.side }),
      ...(executedFrom === undefined ? {} : { executedFrom }),
      ...(executedTo === undefined ? {} : { executedTo }),
    },
  }
}

/** Whether a query leaves out any trades, as opposed to only reordering them. */
export function narrowsList(query: TradeQuery): boolean {
  return query.symbol !== undefined || query.side !== undefined || query.executedFrom !== undefined || query.executedTo !== undefined
}

/**
 * Whether a trade the API returned matches a query's filters, by the API's rules: the search,
 * normalised like a symbol (trimmed, NFC, upper case), appears anywhere in the trade's symbol,
 * which the API has already normalised; the side is equal; and the execution time is within the
 * inclusive bounds. Times are canonical UTC text, so text order is time order.
 */
export function tradeMatchesFilters(trade: Trade, query: TradeQuery): boolean {
  const search = query.symbol?.trim().normalize('NFC').toUpperCase()
  return (search === undefined || search === '' || trade.symbol.includes(search)) &&
    (query.side === undefined || trade.side === query.side) &&
    (query.executedFrom === undefined || trade.executedAt >= query.executedFrom) &&
    (query.executedTo === undefined || trade.executedAt <= query.executedTo)
}

const ARIA_SORT: Readonly<Record<SortDirection, 'ascending' | 'descending'>> = { asc: 'ascending', desc: 'descending' }

/** A sortable column header's aria-sort, for the order shown: only the sorted column has one. */
export function ariaSortFor(shown: TradeSort, field: SortField | undefined): 'ascending' | 'descending' | undefined {
  return field !== undefined && field === shown.sortBy ? ARIA_SORT[shown.sortDirection] : undefined
}

/** The arrow by a header: up or down for the sorted column, both ways for the others. */
export function sortIndicator(shown: TradeSort, field: SortField): string {
  if (field !== shown.sortBy) return '↕'
  return shown.sortDirection === 'asc' ? '↑' : '↓'
}

/** What choosing a header does, for screen readers: "sort ascending", "sort newest first". */
export function sortAction(current: TradeSort, field: SortField): string {
  const next = nextSort(current, field)
  return `sort ${directionLabel(field, next.sortDirection).toLowerCase()}`
}
