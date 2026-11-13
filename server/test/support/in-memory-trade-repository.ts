import type { TradePageResult, TradeRepository } from '../../src/application/ports.ts'
import { positionAfterTrade } from '../../src/domain/position.ts'
import { compareTrades, pageWindow, type PageRequest, type TradeFilter, type TradeQuery } from '../../src/domain/trade-query.ts'
import { compareTradeOrder, type NewTrade, type Trade } from '../../src/domain/trade.ts'

/**
 * The repository contract in memory: checks each trade against its symbol's history, assigns
 * booking sequences 1, 2, 3, ... and lists matching trades in trade order, or sorted and paged
 * with compareTrades and pageWindow, the definitions the SQL is tested against. Exposes what it stores
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
    list(query: TradeQuery): Promise<readonly Trade[]> {
      return Promise.resolve(stored.filter((trade) => matches(trade, query.filter)).sort(compareTrades(query.sort)))
    },
    listPage(query: TradeQuery, page: PageRequest): Promise<TradePageResult> {
      const matching = stored.filter((trade) => matches(trade, query.filter)).sort(compareTrades(query.sort))
      const window = pageWindow(page, matching.length)
      return Promise.resolve({
        trades: window === undefined ? [] : matching.slice(window.offset, window.offset + window.limit),
        totalCount: matching.length,
      })
    },
    /** Every stored trade in booking order. */
    get stored(): readonly Trade[] {
      return [...stored]
    },
  } satisfies TradeRepository & { readonly stored: readonly Trade[] }
}

function matches(trade: Trade, filter: TradeFilter): boolean {
  return (filter.symbolContains === undefined || trade.symbol.includes(filter.symbolContains)) &&
    (filter.symbolEquals === undefined || trade.symbol === filter.symbolEquals) &&
    (filter.side === undefined || trade.side === filter.side) &&
    (filter.executedFrom === undefined || trade.executedAt >= filter.executedFrom) &&
    (filter.executedTo === undefined || trade.executedAt <= filter.executedTo)
}
