import { DEFAULT_SYMBOL_MAX_LENGTH, SYMBOL_MAX_LENGTH_RANGE } from '../domain/symbol.ts'
import { toUtcTimestamp } from '../domain/timestamp.ts'
import {
  pageCount, validateAuditQuery, validateTradePageQuery, validateTradeQuery, type AuditQueryScope, type TradePageQueryRequest, type TradeQueryRequest,
} from '../domain/trade-query.ts'
import { PositionLimitError } from '../domain/position.ts'
import { bookTrade, type LifecycleTrade, type ListedTrade } from '../domain/trade-status.ts'
import { validateTradeRequest, type TradeRequest } from '../domain/trade.ts'
import {
  AuditQueryValidationError, CancellationValidationError, ExecutionLimitError, ExecutionValidationError, TradeNotFoundError, TradeQueryValidationError,
  TradeStateError, TradeValidationError,
} from './errors.ts'
import type { AuditEntry, Clock, IdGenerator, LifecycleTradeRepository, StoredExecution } from './ports.ts'

/** A page of the trades matching a query, with what the blotter needs to page through them. */
export interface TradePage {
  readonly trades: readonly ListedTrade[]
  readonly page: number
  readonly pageSize: number
  /** Trades matching the query, on every page. */
  readonly totalCount: number
  /** Pages they fill: 0 when none match. */
  readonly totalPages: number
}

/** A cancellation as stored: the logical trade, now Cancelled, and the cancellation row inserted. */
export interface Cancellation {
  readonly trade: ListedTrade
  readonly cancellationRecord: LifecycleTrade
}

