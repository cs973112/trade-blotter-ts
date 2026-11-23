import type { AuditEntry, AuditSnapshot, LifecycleTradeRepository } from '../../src/application/ports.ts'
import { decimalText } from '../../src/domain/decimal.ts'
import { executedPositionAfterExecution, executedPositionAfterTrade, pendingPositionAfterTrade } from '../../src/domain/position-summary.ts'
import { toUtcTimestamp, type UtcTimestamp } from '../../src/domain/timestamp.ts'
import { compareTrades, pageWindow, type TradeFilter } from '../../src/domain/trade-query.ts'
import { cancelTrade, executeTrade, type LifecycleTrade, type ListedTrade, type NewLifecycleTrade } from '../../src/domain/trade-status.ts'

/**
 * The lifecycle repository contract in memory, built from the domain's own definitions: the two
 * position-limit rules, cancelTrade, executeTrade, compareTrades and pageWindow, which the SQL is tested
 * against. It keeps an audit trail of its own writes as the triggers would (with the generated
 * keys left empty). Exposes what it stores so tests can check what reached persistence.
 */
export function createInMemoryLifecycleRepository(clock: () => UtcTimestamp = () => toUtcTimestamp(new Date())) {
  const stored: LifecycleTrade[] = []
  const audit: AuditEntry[] = []
  const record = (action: AuditEntry['auditAction'], trade: LifecycleTrade): void => {
    const snapshot: AuditSnapshot = {
      bookingSequence: trade.bookingSequence, id: trade.id, symbol: trade.symbol, side: trade.side, quantity: decimalText(trade.quantity), price: decimalText(trade.price),
      executedAt: trade.executedAt, createdAt: trade.createdAt, updatedAt: trade.updatedAt, quantityKey: '', priceKey: '', status: trade.status,
      createdBy: trade.createdBy, updatedBy: trade.updatedBy, originalTradeId: trade.originalTradeId, cancellationReason: trade.cancellationReason,
    }
    audit.push({ auditId: audit.length + 1, auditAction: action, auditOn: clock(), auditBy: 'System', trade: snapshot })
  }
  const insert = (trade: NewLifecycleTrade): LifecycleTrade => {
    const booked: LifecycleTrade = Object.freeze({ ...trade, bookingSequence: stored.length + 1 })
    stored.push(booked)
    record('Inserted', booked)
    return booked
  }
  const listed = (filter: TradeFilter): ListedTrade[] => stored
    .filter((trade) => trade.originalTradeId === null && matches(trade, filter))
    .map((trade) => {
      const row = stored.find((candidate) => candidate.originalTradeId === trade.id)
      return { ...trade, cancellation: row === undefined ? null : { id: row.id, reason: row.cancellationReason ?? '', cancelledAt: row.createdAt, cancelledBy: row.createdBy } }
    })

  const repository: LifecycleTradeRepository = {
    book(trade) {
      return new Promise((resolve) => {
        const history = stored.filter((row) => row.symbol === trade.symbol)
        if (trade.status === 'Executed' && trade.executedAt !== null) executedPositionAfterTrade(history, { ...trade, executedAt: trade.executedAt })
        else pendingPositionAfterTrade(history, trade)
        resolve(insert(trade))
      })
    },
    cancel(tradeId, request, assigned) {
      const index = stored.findIndex((row) => row.id === tradeId)
      const trade = stored[index]
      if (trade === undefined) return Promise.resolve({ ok: false, problem: 'not-found', message: `No trade has the id ${tradeId}.` })
      const decided = cancelTrade(trade, request, assigned)
      if (!decided.ok) return Promise.resolve(decided)
      stored[index] = decided.original
      record('Updated', decided.original)
      return Promise.resolve({ ok: true, original: decided.original, cancellation: insert(decided.cancellation) })
    },
    execute(tradeId, now) {
      return new Promise((resolve) => {
        const executedAt = now()
        const index = stored.findIndex((row) => row.id === tradeId)
        const trade = stored[index]
        if (trade === undefined) {
          resolve({ ok: false, problem: 'not-found', message: `No trade has the id ${tradeId}.` })
          return
        }
        const decided = executeTrade(trade, { now: executedAt })
        if (!decided.ok) {
          resolve(decided)
          return
        }
        executedPositionAfterExecution(stored.filter((row) => row.symbol === trade.symbol), { ...decided.trade, executedAt })
        stored[index] = decided.trade
        record('Updated', decided.trade)
        resolve({ ok: true, trade: decided.trade })
      })
    },
    get: (tradeId) => Promise.resolve(stored.find((row) => row.id === tradeId)),
    listAll: () => Promise.resolve([...stored]),
    list: ({ filter, sort }) => Promise.resolve(listed(filter).sort(compareTrades(sort))),
    listPage({ filter, sort }, page) {
      const matching = listed(filter).sort(compareTrades(sort))
      const window = pageWindow(page, matching.length)
      return Promise.resolve({ trades: window === undefined ? [] : matching.slice(window.offset, window.offset + window.limit), totalCount: matching.length })
    },
    listForPositions: () => Promise.resolve(stored.filter((row) => row.status === 'Executed' || row.status === 'Pending')),
    audit(tradeId, scope, page) {
      const ids = new Set([tradeId])
      if (scope === 'logical') {
        for (const entry of audit) {
          if (entry.trade.id === tradeId && entry.trade.originalTradeId !== null) ids.add(entry.trade.originalTradeId)
          if (entry.trade.originalTradeId === tradeId) ids.add(entry.trade.id)
        }
      }
      const entries = audit.filter((entry) => ids.has(entry.trade.id))
      if (entries.length === 0 && !stored.some((row) => ids.has(row.id))) return Promise.resolve(undefined)
      const window = pageWindow(page, entries.length)
      return Promise.resolve({ tradeIds: [...ids].sort(), entries: window === undefined ? [] : entries.slice(window.offset, window.offset + window.limit), totalCount: entries.length })
    },
  }
  return Object.assign(repository, {
    get stored(): readonly LifecycleTrade[] {
      return stored
    },
    get auditTrail(): readonly AuditEntry[] {
      return audit
    },
  })
}

function matches(trade: LifecycleTrade, filter: TradeFilter): boolean {
  if (filter.symbolContains !== undefined && !trade.symbol.includes(filter.symbolContains)) return false
  if (filter.symbolEquals !== undefined && trade.symbol !== filter.symbolEquals) return false
  if (filter.side !== undefined && trade.side !== filter.side) return false
  if (filter.status !== undefined && trade.status !== filter.status) return false
  if (filter.executedFrom !== undefined && (trade.executedAt === null || trade.executedAt < filter.executedFrom)) return false
  if (filter.executedTo !== undefined && (trade.executedAt === null || trade.executedAt > filter.executedTo)) return false
  return true
}
