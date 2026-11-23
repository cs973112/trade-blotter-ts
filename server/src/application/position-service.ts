import { calculateStatusPositions, type StatusPosition } from '../domain/position-summary.ts'
import type { LifecycleTradeRepository } from './ports.ts'

export interface PositionServiceDependencies {
  readonly trades: LifecycleTradeRepository
}

export function createPositionService(deps: PositionServiceDependencies) {
  return {
    /**
     * Every listed position, sorted by symbol, from every Executed and Pending trade on each call:
     * Executed, Pending and Projected Net, and the average cost of the Executed trades
     * (calculateStatusPositions). Cancelled trades and cancellation rows count for nothing.
     */
    async listPositions(): Promise<readonly StatusPosition[]> {
      return calculateStatusPositions(await deps.trades.listForPositions())
    },
  }
}

export type PositionService = ReturnType<typeof createPositionService>
