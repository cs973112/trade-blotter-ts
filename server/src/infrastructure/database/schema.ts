import { sql, type SQL } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

import { SYMBOL_MAX_LENGTH_RANGE } from '../../domain/symbol.ts'
import { TRADE_SIDES } from '../../domain/trade.ts'

/**
 * The database schema. Decimals and timestamps are TEXT in canonical form, never REAL: nothing is
 * calculated in SQL, and canonical UTC text sorts chronologically. The CHECK constraints guard the
 * stored representation; the business rules (input ranges, position limits) live in the domain.
 * Drizzle cannot declare STRICT tables. TEXT affinity already converts a number written to these
 * columns into text (a bound JavaScript number 1 becomes '1.0'), which the canonical-form checks then
 * judge; `typeof(...) = 'text'` additionally rejects blobs.
 */

/** A canonical positive decimal: digits with at most one point, no leading or trailing zeros, not zero. */
function canonicalPositiveDecimal(column: AnySQLiteColumn): SQL {
  return sql`typeof(${column}) = 'text'
    and (${column} glob '[0-9]' or ${column} glob '[0-9]*[0-9]')
    and ${column} not glob '*[^0-9.]*'
    and ${column} not glob '*.*.*'
    and ${column} not glob '0[0-9]*'
    and not (${column} glob '*.*' and ${column} glob '*0')
    and ${column} <> '0'`
}

/** Canonical UTC with milliseconds, the output of Date.prototype.toISOString. */
function canonicalUtcTimestamp(column: AnySQLiteColumn): SQL {
  return sql`typeof(${column}) = 'text'
    and ${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`
}

export const trades = sqliteTable(
  'trades',
  {
    /** Booking order, assigned by SQLite. AUTOINCREMENT: never reused, always above any value used before. */
    bookingSequence: integer('booking_sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: TRADE_SIDES }).notNull(),
    quantity: text('quantity').notNull(),
    price: text('price').notNull(),
    executedAt: text('executed_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    // GET /trades and positions: every trade in trade order.
    index('trades_trade_order').on(t.executedAt, t.bookingSequence),
    // Creating a trade: one symbol's history in trade order, inside the write transaction.
    index('trades_symbol_trade_order').on(t.symbol, t.executedAt, t.bookingSequence),
    check('trades_id', sql`typeof(${t.id}) = 'text' and length(${t.id}) > 0`),
    check('trades_symbol', sql`typeof(${t.symbol}) = 'text'
      and length(${t.symbol}) between 1 and ${sql.raw(String(SYMBOL_MAX_LENGTH_RANGE.max))}
      and ${t.symbol} = trim(${t.symbol})`),
    check('trades_side', sql`${t.side} in (${sql.raw(TRADE_SIDES.map((side) => `'${side}'`).join(', '))})`),
    check('trades_quantity', canonicalPositiveDecimal(t.quantity)),
    check('trades_price', canonicalPositiveDecimal(t.price)),
    check('trades_executed_at', canonicalUtcTimestamp(t.executedAt)),
    check('trades_created_at', canonicalUtcTimestamp(t.createdAt)),
    check('trades_updated_at', sql`${canonicalUtcTimestamp(t.updatedAt)} and ${t.updatedAt} >= ${t.createdAt}`),
  ],
)

export type TradeRow = typeof trades.$inferSelect
export type NewTradeRow = typeof trades.$inferInsert
