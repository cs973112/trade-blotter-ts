import { describe, expect, it } from 'vitest'

import { Dec, NET_QUANTITY_LIMIT } from '../../src/domain/decimal.ts'
import { calculatePositions, PositionLimitError } from '../../src/domain/position.ts'
import { calculateStatusPositions, executedPositionAfterExecution, executedPositionAfterTrade, pendingPositionAfterTrade, type StatusPositionTrade } from '../../src/domain/position-summary.ts'
import { cancelTrade, type LifecycleTrade } from '../../src/domain/trade-status.ts'
import type { TradeSide } from '../../src/domain/trade.ts'
import { utc } from '../support/trades.ts'

/**
 * Positions by status (src/domain/position-summary.ts): Executed Net in trade order, Pending Net as
 * a sum (Pending trades have no execution time), Projected Net, average cost from Executed trades
 * only, cancelled originals and cancellation rows ignored, Pending-only symbols listed, and the
 * approved position limit on the Executed history alone.
 */

let sequence = 0
const at = (minute: number) => utc(new Date(Date.UTC(2026, 0, 1, 9) + minute * 60_000).toISOString())
const executed = (side: TradeSide, quantity: string, price: string, symbol = 'ABC', minute = ++sequence): StatusPositionTrade => ({
  symbol, side, quantity: new Dec(quantity), price: new Dec(price), status: 'Executed', executedAt: at(minute), bookingSequence: minute, originalTradeId: null,
})
const pending = (side: TradeSide, quantity: string, price = '1', symbol = 'ABC'): StatusPositionTrade => ({
  symbol, side, quantity: new Dec(quantity), price: new Dec(price), status: 'Pending', executedAt: null, bookingSequence: ++sequence, originalTradeId: null,
})
/** A Pending trade cancelled: the original, and its cancellation row, which copies its economic fields. */
const cancellation = (side: TradeSide, quantity: string, symbol = 'ABC'): StatusPositionTrade[] => {
  const original = { ...pending(side, quantity, '1', symbol), status: 'Cancelled' as const }
  return [original, { ...original, bookingSequence: ++sequence, originalTradeId: `original-${String(original.bookingSequence)}` }]
}
/** Positions as text, so exact values compare by digits. */
const text = (trades: readonly StatusPositionTrade[]) => calculateStatusPositions(trades).map((position) => ({
  symbol: position.symbol, executedNet: position.executedNet.toFixed(), pendingNet: position.pendingNet.toFixed(),
  projectedNet: position.projectedNet.toFixed(), averageCost: position.averageCost.toFixed(),
}))

