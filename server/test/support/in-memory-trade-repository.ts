import type { TradeRepository } from '../../src/application/ports.ts'
import { positionAfterTrade } from '../../src/domain/position.ts'
import type { TradeFilter } from '../../src/domain/trade-query.ts'
import { compareTradeOrder, type NewTrade, type Trade } from '../../src/domain/trade.ts'

/**
 * The repository contract in memory: checks each trade against its symbol's history, assigns
 * booking sequences 1, 2, 3, ... and lists matching trades in trade order. Exposes what it stores
 * so tests can check what reached persistence.
 */
export function createInMemoryTradeRepository() {
  const stored: Trade[] = []

  return {
    add(trade: NewTrade): Promise<Trade> {
      return new Promise((resolve) => {
        positionAfterTrade(stored, trade)
        const booked: Trade = Object.freeze({ ...trade, bookingSequence: stored.length + 1 })
        stored.push(booked)
        resolve(booked)
      })
    },
    listInTradeOrder(filter: TradeFilter = {}): Promise<readonly Trade[]> {
      return Promise.resolve(stored.filter((trade) => matches(trade, filter)).sort(compareTradeOrder))
    },
    /** Every stored trade in booking order. */
    get stored(): readonly Trade[] {
      return [...stored]
    },
  } satisfies TradeRepository & { readonly stored: readonly Trade[] }
}

function matches(trade: Trade, filter: TradeFilter): boolean {
  return (filter.symbolContains === undefined || trade.symbol.includes(filter.symbolContains)) &&
    (filter.side === undefined || trade.side === filter.side) &&
    (filter.executedFrom === undefined || trade.executedAt >= filter.executedFrom) &&
    (filter.executedTo === undefined || trade.executedAt <= filter.executedTo)
}
