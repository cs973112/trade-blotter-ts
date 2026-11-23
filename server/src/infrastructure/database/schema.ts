import { sql, type SQL } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

import { SYMBOL_MAX_LENGTH_RANGE } from '../../domain/symbol.ts'
import { ACTORS, CANCELLATION_REASON_MAX_LENGTH, TRADE_STATUSES } from '../../domain/trade-status.ts'
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

/**
 * An exact sort key for a canonical positive decimal column: its number of integer digits,
 * zero-padded to ten, then the text itself. Canonical text has no leading zeros (except a lone
 * "0" before the point) and no trailing fraction zeros, so comparing keys as text compares the
 * values: more integer digits is larger, and with as many, digit by digit, a missing fraction
 * first. Text operations only, never a float. Ten digits cover any length SQLite can store.
 */
function exactDecimalSortKey(column: string): SQL {
  const name = `"${column}"`
  return sql.raw(`printf('%010d', case when instr(${name}, '.') = 0 then length(${name}) else instr(${name}, '.') - 1 end) || ${name}`)
}

/** A SQL list of quoted words: ('A', 'B'). Only for the fixed words of the domain, never for input. */
const words = (values: readonly string[]): SQL => sql.raw(values.map((value) => `'${value}'`).join(', '))

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
    /** Set exactly when the status is Executed; null on Pending and Cancelled rows. */
    executedAt: text('executed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Computed by SQLite on read, never stored or written: the order of quantities by exact value. */
    quantityKey: text('quantity_key').generatedAlwaysAs(exactDecimalSortKey('quantity'), { mode: 'virtual' }),
    /** As quantityKey, for prices. */
    priceKey: text('price_key').generatedAlwaysAs(exactDecimalSortKey('price'), { mode: 'virtual' }),
    /** Pending, Executed or Cancelled (trade-status.ts). */
    status: text('status', { enum: TRADE_STATUSES }).notNull(),
    /** The actor who created the row, and who last changed it: User or Admin. */
    createdBy: text('created_by', { enum: ACTORS }).notNull(),
    updatedBy: text('updated_by', { enum: ACTORS }).notNull(),
    /** On a cancellation row only: the original it cancels. At most one cancellation row per original. */
    originalTradeId: text('original_trade_id').references((): AnySQLiteColumn => trades.id),
    /** On a cancellation row only: why the original was cancelled. */
    cancellationReason: text('cancellation_reason'),
  },
  (t) => [
    // Positions, and listing trades by execution time: every trade in trade order.
    index('trades_trade_order').on(t.executedAt, t.bookingSequence),
    // Creating a trade: one symbol's history in trade order, inside the write transaction. Also
    // listing trades by symbol, which sorts by code point as SQLite compares UTF-8 text.
    index('trades_symbol_trade_order').on(t.symbol, t.executedAt, t.bookingSequence),
    // Listing trades by quantity or price, ties in trade order.
    index('trades_quantity_order').on(t.quantityKey, t.executedAt, t.bookingSequence),
    index('trades_price_order').on(t.priceKey, t.executedAt, t.bookingSequence),
    // The same orders over Executed trades only, which the existing API reads (M3 fix): a page,
    // count or position history with `status = 'Executed'` then walks only these, and never reads a
    // row to test its status. The condition is written as a literal in the repository so SQLite
    // can match it to these indexes.
    index('trades_executed_trade_order').on(t.executedAt, t.bookingSequence).where(sql`${t.status} = 'Executed'`),
    index('trades_executed_symbol_trade_order').on(t.symbol, t.executedAt, t.bookingSequence).where(sql`${t.status} = 'Executed'`),
    index('trades_executed_quantity_order').on(t.quantityKey, t.executedAt, t.bookingSequence).where(sql`${t.status} = 'Executed'`),
    index('trades_executed_price_order').on(t.priceKey, t.executedAt, t.bookingSequence).where(sql`${t.status} = 'Executed'`),
    // The same orders over logical trades only (`original_trade_id is null`: every trade but the
    // cancellation rows), which every trade list reads (M4): a page walks only these and never reads
    // a row it steps over to test the condition. The repository writes the condition as this literal.
    index('trades_logical_trade_order').on(t.executedAt, t.bookingSequence).where(sql`${t.originalTradeId} is null`),
    index('trades_logical_symbol_trade_order').on(t.symbol, t.executedAt, t.bookingSequence).where(sql`${t.originalTradeId} is null`),
    index('trades_logical_quantity_order').on(t.quantityKey, t.executedAt, t.bookingSequence).where(sql`${t.originalTradeId} is null`),
    index('trades_logical_price_order').on(t.priceKey, t.executedAt, t.bookingSequence).where(sql`${t.originalTradeId} is null`),
    check('trades_id', sql`typeof(${t.id}) = 'text' and length(${t.id}) > 0`),
    check('trades_symbol', sql`typeof(${t.symbol}) = 'text'
      and length(${t.symbol}) between 1 and ${sql.raw(String(SYMBOL_MAX_LENGTH_RANGE.max))}
      and ${t.symbol} = trim(${t.symbol})`),
    check('trades_side', sql`${t.side} in (${sql.raw(TRADE_SIDES.map((side) => `'${side}'`).join(', '))})`),
    check('trades_quantity', canonicalPositiveDecimal(t.quantity)),
    check('trades_price', canonicalPositiveDecimal(t.price)),
    // Present exactly when the status is Executed.
    check('trades_executed_at', sql`(${t.status} = 'Executed' and ${canonicalUtcTimestamp(t.executedAt)})
      or (${t.status} <> 'Executed' and ${t.executedAt} is null)`),
    check('trades_status', sql`typeof(${t.status}) = 'text' and ${t.status} in (${words(TRADE_STATUSES)})`),
    check('trades_actors', sql`${t.createdBy} in (${words(ACTORS)}) and ${t.updatedBy} in (${words(ACTORS)})`),
    // An ordinary trade: no original, no reason, created by User. A cancellation row: another trade's
    // id, Cancelled, a reason, and created and last changed by Admin at one time.
    check('trades_cancellation', sql`(${t.originalTradeId} is null and ${t.cancellationReason} is null and ${t.createdBy} = 'User')
      or (typeof(${t.originalTradeId}) = 'text' and ${t.originalTradeId} <> ${t.id} and ${t.status} = 'Cancelled'
        and typeof(${t.cancellationReason}) = 'text' and length(trim(${t.cancellationReason})) > 0
        and length(${t.cancellationReason}) <= ${sql.raw(String(CANCELLATION_REASON_MAX_LENGTH))}
        and ${t.createdBy} = 'Admin' and ${t.updatedBy} = 'Admin' and ${t.createdAt} = ${t.updatedAt})`),
    // One cancellation row per original. Partial (M4): it holds only the cancellation rows, never
    // the ordinary trades' NULLs, which are never equal to one another anyway. So SQLite never
    // takes `original_trade_id is null` (every ordinary trade) for a one-row lookup on this index.
    // Every lookup of a cancellation (= ?, in (...), is not null) implies its condition.
    uniqueIndex('trades_original_trade_id').on(t.originalTradeId).where(sql`${t.originalTradeId} is not null`),
    check('trades_created_at', canonicalUtcTimestamp(t.createdAt)),
    check('trades_updated_at', sql`${canonicalUtcTimestamp(t.updatedAt)} and ${t.updatedAt} >= ${t.createdAt}`),
  ],
)

