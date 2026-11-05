import { compareSymbols, normaliseSymbol } from './symbol.ts'
import { parseTimestamp, type UtcTimestamp } from './timestamp.ts'
import { compareTradeOrder, toTradeSide, type Trade, type TradeSide } from './trade.ts'

/** Fields the trade history can be sorted by. */
export const TRADE_SORT_FIELDS = ['executedAt', 'symbol', 'quantity', 'price'] as const

export type TradeSortField = (typeof TRADE_SORT_FIELDS)[number]

export const SORT_DIRECTIONS = ['asc', 'desc'] as const

export type SortDirection = (typeof SORT_DIRECTIONS)[number]

/**
 * Which trades to list. Every member is optional and they combine with AND; an empty filter
 * matches every trade.
 */
export interface TradeFilter {
  /** Normalised like a symbol (see normaliseSymbol): a trade matches if its symbol contains it. */
  readonly symbolContains?: string
  readonly side?: TradeSide
  /** Inclusive lower bound on executedAt. */
  readonly executedFrom?: UtcTimestamp
  /** Inclusive upper bound on executedAt. */
  readonly executedTo?: UtcTimestamp
}

export interface TradeSort {
  readonly field: TradeSortField
  readonly direction: SortDirection
}

/** Newest execution first, the blotter's order when no sort is asked for. */
export const DEFAULT_TRADE_SORT: TradeSort = Object.freeze({ field: 'executedAt', direction: 'desc' })

export interface TradeQuery {
  readonly filter: TradeFilter
  readonly sort: TradeSort
}

/**
 * Query parameters for listing trades, before validation. Values are unknown because they come
 * from outside: a string, or an array when a parameter is repeated. Other members are never read.
 */
export interface TradeQueryRequest {
  readonly symbol?: unknown
  readonly side?: unknown
  readonly executedFrom?: unknown
  readonly executedTo?: unknown
  readonly sortBy?: unknown
  readonly sortDirection?: unknown
}

/** Query parameters in the order errors are reported. */
export const TRADE_QUERY_PARAMETERS = ['symbol', 'side', 'executedFrom', 'executedTo', 'sortBy', 'sortDirection'] as const

export type TradeQueryParameter = (typeof TRADE_QUERY_PARAMETERS)[number]

/** Messages for each invalid parameter. Parameters that are valid are absent. */
export type QueryErrors = Readonly<Partial<Record<TradeQueryParameter, readonly string[]>>>

export interface TradeQueryRules {
  /** Maximum symbol length in code points; a longer search could never match. */
  readonly symbolMaxLength: number
}

export type TradeQueryValidationResult =
  | { readonly ok: true; readonly value: TradeQuery }
  | { readonly ok: false; readonly errors: QueryErrors }

type ParameterResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const valid = <T>(value: T): ParameterResult<T> => ({ ok: true, value })
const invalid = (message: string): ParameterResult<never> => ({ ok: false, message })

const timestampMessage = (name: string) =>
  `${name} must be an RFC 3339 date-time with Z or an offset, such as 2026-01-01T09:00:00Z; write + in an offset as %2B.`

/**
 * The text of a parameter, or undefined when it was omitted or sent empty (`?side=` or `?side`),
 * which means the same. A repeated parameter is refused rather than one of its values chosen.
 */
function single(input: unknown, name: string): ParameterResult<string | undefined> {
  if (input === undefined || input === '') return valid(undefined)
  if (typeof input !== 'string') return invalid(`${name} must be given at most once.`)
  return valid(input)
}

function checkSymbol(input: unknown, maxLength: number): ParameterResult<string | undefined> {
  const text = single(input, 'symbol')
  if (!text.ok) return text
  if (text.value === undefined) return valid(undefined)
  const result = normaliseSymbol(text.value, maxLength)
  if (result.ok) return valid(result.value)
  if (result.problem === 'required') return valid(undefined)
  return invalid(result.problem === 'too-long'
    ? `symbol must be at most ${String(maxLength)} characters.`
    : 'symbol must not contain control or invisible characters.')
}

function checkSide(input: unknown): ParameterResult<TradeSide | undefined> {
  const text = single(input, 'side')
  if (!text.ok) return text
  if (text.value === undefined) return valid(undefined)
  const side = toTradeSide(text.value)
  return side === undefined ? invalid('side must be Buy or Sell.') : valid(side)
}

function checkTimestamp(input: unknown, name: string): ParameterResult<UtcTimestamp | undefined> {
  const text = single(input, name)
  if (!text.ok) return text
  if (text.value === undefined) return valid(undefined)
  const timestamp = parseTimestamp(text.value)
  return timestamp === undefined ? invalid(timestampMessage(name)) : valid(timestamp)
}

