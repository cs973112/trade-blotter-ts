import { describe, expect, it } from 'vitest'

import { createPositionService } from '../../src/application/position-service.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { Dec, decimalText } from '../../src/domain/decimal.ts'
import { PositionLimitError } from '../../src/domain/position.ts'
import { createFixedClock, createSequentialIds } from '../support/fixed-clock.ts'
import { createInMemoryLifecycleRepository } from '../support/in-memory-lifecycle-repository.ts'

function setup() {
  const trades = createInMemoryLifecycleRepository()
  const clock = createFixedClock('2026-03-01T12:00:00.000Z')
  return {
    clock,
    tradeService: createTradeService({ trades, clock, ids: createSequentialIds() }),
    positionService: createPositionService({ trades }),
  }
}

/** Books a trade and executes it with the clock reading `at` (by default, what it reads now). */
async function executed(context: ReturnType<typeof setup>, body: { symbol: string; side: string; quantity: string; price: string }, at = context.clock.peek()): Promise<void> {
  context.clock.set(at)
  const booked = await context.tradeService.createTrade(body)
  await context.tradeService.executeTrade(booked.id, undefined)
}

async function listed(service: ReturnType<typeof setup>['positionService']): Promise<string[][]> {
  return (await service.listPositions()).map((position) =>
    [position.symbol, decimalText(position.executedNet), decimalText(position.averageCost)])
}

describe('application: positions', () => {
  it('derives positions from executed trades, sorted by symbol, omitting flat ones', async () => {
    const context = setup()
    const { positionService } = context
    const trade = async (symbol: string, side: string, quantity: string, price: string): Promise<void> => {
      await executed(context, { symbol, side, quantity, price })
    }

    await trade('msft', 'buy', '100', '10')
    await trade('MSFT', 'Buy', '100', '20')
    await trade('aapl', 'sell', '50', '12')
    await trade('flat', 'Buy', '1', '1')
    await trade('FLAT', 'sell', '1', '2')

    expect(await listed(positionService)).toEqual([['AAPL', '-50', '12'], ['MSFT', '200', '15']])
  })

  it('applies trades by execution time, not booking order', async () => {
    const context = setup()

    await executed(context, { symbol: 'X', side: 'Buy', quantity: '100', price: '10' }, '2026-01-01T09:00:00Z')
    await executed(context, { symbol: 'X', side: 'Sell', quantity: '100', price: '12' }, '2026-01-01T11:00:00Z')
    // Executed between the two above, booked after them: it increases the long before the sale.
    await executed(context, { symbol: 'X', side: 'Buy', quantity: '100', price: '20' }, '2026-01-01T10:00:00Z')

    expect(await listed(context.positionService)).toEqual([['X', '100', '15']])
  })

  it('counts a trade in the actual position only once it is executed, at the clock reading then', async () => {
    const context = setup()
    const { clock, tradeService, positionService } = context

    clock.set('2026-01-01T10:00:00Z')
    const sell = await tradeService.createTrade({ symbol: 'X', side: 'Sell', quantity: '10', price: '50' })
    await executed(context, { symbol: 'X', side: 'Buy', quantity: '10', price: '40' }, '2026-01-01T11:00:00Z')
    expect(await listed(positionService)).toEqual([['X', '10', '40']])

    clock.set('2026-01-01T12:00:00Z')
    await tradeService.executeTrade(sell.id, undefined)
    // The Buy executed first (11:00), then the Sell (12:00) closed it.
    expect(await listed(positionService)).toEqual([])
  })

  it('refuses a booking that would take the projected position to the limit, storing nothing', async () => {
    const trades = createInMemoryLifecycleRepository()
    const tradeService = createTradeService({ trades, clock: createFixedClock('2026-03-01T12:00:00.000Z'), ids: createSequentialIds() })
    // Reaching 10^30 takes about 10^15 maximum-size trades, so one oversized trade is stored directly.
    const seed = await tradeService.createTrade({ symbol: 'BIG', side: 'Buy', quantity: '1', price: '1' })
    await tradeService.executeTrade(seed.id, undefined)
    await trades.book({
      id: 'seed', symbol: seed.symbol, side: seed.side, quantity: new Dec('999999999999999000000000000000'), price: seed.price, status: 'Executed', executedAt: seed.createdAt,
      createdAt: seed.createdAt, updatedAt: seed.updatedAt, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null,
    })

    await expect(tradeService.createTrade({ symbol: 'BIG', side: 'Buy', quantity: '999999999999999', price: '1' }))
      .rejects.toThrow(PositionLimitError)
    expect(trades.stored).toHaveLength(2)
    expect(await listed(createPositionService({ trades }))).toEqual([['BIG', '999999999999999000000000000001', '1']])
  })
})

describe('application: positions and filtered trade history', () => {
  it('derives positions from the full history, however the trade list was filtered or sorted', async () => {
    const context = setup()
    const { tradeService, positionService } = context
    for (const [symbol, side, quantity, price, executedAt] of [
      ['MSFT', 'Buy', '100', '10', '2026-01-01T09:00:00Z'],
      ['MSFT', 'Buy', '100', '20', '2026-01-02T09:00:00Z'],
      ['MSFT', 'Sell', '50', '25', '2026-01-03T09:00:00Z'],
      ['AAPL', 'Sell', '10', '7', '2026-01-02T09:00:00Z'],
    ] as const) {
      await executed(context, { symbol, side, quantity, price }, executedAt)
    }
    const before = await listed(positionService)

    expect(await tradeService.listTrades({ symbol: 'aap', side: 'Buy' })).toEqual([])
    expect(await tradeService.listTrades({ executedTo: '2026-01-01T09:00:00Z' })).toHaveLength(1)
    expect(await tradeService.listTrades({ side: 'Sell', sortBy: 'price', sortDirection: 'asc' })).toHaveLength(2)

    expect(before).toEqual([['AAPL', '-10', '7'], ['MSFT', '150', '15']])
    expect(await listed(positionService)).toEqual(before)
  })
})
