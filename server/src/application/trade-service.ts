import { DEFAULT_SYMBOL_MAX_LENGTH, SYMBOL_MAX_LENGTH_RANGE } from '../domain/symbol.ts'
import { toUtcTimestamp } from '../domain/timestamp.ts'
import { createTrade, validateTradeRequest, type Trade, type TradeRequest } from '../domain/trade.ts'
import { TradeValidationError } from './errors.ts'
import type { Clock, IdGenerator, TradeRepository } from './ports.ts'

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

    /** Every trade for the blotter, newest first: the reverse of trade order. */
    async listTrades(): Promise<readonly Trade[]> {
      return [...(await deps.trades.listInTradeOrder())].reverse()
    },
  }
}

export type TradeService = ReturnType<typeof createTradeService>
