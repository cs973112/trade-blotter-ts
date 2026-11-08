import type { PageRequest, TradeFilter, TradeQuery } from '../domain/trade-query.ts'
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

export interface Clock {
  /** The current time. Read once per operation, so every timestamp it assigns agrees. */
  now(): Date
}

export interface IdGenerator {
  /** A new unique trade id. */
  next(): string
}
