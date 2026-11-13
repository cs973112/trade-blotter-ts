import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Dec, decimalText, MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS } from '../../src/domain/decimal.ts'
import { normaliseSymbol } from '../../src/domain/symbol.ts'
import {
  compareTrades,
  pageCount,
  pageWindow,
  SORT_DIRECTIONS,
  TRADE_SORT_FIELDS,
  type TradeFilter,
  type TradeQuery,
} from '../../src/domain/trade-query.ts'
import type { Trade, TradeSide } from '../../src/domain/trade.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository, planPageRead } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestDatabase } from '../support/database.ts'
import { newTrade, utc } from '../support/trades.ts'

/**
 * The repository sorts and pages in SQLite. These tests hold it to compareTrades, the reference
 * order, on a deterministic history built to break a wrong implementation: decimals whose text
 * order, float order or length order differs from their value, the bounds of the input range,
 * symbols where UTF-16 order differs from code-point order, and ties on every field.
 */

let database: ReturnType<typeof createTestDatabase>
let db: Database
let repository: ReturnType<typeof createDrizzleTradeRepository>
let history: readonly Trade[] = []

/** A small deterministic generator (mulberry32), so every run books the same history. */
function generator(seed: number): (n: number) => number {
  let state = seed >>> 0
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) % n)
  }
}

/** Edge values: canonical forms at the bounds, and pairs that text, length or float order gets wrong. */
const EDGE_DECIMALS = [
  '0.0000000001', '0.000000001', '0.0000000011', '0.1', '0.5', '0.51', '0.6', '0.9999999999', '1', '1.05', '1.5', '2', '9',
  '9.5', '9.9999999999', '10', '10.0000000001', '50', '99', '100', '100.2', '100.25', '500', '123456789012345.123456789',
  '123456789012345.1234567891', '123456789012345.1234567892', '100000000000000', '999999999999999', '999999999999999.9999999998',
  '999999999999999.9999999999',
]

/** A random decimal within the input range, in the canonical form the repository stores. */
function randomDecimal(next: (n: number) => number): string {
  const integerDigits = next(MAX_INTEGER_DIGITS + 1)
  let text = integerDigits === 0 ? '0' : String(1 + next(9))
  for (let index = 1; index < integerDigits; index++) text += String(next(10))
  const places = next(MAX_DECIMAL_PLACES + 1)
  if (places > 0) {
    text += '.'
    for (let index = 0; index < places; index++) text += String(next(10))
  }
  const value = new Dec(text)
  return decimalText(value.isZero() ? new Dec('0.0000000001') : value)
}

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints)

/** Normalised as the domain stores them. FF21 (fullwidth A) and 1D400 (bold A) sort one way by code point, the other by UTF-16. */
const SYMBOLS = ['A', 'AA', 'AB', 'B', 'MS', 'MSFT', 'MSTR', 'BRK.B', 'BRK-B', 'Z', 'ZZ', 'ÉCOLE', 'ECOLE', 'Ω', cp(0xff21), cp(0x1d400),
  `${cp(0x1d400)}A`, '株式', `E${cp(0x301)}`].map((symbol) => {
  const result = normaliseSymbol(symbol, 64)
  if (!result.ok) throw new Error(`Test symbol ${symbol} is not valid: ${result.problem}`)
  return result.value
})

/** Few distinct times, so most trades tie on execution time; includes the extremes. */
const TIMES = ['0001-01-01T00:00:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T07:00:00.001Z', '2026-11-01T05:59:59.999Z',
  '9999-12-31T23:59:59.999Z']

const FILTERS: readonly (readonly [string, TradeFilter])[] = [
  ['no filter', {}],
  ['symbol A', { symbolContains: 'A' }],
  ['symbol MS', { symbolContains: 'MS' }],
  ['exactly symbol MS', { symbolEquals: 'MS' }],
  ['exactly symbol MSFT, side Buy', { symbolEquals: 'MSFT', side: 'Buy' }],
  [`symbol ${cp(0x1d400)}`, { symbolContains: cp(0x1d400) }],
  ['side Sell', { side: 'Sell' }],
  ['one execution time', { executedFrom: utc(TIMES[1] ?? ''), executedTo: utc(TIMES[1] ?? '') }],
  ['every filter', { symbolContains: 'M', side: 'Buy', executedFrom: utc(TIMES[1] ?? ''), executedTo: utc(TIMES[3] ?? '') }],
  ['nothing matches', { symbolContains: 'NO SUCH SYMBOL' }],
]

