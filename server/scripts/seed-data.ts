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

/** The execution window: two years spanning several daylight-saving changes. */
const FIRST_EXECUTION = Date.parse('2025-01-02T14:30:00.000Z')
const LAST_EXECUTION = Date.parse('2026-10-30T20:00:00.000Z')

/**
 * Symbols with a typical price and the decimal places their prices use. MS, MSFT and MSTR share
 * letters, for partial searches; BRK.B has punctuation; SOFI, PNNY and TINY have small prices
 * with many decimal places.
 */
const SYMBOLS: readonly (readonly [symbol: string, price: string, places: number])[] = [
  ['AAPL', '189.5', 2], ['MSFT', '415.25', 2], ['AMZN', '178.75', 2], ['GOOGL', '152.1', 2], ['META', '480', 2],
  ['NVDA', '875.4', 2], ['TSLA', '182.6', 2], ['BRK.B', '408.3', 2], ['JPM', '195.2', 2], ['V', '276.9', 2],
  ['MA', '462.15', 2], ['MS', '93.4', 2], ['MSTR', '1510', 2], ['XOM', '113.4', 2], ['JNJ', '156.7', 2],
  ['WMT', '60.35', 2], ['KO', '60.1', 2], ['PEP', '170.25', 2], ['DIS', '111.6', 2], ['NFLX', '612.9', 2],
  ['ORCL', '125.5', 2], ['SOFI', '7.8525', 4], ['PNNY', '0.012345', 6], ['TINY', '0.0000004321', 10],
]

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

function nextPrice(state: SymbolState, random: Random): string {
  if (state.lastPrice !== undefined && random.chance(0.2)) return state.lastPrice
  if (random.chance(0.03)) return SHARED_PRICE
  // A random walk of up to 2% a trade, kept within half and twice the starting level.
  const step = new Dec(random.integer(401) - 200).dividedBy(10_000)
  const moved = state.price.times(step.plus(1))
  const start = new Dec(SYMBOLS.find(([symbol]) => symbol === state.symbol)?.[1] ?? '1')
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
  if (roll < 0.78) return { side: opposite, quantity: held } // close
  return { side: opposite, quantity: held.plus(lot(random)) } // cross
}

/**
 * `count` trades in execution order, executed between 2025-01-02 and 2026-10-30. About one in
 * eight shares its execution time with the trade before it. Each is recorded (createdAt) seconds
 * to minutes after its execution, and a few days later, as if booked late.
 */
export function generateTrades(count: number, seed: string = DEFAULT_SEED): NewTrade[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`The count must be a positive integer, got ${String(count)}.`)
  const random = createRandom(`${seed}:${String(count)}`)
  const states = SYMBOLS.map(([symbol, price, places]): SymbolState => ({ symbol, places, price: new Dec(price), lastPrice: undefined, net: ZERO }))
  // One trade in eight repeats the previous time, so the others step further to span the window.
  const averageStep = (LAST_EXECUTION - FIRST_EXECUTION) / count / (1 - REPEAT_TIME)
  const trades: NewTrade[] = []
  let executed = FIRST_EXECUTION

  for (let index = 0; index < count; index++) {
    if (index > 0 && !random.chance(REPEAT_TIME)) {
      executed = Math.min(LAST_EXECUTION, executed + Math.round(random.next() * 2 * averageStep / 1000) * 1000 + (random.chance(0.1) ? random.integer(1000) : 0))
    }
    // Some symbols trade far more often than others.
    const state = states[Math.floor(states.length * random.next() ** 1.6)] ?? states[0]
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
