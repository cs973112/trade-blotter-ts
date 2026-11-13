import { createHash } from 'node:crypto'

import { Dec, decimalText, type Dec as Decimal } from '../src/domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../src/domain/symbol.ts'
import { toUtcTimestamp } from '../src/domain/timestamp.ts'
import { createTrade, validateTradeRequest, type NewTrade, type TradeSide } from '../src/domain/trade.ts'

/**
 * Deterministic sample trades for trying the application with realistic volumes. The same count
 * and seed always give the same trades: ids, timestamps and every digit.
 *
 * Each trade is built the way the API builds one, through validateTradeRequest and createTrade,
 * so it is valid and normalised by the domain's own rules. The generator tracks only each
 * symbol's net quantity, to choose quantities that open, increase, reduce, close or cross a
 * position; average costs and the position limit are left to the domain (see summariseTrades in
 * trade-data.ts, which checks them).
 */

export const DEFAULT_SEED = 'trade-blotter'

/**
 * The version of the dataset this generator makes. It changes whenever the same count and seed
 * would give other trades, so a database seeded by an earlier version is recognised as such (see
 * DATASET_FINGERPRINTS and review-data.ts) rather than trusted for its count.
 *
 *   1: 24 symbols (18 open positions in the 25,000-trade benchmark).
 *   2: 181 symbols, some traded thousands of times and some a handful (167 open positions in the
 *      25,000-trade benchmark, long and short).
 */
export const DATASET_VERSION = 2

/** The execution window: two years spanning several daylight-saving changes. */
const FIRST_EXECUTION = Date.parse('2025-01-02T14:30:00.000Z')
const LAST_EXECUTION = Date.parse('2026-10-30T20:00:00.000Z')

/**
 * Symbols with a typical price and the decimal places their prices use, the most traded first.
 * MS, MSFT and MSTR share letters, for partial searches; BRK.B and BF.B have punctuation; SOFI,
 * PNNY and TINY have small prices with many decimal places.
 */