describe('domain: positions by status', () => {
  it('nets Executed and Pending trades apart, and projects their sum', () => {
    expect(text([executed('Buy', '100', '10'), pending('Buy', '30', '12'), pending('Sell', '5', '11')]))
      .toEqual([{ symbol: 'ABC', executedNet: '100', pendingNet: '25', projectedNet: '125', averageCost: '10' }])
  })

  it('takes the average cost from Executed trades only: a Pending trade never changes it', () => {
    const trades = [executed('Buy', '100', '10'), executed('Buy', '100', '20')]

    expect(text(trades)[0]?.averageCost).toBe('15')
    expect(text([...trades, pending('Buy', '1000', '1000')])[0]?.averageCost).toBe('15')
    expect(calculatePositions(trades.map((trade) => ({ ...trade, executedAt: trade.executedAt ?? at(0) })))[0]?.averageCost.toFixed()).toBe('15')
  })

  it('applies Executed trades in trade order, whatever order they arrive in, as calculatePositions does', () => {
    const trades = [executed('Buy', '10', '1', 'ABC', 1), executed('Sell', '10', '1', 'ABC', 2), executed('Buy', '5', '7', 'ABC', 3)]

    expect(text([...trades].reverse())).toEqual(text(trades))
    expect(text(trades)[0]).toMatchObject({ executedNet: '5', averageCost: '7' })
  })

  it('sums Pending trades without ordering them: they have no execution time', () => {
    const trades = [pending('Buy', '3'), pending('Sell', '8'), pending('Buy', '1.5')]

    expect(text(trades)[0]?.pendingNet).toBe('-3.5')
    expect(text([...trades].reverse())).toEqual(text(trades))
  })

  it('ignores a cancelled original and its cancellation row entirely', () => {
    const live = [executed('Buy', '100', '10'), pending('Sell', '10')]

    expect(text([...live, ...cancellation('Buy', '500'), ...cancellation('Sell', '7')])).toEqual(text(live))
    expect(text(cancellation('Buy', '40', 'GONE'))).toEqual([])
  })

  it('never counts a cancellation row, even one wrongly marked Pending or Executed', () => {
    const [, record] = cancellation('Buy', '9')
    if (record === undefined) throw new Error('no row')

    expect(text([{ ...record, status: 'Pending' }])).toEqual([])
    expect(text([{ ...record, status: 'Executed', executedAt: at(1) }])).toEqual([])
  })

  it('lists a symbol with only Pending trades, with nothing executed and no average cost', () => {
    expect(text([pending('Sell', '40', '5', 'NEW')])).toEqual([{ symbol: 'NEW', executedNet: '0', pendingNet: '-40', projectedNet: '-40', averageCost: '0' }])
  })

  it('lists a symbol while either net is not zero, and leaves it out when both are', () => {
    expect(text([executed('Buy', '5', '1', 'A'), executed('Sell', '5', '1', 'A'), pending('Buy', '2', '1', 'A')]).map((p) => p.symbol)).toEqual(['A'])
    expect(text([executed('Buy', '5', '1', 'B'), pending('Buy', '2', '1', 'B'), pending('Sell', '2', '1', 'B')])[0]).toMatchObject({ executedNet: '5', pendingNet: '0', projectedNet: '5' })
    expect(text([executed('Buy', '5', '1', 'C'), executed('Sell', '5', '1', 'C'), pending('Buy', '1', '1', 'C'), pending('Sell', '1', '1', 'C')])).toEqual([])
  })

  it('projects a pending reversal through zero: Executed long, projected short', () => {
    expect(text([executed('Buy', '10', '3'), pending('Sell', '25', '4')])[0]).toEqual({ symbol: 'ABC', executedNet: '10', pendingNet: '-25', projectedNet: '-15', averageCost: '3' })
  })

  it('sorts by symbol in code-point order', () => {
    expect(text([pending('Buy', '1', '1', 'b'), executed('Buy', '1', '1', 'B'), executed('Buy', '2', '1', 'A')]).map((p) => p.symbol)).toEqual(['A', 'B', 'b'])
  })

  it('never reports negative zero', () => {
    const [position] = calculateStatusPositions([executed('Sell', '1', '1'), pending('Sell', '0.5'), pending('Buy', '1.5')])

    expect(position?.projectedNet.toFixed()).toBe('0')
    expect(position?.projectedNet.isNegative()).toBe(false)
  })
})

describe('domain: the position limit with statuses (the approved Executed-history rule only)', () => {
  const near = new Dec(NET_QUANTITY_LIMIT).minus(1).toFixed()
  const proposal = (side: TradeSide, quantity: string, minute: number) => ({ symbol: 'ABC', side, quantity: new Dec(quantity), price: new Dec('1'), executedAt: at(minute) })

  it('refuses an Executed trade that takes the Executed position to the limit', () => {
    expect(() => executedPositionAfterTrade([executed('Buy', near, '1', 'ABC', 1)], proposal('Buy', '1', 2))).toThrow(PositionLimitError)
  })

  it('checks every intermediate Executed step, not only the final quantity', () => {
    const history = [executed('Buy', near, '1', 'ABC', 10), executed('Sell', near, '1', 'ABC', 20)]

    expect(() => executedPositionAfterTrade(history, proposal('Buy', '1', 15))).toThrow(PositionLimitError)
  })

  it('leaves Pending trades, cancelled originals and cancellation rows out of the history', () => {
    const history = [pending('Buy', near), ...cancellation('Buy', near), executed('Buy', '1', '1', 'ABC', 1)]

    expect(executedPositionAfterTrade(history, proposal('Buy', '1', 2)).netQuantity.toFixed()).toBe('2')
  })
})

