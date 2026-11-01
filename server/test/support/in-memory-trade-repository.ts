import type { TradeRepository } from '../../src/application/ports.ts'
import { positionAfterTrade } from '../../src/domain/position.ts'
import { compareTradeOrder, type NewTrade, type Trade } from '../../src/domain/trade.ts'

/**
 * The repository contract in memory: checks each trade against its symbol's history, assigns
 * booking sequences 1, 2, 3, ... and lists in trade order. Exposes what it stores so tests can
 * check what reached persistence.
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
    listInTradeOrder(): Promise<readonly Trade[]> {
      return Promise.resolve([...stored].sort(compareTradeOrder))
    },
    /** Every stored trade in booking order. */
    get stored(): readonly Trade[] {
      return [...stored]
    },
  } satisfies TradeRepository & { readonly stored: readonly Trade[] }
}
