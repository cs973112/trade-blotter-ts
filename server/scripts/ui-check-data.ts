import { calculatePositions } from '../src/domain/position.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../src/domain/symbol.ts'
import { toUtcTimestamp } from '../src/domain/timestamp.ts'
import { createTrade, validateTradeRequest, type NewTrade, type Trade } from '../src/domain/trade.ts'
import { closeDatabase, openDatabase } from '../src/infrastructure/database/connection.ts'
import { applyMigrations } from '../src/infrastructure/database/migrate.ts'
import { trades } from '../src/infrastructure/database/schema.ts'
import { toRow } from '../src/infrastructure/drizzle-trade-repository.ts'
import { BENCHMARK_COUNT, BENCHMARK_SEED } from './review-context.ts'
import { generateTrades } from './seed-data.ts'

/**
 * The UI checks' own dataset: fixed trades, identical on every run and machine, with more open
 * positions than the Positions grid shows at once (so it must scroll), and enough trades for the
 * trade list to have several pages. It is not the benchmark dataset, which it never touches.
 *
 *   - 40 open positions, POS01 to POS40: every third one short, the rest long; some built from
 *     several trades, partly closed, or reversed.
 *   - 4 symbols bought and sold back to flat (FLAT1 to FLAT4), which the grid must not show.
 *   - Exact decimals that a JavaScript number would change: an average cost of 5/3 (50
 *     significant digits), and a quantity with 15 integer and 10 decimal digits.
 */

export const UI_OPEN_POSITIONS = 40
const FIRST_EXECUTION = Date.parse('2026-01-05T14:30:00.000Z')

interface Order {
  readonly symbol: string
  readonly side: 'Buy' | 'Sell'
  readonly quantity: string
  readonly price: string
}

function orders(): Order[] {
  const list: Order[] = []
  // 1 at 1 and 2 at 2: an average cost of exactly 5/3, to the API's 50 significant digits.
  list.push({ symbol: 'POS01', side: 'Buy', quantity: '1', price: '1' }, { symbol: 'POS01', side: 'Buy', quantity: '2', price: '2' })
  for (let number = 2; number <= UI_OPEN_POSITIONS; number++) {
    const symbol = `POS${String(number).padStart(2, '0')}`
    const opening = number % 3 === 0 ? 'Sell' : 'Buy'
    const closing = opening === 'Buy' ? 'Sell' : 'Buy'
    const lot = String(number * 10)
    const price = `${String(20 + number)}.${String(number % 4 * 25).padStart(2, '0')}`
    list.push({ symbol, side: opening, quantity: lot, price })
    // Add to it, then take some off: the average comes from the opening trades only.
    if (number % 2 === 0) list.push({ symbol, side: opening, quantity: String(number * 5), price: `${String(21 + number)}.5` })
    if (number % 5 === 0) list.push({ symbol, side: closing, quantity: String(number * 3), price: String(22 + number) })
    // Reverse through zero: the new average is this trade's price.
    if (number % 7 === 0) list.push({ symbol, side: closing, quantity: String(number * 30), price: `${String(19 + number)}.125` })
  }
  list.push({ symbol: 'POS02', side: 'Buy', quantity: '123456789012345.1234567891', price: '0.0000000001' })
  for (let number = 1; number <= 4; number++) {
    list.push({ symbol: `FLAT${String(number)}`, side: 'Buy', quantity: '25', price: '10' })
    list.push({ symbol: `FLAT${String(number)}`, side: 'Sell', quantity: '25', price: '11' })
  }
  // Pad the history so the trade list has several pages at every page size; the positions stay as they are.
  for (let index = 0; index < 60; index++) {
    const symbol = `POS${String(3 + (index % 20)).padStart(2, '0')}`
    list.push({ symbol, side: 'Buy', quantity: '1', price: '50' })
    list.push({ symbol, side: 'Sell', quantity: '1', price: '51' })
  }
  return list
}

/** A UUID (version 4 form) from a number, so ids are the same on every run; `variant` keeps datasets apart. */
const fixedId = (index: number, variant = '8'): string => `00000000-0000-4000-${variant}000-${index.toString(16).padStart(12, '0')}`

/** Orders built into trades as the API builds them, in execution order, a minute apart from `first`. */
function build(list: readonly Order[], first: number, variant: string): NewTrade[] {
  return list.map((order, index) => {
    const executedAt = new Date(first + index * 60_000).toISOString()
    const result = validateTradeRequest({ ...order, executedAt }, { symbolMaxLength: DEFAULT_SYMBOL_MAX_LENGTH })
    if (!result.ok) throw new Error(`An invalid UI check trade (${JSON.stringify(result.errors)}); this is a bug in the dataset.`)
    return createTrade(result.value, { id: fixedId(index + 1, variant), now: toUtcTimestamp(new Date(Date.parse(executedAt) + 30_000)) })
  })
}

/** The dataset's trades, built as the API builds them, in execution order, a minute apart. */
export function uiCheckTrades(): NewTrade[] {
  return build(orders(), FIRST_EXECUTION, '8')
}