const SYMBOLS: readonly (readonly [symbol: string, price: string, places: number])[] = [
  ['AAPL', '189.5', 2], ['MSFT', '415.25', 2], ['AMZN', '178.75', 2], ['GOOGL', '152.1', 2], ['META', '480', 2],
  ['NVDA', '875.4', 2], ['TSLA', '182.6', 2], ['BRK.B', '408.3', 2], ['JPM', '195.2', 2], ['V', '276.9', 2],
  ['MA', '462.15', 2], ['MS', '93.4', 2], ['MSTR', '1510', 2], ['XOM', '113.4', 2], ['JNJ', '156.7', 2],
  ['WMT', '60.35', 2], ['KO', '60.1', 2], ['PEP', '170.25', 2], ['DIS', '111.6', 2], ['NFLX', '612.9', 2],
  ['ORCL', '125.5', 2], ['SOFI', '7.8525', 4], ['PNNY', '0.012345', 6], ['TINY', '0.0000004321', 10],
  ['AMD', '178.6', 2], ['AVGO', '1320.4', 2], ['ADBE', '492.3', 2], ['CRM', '298.75', 2], ['CSCO', '49.8', 2],
  ['INTC', '43.15', 2], ['QCOM', '168.9', 2], ['TXN', '172.4', 2], ['IBM', '187.6', 2], ['NOW', '762.1', 2],
  ['INTU', '650.2', 2], ['AMAT', '205.7', 2], ['MU', '112.35', 2], ['LRCX', '940.5', 2], ['KLAC', '690.25', 2],
  ['ADI', '197.8', 2], ['PANW', '305.6', 2], ['SNPS', '575.9', 2], ['CDNS', '303.2', 2], ['ANET', '290.45', 2],
  ['UBER', '76.2', 2], ['ABNB', '160.35', 2], ['SHOP', '76.9', 2], ['SQ', '79.4', 2], ['PYPL', '64.8', 2],
  ['BAC', '37.6', 2], ['WFC', '57.9', 2], ['C', '62.45', 2], ['GS', '455.3', 2], ['SCHW', '73.1', 2],
  ['BLK', '815.6', 2], ['AXP', '228.4', 2], ['USB', '43.2', 2], ['PNC', '155.8', 2], ['TFC', '38.9', 2],
  ['COF', '139.25', 2], ['SPGI', '425.7', 2], ['ICE', '137.4', 2], ['CME', '210.6', 2], ['MMC', '204.15', 2],
  ['CB', '257.8', 2], ['PGR', '209.3', 2], ['AIG', '75.1', 2], ['MET', '72.6', 2], ['PRU', '115.9', 2],
  ['UNH', '492.5', 2], ['LLY', '772.3', 2], ['PFE', '27.85', 2], ['MRK', '129.6', 2], ['ABBV', '162.4', 2],
  ['TMO', '578.2', 2], ['ABT', '113.7', 2], ['DHR', '249.9', 2], ['BMY', '50.65', 2], ['AMGN', '275.3', 2],
  ['GILD', '73.25', 2], ['CVS', '73.8', 2], ['CI', '336.4', 2], ['ELV', '515.2', 2], ['ISRG', '388.6', 2],
  ['VRTX', '418.9', 2], ['REGN', '962.5', 2], ['ZTS', '168.3', 2], ['MDT', '82.4', 2], ['SYK', '338.75', 2],
  ['CVX', '157.3', 2], ['COP', '126.4', 2], ['SLB', '52.6', 2], ['EOG', '127.85', 2], ['OXY', '62.3', 2],
  ['PSX', '160.2', 2], ['MPC', '182.4', 2], ['VLO', '165.7', 2], ['KMI', '18.45', 2], ['WMB', '38.9', 2],
  ['HD', '348.6', 2], ['LOW', '232.4', 2], ['COST', '725.3', 2], ['TGT', '168.9', 2], ['NKE', '93.6', 2],
  ['SBUX', '87.2', 2], ['MCD', '279.4', 2], ['CMG', '2915.5', 2], ['BKNG', '3510.25', 2], ['MAR', '245.6', 2],
  ['HLT', '209.4', 2], ['F', '12.15', 2], ['GM', '44.3', 2], ['TM', '235.8', 2], ['HMC', '33.6', 2],
  ['PG', '160.9', 2], ['CL', '89.4', 2], ['KMB', '128.3', 2], ['MDLZ', '70.15', 2], ['GIS', '67.9', 2],
  ['K', '57.3', 2], ['HSY', '193.4', 2], ['STZ', '264.2', 2], ['BF.B', '52.75', 2], ['PM', '91.6', 2],
  ['MO', '42.35', 2], ['CAT', '338.2', 2], ['DE', '392.6', 2], ['HON', '197.4', 2], ['GE', '157.3', 2],
  ['BA', '183.9', 2], ['LMT', '458.7', 2], ['RTX', '101.25', 2], ['NOC', '462.8', 2], ['GD', '286.4', 2],
  ['UPS', '146.8', 2], ['FDX', '262.3', 2], ['UNP', '238.9', 2], ['CSX', '35.6', 2], ['NSC', '242.15', 2],
  ['MMM', '93.2', 2], ['EMR', '107.6', 2], ['ETN', '308.4', 2], ['ITW', '258.3', 2], ['PH', '548.9', 2],
  ['NEE', '64.2', 2], ['DUK', '96.8', 2], ['SO', '70.45', 2], ['D', '48.6', 2], ['AEP', '84.3', 2],
  ['T', '17.2', 2], ['VZ', '40.15', 2], ['TMUS', '163.4', 2], ['CMCSA', '41.3', 2], ['CHTR', '275.6', 2],
  ['AMT', '192.3', 2], ['PLD', '118.6', 2], ['CCI', '98.4', 2], ['EQIX', '780.2', 2], ['SPG', '148.9', 2],
  ['LIN', '459.3', 2], ['SHW', '305.8', 2], ['APD', '238.4', 2], ['ECL', '228.6', 2], ['NEM', '35.85', 2],
  ['FCX', '47.3', 2], ['NUE', '186.2', 2], ['DOW', '57.4', 2], ['DD', '76.9', 2], ['PPG', '141.2', 2],
]

/**
 * Thinly traded symbols, each about a dozen times in 25,000 trades: lists that fit on one page,
 * beside the many that need several. Penny prices with up to six decimal places.
 */