const QUERIES: readonly (readonly [string, TradeQuery])[] = FILTERS.flatMap(([name, filter]) =>
  TRADE_SORT_FIELDS.flatMap((field) => SORT_DIRECTIONS.map((direction) =>
    [`${name}, ${field} ${direction}`, { filter, sort: { field, direction } }] as const)))

const matches = (trade: Trade, filter: TradeFilter): boolean =>
  (filter.symbolContains === undefined || trade.symbol.includes(filter.symbolContains)) &&
  (filter.symbolEquals === undefined || trade.symbol === filter.symbolEquals) &&
  (filter.side === undefined || trade.side === filter.side) &&
  (filter.executedFrom === undefined || trade.executedAt >= filter.executedFrom) &&
  (filter.executedTo === undefined || trade.executedAt <= filter.executedTo)

/** The ids compareTrades puts first to last. */
const expectedIds = (query: TradeQuery): string[] =>
  history.filter((trade) => matches(trade, query.filter)).sort(compareTrades(query.sort)).map((trade) => trade.id)

const ids = (trades: readonly Trade[]): string[] => trades.map((trade) => trade.id)

beforeAll(async () => {
  database = createTestDatabase()
  db = database.open()
  repository = createDrizzleTradeRepository(db)
  const next = generator(20261107)
  const count = 420
  for (let index = 0; index < count; index++) {
    // The edge values three times each, to make ties; then random ones, a third repeating an edge value.
    const quantity = index < EDGE_DECIMALS.length * 3 ? EDGE_DECIMALS[index % EDGE_DECIMALS.length] ?? '1'
      : next(3) === 0 ? EDGE_DECIMALS[next(EDGE_DECIMALS.length)] ?? '1' : randomDecimal(next)
    const price = next(3) === 0 ? EDGE_DECIMALS[next(EDGE_DECIMALS.length)] ?? '1' : randomDecimal(next)
    const side: TradeSide = next(2) === 0 ? 'Buy' : 'Sell'
    await repository.add(newTrade({
      id: `t${String(index).padStart(3, '0')}`, symbol: SYMBOLS[next(SYMBOLS.length)] ?? 'A', side, quantity, price,
      executedAt: TIMES[next(TIMES.length)] ?? '2026-01-01T00:00:00.000Z',
    }))
  }
  history = await repository.listInTradeOrder()
}, 60_000)

afterAll(() => {
  database.dispose()
})

describe('infrastructure: SQL sort order matches compareTrades', () => {
  it('books a history that exercises the order', () => {
    const quantities = new Set(history.map((trade) => decimalText(trade.quantity)))
    const executions = new Set(history.map((trade) => trade.executedAt))

    expect(history).toHaveLength(420)
    expect(quantities.size).toBeLessThan(history.length)
    expect(executions.size).toBe(TIMES.length)
    for (const value of ['0.0000000001', '999999999999999.9999999999', '123456789012345.1234567891']) expect(quantities).toContain(value)
    // Code-point order and UTF-16 order disagree on these two symbols; the history needs both.
    expect([cp(0xff21) < cp(0x1d400), history.some((trade) => trade.symbol === cp(0xff21)), history.some((trade) => trade.symbol === cp(0x1d400))])
      .toEqual([false, true, true])
  })

  it.each(QUERIES)('lists in compareTrades order: %s', async (_name, query) => {
    expect(ids(await repository.list(query))).toEqual(expectedIds(query))
  })

  it.each(QUERIES)('lists exactly what reading in trade order and sorting in memory gave: %s', async (_name, query) => {
    const inMemory = [...(await repository.listInTradeOrder(query.filter))].sort(compareTrades(query.sort))

    expect(ids(await repository.list(query))).toEqual(ids(inMemory))
  })

  it.each(QUERIES)('pages through the same order, every slice and count exact: %s', async (_name, query) => {
    const expected = expectedIds(query)
    for (const pageSize of [1, 7, 50, 100]) {
      const pages = pageCount(expected.length, pageSize)
      const walked: string[] = []
      // Every page for the small sizes; for size 1, the first, middle and last few.
      const numbers = pageSize === 1
        ? [...new Set([1, 2, Math.ceil(pages / 2), pages - 1, pages].filter((page) => page >= 1))]
        : Array.from({ length: pages }, (_, index) => index + 1)
      for (const page of numbers) {
        const result = await repository.listPage(query, { page, pageSize })
        expect(result.totalCount).toBe(expected.length)
        const slice = expected.slice((page - 1) * pageSize, page * pageSize)
        expect(ids(result.trades), `page ${String(page)} of size ${String(pageSize)}`).toEqual(slice)
        walked.push(...ids(result.trades))
      }
      if (pageSize !== 1) expect(walked).toEqual(expected)
      for (const past of [pages + 1, pages + 2, Number.MAX_SAFE_INTEGER]) {
        expect(await repository.listPage(query, { page: past, pageSize })).toEqual({ trades: [], totalCount: expected.length })
      }
    }
  })

  it('reads the pages above in every way a page can be read, so each is checked', () => {
    const plans = new Set<string>()
    for (const [, query] of QUERIES) {
      const total = expectedIds(query).length
      for (const pageSize of [1, 7, 50, 100]) {
        for (let page = 1; page <= pageCount(total, pageSize); page++) {
          const window = pageWindow({ page, pageSize }, total)
          if (window === undefined) continue
          const plan = planPageRead(window, total, query.sort.field, query.filter, () => history.length)
          plans.add(`${plan.fromEnd ? 'from end' : 'from start'}, ${plan.useSortIndex ? 'sort index' : 'sorted matches'}`)
        }
      }
    }

    expect([...plans].sort()).toEqual([
      'from end, sort index', 'from end, sorted matches', 'from start, sort index', 'from start, sorted matches',
    ])
  })

  it('returns whole trades from a page, decimals exact', async () => {
    const query: TradeQuery = { filter: {}, sort: { field: 'price', direction: 'desc' } }
    const listed = await repository.list(query)
    const { trades } = await repository.listPage(query, { page: 2, pageSize: 7 })

    expect(trades).toEqual(listed.slice(7, 14))
    expect(trades.every((trade) => Object.isFrozen(trade))).toBe(true)
  })
})

