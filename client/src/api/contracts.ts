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

/** What a booking may name: Pending, as every booking is. Executed only by executing, Cancelled only by cancelling. */
export type BookingStatus = 'Pending'

export type TradeStatus = 'Pending' | 'Executed' | 'Cancelled'

/** Who created or last changed a trade: set by the server, never sent. */
export type Actor = 'User' | 'Admin'

/**
 * POST /trades body. Every trade is booked Pending: the server assigns id, bookingSequence,
 * createdAt, updatedAt and the actors, and sets executedAt only when the trade is executed.
 */
export interface CreateTradeRequest {
  readonly symbol: string
  readonly side: Side
  /** Sent as a JSON string, so the digits typed are the digits received. */
  readonly quantity: DecimalText
  readonly price: DecimalText
  /** Pending, or omitted (also Pending). The page never sends it. */
  readonly status?: BookingStatus
}

export interface Trade {
  readonly id: string
  readonly bookingSequence: number
  readonly symbol: string
  readonly side: Side
  readonly quantity: DecimalText
  readonly price: DecimalText
  readonly notional: DecimalText
  readonly status: TradeStatus
  /** Null for a Pending trade, and one cancelled while Pending. */
  readonly executedAt: UtcTimestamp | null
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
  readonly createdBy: Actor
  readonly updatedBy: Actor
  /** Null on every listed trade; set on a cancellation record. */
  readonly originalTradeId: string | null
  /** Why a Cancelled trade was cancelled; otherwise null. */
  readonly cancellationReason: string | null
  /** A Cancelled trade's cancellation record; otherwise null. */
  readonly cancellationTradeId: string | null
}

export interface Position {
  readonly symbol: string
  /** The Executed Net: positive long, negative short. Zero for a symbol with only Pending trades. */
  readonly netQuantity: DecimalText
  /** From Executed trades only. */
  readonly averageCost: DecimalText
  readonly executedNetQuantity: DecimalText
  readonly pendingNetQuantity: DecimalText
  /** executedNetQuantity + pendingNetQuantity. */
  readonly projectedNetQuantity: DecimalText
}

/** The request fields the API can report as invalid. */
export type TradeField = 'symbol' | 'side' | 'quantity' | 'price' | 'executedAt' | 'status'

export type FieldErrors = Partial<Record<TradeField, readonly string[]>>

/** Fields GET /trades can sort by. */
export type SortField = 'executedAt' | 'symbol' | 'quantity' | 'price'

export type SortDirection = 'asc' | 'desc'

/** How GET /trades matches symbol: anywhere in the symbol, or the whole symbol. Both ignore case. */
export type SymbolMatch = 'contains' | 'exact'

/**
 * GET /trades query parameters. Every member is optional; an omitted one is not sent, and the API
 * then applies its default: no filter, or newest execution first.
 */
export interface TradeQuery {
  /** Matches anywhere in the symbol, ignoring case; or the whole symbol with symbolMatch exact. */
  readonly symbol?: string
  /** How symbol matches: contains (the API's default) or exact, so MS matches MS but not MSFT or MSTR. */
  readonly symbolMatch?: SymbolMatch
  readonly side?: Side
  /** Only trades of this status. */
  readonly status?: TradeStatus
  /** Inclusive bounds on executedAt, as UTC timestamps. */
  readonly executedFrom?: UtcTimestamp
  readonly executedTo?: UtcTimestamp
  readonly sortBy?: SortField
  readonly sortDirection?: SortDirection
}

/** The query parameters, in the order they are sent and the API reports them. */
export const TRADE_QUERY_PARAMETERS = ['symbol', 'symbolMatch', 'side', 'status', 'executedFrom', 'executedTo', 'sortBy', 'sortDirection'] as const

/** GET /trades/page: the GET /trades query, and which page of it. */
export interface TradePageQuery extends TradeQuery {
  /** From 1. A page past the last is not an error: it has no items. */
  readonly page: number
  /** 1 to 100. */
  readonly pageSize: number
}

/** GET /trades/page query parameters, in the order they are sent and the API reports them. */
export const TRADE_PAGE_QUERY_PARAMETERS = [...TRADE_QUERY_PARAMETERS, 'page', 'pageSize'] as const

/** One page of the trades GET /trades would list for the same query. */
export interface TradePage {
  readonly items: readonly Trade[]
  readonly page: number
  readonly pageSize: number
  /** Trades matching the query, on every page. */
  readonly totalCount: number
  /** Pages they fill: 0 when none match. */
  readonly totalPages: number
}

/** POST /trades/{id}/cancellation body. The actor (Admin) and the time are set by the server. */
export interface CancellationRequest {
  readonly reason: string
}

/** A cancellation: the logical trade, now Cancelled, and the cancellation record inserted. */
export interface Cancellation {
  readonly trade: Trade
  readonly cancellationRecord: Trade
}

/** Every column of a physical trades row as it was at one write, as stored. */
export interface AuditTradeSnapshot {
  readonly bookingSequence: number
  readonly id: string
  readonly symbol: string
  readonly side: string
  readonly quantity: DecimalText
  readonly price: DecimalText
  readonly executedAt: UtcTimestamp | null
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
  readonly quantityKey: string
  readonly priceKey: string
  readonly status: TradeStatus
  readonly createdBy: Actor
  readonly updatedBy: Actor
  readonly originalTradeId: string | null
  readonly cancellationReason: string | null
}

export interface AuditEntry {
  readonly auditId: number
  readonly auditAction: 'Inserted' | 'Updated' | 'Deleted'
  readonly auditOn: UtcTimestamp
  readonly auditBy: 'System'
  readonly trade: AuditTradeSnapshot
}

/** GET /trades/{id}/audit: one page of a trade's audit history, in write order. */
export interface AuditPage {
  readonly tradeId: string
  /** trade: this physical row; logical: the original and its cancellation record. */
  readonly scope: 'trade' | 'logical'
  readonly tradeIds: readonly string[]
  readonly items: readonly AuditEntry[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}
