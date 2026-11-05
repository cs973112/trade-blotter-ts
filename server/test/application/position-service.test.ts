import { describe, expect, it } from 'vitest'

import { createPositionService } from '../../src/application/position-service.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { Dec, decimalText } from '../../src/domain/decimal.ts'
import { PositionLimitError } from '../../src/domain/position.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { createInMemoryTradeRepository } from '../support/in-memory-trade-repository.ts'

function setup() {
  const trades = createInMemoryTradeRepository()
  const clock = createFixedClock('2026-03-01T12:00:00.000Z')
  return {
    clock,
    tradeService: createTradeService({ trades, clock, ids: createSequentialIds() }),
    positionService: createPositionService({ trades }),
  }
}

async function listed(service: ReturnType<typeof setup>['positionService']): Promise<string[][]> {
  return (await service.listPositions()).map((position) =>
    [position.symbol, decimalText(position.netQuantity), decimalText(position.averageCost)])
}

describe('application: positions', () => {
  it('derives positions from booked trades, sorted by symbol, omitting flat ones', async () => {
    const { tradeService, positionService } = setup()
    const trade = async (symbol: string, side: string, quantity: string, price: string): Promise<void> => {
      await tradeService.createTrade({ symbol, side, quantity, price })
    }

    await trade('msft', 'buy', '100', '10')
    await trade('MSFT', 'Buy', '100', '20')
    await trade('aapl', 'sell', '50', '12')
    await trade('flat', 'Buy', '1', '1')
    await trade('FLAT', 'sell', '1', '2')

    expect(await listed(positionService)).toEqual([['AAPL', '-50', '12'], ['MSFT', '200', '15']])
  })

  it('applies trades by execution time, so a trade booked late for an earlier time is placed correctly', async () => {
    const { clock, tradeService, positionService } = setup()

    await tradeService.createTrade({ symbol: 'X', side: 'Buy', quantity: '100', price: '10', executedAt: '2026-01-01T09:00:00Z' })
    await tradeService.createTrade({ symbol: 'X', side: 'Sell', quantity: '100', price: '12', executedAt: '2026-01-01T11:00:00Z' })
    clock.set('2026-03-05T00:00:00Z')
    // Executed between the two above, recorded days later: it increases the long before the sale.
    await tradeService.createTrade({ symbol: 'X', side: 'Buy', quantity: '100', price: '20', executedAt: '2026-01-01T10:00:00Z' })

    expect(await listed(positionService)).toEqual([['X', '100', '15']])
  })

  it('applies trades with no execution time at the server clock reading', async () => {
    const { clock, tradeService, positionService } = setup()

    clock.set('2026-01-01T12:00:00Z')
    await tradeService.createTrade({ symbol: 'X', side: 'Sell', quantity: '10', price: '50' })
    await tradeService.createTrade({ symbol: 'X', side: 'Buy', quantity: '10', price: '40', executedAt: '2026-01-01T11:00:00Z' })

    // The Buy executed first (11:00), then the Sell (12:00) closed it.
    expect(await listed(positionService)).toEqual([])
  })

  it('refuses a trade that would breach the position limit, storing nothing', async () => {
    const trades = createInMemoryTradeRepository()
    const tradeService = createTradeService({ trades, clock: createFixedClock('2026-03-01T12:00:00.000Z'), ids: createSequentialIds() })
    // Reaching 10^30 takes about 10^15 maximum-size trades, so one oversized trade is stored directly.
    const seed = await tradeService.createTrade({ symbol: 'BIG', side: 'Buy', quantity: '1', price: '1' })
    await trades.add({ ...seed, id: 'seed', quantity: new Dec('999999999999999000000000000000') })

    await expect(tradeService.createTrade({ symbol: 'BIG', side: 'Buy', quantity: '999999999999999', price: '1' }))
      .rejects.toThrow(PositionLimitError)
    expect(trades.stored).toHaveLength(2)
    expect(await listed(createPositionService({ trades }))).toEqual([['BIG', '999999999999999000000000000001', '1']])
  })
})

describe('application: positions and filtered trade history', () => {
  it('derives positions from the full history, however the trade list was filtered or sorted', async () => {
    const { tradeService, positionService } = setup()
    for (const [symbol, side, quantity, price, executedAt] of [
      ['MSFT', 'Buy', '100', '10', '2026-01-01T09:00:00Z'],
      ['MSFT', 'Buy', '100', '20', '2026-01-02T09:00:00Z'],
      ['MSFT', 'Sell', '50', '25', '2026-01-03T09:00:00Z'],
      ['AAPL', 'Sell', '10', '7', '2026-01-02T09:00:00Z'],
    ] as const) {
      await tradeService.createTrade({ symbol, side, quantity, price, executedAt })
    }
    const before = await listed(positionService)

    expect(await tradeService.listTrades({ symbol: 'aap', side: 'Buy' })).toEqual([])
    expect(await tradeService.listTrades({ executedTo: '2026-01-01T09:00:00Z' })).toHaveLength(1)
    expect(await tradeService.listTrades({ side: 'Sell', sortBy: 'price', sortDirection: 'asc' })).toHaveLength(2)

    expect(before).toEqual([['AAPL', '-10', '7'], ['MSFT', '150', '15']])
    expect(await listed(positionService)).toEqual(before)
  })
})