describe('domain: the position limit for a Pending booking (final projected position only)', () => {
  const LIMIT = new Dec(NET_QUANTITY_LIMIT)
  const below = (amount: string) => LIMIT.minus(amount).toFixed()
  const book = (history: StatusPositionTrade[], side: TradeSide, quantity: string) => pendingPositionAfterTrade(history, { symbol: 'ABC', side, quantity: new Dec(quantity) })

  it('allows a projection just below the limit and refuses one that reaches it, long or short', () => {
    expect(book([executed('Buy', below('2'), '1')], 'Buy', '1').projectedNet.toFixed()).toBe(below('1'))
    expect(() => book([executed('Buy', below('2'), '1')], 'Buy', '2')).toThrow(PositionLimitError)
    expect(book([executed('Sell', below('2'), '1')], 'Sell', '1').projectedNet.toFixed()).toBe(`-${below('1')}`)
    expect(() => book([executed('Sell', below('2'), '1')], 'Sell', '2')).toThrow(PositionLimitError)
    // Beyond the limit, not only at it.
    expect(() => book([], 'Buy', LIMIT.plus(1).toFixed())).toThrow(PositionLimitError)
    expect(() => book([], 'Sell', NET_QUANTITY_LIMIT)).toThrow(PositionLimitError)
  })

  it('counts existing Pending trades with the proposal, with nothing executed', () => {
    expect(() => book([pending('Buy', below('1'))], 'Buy', '1')).toThrow(PositionLimitError)
    expect(book([pending('Buy', below('1'))], 'Buy', '0.5').pendingNet.toFixed()).toBe(below('0.5'))
  })

  it('accepts a booking that brings the projection back from the limit: an offsetting trade', () => {
    const history = [executed('Buy', below('1'), '1'), pending('Buy', '0.5')]

    const after = book(history, 'Sell', '10')

    expect([after.executedNet.toFixed(), after.pendingNet.toFixed(), after.projectedNet.toFixed()]).toEqual([below('1'), '-9.5', below('10.5')])
  })

  it('invents no intermediate steps: only the final projection counts, whatever the order of the Pending trades', () => {
    // A Pending Buy that alone would reach the limit, beside a Pending Sell that offsets it: the final projection is far below.
    const history = [executed('Buy', below('5'), '1'), pending('Sell', '100')]

    expect(book(history, 'Buy', '50').projectedNet.toFixed()).toBe(below('55'))
  })

  it('ignores cancelled originals and cancellation rows', () => {
    expect(book([...cancellation('Buy', below('1'))], 'Buy', '2').projectedNet.toFixed()).toBe('2')
  })

  it('leaves the Executed rule as it is: an Executed booking is still checked at every intermediate step', () => {
    const history = [executed('Buy', below('1'), '1', 'ABC', 10), executed('Sell', below('1'), '1', 'ABC', 20)]

    expect(() => executedPositionAfterTrade(history, { symbol: 'ABC', side: 'Buy', quantity: new Dec('1'), price: new Dec('1'), executedAt: at(15) })).toThrow(PositionLimitError)
  })

  it('never refuses a cancellation, even one that leaves the projection beyond the limit by removing an offsetting Pending trade', () => {
    const offsetting: LifecycleTrade = {
      id: 'offset', bookingSequence: 99, symbol: 'ABC', side: 'Sell', quantity: new Dec('10'), price: new Dec('1'), status: 'Pending', executedAt: null,
      createdAt: at(1), updatedAt: at(1), createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null,
    }
    const history = [executed('Buy', below('1'), '1'), pending('Buy', '5'), offsetting]
    expect(calculateStatusPositions(history)[0]?.projectedNet.toFixed()).toBe(below('6'))

    const result = cancelTrade(offsetting, { reason: 'Client withdrew' }, { id: 'c1', now: at(2) })
    if (!result.ok) throw new Error(result.message)
    const after = calculateStatusPositions([...history.filter((trade) => trade !== offsetting), result.original, { ...result.cancellation, bookingSequence: 100 }])

    expect(after[0]?.projectedNet.toFixed()).toBe(LIMIT.plus(4).toFixed())
    expect(after[0]?.projectedNet.abs().gte(LIMIT)).toBe(true)
  })
})