/** The open positions the dataset should produce, as the domain calculates them. */
export function uiCheckPositions(): ReturnType<typeof calculatePositions> {
  return positionsOf(uiCheckTrades())
}

function positionsOf(list: readonly NewTrade[]): ReturnType<typeof calculatePositions> {
  return calculatePositions(list.map((trade, index): Trade => ({ ...trade, bookingSequence: index + 1 })))
}

/** Creates a new database file at `path` (migrated as the API would) holding the dataset. */
export function writeUiCheckDatabase(path: string): void {
  writeTrades(path, uiCheckTrades())
}

function writeTrades(path: string, list: readonly NewTrade[]): void {
  const db = openDatabase(path)
  try {
    applyMigrations(db)
    const rows = list.map(toRow)
    db.transaction((tx) => {
      for (let start = 0; start < rows.length; start += 200) tx.insert(trades).values(rows.slice(start, start + 200)).run()
    }, { behavior: 'immediate' })
  } finally {
    closeDatabase(db)
  }
}

// ---------------------------------------------------------------------------------------------
// Positions & Trade Details: a second, separate dataset

/**
 * The master-detail checks' own dataset, kept apart from the one above so its 40 positions stay as
 * they are. Symbols that contain one another, so an exact match can be told from a search within
 * symbols: MS (60 trades, more than two pages of 25), MSFT (7), MSTR (4), AMS (3) and
 * MSXLONGSYMBOLNAMEFORLAYOUTCHECKS (2, a long name for the layout). Prices and notionals whose
 * two-decimal display depends on rounding half to even: 90.125 shows as 90.12, 90.135 as 90.14,
 * and a notional of 270.405 as 270.40.
 */
export const UI_DETAIL_COUNTS: Readonly<Record<string, number>> = { AMS: 3, MS: 60, MSFT: 7, MSTR: 4, MSXLONGSYMBOLNAMEFORLAYOUTCHECKS: 2 }
const FIRST_DETAIL_EXECUTION = Date.parse('2026-02-02T14:30:00.000Z')

function detailOrders(): Order[] {
  const list: Order[] = []
  const add = (symbol: string, side: 'Buy' | 'Sell', quantity: string, price: string): void => { list.push({ symbol, side, quantity, price }) }
  // MS: opened with the rounding cases, then 58 more, buying 2 for every 1 sold, so it stays long.
  add('MS', 'Buy', '2', '90.125')
  add('MS', 'Buy', '3', '90.135')
  for (let index = 0; index < 58; index++) {
    const sell = index % 3 === 2
    add('MS', sell ? 'Sell' : 'Buy', sell ? '1' : '2', `${String(80 + (index % 17))}.${String((index * 7) % 100).padStart(2, '0')}`)
  }
  for (let index = 0; index < 7; index++) add('MSFT', index === 0 ? 'Sell' : index % 2 === 0 ? 'Buy' : 'Sell', String(10 + index), `${String(400 + index)}.3333`)
  for (let index = 0; index < 4; index++) add('MSTR', 'Buy', '0.5', `${String(1500 + index * 10)}.005`)
  for (let index = 0; index < 3; index++) add('AMS', 'Buy', '100', `${String(12 + index)}.5`)
  add('MSXLONGSYMBOLNAMEFORLAYOUTCHECKS', 'Buy', '123456789.123456789', '0.0000000001')
  add('MSXLONGSYMBOLNAMEFORLAYOUTCHECKS', 'Buy', '1', '999999999999999.9999999999')
  // Interleave the symbols in time, as trading would: sorted by symbol then by order, spread by index.
  return list.map((order, index) => ({ order, key: (index * 37) % list.length })).sort((a, b) => a.key - b.key).map(({ order }) => order)
}

export function uiDetailTrades(): NewTrade[] {
  return build(detailOrders(), FIRST_DETAIL_EXECUTION, '9')
}

export function uiDetailPositions(): ReturnType<typeof calculatePositions> {
  return positionsOf(uiDetailTrades())
}

/** Creates a new database file at `path` (migrated as the API would) holding the master-detail dataset. */
export function writeUiDetailDatabase(path: string): void {
  writeTrades(path, uiDetailTrades())
}

// ---------------------------------------------------------------------------------------------
// The benchmark's own dataset, for the grids at its scale

/**
 * Writes the reviewer's benchmark dataset (the seed generator's 25,000 trades, BENCHMARK_SEED) into
 * a new database at `path`: the same trades as the reviewer's benchmark, in a file of the UI
 * checks' own, so the reviewer's database is never opened.
 */
export function writeBenchmarkDatabase(path: string): void {
  writeTrades(path, generateTrades(BENCHMARK_COUNT, BENCHMARK_SEED))
}

/** The benchmark's open positions, as the domain calculates them from its trades. */
export function uiBenchmarkPositionCount(): number {
  return positionsOf(generateTrades(BENCHMARK_COUNT, BENCHMARK_SEED)).length
}
