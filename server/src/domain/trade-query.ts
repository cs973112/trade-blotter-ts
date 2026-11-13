import { compareSymbols, normaliseSymbol } from './symbol.ts'
import { parseTimestamp, type UtcTimestamp } from './timestamp.ts'
import { compareTradeOrder, toTradeSide, type Trade, type TradeSide } from './trade.ts'

/** Fields the trade history can be sorted by. */
export const TRADE_SORT_FIELDS = ['executedAt', 'symbol', 'quantity', 'price'] as const

export type TradeSortField = (typeof TRADE_SORT_FIELDS)[number]

export const SORT_DIRECTIONS = ['asc', 'desc'] as const

export type SortDirection = (typeof SORT_DIRECTIONS)[number]

/** How the symbol parameter matches: anywhere in the symbol (the default), or the whole symbol. */
export const SYMBOL_MATCHES = ['contains', 'exact'] as const

export type SymbolMatch = (typeof SYMBOL_MATCHES)[number]

export const DEFAULT_SYMBOL_MATCH: SymbolMatch = 'contains'

/**
 * Which trades to list. Every member is optional and they combine with AND; an empty filter
 * matches every trade.
 */
export interface TradeFilter {
  /** Normalised like a symbol (see normaliseSymbol): a trade matches if its symbol contains it. */
  readonly symbolContains?: string
  /** Normalised like a symbol: a trade matches if its symbol is exactly it. Never set with symbolContains. */
  readonly symbolEquals?: string
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
  readonly symbolMatch?: unknown
  readonly side?: unknown
  readonly executedFrom?: unknown
  readonly executedTo?: unknown
  readonly sortBy?: unknown
  readonly sortDirection?: unknown
}

/** Query parameters in the order errors are reported. */
export const TRADE_QUERY_PARAMETERS = ['symbol', 'symbolMatch', 'side', 'executedFrom', 'executedTo', 'sortBy', 'sortDirection'] as const

export type TradeQueryParameter = (typeof TRADE_QUERY_PARAMETERS)[number]

/** Trades on a page when no size is asked for. */
export const DEFAULT_PAGE_SIZE = 50

/** The most trades a page can hold. */
export const MAX_PAGE_SIZE = 100

/** The highest page number accepted, so every page number is an exact JavaScript integer. */
export const MAX_PAGE = Number.MAX_SAFE_INTEGER

/** Which page of the matching trades to list, counting from 1. */
export interface PageRequest {
  readonly page: number
  readonly pageSize: number
}

export interface TradePageQuery {
  readonly query: TradeQuery
  readonly page: PageRequest
}

/** As TradeQueryRequest, with the page parameters. */
export interface TradePageQueryRequest extends TradeQueryRequest {
  readonly page?: unknown
  readonly pageSize?: unknown
}

/** Query parameters for a page of trades, in the order errors are reported. */
export const TRADE_PAGE_QUERY_PARAMETERS = [...TRADE_QUERY_PARAMETERS, 'page', 'pageSize'] as const

export type TradePageQueryParameter = (typeof TRADE_PAGE_QUERY_PARAMETERS)[number]

/** Messages for each invalid parameter. Parameters that are valid are absent. */
export type QueryErrors = Readonly<Partial<Record<TradePageQueryParameter, readonly string[]>>>

export interface TradeQueryRules {
  /** Maximum symbol length in code points; a longer search could never match. */
  readonly symbolMaxLength: number
}

export type TradeQueryValidationResult =
  | { readonly ok: true; readonly value: TradeQuery }
  | { readonly ok: false; readonly errors: QueryErrors }

export type TradePageQueryValidationResult =
  | { readonly ok: true; readonly value: TradePageQuery }
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

/** Digits only, from 1 to max. The text is compared as a BigInt, so a huge number is refused, never rounded. */
function checkWholeNumber(input: unknown, name: string, max: number, fallback: number): ParameterResult<number> {
  const text = single(input, name)
  if (!text.ok) return text
  if (text.value === undefined) return valid(fallback)
  const message = `${name} must be a whole number from 1 to ${String(max)}.`
  if (!/^[0-9]+$/.test(text.value)) return invalid(message)
  const number = BigInt(text.value)
  return number < 1n || number > BigInt(max) ? invalid(message) : valid(Number(number))
}

type ParameterResults = Readonly<Partial<Record<TradePageQueryParameter, ParameterResult<unknown>>>>

/** The messages of the invalid parameters, in TRADE_PAGE_QUERY_PARAMETERS order. */
function errorsOf(results: ParameterResults): QueryErrors {
  const errors: Partial<Record<TradePageQueryParameter, readonly string[]>> = {}
  for (const parameter of TRADE_PAGE_QUERY_PARAMETERS) {
    const result = results[parameter]
    if (result !== undefined && !result.ok) errors[parameter] = [result.message]
  }
  return errors
}

