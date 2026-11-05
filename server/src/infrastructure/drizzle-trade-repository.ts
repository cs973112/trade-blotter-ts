import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'

import type { TradeRepository } from '../application/ports.ts'
import { Dec, decimalText } from '../domain/decimal.ts'
import { positionAfterTrade } from '../domain/position.ts'
import { parseTimestamp, type UtcTimestamp } from '../domain/timestamp.ts'
import type { TradeFilter } from '../domain/trade-query.ts'
import type { NewTrade, Trade } from '../domain/trade.ts'
import type { Database } from './database/connection.ts'
import { trades, type NewTradeRow, type TradeRow } from './database/schema.ts'

/**
 * TradeRepository on SQLite through Drizzle. Rows never leave this module: callers see domain
 * trades with decimal.js values and canonical timestamps.
 */
export function createDrizzleTradeRepository(db: Database): TradeRepository {
  return {
    add(trade) {
      return settle(() =>
        // BEGIN IMMEDIATE takes the write lock before the history is read, so no other connection
        // can insert a trade for the symbol between the check and the insert. The callback is
        // synchronous, as the node:sqlite driver requires; anything it throws rolls everything back.
        db.transaction((tx) => {
          const history = tx.select().from(trades)
            .where(eq(trades.symbol, trade.symbol))
            .orderBy(asc(trades.executedAt), asc(trades.bookingSequence))
            .all()
            .map(toTrade)
          positionAfterTrade(history, trade)
          return toTrade(tx.insert(trades).values(toRow(trade)).returning().get())
        }, { behavior: 'immediate' }))
    },

    listInTradeOrder(filter = {}) {
      return settle(() =>
        db.select().from(trades)
          .where(matching(filter))
          .orderBy(asc(trades.executedAt), asc(trades.bookingSequence))
          .all()
          .map(toTrade))
    },
  }
}

/**
 * The WHERE condition for a filter, or undefined for an empty one. Every value is a bound
 * parameter. Symbols and the search are both normalised, upper case included, so the symbol match
 * is an exact substring test: instr, not LIKE, whose % and _ would be wildcards and whose case
 * folding covers ASCII only. Timestamps are canonical UTC text, so text comparison is time order.
 */
function matching(filter: TradeFilter): SQL | undefined {
  return and(
    filter.symbolContains === undefined ? undefined : sql`instr(${trades.symbol}, ${filter.symbolContains}) > 0`,
    filter.side === undefined ? undefined : eq(trades.side, filter.side),
    filter.executedFrom === undefined ? undefined : gte(trades.executedAt, filter.executedFrom),
    filter.executedTo === undefined ? undefined : lte(trades.executedAt, filter.executedTo),
  )
}

/** Runs synchronous database work and reports its result, or what it threw, as a promise. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work())
  })
}

/** A new trade as its database row: decimals as canonical text. Also used by the test-data seeder. */
export function toRow(trade: NewTrade): NewTradeRow {
  return {
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    quantity: decimalText(trade.quantity),
    price: decimalText(trade.price),
    executedAt: trade.executedAt,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
  }
}

function toTrade(row: TradeRow): Trade {
  return Object.freeze({
    id: row.id,
    bookingSequence: row.bookingSequence,
    symbol: row.symbol,
    side: row.side,
    quantity: new Dec(row.quantity),
    price: new Dec(row.price),
    executedAt: storedTimestamp(row.executedAt),
    createdAt: storedTimestamp(row.createdAt),
    updatedAt: storedTimestamp(row.updatedAt),
  })
}

function storedTimestamp(text: string): UtcTimestamp {
  const timestamp = parseTimestamp(text)
  if (timestamp !== text) throw new Error(`A stored timestamp is not canonical UTC: "${text}".`)
  return timestamp
}
