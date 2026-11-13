import { describe, expect, it } from 'vitest'

import { BENCHMARK_COUNT, BENCHMARK_SEED, SCRATCH_COUNT, SCRATCH_SEED } from '../../scripts/review-context.ts'
import { createRandom, DATASET_VERSION, datasetFingerprint, DEFAULT_SEED, generateTrades, PREVIOUS_DATASETS } from '../../scripts/seed-data.ts'
import { summariseTrades } from '../../scripts/trade-data.ts'
import { Dec } from '../../src/domain/decimal.ts'
import { calculatePositions } from '../../src/domain/position.ts'
import { compareTradeOrder, type NewTrade, type Trade } from '../../src/domain/trade.ts'
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

  it('covers many symbols, small prices with ten decimal places, and quantities shared by many trades', () => {
    const sample = trades(10_000)
    const quantities = new Map<string, number>()
    for (const trade of sample) quantities.set(trade.quantity.toFixed(), (quantities.get(trade.quantity.toFixed()) ?? 0) + 1)

    expect(new Set(sample.map((trade) => trade.symbol)).size).toBeGreaterThan(150)
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

describe('scripts: the reviewer\'s benchmark dataset (version 2)', () => {
  const benchmark = generateTrades(BENCHMARK_COUNT, BENCHMARK_SEED)
  const positions = calculatePositions(booked(benchmark))
  const perSymbol = new Map<string, number>()
  for (const trade of benchmark) perSymbol.set(trade.symbol, (perSymbol.get(trade.symbol) ?? 0) + 1)

  it('is exactly 25,000 trades, the same on every run, with a pinned identity', () => {
    expect(benchmark).toHaveLength(25_000)
    expect(DATASET_VERSION).toBe(2)
    const fingerprint = datasetFingerprint(benchmark.map(toRow))
    expect(datasetFingerprint(generateTrades(BENCHMARK_COUNT, BENCHMARK_SEED).map(toRow))).toBe(fingerprint)
    // Changes only with a new DATASET_VERSION: a different value here means the benchmark changed.
    expect(fingerprint).toBe('34f76ee8bb722c7f5e8af1645025b0cb28839b6d59269709aee5d349c6548885')
    expect(datasetFingerprint(generateTrades(SCRATCH_COUNT, SCRATCH_SEED).map(toRow))).toBe('e2e2d238e8623ec899e44282c42a6f21aef083abdbea7cf1bda7c4f476048b0e')
    // Version 1's datasets are known by fingerprint, and none is the current one.
    expect(PREVIOUS_DATASETS.map((known) => known.version)).toEqual([1, 1])
    expect(PREVIOUS_DATASETS.some((known) => known.fingerprint === fingerprint)).toBe(false)
  }, 60_000)

  it('leaves at least 120 open positions, long and short, calculated from the trades', () => {
    expect(positions.length).toBeGreaterThanOrEqual(120)
    expect(positions).toHaveLength(167)
    const long = positions.filter((position) => position.netQuantity.isPositive()).length
    const short = positions.filter((position) => position.netQuantity.isNegative()).length
    expect(long + short).toBe(positions.length)
    expect(Math.min(long, short)).toBeGreaterThan(positions.length / 4)
    // Some symbols end flat, and are not positions.
    expect(perSymbol.size).toBeGreaterThan(positions.length)
  })

  it('has quantities and average costs that differ, fractional ones among them, which need exact decimals', () => {
    expect(new Set(positions.map((position) => position.netQuantity.toFixed())).size).toBeGreaterThan(100)
    expect(new Set(positions.map((position) => position.averageCost.toFixed())).size).toBeGreaterThan(positions.length - 5)
    expect(positions.filter((position) => position.netQuantity.decimalPlaces() > 0).length).toBeGreaterThan(20)
    expect(positions.filter((position) => position.averageCost.decimalPlaces() > 10).length).toBeGreaterThan(20)
    // Beyond what a JavaScript number holds exactly.
    expect(positions.some((position) => position.averageCost.toFixed().replace(/[-.]/g, '').replace(/^0+/, '').length > 17)).toBe(true)
  })

  it('has positions whose net quantity and average cost agree with a calculation made here, trade by trade', () => {
    const ordered = [...booked(benchmark)].sort(compareTradeOrder)
    const expected = new Map<string, { net: Dec; cost: Dec }>()
    for (const trade of ordered) {
      const now = expected.get(trade.symbol) ?? { net: new Dec(0), cost: new Dec(0) }
      const signed = trade.side === 'Buy' ? trade.quantity : trade.quantity.negated()
      const net = now.net.plus(signed)
      let cost: Dec
      if (net.isZero()) cost = new Dec(0)
      else if (now.net.isZero() || now.net.isPositive() !== net.isPositive()) cost = trade.price // opened, or crossed through zero
      else if (now.net.isPositive() === signed.isPositive()) cost = now.net.abs().times(now.cost).plus(trade.quantity.times(trade.price)).dividedBy(net.abs()) // added to
      else cost = now.cost // reduced
      expected.set(trade.symbol, { net, cost })
    }
    const open = [...expected].filter(([, value]) => !value.net.isZero())
    expect(positions.map((position) => position.symbol)).toEqual(open.map(([symbol]) => symbol).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    for (const position of positions) {
      const want = expected.get(position.symbol)
      expect(position.netQuantity.toFixed(), position.symbol).toBe(want?.net.toFixed())
      expect(position.averageCost.toFixed(), position.symbol).toBe(want?.cost.toFixed())
    }
  })

  it('gives symbols very different numbers of trades: many over 100, for several pages, and a few that fit on one', () => {
    const counts = [...perSymbol.values()]
    expect(counts.filter((count) => count > 100).length).toBeGreaterThanOrEqual(50)
    expect(counts.filter((count) => count > 1_000).length).toBeGreaterThan(0)
    expect(counts.filter((count) => count <= 25).length).toBeGreaterThanOrEqual(5)
    // MS, MSFT and MSTR still share letters: searching within symbols differs from an exact match.
    for (const symbol of ['MS', 'MSFT', 'MSTR']) expect(perSymbol.get(symbol)).toBeGreaterThan(100)
    expect(positions.filter((position) => position.symbol.includes('MS')).length).toBeGreaterThanOrEqual(2)
  })
})
