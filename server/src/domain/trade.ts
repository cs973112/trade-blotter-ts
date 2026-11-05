import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS, parseDecimalInput, type Dec, type DecimalInputProblem } from './decimal.ts'
import { normaliseSymbol, type SymbolProblem } from './symbol.ts'
import { parseTimestamp, type UtcTimestamp } from './timestamp.ts'

export const TRADE_SIDES = ['Buy', 'Sell'] as const

export type TradeSide = (typeof TRADE_SIDES)[number]

/**
 * A booked trade. Immutable: amendments are out of scope, so `updatedAt` equals `createdAt`.
 */
export interface Trade {
  readonly id: string
  /** Booking order, assigned when the trade is stored. Breaks ties between equal execution times. */
  readonly bookingSequence: number
  /** Normalised: see normaliseSymbol. */
  readonly symbol: string
  readonly side: TradeSide
  /** Greater than zero; the side gives the direction. */
  readonly quantity: Dec
  readonly price: Dec
  /** When the trade was executed: supplied by the client, or the server clock when omitted. */
  readonly executedAt: UtcTimestamp
  /** When the application recorded the trade. Always the server clock. */
  readonly createdAt: UtcTimestamp
  /** When the stored record last changed. Always the server clock; never used for ordering. */
  readonly updatedAt: UtcTimestamp
}

/** A trade that has not been stored yet, and so has no booking sequence. */
export type NewTrade = Omit<Trade, 'bookingSequence'>

/**
 * The fields a client may supply to book a trade, before validation. Values are unknown because
 * they come from outside; decimals arrive as their exact source text. `createdAt`, `updatedAt` and
 * any other members are not part of the request, and are never read.
 */
export interface TradeRequest {
  readonly symbol?: unknown
  readonly side?: unknown
  readonly quantity?: unknown
  readonly price?: unknown
  readonly executedAt?: unknown
}

/** Request fields in the order errors are reported. */
export const TRADE_FIELDS = ['symbol', 'side', 'quantity', 'price', 'executedAt'] as const

export type TradeField = (typeof TRADE_FIELDS)[number]

/** Messages for each invalid field. Fields that are valid are absent. */
export type FieldErrors = Readonly<Partial<Record<TradeField, readonly string[]>>>

/** A request that passed validation, normalised. `executedAt` is undefined when the client omitted it. */
export interface ValidTradeRequest {
  readonly symbol: string
  readonly side: TradeSide
  readonly quantity: Dec
  readonly price: Dec
  readonly executedAt: UtcTimestamp | undefined
}

export interface TradeRules {
  /** Maximum symbol length in code points; see DEFAULT_SYMBOL_MAX_LENGTH. */
  readonly symbolMaxLength: number
}

export type TradeValidationResult =
  | { readonly ok: true; readonly value: ValidTradeRequest }
  | { readonly ok: false; readonly errors: FieldErrors }

type FieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const valid = <T>(value: T): FieldResult<T> => ({ ok: true, value })
const invalid = (message: string): FieldResult<never> => ({ ok: false, message })

const EXECUTED_AT_MESSAGE = 'Execution time must be an RFC 3339 date-time with an offset, such as 2026-01-01T09:00:00Z.'

function checkSymbol(input: unknown, maxLength: number): FieldResult<string> {
  if (input === undefined || input === null) return invalid('Symbol is required.')
  if (typeof input !== 'string') return invalid('Symbol must be a string.')
  const result = normaliseSymbol(input, maxLength)
  if (result.ok) return valid(result.value)
  const messages: Record<SymbolProblem, string> = {
    required: 'Symbol is required.',
    'too-long': `Symbol must be at most ${String(maxLength)} characters.`,
    invisible: 'Symbol must not contain control or invisible characters.',
  }
  return invalid(messages[result.problem])
}

