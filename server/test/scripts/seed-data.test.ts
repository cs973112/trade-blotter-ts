import { describe, expect, it } from 'vitest'

import { createRandom, DEFAULT_SEED, generateTrades } from '../../scripts/seed-data.ts'
import { summariseTrades } from '../../scripts/trade-data.ts'
import type { NewTrade, Trade } from '../../src/domain/trade.ts'
import { toRow } from '../../src/infrastructure/drizzle-trade-repository.ts'

/** The deterministic sample trades: every one valid, the same for the same seed, and varied enough to test with. */

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:[.][0-9]*[1-9])?$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** As stored, with booking sequences in insertion order. */
const booked = (trades: readonly NewTrade[]): Trade[] => trades.map((trade, index) => ({ ...trade, bookingSequence: index + 1 }))

describe('scripts: generated sample trades', () => {
  it('are the same for the same count and seed, and differ for another seed', () => {
    const first = generateTrades(500, 'repeatable').map(toRow)

    expect(generateTrades(500, 'repeatable').map(toRow)).toEqual(first)
    expect(generateTrades(500, 'other').map(toRow)).not.toEqual(first)
    expect(generateTrades(500).map(toRow)).toEqual(generateTrades(500, DEFAULT_SEED).map(toRow))
  })

  // Each size is generated once; the checks below share it.
  const generated = new Map<number, NewTrade[]>()
  const trades = (count: number): NewTrade[] => {
    const cached = generated.get(count) ?? generateTrades(count)
    generated.set(count, cached)
    return cached
  }

  it.each([100, 1_000, 10_000, 25_000])('gives exactly %i valid, canonical trades in execution order', (count) => {
    const rows = trades(count).map(toRow)
    // Collected and checked once: an assertion per row would make this test slow.
    const problems = rows.flatMap((row, index) => [
      UUID_V4.test(row.id) ? [] : [`id ${row.id}`],
      DECIMAL.test(row.quantity) && DECIMAL.test(row.price) ? [] : [`decimals ${row.quantity} ${row.price}`],
      [row.executedAt, row.createdAt, row.updatedAt].every((time) => TIMESTAMP.test(time)) ? [] : [`times of ${row.id}`],
      row.createdAt > row.executedAt && row.updatedAt === row.createdAt ? [] : [`recording of ${row.id}`],
      index === 0 || row.executedAt >= (rows[index - 1]?.executedAt ?? '') ? [] : [`order at ${String(index)}`],
    ].flat())

    expect(rows).toHaveLength(count)
    expect(new Set(rows.map((row) => row.id)).size).toBe(count)
    expect(problems).toEqual([])
    expect(rows[0]?.executedAt).toBe('2025-01-02T14:30:00.000Z')
    expect((rows.at(-1)?.executedAt ?? '') <= '2026-10-30T20:00:00.000Z').toBe(true)
  }, 60_000)

  it.each([100, 1_000, 10_000, 25_000])('open, increase, reduce, close and cross positions, with repeated values for sorting (%i trades)', (count) => {
    const summary = summariseTrades(booked(trades(count)))

    expect(Object.values(summary.changes).every((times) => times > 0)).toBe(true)
    expect(summary.sharedExecutionTimes).toBeGreaterThan(count / 20)
    expect(summary.distinctQuantities).toBeLessThan(count)
    expect(summary.distinctPrices).toBeLessThan(count)
    expect(summary.buys).toBeGreaterThan(count / 4)
    expect(summary.sells).toBeGreaterThan(count / 4)
    if (count >= 1_000) expect(summary.symbols).toBeGreaterThanOrEqual(20)
  }, 60_000)

  it('covers 24 symbols, small prices with ten decimal places, and quantities shared by many trades', () => {
    const sample = trades(10_000)
    const quantities = new Map<string, number>()
    for (const trade of sample) quantities.set(trade.quantity.toFixed(), (quantities.get(trade.quantity.toFixed()) ?? 0) + 1)

    expect(new Set(sample.map((trade) => trade.symbol)).size).toBe(24)
    expect(sample.some((trade) => trade.price.decimalPlaces() === 10)).toBe(true)
    expect(sample.some((trade) => trade.quantity.decimalPlaces() > 0)).toBe(true)
    expect(Math.max(...quantities.values())).toBeGreaterThan(500)
    expect(sample.filter((trade) => trade.price.toFixed() === '100').length).toBeGreaterThan(10)
  })

  it('refuses a count that is not a positive integer', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) expect(() => generateTrades(count)).toThrow(RangeError)
  })

  it('draws the same numbers on every run from the same seed', () => {
    const random = createRandom('fixed')
    const again = createRandom('fixed')

    expect(Array.from({ length: 5 }, () => random.next())).toEqual(Array.from({ length: 5 }, () => again.next()))
    expect(createRandom('fixed').uuid()).toMatch(UUID_V4)
  })
})
