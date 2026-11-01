import { describe, expect, it } from 'vitest'

import { Dec, decimalText } from '../../src/domain/decimal.ts'
import {
  applyTrade,
  calculatePositions,
  flatPosition,
  PositionLimitError,
  positionAfterTrade,
  type Position,
} from '../../src/domain/position.ts'
import { parseTimestamp, type UtcTimestamp } from '../../src/domain/timestamp.ts'
import type { Trade } from '../../src/domain/trade.ts'
import { POSITION_SCENARIOS, type Fill } from '../scenarios/positions.ts'
import { abs, compare, isTerminating, mul, rational, sub } from '../support/rational.ts'

/** Relative tolerance for averages that do not terminate (docs/architecture.md, "Numeric policy"). */
const RECURRING_TOLERANCE = rational('1e-45')

const START = Date.parse('2026-01-01T09:00:00.000Z')
const at = (seconds: number): UtcTimestamp => parseTimestamp(new Date(START + seconds * 1000).toISOString()) ?? (() => {
  throw new Error('bad time')
})()

/**
 * Scenario fills as booked trades. Booking sequence follows the fill order. createdAt and updatedAt
 * run backwards against it, so a calculation that used either would get the order wrong.
 */
function toTrades(symbol: string, fills: readonly Fill[]): Trade[] {
  return fills.map(([side, quantity, price, seconds = 0], index) => ({
    id: `${symbol}-${String(index)}`,
    bookingSequence: index + 1,
    symbol,
    side,
    quantity: new Dec(quantity),
    price: new Dec(price),
    executedAt: at(seconds),
    createdAt: at(1000 - index),
    updatedAt: at(2000 - index),
  }))
}

function expectAverageCost(actual: Dec, expectedText: string): void {
  const exact = rational(expectedText)
  const computed = rational(decimalText(actual))
  if (isTerminating(exact)) {
    expect(decimalText(actual)).toBe(expectedText)
    return
  }
  const error = abs(sub(computed, exact))
  expect(compare(error, mul(exact, RECURRING_TOLERANCE)), `${decimalText(actual)} vs ${expectedText}`).toBeLessThanOrEqual(0)
}

const position = (symbol: string, netQuantity: string, averageCost: string): Position =>
  ({ symbol, netQuantity: new Dec(netQuantity), averageCost: new Dec(averageCost) })

const text = (value: Position): [string, string, string] =>
  [value.symbol, decimalText(value.netQuantity), decimalText(value.averageCost)]

describe('domain: position calculation', () => {
  it.each(POSITION_SCENARIOS.map((scenario) => [scenario.symbol, scenario.rule, scenario] as const))(
    '%s: %s',
    (symbol, _rule, scenario) => {
      const positions = calculatePositions(toTrades(symbol, scenario.fills))

      if (scenario.expected === 'flat') {
        expect(positions).toEqual([])
        return
      }
      expect(positions).toHaveLength(1)
      const [result] = positions
      if (result === undefined) return
      expect(decimalText(result.netQuantity)).toBe(scenario.expected.netQuantity)
      expectAverageCost(result.averageCost, scenario.expected.averageCost)
    },
  )

  it('calculates every scenario together, each symbol independently, sorted by symbol', () => {
    const trades = POSITION_SCENARIOS.flatMap((scenario) => toTrades(scenario.symbol, scenario.fills))
    const open = POSITION_SCENARIOS.filter((scenario) => scenario.expected !== 'flat').map((scenario) => scenario.symbol)

    expect(calculatePositions(trades).map((result) => result.symbol)).toEqual([...open].sort())
  })

  it('does not depend on the order trades are given in', () => {
    const trades = POSITION_SCENARIOS.flatMap((scenario) => toTrades(scenario.symbol, scenario.fills))
    const forwards = calculatePositions(trades).map(text)

    expect(calculatePositions([...trades].reverse()).map(text)).toEqual(forwards)
    expect(calculatePositions([...trades].sort((a, b) => a.id.localeCompare(b.id))).map(text)).toEqual(forwards)
  })

  it('breaks execution-time ties by booking sequence, not by createdAt, updatedAt or id', () => {
    const booked = toTrades('TIE', [['Buy', '10', '20'], ['Sell', '10', '30'], ['Buy', '5', '40']])
    // createdAt, updatedAt and id all rank the trades in reverse booking order.
    const misleading = booked.map((trade, index) =>
      ({ ...trade, id: String(9 - index), createdAt: at(-index), updatedAt: at(-index) }))

    // In booking order: open, close, then reopen at 40. In reverse it would end at 5 @ 20.
    expect(calculatePositions(misleading).map(text)).toEqual([['TIE', '5', '40']])
  })

  it('never reports a flat position', () => {
    expect(calculatePositions(toTrades('FLAT', [['Buy', '0.1', '1'], ['Buy', '0.2', '1'], ['Sell', '0.3', '2']]))).toEqual([])
  })

  it('returns no positions for no trades', () => {
    expect(calculatePositions([])).toEqual([])
  })
})

