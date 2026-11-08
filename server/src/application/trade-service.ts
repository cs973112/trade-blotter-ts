import { DEFAULT_SYMBOL_MAX_LENGTH, SYMBOL_MAX_LENGTH_RANGE } from '../domain/symbol.ts'
import { toUtcTimestamp } from '../domain/timestamp.ts'
import { pageCount, validateTradePageQuery, validateTradeQuery, type TradePageQueryRequest, type TradeQueryRequest } from '../domain/trade-query.ts'
import { createTrade, validateTradeRequest, type Trade, type TradeRequest } from '../domain/trade.ts'
import { TradeQueryValidationError, TradeValidationError } from './errors.ts'
import type { Clock, IdGenerator, TradeRepository } from './ports.ts'

/** A page of the trades matching a query, with what the blotter needs to page through them. */
export interface TradePage {
  readonly trades: readonly Trade[]
  readonly page: number
  readonly pageSize: number
  /** Trades matching the query, on every page. */
  readonly totalCount: number
  /** Pages they fill: 0 when none match. */
  readonly totalPages: number
}

export interface TradeServiceDependencies {
  readonly trades: TradeRepository
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
     * Validates, timestamps and stores a trade. Throws TradeValidationError, naming every invalid
     * field, before anything is stored. The clock is read once: that reading is `createdAt` and
     * `updatedAt`, and `executedAt` when the request has none.
     */
    async createTrade(request: TradeRequest): Promise<Trade> {
      const result = validateTradeRequest(request, { symbolMaxLength })
      if (!result.ok) throw new TradeValidationError(result.errors)
      const now = toUtcTimestamp(deps.clock.now())
      return deps.trades.add(createTrade(result.value, { id: deps.ids.next(), now }))
    },

    /**
     * Trades for the blotter: those matching the query's filter, in its sort order. With no query
     * parameters, every trade, newest first: the reverse of trade order. Throws
     * TradeQueryValidationError, naming every invalid parameter, before anything is read.
     */
    async listTrades(request: TradeQueryRequest = {}): Promise<readonly Trade[]> {
      const result = validateTradeQuery(request, { symbolMaxLength })
      if (!result.ok) throw new TradeQueryValidationError(result.errors)
      return deps.trades.list(result.value)
    },

    /**
     * One page of what listTrades returns for the same query, with the number of matching trades
     * and pages, read together. Page 1 of 50 trades unless the request says otherwise; a page past
     * the last holds no trades. Throws TradeQueryValidationError, naming every invalid parameter,
     * before anything is read.
     */
    async listTradePage(request: TradePageQueryRequest = {}): Promise<TradePage> {
      const result = validateTradePageQuery(request, { symbolMaxLength })
      if (!result.ok) throw new TradeQueryValidationError(result.errors)
      const { query, page } = result.value
      const { trades, totalCount } = await deps.trades.listPage(query, page)
      return { trades, page: page.page, pageSize: page.pageSize, totalCount, totalPages: pageCount(totalCount, page.pageSize) }
    },
  }
}

export type TradeService = ReturnType<typeof createTradeService>