/** The side a client wrote, ignoring case and surrounding whitespace, or undefined if it names none. */
export function toTradeSide(input: unknown): TradeSide | undefined {
  const text = typeof input === 'string' ? input.trim().toLowerCase() : undefined
  return TRADE_SIDES.find((candidate) => candidate.toLowerCase() === text)
}

function checkSide(input: unknown): FieldResult<TradeSide> {
  const side = toTradeSide(input)
  return side === undefined ? invalid('Side must be Buy or Sell.') : valid(side)
}

function checkDecimal(input: unknown, label: 'Quantity' | 'Price'): FieldResult<Dec> {
  const result = parseDecimalInput(input)
  if (result.ok) return valid(result.value)
  const messages: Record<DecimalInputProblem, string> = {
    missing: `${label} is required.`,
    'not-a-number': `${label} must be a number.`,
    'not-positive': `${label} must be greater than zero.`,
    'out-of-range':
      `${label} must be less than 10^${String(MAX_INTEGER_DIGITS)} with at most ${String(MAX_DECIMAL_PLACES)} decimal places.`,
  }
  return invalid(messages[result.problem])
}

function checkExecutedAt(input: unknown): FieldResult<UtcTimestamp | undefined> {
  if (input === undefined || input === null) return valid(undefined)
  const timestamp = typeof input === 'string' ? parseTimestamp(input) : undefined
  return timestamp === undefined ? invalid(EXECUTED_AT_MESSAGE) : valid(timestamp)
}

/**
 * Validates and normalises a trade request. Checks every field and reports every invalid one at
 * once, in TRADE_FIELDS order. Never throws for invalid input.
 */
export function validateTradeRequest(request: TradeRequest, rules: TradeRules): TradeValidationResult {
  const symbol = checkSymbol(request.symbol, rules.symbolMaxLength)
  const side = checkSide(request.side)
  const quantity = checkDecimal(request.quantity, 'Quantity')
  const price = checkDecimal(request.price, 'Price')
  const executedAt = checkExecutedAt(request.executedAt)

  if (symbol.ok && side.ok && quantity.ok && price.ok && executedAt.ok) {
    return {
      ok: true,
      value: { symbol: symbol.value, side: side.value, quantity: quantity.value, price: price.value, executedAt: executedAt.value },
    }
  }

  const results: Record<TradeField, FieldResult<unknown>> = { symbol, side, quantity, price, executedAt }
  const errors: Partial<Record<TradeField, readonly string[]>> = {}
  for (const field of TRADE_FIELDS) {
    const result = results[field]
    if (!result.ok) errors[field] = [result.message]
  }
  return { ok: false, errors }
}

/**
 * Creates a trade from a validated request, with the identity and time the application assigns.
 * `now` is one clock reading: it becomes `createdAt` and `updatedAt`, and `executedAt` when the
 * request did not supply one.
 */
export function createTrade(request: ValidTradeRequest, assigned: { readonly id: string; readonly now: UtcTimestamp }): NewTrade {
  return Object.freeze({
    id: assigned.id,
    symbol: request.symbol,
    side: request.side,
    quantity: request.quantity,
    price: request.price,
    executedAt: request.executedAt ?? assigned.now,
    createdAt: assigned.now,
    updatedAt: assigned.now,
  })
}

/** Quantity times price. Exact for every valid trade (see docs/architecture.md, "Numeric policy"). */
export function notional(trade: Pick<Trade, 'quantity' | 'price'>): Dec {
  return trade.quantity.times(trade.price)
}

/**
 * Trade order: execution time ascending, then booking sequence ascending. The order positions are
 * calculated in. `createdAt` and `updatedAt` play no part.
 */
export function compareTradeOrder(a: Pick<Trade, 'executedAt' | 'bookingSequence'>, b: Pick<Trade, 'executedAt' | 'bookingSequence'>): number {
  if (a.executedAt !== b.executedAt) return a.executedAt < b.executedAt ? -1 : 1
  return a.bookingSequence - b.bookingSequence
}
