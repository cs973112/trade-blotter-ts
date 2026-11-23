import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS, parseDecimalInput, type Dec, type DecimalInputProblem } from './decimal.ts'
import { normaliseSymbol, type SymbolProblem } from './symbol.ts'
import { parseTimestamp, type UtcTimestamp } from './timestamp.ts'
import { validateBookingStatus, type BookingStatus } from './trade-status.ts'

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
  /** Refused in a booking (the server sets it when the trade is executed); read only for historical trades. */
  readonly executedAt?: unknown
  /** Pending, or omitted (trade-status.ts, validateBookingStatus). */
  readonly status?: unknown
}

/** Request fields in the order errors are reported. */
export const TRADE_FIELDS = ['symbol', 'side', 'quantity', 'price', 'executedAt', 'status'] as const

export type TradeField = (typeof TRADE_FIELDS)[number]

/** Messages for each invalid field. Fields that are valid are absent. */
export type FieldErrors = Readonly<Partial<Record<TradeField, readonly string[]>>>

/** A booking request that passed validation, normalised: always Pending, with no execution time. */
export interface ValidTradeRequest {
  readonly symbol: string
  readonly side: TradeSide
  readonly quantity: Dec
  readonly price: Dec
  readonly status: BookingStatus
}

/**
 * A historical Executed trade's request, normalised (validateExecutedTradeRequest). `executedAt` is
 * undefined when the request has none.
 */
export interface ValidExecutedTradeRequest {
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

export type ExecutedTradeValidationResult =
  | { readonly ok: true; readonly value: ValidExecutedTradeRequest }
  | { readonly ok: false; readonly errors: FieldErrors }

type FieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const valid = <T>(value: T): FieldResult<T> => ({ ok: true, value })
const invalid = (message: string): FieldResult<never> => ({ ok: false, message })

const BOOKING_EXECUTED_AT_MESSAGE = 'A trade is booked as Pending, with no execution time: omit executedAt. The server sets it when the trade is executed.'
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

/** Every invalid field's message, in TRADE_FIELDS order. */
function fieldErrors(results: Partial<Record<TradeField, FieldResult<unknown>>>): FieldErrors {
  const errors: Partial<Record<TradeField, readonly string[]>> = {}
  for (const field of TRADE_FIELDS) {
    const result = results[field]
    if (result !== undefined && !result.ok) errors[field] = [result.message]
  }
  return errors
}

/**
 * Validates and normalises a booking request (POST /trades). Checks every field and reports every
 * invalid one at once, in TRADE_FIELDS order. A booking is always Pending: a status other than
 * Pending (or none) is refused, and so is any execution time (null counts as none), since the
 * server sets it when the trade is executed. Never throws for invalid input.
 */
export function validateTradeRequest(request: TradeRequest, rules: TradeRules): TradeValidationResult {
  const symbol = checkSymbol(request.symbol, rules.symbolMaxLength)
  const side = checkSide(request.side)
  const quantity = checkDecimal(request.quantity, 'Quantity')
  const price = checkDecimal(request.price, 'Price')
  const executedAt: FieldResult<undefined> = request.executedAt === undefined || request.executedAt === null ? valid(undefined) : invalid(BOOKING_EXECUTED_AT_MESSAGE)
  const bookingStatus = validateBookingStatus(request.status)
  const status: FieldResult<BookingStatus> = bookingStatus.ok ? valid(bookingStatus.value) : invalid(bookingStatus.message)

  if (symbol.ok && side.ok && quantity.ok && price.ok && executedAt.ok && status.ok) {
    return { ok: true, value: { symbol: symbol.value, side: side.value, quantity: quantity.value, price: price.value, status: status.value } }
  }
  return { ok: false, errors: fieldErrors({ symbol, side, quantity, price, executedAt, status }) }
}

/**
 * Validates and normalises a historical Executed trade: the trades the reviewer and UI-check
 * datasets write straight to the database, as trades booked Executed before M7 were. The same rules
 * as a booking for symbol, side, quantity and price; executedAt, when given, must be an RFC 3339
 * date-time with an offset. No status is read. The API never uses this: it books only Pending trades.
 */
export function validateExecutedTradeRequest(request: TradeRequest, rules: TradeRules): ExecutedTradeValidationResult {
  const symbol = checkSymbol(request.symbol, rules.symbolMaxLength)
  const side = checkSide(request.side)
  const quantity = checkDecimal(request.quantity, 'Quantity')
  const price = checkDecimal(request.price, 'Price')
  const executedAt = checkExecutedAt(request.executedAt)
  if (symbol.ok && side.ok && quantity.ok && price.ok && executedAt.ok) {
    return { ok: true, value: { symbol: symbol.value, side: side.value, quantity: quantity.value, price: price.value, executedAt: executedAt.value } }
  }
  return { ok: false, errors: fieldErrors({ symbol, side, quantity, price, executedAt }) }
}

/**
 * Creates a historical Executed trade from a validated request, with the identity and time given.
 * `now` is one clock reading: it becomes `createdAt` and `updatedAt`, and `executedAt` when the
 * request did not supply one. Used only to build the datasets written straight to the database.
 */
export function createTrade(request: ValidExecutedTradeRequest, assigned: { readonly id: string; readonly now: UtcTimestamp }): NewTrade {
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