function checkChoice<T extends string>(input: unknown, name: string, choices: readonly T[], fallback: T): ParameterResult<T> {
  const text = single(input, name)
  if (!text.ok) return text
  if (text.value === undefined) return valid(fallback)
  const choice = choices.find((candidate) => candidate === text.value)
  return choice === undefined ? invalid(`${name} must be one of ${choices.join(', ')}.`) : valid(choice)
}

/**
 * Validates and normalises the query parameters for listing trades. Checks every parameter and
 * reports every invalid one at once, in TRADE_QUERY_PARAMETERS order. Never throws for invalid
 * input.
 *
 * - `symbol`: a case-insensitive search anywhere in the symbol, normalised like a symbol. Blank
 *   matches every trade.
 * - `side`: Buy or Sell, ignoring case and surrounding whitespace. Omitted: both sides.
 * - `executedFrom`, `executedTo`: inclusive bounds, RFC 3339 with an offset (see parseTimestamp).
 *   A date without a time, or a time without an offset, is refused, never assumed to be UTC. The
 *   start may equal the end but not follow it.
 * - `sortBy` (TRADE_SORT_FIELDS) and `sortDirection` (asc or desc), exactly as written. Each
 *   defaults to DEFAULT_TRADE_SORT's value, so `sortDirection=asc` alone lists oldest first.
 */
export function validateTradeQuery(request: TradeQueryRequest, rules: TradeQueryRules): TradeQueryValidationResult {
  const symbol = checkSymbol(request.symbol, rules.symbolMaxLength)
  const side = checkSide(request.side)
  const executedFrom = checkTimestamp(request.executedFrom, 'executedFrom')
  let executedTo = checkTimestamp(request.executedTo, 'executedTo')
  const sortBy = checkChoice(request.sortBy, 'sortBy', TRADE_SORT_FIELDS, DEFAULT_TRADE_SORT.field)
  const sortDirection = checkChoice(request.sortDirection, 'sortDirection', SORT_DIRECTIONS, DEFAULT_TRADE_SORT.direction)

  if (executedFrom.ok && executedTo.ok && executedFrom.value !== undefined && executedTo.value !== undefined &&
    executedFrom.value > executedTo.value) {
    executedTo = invalid('executedTo must not be earlier than executedFrom.')
  }

  if (symbol.ok && side.ok && executedFrom.ok && executedTo.ok && sortBy.ok && sortDirection.ok) {
    const filter: { -readonly [K in keyof TradeFilter]: TradeFilter[K] } = {}
    if (symbol.value !== undefined) filter.symbolContains = symbol.value
    if (side.value !== undefined) filter.side = side.value
    if (executedFrom.value !== undefined) filter.executedFrom = executedFrom.value
    if (executedTo.value !== undefined) filter.executedTo = executedTo.value
    return { ok: true, value: { filter, sort: { field: sortBy.value, direction: sortDirection.value } } }
  }

  const results: Record<TradeQueryParameter, ParameterResult<unknown>> = { symbol, side, executedFrom, executedTo, sortBy, sortDirection }
  const errors: Partial<Record<TradeQueryParameter, readonly string[]>> = {}
  for (const parameter of TRADE_QUERY_PARAMETERS) {
    const result = results[parameter]
    if (!result.ok) errors[parameter] = [result.message]
  }
  return { ok: false, errors }
}

type SortableTrade = Pick<Trade, 'symbol' | 'quantity' | 'price' | 'executedAt' | 'bookingSequence'>

/** Compares one sort field alone. Execution time is left to trade order, which also breaks every tie. */
function compareField(field: TradeSortField, a: SortableTrade, b: SortableTrade): number {
  switch (field) {
    case 'executedAt':
      return 0
    case 'symbol':
      return compareSymbols(a.symbol, b.symbol)
    case 'quantity':
      return a.quantity.comparedTo(b.quantity)
    case 'price':
      return a.price.comparedTo(b.price)
  }
}

/**
 * A comparator for listing trades: the sort field in the given direction, then trade order
 * (executedAt, then booking sequence) in the same direction. Booking sequences are unique, so the
 * order is total and the descending order is exactly the ascending order reversed. Symbols compare
 * by code point and decimals by exact value, never through a JavaScript number.
 */
export function compareTrades(sort: TradeSort): (a: SortableTrade, b: SortableTrade) => number {
  const sign = sort.direction === 'asc' ? 1 : -1
  return (a, b) => sign * (compareField(sort.field, a, b) || compareTradeOrder(a, b))
}
