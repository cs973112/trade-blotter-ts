import { and, asc, count, eq, gte, lte, sql, type SQL } from 'drizzle-orm'

import type { TradeRepository } from '../application/ports.ts'
import { Dec, decimalText } from '../domain/decimal.ts'
import { positionAfterTrade } from '../domain/position.ts'
import { parseTimestamp, type UtcTimestamp } from '../domain/timestamp.ts'
import { pageWindow, type SortDirection, type TradeFilter, type TradeSortField } from '../domain/trade-query.ts'
import type { NewTrade, Trade } from '../domain/trade.ts'
import type { Database } from './database/connection.ts'
import { trades, type NewTradeRow, type TradeRow } from './database/schema.ts'

/** Every stored column. The generated sort keys are left out, so a read never computes them. */
const TRADE_COLUMNS = {
  bookingSequence: trades.bookingSequence,
  id: trades.id,
  symbol: trades.symbol,
  side: trades.side,
  quantity: trades.quantity,
  price: trades.price,
  executedAt: trades.executedAt,
  createdAt: trades.createdAt,
  updatedAt: trades.updatedAt,
}

type StoredTrade = Omit<TradeRow, 'quantityKey' | 'priceKey'>

/**
 * The column each sort field orders by. Symbols compare as UTF-8 bytes, which is code-point order;
 * quantities and prices by their exact sort keys (schema.ts); timestamps as canonical UTC text.
 */
const SORT_COLUMNS = {
  executedAt: trades.executedAt,
  symbol: trades.symbol,
  quantity: trades.quantityKey,
  price: trades.priceKey,
} as const

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
          const history = tx.select(TRADE_COLUMNS).from(trades)
            .where(eq(trades.symbol, trade.symbol))
            .orderBy(asc(trades.executedAt), asc(trades.bookingSequence))
            .all()
            .map(toTrade)
          positionAfterTrade(history, trade)
          return toTrade(tx.insert(trades).values(toRow(trade)).returning(TRADE_COLUMNS).get())
        }, { behavior: 'immediate' }))
    },

    listInTradeOrder(filter = {}) {
      return settle(() =>
        db.select(TRADE_COLUMNS).from(trades)
          .where(matching(filter))
          .orderBy(asc(trades.executedAt), asc(trades.bookingSequence))
          .all()
          .map(toTrade))
    },

    list({ filter, sort }) {
      // Every match is read, so walking a scattered index would look up every trade one by one.
      const useSortIndex = !scatteredIndexWalk(sort.field, filter)
      return settle(() =>
        db.select(TRADE_COLUMNS).from(trades)
          .where(matching(filter))
          .orderBy(...ordering(sort.field, sort.direction, useSortIndex))
          .all()
          .map(toTrade))
    },

    listPage({ filter, sort }, page) {
      return settle(() =>
        // One read transaction: the count and the page come from the same snapshot of the file,
        // even if another connection books a trade between the two statements.
        db.transaction((tx) => {
          const where = matching(filter)
          const totalCount = tx.select({ count: count() }).from(trades).where(where).get()?.count ?? 0
          const window = pageWindow(page, totalCount)
          if (window === undefined) return { trades: [], totalCount }

          const plan = planPageRead(window, totalCount, sort.field, filter, () => tx.select({ count: count() }).from(trades).get()?.count ?? 0)
          const direction = plan.fromEnd ? (sort.direction === 'asc' ? 'desc' : 'asc') : sort.direction
          const rows = tx.select(TRADE_COLUMNS).from(trades)
            .where(where)
            .orderBy(...ordering(sort.field, direction, plan.useSortIndex))
            .limit(window.limit)
            .offset(plan.skip)
            .all()
          return { trades: (plan.fromEnd ? rows.reverse() : rows).map(toTrade), totalCount }
        }, { behavior: 'deferred' }))
    },
  }
}

/**
 * ORDER BY for a sort: its column, then execution time, then booking sequence, all in one
 * direction, which is the order compareTrades defines. With `useSortIndex` false, the first term
 * is written `+column`: the same value and order, but SQLite can no longer walk that column's
 * index to produce it, so it reads the matching rows another way and sorts them.
 */
function ordering(field: TradeSortField, direction: SortDirection, useSortIndex: boolean): SQL[] {
  const order = direction === 'asc' ? sql`asc` : sql`desc`
  const columns = [...new Set([SORT_COLUMNS[field], trades.executedAt, trades.bookingSequence])]
  return columns.map((column, index) => index === 0 && !useSortIndex ? sql`+${column} ${order}` : sql`${column} ${order}`)
}

export interface PageReadPlan {
  /** Read in the opposite direction from the end of the order, then turn the rows round. */
  readonly fromEnd: boolean
  /** Rows to skip from the end read from. */
  readonly skip: number
  /** Let SQLite walk the sort column's index; otherwise it sorts the matches. */
  readonly useSortIndex: boolean
}

/**
 * Whether producing the order by walking the sort column's index would visit trades scattered
 * across the table while a condition no index serves (symbol or side) rejects some of them. The
 * execution-time index lists trades in about the order they are stored, so walking it is cheap;
 * the symbol, quantity and price indexes do not, and each trade they lead to is a separate lookup.
 * Listing every match that way measured several times dearer, on 25,000 trades, than reading
 * every trade once and sorting the matches: 56 against 10 ms (symbol BRK, by price), 142 against
 * 36 ms (symbol MS, by quantity), 156 against 52 ms (side Buy, by quantity).
 */
function scatteredIndexWalk(field: TradeSortField, filter: TradeFilter): boolean {
  return field !== 'executedAt' && (filter.symbolContains !== undefined || filter.side !== undefined)
}

/**
 * How listPage reads a page that exists. Every plan gives the same rows; they differ in cost.
 *
 * - From the nearer end: OFFSET steps past every row it skips, so a page in the second half is
 *   read from the end, which skips fewer.
 * - Through the sort index, unless walking it would be scattered (scatteredIndexWalk) and the
 *   page is deep. Walking then visits about `rowsToPage × tradeCount / matchCount` trades, each
 *   looked up by itself, while sorting reads every trade once and sorts the matches. Measured on
 *   25,000 trades, a trade visited that way costs about ten reads in a scan, and a sorted match
 *   about eleven; the plan walks when that estimate is no dearer. A first or last page almost
 *   always walks; a page deep among few matches sorts. `tradeCount` is only asked for then.
 */
export function planPageRead(
  window: { readonly offset: number; readonly limit: number },
  matchCount: number,
  field: TradeSortField,
  filter: TradeFilter,
  tradeCount: () => number,
): PageReadPlan {
  const fromEnd = matchCount - window.offset - window.limit < window.offset
  const skip = fromEnd ? matchCount - window.offset - window.limit : window.offset
  if (!scatteredIndexWalk(field, filter)) return { fromEnd, skip, useSortIndex: true }
  const trades = tradeCount()
  return { fromEnd, skip, useSortIndex: (skip + window.limit) * trades <= matchCount * (trades / 10 + 1.1 * matchCount) }
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

function toTrade(row: StoredTrade): Trade {
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