/** Checks every filter and sort parameter: the query when all are valid, and each one's result. */
function readTradeQuery(request: TradeQueryRequest, rules: TradeQueryRules): { readonly value?: TradeQuery; readonly results: ParameterResults } {
  const symbol = checkSymbol(request.symbol, rules.symbolMaxLength)
  const symbolMatch = checkChoice(request.symbolMatch, 'symbolMatch', SYMBOL_MATCHES, DEFAULT_SYMBOL_MATCH)
  const side = checkSide(request.side)
  const executedFrom = checkTimestamp(request.executedFrom, 'executedFrom')
  let executedTo = checkTimestamp(request.executedTo, 'executedTo')
  const sortBy = checkChoice(request.sortBy, 'sortBy', TRADE_SORT_FIELDS, DEFAULT_TRADE_SORT.field)
  const sortDirection = checkChoice(request.sortDirection, 'sortDirection', SORT_DIRECTIONS, DEFAULT_TRADE_SORT.direction)

  if (executedFrom.ok && executedTo.ok && executedFrom.value !== undefined && executedTo.value !== undefined &&
    executedFrom.value > executedTo.value) {
    executedTo = invalid('executedTo must not be earlier than executedFrom.')
  }

  const results = { symbol, symbolMatch, side, executedFrom, executedTo, sortBy, sortDirection }
  if (!(symbol.ok && symbolMatch.ok && side.ok && executedFrom.ok && executedTo.ok && sortBy.ok && sortDirection.ok)) return { results }

  const filter: { -readonly [K in keyof TradeFilter]: TradeFilter[K] } = {}
  if (symbol.value !== undefined) {
    if (symbolMatch.value === 'exact') filter.symbolEquals = symbol.value
    else filter.symbolContains = symbol.value
  }
  if (side.value !== undefined) filter.side = side.value
  if (executedFrom.value !== undefined) filter.executedFrom = executedFrom.value
  if (executedTo.value !== undefined) filter.executedTo = executedTo.value
  return { value: { filter, sort: { field: sortBy.value, direction: sortDirection.value } }, results }
}

/**
 * Validates and normalises the query parameters for listing trades. Checks every parameter and
 * reports every invalid one at once, in TRADE_QUERY_PARAMETERS order. Never throws for invalid
 * input.
 *
 * - `symbol`: a case-insensitive search anywhere in the symbol, normalised like a symbol. Blank
 *   matches every trade.
 * - `symbolMatch`: `contains` (the default: anywhere in the symbol) or `exact` (the whole symbol,
 *   so MS matches MS but not MSFT or MSTR), exactly as written. The symbol is normalised the same
 *   way for both, so the exact match ignores case too. Without a symbol it changes nothing.
 * - `side`: Buy or Sell, ignoring case and surrounding whitespace. Omitted: both sides.
 * - `executedFrom`, `executedTo`: inclusive bounds, RFC 3339 with an offset (see parseTimestamp).
 *   A date without a time, or a time without an offset, is refused, never assumed to be UTC. The
 *   start may equal the end but not follow it.
 * - `sortBy` (TRADE_SORT_FIELDS) and `sortDirection` (asc or desc), exactly as written. Each
 *   defaults to DEFAULT_TRADE_SORT's value, so `sortDirection=asc` alone lists oldest first.
 */
export function validateTradeQuery(request: TradeQueryRequest, rules: TradeQueryRules): TradeQueryValidationResult {
  const { value, results } = readTradeQuery(request, rules)
  return value === undefined ? { ok: false, errors: errorsOf(results) } : { ok: true, value }
}

/**
 * As validateTradeQuery, with the page: every invalid parameter is reported at once, in
 * TRADE_PAGE_QUERY_PARAMETERS order.
 *
 * - `page`: from 1 to MAX_PAGE, default 1. A page past the last is valid: it holds no trades.
 * - `pageSize`: from 1 to MAX_PAGE_SIZE, default DEFAULT_PAGE_SIZE.
 *
 * Both are digits only: no sign, point, exponent or space. Empty means omitted, and a repeated
 * parameter is refused, as for the others.
 */
export function validateTradePageQuery(request: TradePageQueryRequest, rules: TradeQueryRules): TradePageQueryValidationResult {
  const { value, results } = readTradeQuery(request, rules)
  const page = checkWholeNumber(request.page, 'page', MAX_PAGE, 1)
  const pageSize = checkWholeNumber(request.pageSize, 'pageSize', MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)
  if (value === undefined || !page.ok || !pageSize.ok) return { ok: false, errors: errorsOf({ ...results, page, pageSize }) }
  return { ok: true, value: { query: value, page: { page: page.value, pageSize: pageSize.value } } }
}

/** The number of pages `totalCount` matching trades fill: 0 when none match. */
export function pageCount(totalCount: number, pageSize: number): number {
  return Math.ceil(totalCount / pageSize)
}

/**
 * Where a page starts among `totalCount` matching trades in sort order, and how many it holds, or
 * undefined for a page past the last. Only a page that exists gets an offset, so the offset is
 * always below totalCount, however large the page number.
 */
export function pageWindow(page: PageRequest, totalCount: number): { readonly offset: number; readonly limit: number } | undefined {
  if (page.page > pageCount(totalCount, page.pageSize)) return undefined
  const offset = (page.page - 1) * page.pageSize
  return { offset, limit: Math.min(page.pageSize, totalCount - offset) }
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
 *
 * The reference definition of the order: the repository sorts in SQL, and is tested against it.
 */
export function compareTrades(sort: TradeSort): (a: SortableTrade, b: SortableTrade) => number {
  const sign = sort.direction === 'asc' ? 1 : -1
  return (a, b) => sign * (compareField(sort.field, a, b) || compareTradeOrder(a, b))
}