const THIN_SYMBOLS: readonly (readonly [symbol: string, price: string, places: number])[] = [
  ['ACME', '3.2175', 4], ['BOLT', '0.4825', 4], ['CRAB', '12.375', 3], ['DUNE', '0.091234', 6], ['EMBR', '1.0625', 4],
  ['FJORD', '27.5', 2], ['GLYPH', '0.5', 2], ['HALO', '8.125', 3], ['IRIS', '0.003125', 6], ['JADE', '45.875', 3],
  ['KELP', '2.25', 2], ['LUMEN', '0.0625', 4],
]

/** The share of trades in the thinly traded symbols, all together. */
const THIN_SHARE = 0.006

/** Quantities that recur, so sorting by quantity meets many ties; and a few fractional ones. */
const LOTS = ['1', '5', '10', '25', '50', '100', '200', '250', '500', '1000'] as const
const FRACTIONS = ['0.5', '2.75', '12.125', '0.001'] as const

/** The share of trades executed at the same time as the trade before. */
const REPEAT_TIME = 0.12

/** A price several symbols can share, for ties across symbols when sorting by price. */
const SHARED_PRICE = '100'

/**
 * A small seeded generator (xmur3 to hash the seed, sfc32 to generate): fast, and the same on
 * every platform and Node.js version, unlike Math.random.
 */
export function createRandom(seed: string) {
  let h = 1779033703 ^ seed.length
  for (let index = 0; index < seed.length; index++) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  const nextSeed = (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^= h >>> 16) >>> 0
  }
  let a = nextSeed(), b = nextSeed(), c = nextSeed(), d = nextSeed()
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  const integer = (below: number): number => Math.floor(next() * below)
  return {
    /** In [0, 1). */
    next,
    /** An integer in [0, below). */
    integer,
    chance: (probability: number): boolean => next() < probability,
    pick: <T>(items: readonly T[]): T => {
      const item = items[integer(items.length)]
      if (item === undefined) throw new Error('cannot pick from an empty list')
      return item
    },
    /** A version 4 UUID, from this generator's bytes. */
    uuid: (): string => {
      const bytes = Array.from({ length: 16 }, () => integer(256))
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
      const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  }
}

type Random = ReturnType<typeof createRandom>

interface SymbolState {
  readonly symbol: string
  readonly places: number
  /** The price drifts from here, a small step at a time. */
  price: Decimal
  lastPrice: string | undefined
  /** Signed: positive long, negative short. */
  net: Decimal
}

const ZERO = new Dec(0)

const ALL_SYMBOLS = [...SYMBOLS, ...THIN_SYMBOLS]

function nextPrice(state: SymbolState, random: Random): string {
  if (state.lastPrice !== undefined && random.chance(0.2)) return state.lastPrice
  if (random.chance(0.03)) return SHARED_PRICE
  // A random walk of up to 2% a trade, kept within half and twice the starting level.
  const step = new Dec(random.integer(401) - 200).dividedBy(10_000)
  const moved = state.price.times(step.plus(1))
  const start = new Dec(ALL_SYMBOLS.find(([symbol]) => symbol === state.symbol)?.[1] ?? '1')
  state.price = Dec.max(start.dividedBy(2), Dec.min(start.times(2), moved))
  const rounded = state.price.toDecimalPlaces(state.places, Dec.ROUND_HALF_EVEN)
  const price = rounded.isZero() ? new Dec(1).dividedBy(new Dec(10).pow(state.places)) : rounded
  return decimalText(price)
}

function lot(random: Random): Decimal {
  return new Dec(random.chance(0.1) ? random.pick(FRACTIONS) : random.pick(LOTS))
}

/** The side and quantity of the next trade for a symbol, by what it should do to the position. */
function nextOrder(state: SymbolState, random: Random): { side: TradeSide; quantity: Decimal } {
  const held = state.net.abs()
  if (held.isZero()) return { side: random.chance(0.5) ? 'Buy' : 'Sell', quantity: lot(random) }
  const same: TradeSide = state.net.isPositive() ? 'Buy' : 'Sell'
  const opposite: TradeSide = same === 'Buy' ? 'Sell' : 'Buy'
  // Large positions are wound down more often than they are grown.
  const roll = random.next() + (held.gt(20_000) ? 0.3 : 0)
  if (roll < 0.3) return { side: same, quantity: lot(random) } // increase
  if (roll < 0.6) {
    const smaller = [...LOTS, ...FRACTIONS].map((text) => new Dec(text)).filter((quantity) => quantity.lt(held))
    if (smaller.length > 0) return { side: opposite, quantity: random.pick(smaller) } // reduce
  }
  if (roll < 0.7) return { side: opposite, quantity: held } // close
  return { side: opposite, quantity: held.plus(lot(random)) } // cross
}

