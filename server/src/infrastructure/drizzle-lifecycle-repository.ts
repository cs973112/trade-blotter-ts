import { and, asc, count, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm'

import type { AuditEntry, AuditSnapshot, LifecycleTradeRepository } from '../application/ports.ts'
import { Dec, decimalText } from '../domain/decimal.ts'
import { executedPositionAfterExecution, executedPositionAfterTrade, pendingPositionAfterTrade } from '../domain/position-summary.ts'
import { pageWindow, type TradeFilter } from '../domain/trade-query.ts'
import { cancelTrade, executeTrade, lifecycleProblems, type LifecycleTrade, type ListedTrade, type NewLifecycleTrade, type TradeStatus } from '../domain/trade-status.ts'
import type { Database } from './database/connection.ts'
import { tradeAudit, trades, type NewTradeRow, type TradeRow } from './database/schema.ts'
import { ordering, planPageRead, storedTimestamp } from './drizzle-trade-repository.ts'

/**
 * Which rows a list reads: the logical trades, every row but the cancellation rows, and those of
 * one status. A logical trade is `original_trade_id is null`, the domain's own definition of an
 * ordinary trade, exact in every database state. Each condition is a fixed literal, never input,
 * so SQLite can match `status = 'Executed'` to the Executed partial indexes (schema.ts); and since
 * the unique index on original_trade_id holds only cancellation rows, `is null` is never served
 * from it. Every filter value is a bound parameter.
 */
const LOGICAL = sql`${trades.originalTradeId} is null`
const OF_STATUS: Readonly<Record<TradeStatus, SQL>> = {
  // Executed rows are never cancellation rows.
  Executed: sql`${trades.status} = 'Executed'`,
  Pending: sql`${trades.originalTradeId} is null and ${trades.status} = 'Pending'`,
  Cancelled: sql`${trades.originalTradeId} is null and ${trades.status} = 'Cancelled'`,
}

/** The WHERE condition for a filter over logical trades, as the existing repository writes it (matching). */
function listed(filter: TradeFilter): SQL | undefined {
  return and(
    filter.status === undefined ? LOGICAL : OF_STATUS[filter.status],
    filter.symbolContains === undefined ? undefined : sql`instr(${trades.symbol}, ${filter.symbolContains}) > 0`,
    filter.symbolEquals === undefined ? undefined : eq(trades.symbol, filter.symbolEquals),
    filter.side === undefined ? undefined : eq(trades.side, filter.side),
    filter.executedFrom === undefined ? undefined : gte(trades.executedAt, filter.executedFrom),
    filter.executedTo === undefined ? undefined : lte(trades.executedAt, filter.executedTo),
  )
}

const AUDIT_COLUMNS = {
  auditId: tradeAudit.auditId, auditAction: tradeAudit.auditAction, auditOn: tradeAudit.auditOn, auditBy: tradeAudit.auditBy,
  bookingSequence: tradeAudit.bookingSequence, id: tradeAudit.id, symbol: tradeAudit.symbol, side: tradeAudit.side, quantity: tradeAudit.quantity,
  price: tradeAudit.price, executedAt: tradeAudit.executedAt, createdAt: tradeAudit.createdAt, updatedAt: tradeAudit.updatedAt,
  quantityKey: tradeAudit.quantityKey, priceKey: tradeAudit.priceKey, status: tradeAudit.status, createdBy: tradeAudit.createdBy,
  updatedBy: tradeAudit.updatedBy, originalTradeId: tradeAudit.originalTradeId, cancellationReason: tradeAudit.cancellationReason,
}

/**
 * LifecycleTradeRepository on SQLite through Drizzle (M3: persistence only; the API does not use
 * it yet). Every row is a physical row of `trades`; the audit triggers record each write.
 */

const COLUMNS = {
  bookingSequence: trades.bookingSequence, id: trades.id, symbol: trades.symbol, side: trades.side, quantity: trades.quantity, price: trades.price,
  executedAt: trades.executedAt, createdAt: trades.createdAt, updatedAt: trades.updatedAt, status: trades.status, createdBy: trades.createdBy,
  updatedBy: trades.updatedBy, originalTradeId: trades.originalTradeId, cancellationReason: trades.cancellationReason,
}

type StoredRow = Pick<TradeRow, keyof typeof COLUMNS>

export class LifecycleRowError extends Error {}

export function createDrizzleLifecycleRepository(db: Database): LifecycleTradeRepository {
  return {
    book(trade) {
      return settle(() => {
        if (trade.status === 'Cancelled' || trade.originalTradeId !== null) throw new LifecycleRowError('A booking is Pending or Executed, and is not a cancellation row.')
        const problems = lifecycleProblems(trade)
        if (problems.length > 0) throw new LifecycleRowError(`The booking breaks the lifecycle rules: ${problems.join(' ')}`)
        // BEGIN IMMEDIATE: the write lock is held from the read of the history to the insert.
        return db.transaction((tx) => {
          const history = tx.select(COLUMNS).from(trades).where(eq(trades.symbol, trade.symbol)).all().map(toLifecycleTrade)
          if (trade.status === 'Executed' && trade.executedAt !== null) {
            executedPositionAfterTrade(history, { symbol: trade.symbol, side: trade.side, quantity: trade.quantity, price: trade.price, executedAt: trade.executedAt })
          } else {
            pendingPositionAfterTrade(history, trade)
          }
          return toLifecycleTrade(tx.insert(trades).values(toRow(trade)).returning(COLUMNS).get())
        }, { behavior: 'immediate' })
      })
    },

    cancel(tradeId, request, assigned) {
      return settle(() =>
        // One IMMEDIATE transaction: no other connection can change the trade between the read and
        // the writes, and anything thrown after the update rolls the update back too.
        db.transaction((tx) => {
          const row = tx.select(COLUMNS).from(trades).where(eq(trades.id, tradeId)).get()
          if (row === undefined) return { ok: false, problem: 'not-found', message: `No trade has the id ${tradeId}.` } as const
          const decided = cancelTrade(toLifecycleTrade(row), request, assigned)
          if (!decided.ok) return decided
          // Only while it is still Pending: the guard holds even if a caller skipped the read above.
          const updated = tx.update(trades)
            .set({ status: 'Cancelled', updatedBy: decided.original.updatedBy, updatedAt: decided.original.updatedAt })
            .where(and(eq(trades.bookingSequence, row.bookingSequence), eq(trades.status, 'Pending')))
            .returning(COLUMNS).all()
          if (updated.length !== 1 || updated[0] === undefined) throw new LifecycleRowError(`Trade ${tradeId} changed while it was being cancelled; nothing was written.`)
          const inserted = tx.insert(trades).values(toRow(decided.cancellation)).returning(COLUMNS).get()
          return { ok: true, original: toLifecycleTrade(updated[0]), cancellation: toLifecycleTrade(inserted) } as const
        }, { behavior: 'immediate' }))
    },

    execute(tradeId, now) {
      return settle(() =>
        // BEGIN IMMEDIATE takes the write lock before anything is read, so the execution time, read
        // next, is after every write that committed before this one, and no other connection can
        // change the trade or its symbol's history until this commits. Anything thrown rolls back.
        db.transaction((tx) => {
          const executedAt = now()
          const row = tx.select(COLUMNS).from(trades).where(eq(trades.id, tradeId)).get()
          if (row === undefined) return { ok: false, problem: 'not-found', message: `No trade has the id ${tradeId}.` } as const
          const decided = executeTrade(toLifecycleTrade(row), { now: executedAt })
          if (!decided.ok) return decided
          const executed = decided.trade
          const history = tx.select(COLUMNS).from(trades).where(eq(trades.symbol, executed.symbol)).all().map(toLifecycleTrade)
          executedPositionAfterExecution(history, { ...executed, executedAt })
          // Only while it is still Pending: the guard holds even if a caller skipped the read above.
          const updated = tx.update(trades)
            .set({ status: 'Executed', executedAt, updatedBy: executed.updatedBy, updatedAt: executed.updatedAt })
            .where(and(eq(trades.bookingSequence, row.bookingSequence), eq(trades.status, 'Pending')))
            .returning(COLUMNS).all()
          if (updated.length !== 1 || updated[0] === undefined) throw new LifecycleRowError(`Trade ${tradeId} changed while it was being executed; nothing was written.`)
          return { ok: true, trade: toLifecycleTrade(updated[0]) } as const
        }, { behavior: 'immediate' }))
    },

    get(tradeId) {
      return settle(() => {
        const row = db.select(COLUMNS).from(trades).where(eq(trades.id, tradeId)).get()
        return row === undefined ? undefined : toLifecycleTrade(row)
      })
    },

    listAll() {
      return settle(() => db.select(COLUMNS).from(trades).orderBy(asc(trades.bookingSequence)).all().map(toLifecycleTrade))
    },

    list({ filter, sort }) {
      return settle(() => db.transaction((tx) => {
        const rows = tx.select(COLUMNS).from(trades).where(listed(filter)).orderBy(...ordering(sort.field, sort.direction, true)).all()
        // Every cancellation, at once: there are as many as cancelled trades.
        const cancellations = tx.select(COLUMNS).from(trades).where(sql`${trades.originalTradeId} is not null`).all()
        return withCancellations(rows, cancellations)
      }, { behavior: 'deferred' }))
    },

    listPage({ filter, sort }, page) {
      return settle(() => db.transaction((tx) => {
        const where = listed(filter)
        const totalCount = tx.select({ count: count() }).from(trades).where(where).get()?.count ?? 0
        const window = pageWindow(page, totalCount)
        if (window === undefined) return { trades: [], totalCount }
        const plan = planPageRead(window, totalCount, sort.field, filter, () => tx.select({ count: count() }).from(trades).where(LOGICAL).get()?.count ?? 0)
        const direction = plan.fromEnd ? (sort.direction === 'asc' ? 'desc' : 'asc') : sort.direction
        const rows = tx.select(COLUMNS).from(trades).where(where)
          .orderBy(...ordering(sort.field, direction, plan.useSortIndex)).limit(window.limit).offset(plan.skip).all()
        const ordered = plan.fromEnd ? rows.reverse() : rows
        // The cancellations of this page's trades only, through the unique index on original_trade_id.
        const ids = ordered.filter((row) => row.status === 'Cancelled').map((row) => row.id)
        const cancellations = ids.length === 0 ? [] : tx.select(COLUMNS).from(trades).where(inArray(trades.originalTradeId, ids)).all()
        return { trades: withCancellations(ordered, cancellations), totalCount }
      }, { behavior: 'deferred' }))
    },

    listForPositions() {
      return settle(() => db.select({
        symbol: trades.symbol, side: trades.side, quantity: trades.quantity, price: trades.price, status: trades.status,
        executedAt: trades.executedAt, bookingSequence: trades.bookingSequence, originalTradeId: trades.originalTradeId,
      }).from(trades).where(or(OF_STATUS.Executed, OF_STATUS.Pending)).all().map((row) => Object.freeze({
        ...row, quantity: new Dec(row.quantity), price: new Dec(row.price), executedAt: row.executedAt === null ? null : storedTimestamp(row.executedAt),
      })))
    },

    audit(tradeId, scope, page) {
      return settle(() => db.transaction((tx) => {
        const ids = new Set([tradeId])
        if (scope === 'logical') {
          // The logical trade: the original (this row, or the one it cancels) and its cancellation row,
          // from the trades still stored and from the audit trail, for rows since deleted.
          for (const source of [trades, tradeAudit] as const) {
            for (const row of tx.selectDistinct({ id: source.id, originalTradeId: source.originalTradeId }).from(source)
              .where(or(eq(source.id, tradeId), eq(source.originalTradeId, tradeId))).all()) {
              ids.add(row.id)
              if (row.originalTradeId !== null) ids.add(row.originalTradeId)
            }
          }
          for (const id of [...ids]) {
            for (const row of tx.selectDistinct({ id: tradeAudit.id }).from(tradeAudit).where(eq(tradeAudit.originalTradeId, id)).all()) ids.add(row.id)
          }
        }
        const tradeIds = [...ids].sort()
        const where = inArray(tradeAudit.id, tradeIds)
        const totalCount = tx.select({ count: count() }).from(tradeAudit).where(where).get()?.count ?? 0
        const exists = tx.select({ id: trades.id }).from(trades).where(inArray(trades.id, tradeIds)).limit(1).get() !== undefined
        if (totalCount === 0 && !exists) return undefined
        const window = pageWindow(page, totalCount)
        const entries = window === undefined ? [] : tx.select(AUDIT_COLUMNS).from(tradeAudit).where(where)
          .orderBy(asc(tradeAudit.auditId)).limit(window.limit).offset(window.offset).all().map(toAuditEntry)
        return { tradeIds, entries, totalCount }
      }, { behavior: 'deferred' }))
    },
  }
}

/** Each row as a listed trade, with what its cancellation row records when it has one. */
function withCancellations(rows: readonly StoredRow[], cancellations: readonly StoredRow[]): ListedTrade[] {
  const byOriginal = new Map(cancellations.map((row) => [row.originalTradeId, row]))
  return rows.map((row) => {
    const cancellation = byOriginal.get(row.id)
    return Object.freeze({
      ...toLifecycleTrade(row),
      cancellation: cancellation === undefined ? null : Object.freeze({
        id: cancellation.id, reason: cancellation.cancellationReason ?? '', cancelledAt: storedTimestamp(cancellation.createdAt), cancelledBy: cancellation.createdBy,
      }),
    })
  })
}

function toAuditEntry(row: { readonly auditId: number; readonly auditAction: AuditEntry['auditAction']; readonly auditOn: string; readonly auditBy: 'System' } & Omit<AuditSnapshot, 'status' | 'createdBy' | 'updatedBy'> & { readonly status: string; readonly createdBy: string; readonly updatedBy: string }): AuditEntry {
  const { auditId, auditAction, auditOn, auditBy, ...snapshot } = row
  return Object.freeze({ auditId, auditAction, auditOn: storedTimestamp(auditOn), auditBy, trade: Object.freeze(snapshot as AuditSnapshot) })
}

function toRow(trade: NewLifecycleTrade): NewTradeRow {
  return {
    id: trade.id, symbol: trade.symbol, side: trade.side, quantity: decimalText(trade.quantity), price: decimalText(trade.price),
    executedAt: trade.executedAt, createdAt: trade.createdAt, updatedAt: trade.updatedAt, status: trade.status,
    createdBy: trade.createdBy, updatedBy: trade.updatedBy, originalTradeId: trade.originalTradeId, cancellationReason: trade.cancellationReason,
  }
}

function toLifecycleTrade(row: StoredRow): LifecycleTrade {
  return Object.freeze({
    id: row.id, bookingSequence: row.bookingSequence, symbol: row.symbol, side: row.side, quantity: new Dec(row.quantity), price: new Dec(row.price),
    status: row.status, executedAt: row.executedAt === null ? null : storedTimestamp(row.executedAt),
    createdAt: storedTimestamp(row.createdAt), updatedAt: storedTimestamp(row.updatedAt), createdBy: row.createdBy, updatedBy: row.updatedBy,
    originalTradeId: row.originalTradeId, cancellationReason: row.cancellationReason,
  })
}

/** Runs synchronous database work and reports its result, or what it threw, as a promise. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work())
  })
}
