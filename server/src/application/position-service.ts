import { calculatePositions, type Position } from '../domain/position.ts'
import type { TradeRepository } from './ports.ts'

export interface PositionServiceDependencies {
  readonly trades: TradeRepository
}

export function createPositionService(deps: PositionServiceDependencies) {
  return {
    /** Every open position, sorted by symbol, derived from the full trade history on each call. */
    async listPositions(): Promise<readonly Position[]> {
      return calculatePositions(await deps.trades.listInTradeOrder())
    },
  }
}

export type PositionService = ReturnType<typeof createPositionService>