/** A page of a trade's audit trail. */
export interface AuditTrail {
  readonly tradeId: string
  readonly scope: AuditQueryScope
  readonly tradeIds: readonly string[]
  readonly entries: readonly AuditEntry[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

export interface TradeServiceDependencies {
  readonly trades: LifecycleTradeRepository
  readonly clock: Clock
  readonly ids: IdGenerator
  /** Defaults to DEFAULT_SYMBOL_MAX_LENGTH. */
  readonly symbolMaxLength?: number
}

export function createTradeService(deps: TradeServiceDependencies) {
  const symbolMaxLength = deps.symbolMaxLength ?? DEFAULT_SYMBOL_MAX_LENGTH
  if (!Number.isInteger(symbolMaxLength) || symbolMaxLength < SYMBOL_MAX_LENGTH_RANGE.min || symbolMaxLength > SYMBOL_MAX_LENGTH_RANGE.max) {
    throw new RangeError(
      `The maximum symbol length must be an integer from ${String(SYMBOL_MAX_LENGTH_RANGE.min)} to ${String(SYMBOL_MAX_LENGTH_RANGE.max)}.`,
    )
  }

  return {
    /**
     * Validates, timestamps and stores a trade, always Pending, booked by User. Throws
     * TradeValidationError, naming every invalid field (a status other than Pending, or an
     * execution time, among them), before anything is stored. The clock is read once: that reading
     * is `createdAt` and `updatedAt`; `executedAt` is null until the trade is executed. The
     * position limit is applied when storing (LifecycleTradeRepository.book: the projected position).
     */
    async createTrade(request: TradeRequest): Promise<ListedTrade> {
      const result = validateTradeRequest(request, { symbolMaxLength })
      if (!result.ok) throw new TradeValidationError(result.errors)
      const now = toUtcTimestamp(deps.clock.now())
      return { ...(await deps.trades.book(bookTrade(result.value, { id: deps.ids.next(), now }))), cancellation: null }
    },

    /**
     * Executes a Pending trade, as User: in one transaction, the same row becomes Executed, with the
     * clock read after the write lock is held as its execution time and updatedAt. The body must be
     * absent or an empty JSON object: the server sets the time and the actor, and never reads them
     * from the request. Throws ExecutionValidationError (the body), TradeNotFoundError,
     * TradeStateError (already Executed, Cancelled, a cancellation row) or ExecutionLimitError (the
     * Executed position would reach the limit); nothing is written then.
     */
    async executeTrade(tradeId: string, body: unknown): Promise<ListedTrade> {
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) throw new ExecutionValidationError('The request body must be empty or an empty JSON object.')
        const members = Object.keys(body)
        if (members.length > 0) {
          throw new ExecutionValidationError(
            `Unexpected member${members.length === 1 ? '' : 's'} ${members.join(', ')}: an execution takes no fields; the server sets the execution time and who executed it.`,
            Object.fromEntries(members.map((member) => [member, ['Not accepted: an execution takes no fields.']])),
          )
        }
      }
      let result: StoredExecution
      try {
        result = await deps.trades.execute(tradeId, () => toUtcTimestamp(deps.clock.now()))
      } catch (error) {
        if (error instanceof PositionLimitError) {
          throw new ExecutionLimitError(tradeId, error.symbol, `Trade ${tradeId} was not executed: ${error.message} It stays Pending.`)
        }
        throw error
      }
      if (result.ok) return { ...result.trade, cancellation: null }
      switch (result.problem) {
        case 'not-found': throw new TradeNotFoundError(tradeId)
        case 'already-executed': case 'already-cancelled': case 'cancellation-record': throw new TradeStateError(tradeId, result.problem, result.message)
        // The time comes from the server, and a stored row always satisfies the rules: either is a fault.
        case 'invalid-time': case 'invalid-trade': throw new Error(result.message)
      }
    },

    /**
     * Trades for the blotter: one entry per logical trade (never a cancellation row), those matching
     * the query's filter, in its sort order. With no query parameters, every trade, newest
     * execution first, then those without an execution time. Throws TradeQueryValidationError,
     * naming every invalid parameter, before anything is read.
     */
    async listTrades(request: TradeQueryRequest = {}): Promise<readonly ListedTrade[]> {
      const result = validateTradeQuery(request, { symbolMaxLength })
      if (!result.ok) throw new TradeQueryValidationError(result.errors)
      return deps.trades.list(result.value)
    },

    /**
     * One page of what listTrades returns for the same query, with the number of matching trades
     * and pages, read together. Throws TradeQueryValidationError before anything is read.
     */
    async listTradePage(request: TradePageQueryRequest = {}): Promise<TradePage> {
      const result = validateTradePageQuery(request, { symbolMaxLength })
      if (!result.ok) throw new TradeQueryValidationError(result.errors)
      const { query, page } = result.value
      const { trades, totalCount } = await deps.trades.listPage(query, page)
      return { trades, page: page.page, pageSize: page.pageSize, totalCount, totalPages: pageCount(totalCount, page.pageSize) }
    },

    /**
     * Cancels a Pending trade, as Admin, at one clock reading, in one transaction: the original
     * updated and the cancellation row inserted. Throws CancellationValidationError (the body or
     * reason), TradeNotFoundError, or TradeStateError (Executed, already cancelled, a cancellation
     * row); nothing is written then. The actor is never read from the request.
     */
    async cancelTrade(tradeId: string, body: unknown): Promise<Cancellation> {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CancellationValidationError({ reason: ['The request body must be a JSON object with a reason.'] })
      const reason: unknown = (body as { readonly reason?: unknown }).reason
      const result = await deps.trades.cancel(tradeId, { reason }, { id: deps.ids.next(), now: toUtcTimestamp(deps.clock.now()) })
      if (result.ok) {
        const { cancellation } = result
        return {
          trade: { ...result.original, cancellation: { id: cancellation.id, reason: cancellation.cancellationReason ?? '', cancelledAt: cancellation.createdAt, cancelledBy: cancellation.createdBy } },
          cancellationRecord: cancellation,
        }
      }
      switch (result.problem) {
        case 'not-found': throw new TradeNotFoundError(tradeId)
        case 'invalid-reason': throw new CancellationValidationError({ reason: [result.message] })
        case 'not-pending': case 'already-cancelled': case 'cancellation-record': throw new TradeStateError(tradeId, result.problem, result.message)
        // The id and time come from the server, and a stored row always satisfies the rules: any of these is a fault.
        case 'same-id': case 'invalid-time': case 'invalid-trade': throw new Error(result.message)
      }
    },

    /**
     * A page of a trade's audit trail, in write order. Throws AuditQueryValidationError, or
     * TradeNotFoundError when no trade has the id and no audit entry names it.
     */
    async tradeAudit(tradeId: string, request: { readonly scope?: unknown; readonly page?: unknown; readonly pageSize?: unknown } = {}): Promise<AuditTrail> {
      const result = validateAuditQuery(request)
      if (!result.ok) throw new AuditQueryValidationError(result.errors)
      const { scope, page } = result.value
      const trail = await deps.trades.audit(tradeId, scope, page)
      if (trail === undefined) throw new TradeNotFoundError(tradeId)
      return { tradeId, scope, tradeIds: trail.tradeIds, entries: trail.entries, page: page.page, pageSize: page.pageSize, totalCount: trail.totalCount, totalPages: pageCount(trail.totalCount, page.pageSize) }
    },
  }
}

export type TradeService = ReturnType<typeof createTradeService>