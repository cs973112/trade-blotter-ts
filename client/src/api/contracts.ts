/**
 * The HTTP contract of the Trade Blotter API, as documented in its OpenAPI document
 * (/documentation/json). Decimals are carried as their exact text: the API sends JSON numbers with
 * up to 50 significant digits, which a JavaScript number cannot hold, so the client never turns them
 * into numbers.
 */

export type Side = 'Buy' | 'Sell'

/** Decimal text exactly as written, such as "101.25" or "-0.5". */
export type DecimalText = string

/** Canonical UTC timestamp text, such as "2026-01-01T09:00:00.000Z". */
export type UtcTimestamp = string

/** POST /trades body. The server assigns id, bookingSequence, createdAt and updatedAt. */
export interface CreateTradeRequest {
  readonly symbol: string
  readonly side: Side
  /** Sent as a JSON string, so the digits typed are the digits received. */
  readonly quantity: DecimalText
  readonly price: DecimalText
  /** RFC 3339 with an explicit offset. Omitted: the server uses its clock. */
  readonly executedAt?: string
}

export interface Trade {
  readonly id: string
  readonly bookingSequence: number
  readonly symbol: string
  readonly side: Side
  readonly quantity: DecimalText
  readonly price: DecimalText
  readonly notional: DecimalText
  readonly executedAt: UtcTimestamp
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

export interface Position {
  readonly symbol: string
  /** Positive long, negative short. */
  readonly netQuantity: DecimalText
  readonly averageCost: DecimalText
}

/** The request fields the API can report as invalid. */
export type TradeField = 'symbol' | 'side' | 'quantity' | 'price' | 'executedAt'

export type FieldErrors = Partial<Record<TradeField, readonly string[]>>

/** Fields GET /trades can sort by. */
export type SortField = 'executedAt' | 'symbol' | 'quantity' | 'price'

export type SortDirection = 'asc' | 'desc'

/**
 * GET /trades query parameters. Every member is optional; an omitted one is not sent, and the API
 * then applies its default: no filter, or newest execution first.
 */
export interface TradeQuery {
  /** Matches anywhere in the symbol, ignoring case. */
  readonly symbol?: string
  readonly side?: Side
  /** Inclusive bounds on executedAt, as UTC timestamps. */
  readonly executedFrom?: UtcTimestamp
  readonly executedTo?: UtcTimestamp
  readonly sortBy?: SortField
  readonly sortDirection?: SortDirection
}

/** The query parameters, in the order they are sent and the API reports them. */
export const TRADE_QUERY_PARAMETERS = ['symbol', 'side', 'executedFrom', 'executedTo', 'sortBy', 'sortDirection'] as const
