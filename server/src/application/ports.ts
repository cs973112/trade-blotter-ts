import type { PageRequest, TradeFilter, TradeQuery } from '../domain/trade-query.ts'
import type { UtcTimestamp } from '../domain/timestamp.ts'
import type { StatusPositionTrade } from '../domain/position-summary.ts'
import type { Actor, CancellationProblem, ExecutionProblem, LifecycleTrade, ListedTrade, NewLifecycleTrade, TradeStatus } from '../domain/trade-status.ts'
import type { NewTrade, Trade } from '../domain/trade.ts'

/** One page of the trades matching a query, and how many match in all. */
export interface TradePageResult {
  readonly trades: readonly Trade[]
  readonly totalCount: number
}

/**
 * The interfaces the application needs from the outside world. Infrastructure implements them;
 * tests use simple in-memory versions. Nothing here knows about a database or HTTP.
 */

export interface TradeRepository {
  /**
   * Stores a new trade and returns it with the booking sequence the store assigned, which is
   * higher than any sequence it has assigned before. Atomic: the store checks the trade against
   * every stored trade for its symbol with positionAfterTrade, and inserts it only if that passes,
   * with no other write in between. Rejects with PositionLimitError, storing nothing, if the trade
   * would breach the position limit.
   */
  add(trade: NewTrade): Promise<Trade>
  /**
   * Stored trades in trade order: `executedAt` ascending, then booking sequence ascending. With no
   * filter, or an empty one, every stored trade; otherwise only those matching every member given.
   * Reads only: never changes what is stored.
   */
  listInTradeOrder(filter?: TradeFilter): Promise<readonly Trade[]>
  /**
   * Stored trades matching the query's filter, in its sort order: exactly the order compareTrades
   * defines. Reads only.
   */
  list(query: TradeQuery): Promise<readonly Trade[]>
  /**
   * One page of what `list` returns for the query, and the number of matching trades, both read
   * from the same state of the store. A page past the last has no trades. Reads only.
   */
  listPage(query: TradeQuery, page: PageRequest): Promise<TradePageResult>
}

/** What a cancellation came to: both rows as stored, or why nothing was written. */
export type StoredCancellation =
  | { readonly ok: true; readonly original: LifecycleTrade; readonly cancellation: LifecycleTrade }
  | { readonly ok: false; readonly problem: CancellationProblem | 'not-found'; readonly message: string }

/** What an execution came to: the trade as stored, now Executed, or why nothing was written. */
export type StoredExecution =
  | { readonly ok: true; readonly trade: LifecycleTrade }
  | { readonly ok: false; readonly problem: ExecutionProblem | 'not-found'; readonly message: string }

/**
 * The trade lifecycle's rows (trade-status.ts): Pending, Executed and Cancelled trades and
 * cancellation rows, all in the one trades table.
 */
export interface LifecycleTradeRepository {
  /**
   * Stores a booking and returns it with its booking sequence. Atomic: the symbol's rows are read,
   * the booking is checked against them (pendingPositionAfterTrade for a Pending one;
   * executedPositionAfterTrade for an Executed row, which only datasets and tests write: the API
   * books Pending trades only), and it is inserted only if that passes, with no other write in
   * between. Rejects with PositionLimitError, storing nothing.
   */
  book(trade: NewLifecycleTrade): Promise<LifecycleTrade>
  /**
   * Cancels a Pending trade: in one transaction, the trade is read, cancelTrade decides, the
   * original is updated only if it is still Pending, and the cancellation row is inserted. Both
   * rows are written, or neither. A refusal writes nothing and says why.
   */
  cancel(tradeId: string, request: { readonly reason?: unknown }, assigned: { readonly id: string; readonly now: UtcTimestamp }): Promise<StoredCancellation>
  /**
   * Executes a Pending trade: in one transaction that holds the write lock from its start, the
   * execution time is read from `now` (after the lock is held), the trade is read, executeTrade
   * decides, the symbol's Executed position is checked with the trade at that time
   * (executedPositionAfterExecution), and the row is updated only if it is still Pending. No row is
   * added. A refusal writes nothing and says why; a position-limit breach rejects with
   * PositionLimitError, writing nothing.
   */
  execute(tradeId: string, now: () => UtcTimestamp): Promise<StoredExecution>
  /** One row by trade id, or undefined. Reads only. */
  get(tradeId: string): Promise<LifecycleTrade | undefined>
  /** Every row, in booking order. Reads only. */
  listAll(): Promise<readonly LifecycleTrade[]>
  /**
   * The logical trades matching the query, in its sort order (compareTrades): every row but the
   * cancellation rows, each cancelled trade with what its cancellation row records. Reads only.
   */
  list(query: TradeQuery): Promise<readonly ListedTrade[]>
  /** One page of what list returns, and the number of matches, read together. Reads only. */
  listPage(query: TradeQuery, page: PageRequest): Promise<{ readonly trades: readonly ListedTrade[]; readonly totalCount: number }>
  /** What positions are calculated from: every Executed and Pending trade (calculateStatusPositions). Reads only. */
  listForPositions(): Promise<readonly StatusPositionTrade[]>
  /**
   * Audit entries in write order (audit id), a page at a time: of one physical row ('trade'), or
   * of a logical trade, its original and its cancellation row ('logical'), the trade named by
   * either. Undefined when no row has the id and no entry names it. Reads only: never writes.
   */
  audit(tradeId: string, scope: AuditScope, page: PageRequest): Promise<AuditPage | undefined>
}

export type AuditScope = 'trade' | 'logical'

/** A row of trades as it was at one write: every column, as stored. */
export interface AuditSnapshot {
  readonly bookingSequence: number
  readonly id: string
  readonly symbol: string
  readonly side: string
  readonly quantity: string
  readonly price: string
  readonly executedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
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
  readonly trade: AuditSnapshot
}

export interface AuditPage {
  /** The physical trades whose entries these are: one, or a logical trade's original and cancellation row. */
  readonly tradeIds: readonly string[]
  readonly entries: readonly AuditEntry[]
  readonly totalCount: number
}

export interface Clock {
  /** The current time. Read once per operation, so every timestamp it assigns agrees. */
  now(): Date
}

export interface IdGenerator {
  /** A new unique trade id. */
  next(): string
}