/**
 * `count` trades in execution order, executed between 2025-01-02 and 2026-10-30. About one in
 * eight shares its execution time with the trade before it. Each is recorded (createdAt) seconds
 * to minutes after its execution, and a few days later, as if booked late.
 */
export function generateTrades(count: number, seed: string = DEFAULT_SEED): NewTrade[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`The count must be a positive integer, got ${String(count)}.`)
  const random = createRandom(`${seed}:v${String(DATASET_VERSION)}:${String(count)}`)
  const toState = ([symbol, price, places]: readonly [string, string, number]): SymbolState => ({ symbol, places, price: new Dec(price), lastPrice: undefined, net: ZERO })
  const states = SYMBOLS.map(toState)
  const thin = THIN_SYMBOLS.map(toState)
  // One trade in eight repeats the previous time, so the others step further to span the window.
  const averageStep = (LAST_EXECUTION - FIRST_EXECUTION) / count / (1 - REPEAT_TIME)
  const trades: NewTrade[] = []
  let executed = FIRST_EXECUTION

  for (let index = 0; index < count; index++) {
    if (index > 0 && !random.chance(REPEAT_TIME)) {
      executed = Math.min(LAST_EXECUTION, executed + Math.round(random.next() * 2 * averageStep / 1000) * 1000 + (random.chance(0.1) ? random.integer(1000) : 0))
    }
    // Some symbols trade far more often than others; a few hardly at all.
    const state = random.chance(THIN_SHARE) ? random.pick(thin) : states[Math.floor(states.length * random.next() ** 2.2)] ?? states[0]
    if (state === undefined) throw new Error('no symbols')
    const { side, quantity } = nextOrder(state, random)
    const price = nextPrice(state, random)
    const recorded = executed + (random.chance(0.03) ? (1 + random.integer(10)) * 86_400_000 : (1 + random.integer(600)) * 1000)

    const result = validateTradeRequest(
      { symbol: state.symbol, side, quantity: decimalText(quantity), price, executedAt: new Date(executed).toISOString() },
      { symbolMaxLength: DEFAULT_SYMBOL_MAX_LENGTH },
    )
    if (!result.ok) throw new Error(`Generated an invalid trade (${JSON.stringify(result.errors)}); this is a bug in the seeder.`)
    trades.push(createTrade(result.value, { id: random.uuid(), now: toUtcTimestamp(new Date(recorded)) }))
    state.lastPrice = price
    state.net = state.net.plus(side === 'Buy' ? quantity : quantity.negated())
  }
  return trades
}

/**
 * A dataset's identity: SHA-256 of its trades in booking order, one line each with its position
 * in that order and every stored field. For a database holding just its seeded dataset this is
 * what perf-api.ts's readSnapshot gives too (it lists trades in trade order, which seeding makes
 * the same as booking order).
 */
export function datasetFingerprint(trades: readonly StoredTradeText[]): string {
  const hash = createHash('sha256')
  trades.forEach((t, index) => {
    hash.update(`${String(index + 1)}|${t.id}|${t.symbol}|${t.side}|${t.quantity}|${t.price}|${t.executedAt}|${t.createdAt}|${t.updatedAt}\n`)
  })
  return hash.digest('hex')
}

/** A trade's fields as stored, all text: what toRow gives for a generated trade, and what a database holds. */
export interface StoredTradeText {
  readonly id: string
  readonly symbol: string
  readonly side: string
  readonly quantity: string
  readonly price: string
  readonly executedAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Datasets earlier versions of this generator made for the reviewer workflow, by fingerprint, so
 * a database holding one is named for what it is. Recorded from version 1 before it was replaced.
 */
export const PREVIOUS_DATASETS: readonly { readonly version: number; readonly seed: string; readonly count: number; readonly fingerprint: string }[] = [
  { version: 1, seed: 'trade-blotter', count: 25_000, fingerprint: '6c9f755de89dce237b070de1ef3249e2ccfdaebce4390ac136fd33e8d467ec38' },
  { version: 1, seed: 'trade-blotter-scratch', count: 120, fingerprint: 'f44f32e2e5f1172cf407bed5660f590475cf208b5a046a9a7f08d6be85b418ac' },
]