describe('domain: executing a Pending trade (M7: the Executed rule, the trade at its execution time and booking sequence)', () => {
  const near = new Dec(NET_QUANTITY_LIMIT).minus(1).toFixed()
  /** The stored Pending trade as executed at `minute`. */
  const executing = (trade: StatusPositionTrade, minute: number) => ({ ...trade, executedAt: at(minute) })
  const position = (history: readonly StatusPositionTrade[], trade: StatusPositionTrade, minute: number) => {
    const result = executedPositionAfterExecution(history, executing(trade, minute))
    return { netQuantity: result.netQuantity.toFixed(), averageCost: result.averageCost.toFixed() }
  }

  it.each([
    ['opens from flat at its price', [], 'Buy', '10', '5', { netQuantity: '10', averageCost: '5' }],
    ['increases: the quantity-weighted average', [['Buy', '10', '5']], 'Buy', '30', '9', { netQuantity: '40', averageCost: '8' }],
    ['reduces: the average cost is unchanged', [['Buy', '10', '5']], 'Sell', '4', '9', { netQuantity: '6', averageCost: '5' }],
    ['closes: flat, with no average cost', [['Buy', '10', '5']], 'Sell', '10', '9', { netQuantity: '0', averageCost: '0' }],
    ['crosses: the remainder at its price', [['Buy', '10', '5']], 'Sell', '25', '9', { netQuantity: '-15', averageCost: '9' }],
    ['increases a short', [['Sell', '10', '6']], 'Sell', '10', '4', { netQuantity: '-20', averageCost: '5' }],
  ] as const)('%s', (_name, before, side, quantity, price, expected) => {
    const history = before.map(([s, q, p], index) => executed(s, q, p, 'ABC', index + 1))
    const trade = pending(side, quantity, price)
    expect(position([...history, trade], trade, 100)).toEqual(expected)
  })

  it('counts only Executed trades: other Pending trades, cancelled originals and cancellation rows are left out', () => {
    const trade = pending('Buy', '10', '4')
    const history = [executed('Buy', '10', '2', 'ABC', 1), pending('Buy', near), ...cancellation('Sell', '5'), trade, executed('Buy', '1', '1', 'XYZ', 2)]
    expect(position(history, trade, 100)).toEqual({ netQuantity: '20', averageCost: '3' })
  })

  it('refuses an execution that takes the Executed position to the limit, long or short', () => {
    const long = pending('Buy', '1')
    expect(() => executedPositionAfterExecution([executed('Buy', near, '1', 'ABC', 1), long], executing(long, 100))).toThrow(PositionLimitError)
    const short = pending('Sell', '1')
    expect(() => executedPositionAfterExecution([executed('Sell', near, '1', 'ABC', 1), short], executing(short, 100))).toThrow(PositionLimitError)
    expect(() => executedPositionAfterExecution([executed('Buy', new Dec(near).minus(1).toFixed(), '1', 'ABC', 1), long], executing(long, 100))).not.toThrow()
  })

  it('can refuse an execution the projected position allowed: offsetting Pending trades do not count once executed alone', () => {
    const buy = pending('Buy', '2')
    const history = [executed('Buy', new Dec(near).minus(1).toFixed(), '1', 'ABC', 1), pending('Sell', '5'), buy]
    expect(calculateStatusPositions(history)[0]?.projectedNet.abs().lt(new Dec(NET_QUANTITY_LIMIT))).toBe(true)
    expect(() => executedPositionAfterExecution(history, executing(buy, 100))).toThrow(PositionLimitError)
  })

  it('replays later Executed trades on top of it: a historical trade executed after its execution time is checked too', () => {
    // A trade booked Executed before M7 with an execution time later than now: the execution lands before it.
    const trade = pending('Buy', '1')
    // Executed at minute 100 it makes the trade at minute 500 reach the limit, though the final
    // position (near - 4) is within it; executed after all of them, it is accepted.
    const history = [executed('Buy', new Dec(near).minus(1).toFixed(), '1', 'ABC', 1), executed('Buy', '1', '1', 'ABC', 500), executed('Sell', '5', '1', 'ABC', 600), trade]
    expect(() => executedPositionAfterExecution(history, executing(trade, 100))).toThrow(PositionLimitError)
    expect(position(history, trade, 700)).toEqual({ netQuantity: new Dec(near).minus(4).toFixed(), averageCost: '1' })
  })

  it('orders a trade executed at the same time as another by booking sequence, not as if it were booked last', () => {
    const trade = { ...pending('Buy', '10', '3'), bookingSequence: 5 }
    // An Executed sale at the same millisecond, booked after it: the purchase applies first, so the sale reduces it.
    const history = [executed('Buy', '10', '1', 'ABC', 1), { ...executed('Sell', '15', '9', 'ABC', 100), bookingSequence: 6 }, trade]
    expect(position(history, trade, 100)).toEqual({ netQuantity: '5', averageCost: '2' })
  })
})