describe('domain: applying one trade', () => {
  const trade = (side: 'Buy' | 'Sell', quantity: string, price: string) => ({ side, quantity: new Dec(quantity), price: new Dec(price) })

  it.each([
    ['open long from flat', flatPosition('X'), trade('Buy', '100', '10'), ['X', '100', '10']],
    ['open short from flat', flatPosition('X'), trade('Sell', '100', '12'), ['X', '-100', '12']],
    ['increase long', position('X', '100', '10'), trade('Buy', '100', '20'), ['X', '200', '15']],
    ['increase short', position('X', '-100', '12'), trade('Sell', '100', '16'), ['X', '-200', '14']],
    ['reduce long', position('X', '200', '15'), trade('Sell', '50', '25'), ['X', '150', '15']],
    ['reduce short', position('X', '-200', '14'), trade('Buy', '50', '11'), ['X', '-150', '14']],
    ['close long', position('X', '150', '15'), trade('Sell', '150', '18'), ['X', '0', '0']],
    ['close short', position('X', '-150', '14'), trade('Buy', '150', '9'), ['X', '0', '0']],
    ['cross long to short', position('X', '50', '15'), trade('Sell', '150', '12'), ['X', '-100', '12']],
    ['cross short to long', position('X', '-150', '14'), trade('Buy', '250', '13'), ['X', '100', '13']],
  ] as const)('%s', (_rule, before, applied, expected) => {
    expect(text(applyTrade(before, applied))).toEqual(expected)
  })

  it('never produces negative zero', () => {
    const closed = applyTrade(position('X', '-1', '5'), trade('Buy', '1', '5'))

    expect(closed.netQuantity.isNegative()).toBe(false)
    expect(Object.is(closed.netQuantity.toNumber(), -0)).toBe(false)
  })

  it('does not change the position it is given', () => {
    const before = position('X', '100', '10')
    applyTrade(before, trade('Buy', '100', '20'))

    expect(text(before)).toEqual(['X', '100', '10'])
  })

  it('keeps a recurring average to 50 significant digits, with no display rounding', () => {
    const result = applyTrade(position('X', '1', '1'), trade('Buy', '2', '2'))

    expect(decimalText(result.averageCost)).toBe(`1.${'6'.repeat(48)}7`)
  })

  it('throws a position limit error when the net quantity reaches 10^30', () => {
    const nearLimit = position('BIG', '999999999999999000000000000001', '1')

    expect(() => applyTrade(nearLimit, trade('Buy', '999999999999999', '1'))).toThrow(PositionLimitError)
    expect(() => applyTrade(nearLimit, trade('Buy', '999999999999999', '1'))).toThrow('BIG')
    expect(text(applyTrade(nearLimit, trade('Buy', '999999999999998.9999999999', '1')))[1])
      .toBe('999999999999999999999999999999.9999999999')
  })

  it('throws a position limit error for a short as well as a long', () => {
    expect(() => applyTrade(position('BIG', '-999999999999999000000000000001', '1'), trade('Sell', '999999999999999', '1')))
      .toThrow(PositionLimitError)
  })
})

describe('domain: checking a proposed trade', () => {
  const NEAR_LIMIT = '999999999999999000000000000001'
  const proposed = (side: 'Buy' | 'Sell', quantity: string, price: string, seconds: number) => {
    const [trade] = toTrades('BIG', [[side, quantity, price, seconds]])
    if (trade === undefined) throw new Error('missing trade')
    return trade
  }
  // Long almost to the limit at 0 s, flat again at 60 s.
  const history = toTrades('BIG', [['Buy', NEAR_LIMIT, '1', 0], ['Sell', NEAR_LIMIT, '2', 60]])

  it('returns the position the trade leads to', () => {
    expect(text(positionAfterTrade(history, proposed('Buy', '5', '3', 120)))).toEqual(['BIG', '5', '3'])
    expect(text(positionAfterTrade([], proposed('Sell', '5', '3', 0)))).toEqual(['BIG', '-5', '3'])
  })

  it('checks a trade executed in the past against every trade executed after it', () => {
    // At 30 s the long is at its largest, so the same Buy breaches there but not at 120 s.
    expect(() => positionAfterTrade(history, proposed('Buy', '999999999999999', '1', 30))).toThrow(PositionLimitError)
    expect(text(positionAfterTrade(history, proposed('Buy', '999999999999999', '1', 120)))[1]).toBe('999999999999999')
  })

  it('places the trade after stored trades with the same execution time', () => {
    // At 60 s, after the closing Sell: a fresh long. Before it, the Buy would breach the limit.
    expect(text(positionAfterTrade(history, proposed('Buy', '999999999999999', '7', 60)))).toEqual(['BIG', '999999999999999', '7'])
  })

  it('ignores trades for other symbols', () => {
    const other = toTrades('OTHER', [['Buy', NEAR_LIMIT, '1', 0]])

    expect(text(positionAfterTrade([...other, ...history], proposed('Buy', '1', '1', 120)))).toEqual(['BIG', '1', '1'])
  })
})
