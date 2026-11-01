import type { NewTrade, Trade } from '../domain/trade.ts'

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
  /** Every stored trade in trade order: `executedAt` ascending, then booking sequence ascending. */
  listInTradeOrder(): Promise<readonly Trade[]>
}

export interface Clock {
  /** The current time. Read once per operation, so every timestamp it assigns agrees. */
  now(): Date
}

export interface IdGenerator {
  /** A new unique trade id. */
  next(): string
}