describe('infrastructure: exact decimal sort keys', () => {
  const keys = (column: 'quantity_key' | 'price_key'): string[] =>
    (db.$client.prepare(`select ${column} as key from trades order by ${column}, booking_sequence`).all() as { key: string }[])
      .map((row) => row.key)

  it('are text, computed by SQLite from the stored canonical text', () => {
    const rows = db.$client.prepare(`select quantity, quantity_key, typeof(quantity_key) as type, price, price_key from trades
      where quantity in ('0.0000000001', '999999999999999.9999999999', '10') limit 3`).all()

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows as { quantity: string; quantity_key: string; type: string; price: string; price_key: string }[]) {
      const integerDigits = row.quantity.split('.')[0]?.length ?? 0
      expect(row.type).toBe('text')
      expect(row.quantity_key).toBe(`${String(integerDigits).padStart(10, '0')}${row.quantity}`)
      expect(row.price_key.endsWith(row.price)).toBe(true)
    }
  })

  it('sort every stored quantity and price by exact value', () => {
    const byValue = (column: 'quantity' | 'price') => [...history]
      .sort((a, b) => a[column].comparedTo(b[column]) || a.bookingSequence - b.bookingSequence)
    const quantityKeys = keys('quantity_key')
    const priceKeys = keys('price_key')

    expect(quantityKeys).toEqual([...quantityKeys].sort())
    expect(db.$client.prepare('select quantity from trades order by quantity_key, booking_sequence').all().map((row) => (row as { quantity: string }).quantity))
      .toEqual(byValue('quantity').map((trade) => decimalText(trade.quantity)))
    expect(db.$client.prepare('select price from trades order by price_key, booking_sequence').all().map((row) => (row as { price: string }).price))
      .toEqual(byValue('price').map((trade) => decimalText(trade.price)))
    expect(priceKeys).toHaveLength(history.length)
  })

  it('order every pair of edge values as decimal.js does, including where floats cannot tell them apart', () => {
    const select = db.$client.prepare(`select (
      printf('%010d', case when instr(:a, '.') = 0 then length(:a) else instr(:a, '.') - 1 end) || :a) <
      (printf('%010d', case when instr(:b, '.') = 0 then length(:b) else instr(:b, '.') - 1 end) || :b) as less`)
    const generatedSql = (db.$client.prepare(`select sql from sqlite_master where name = 'trades'`).get() as { sql: string }).sql

    // The same expression the schema generates, so the pairs below test the real key.
    expect(generatedSql).toContain(`printf('%010d', case when instr("quantity", '.') = 0 then length("quantity") else instr("quantity", '.') - 1 end) || "quantity"`)
    for (const a of EDGE_DECIMALS) {
      for (const b of EDGE_DECIMALS) {
        const less = (select.get({ a, b }) as { less: number }).less === 1
        expect(less, `${a} < ${b}`).toBe(new Dec(a).lessThan(new Dec(b)))
      }
    }
    expect(Number('123456789012345.1234567891')).toBe(Number('123456789012345.1234567892'))
  })
})