export type TradeRow = typeof trades.$inferSelect
export type NewTradeRow = typeof trades.$inferInsert

/**
 * The audit trail of every physical write to `trades`, filled by SQLite triggers (created by the
 * lifecycle migration, server/drizzle/*_trade_lifecycle_audit) and by nothing else: AFTER INSERT and
 * AFTER UPDATE copy the new row, BEFORE DELETE the old one. Each entry is a snapshot of every
 * column of `trades` as it was at that write, the generated sort keys included as the values they
 * had, stored as plain text. Append-only: triggers refuse any UPDATE or DELETE of an entry.
 */
export const tradeAudit = sqliteTable(
  'trade_audit',
  {
    auditId: integer('audit_id').primaryKey({ autoIncrement: true }),
    auditAction: text('audit_action', { enum: ['Inserted', 'Updated', 'Deleted'] }).notNull(),
    /** When SQLite performed the write, canonical UTC. */
    auditOn: text('audit_on').notNull(),
    auditBy: text('audit_by', { enum: ['System'] }).notNull(),
    bookingSequence: integer('booking_sequence').notNull(),
    id: text('id').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: text('quantity').notNull(),
    price: text('price').notNull(),
    executedAt: text('executed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    quantityKey: text('quantity_key').notNull(),
    priceKey: text('price_key').notNull(),
    status: text('status').notNull(),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    originalTradeId: text('original_trade_id'),
    cancellationReason: text('cancellation_reason'),
  },
  (t) => [
    index('trade_audit_trade').on(t.id, t.auditId),
    check('trade_audit_action', sql`${t.auditAction} in ('Inserted', 'Updated', 'Deleted')`),
    check('trade_audit_on', canonicalUtcTimestamp(t.auditOn)),
    check('trade_audit_by', sql`${t.auditBy} = 'System'`),
  ],
)

export type TradeAuditRow = typeof tradeAudit.$inferSelect