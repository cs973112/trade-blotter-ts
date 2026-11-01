import { asc, eq } from 'drizzle-orm'

import type { TradeRepository } from '../application/ports.ts'
import { Dec, decimalText } from '../domain/decimal.ts'
import { positionAfterTrade } from '../domain/position.ts'
import { parseTimestamp, type UtcTimestamp } from '../domain/timestamp.ts'
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

    listInTradeOrder() {
      return settle(() =>
        db.select().from(trades).orderBy(asc(trades.executedAt), asc(trades.bookingSequence)).all().map(toTrade))
    },
  }
}

/** Runs synchronous database work and reports its result, or what it threw, as a promise. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work())
  })
}

function toRow(trade: NewTrade): NewTradeRow {
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
