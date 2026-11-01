import { Dec, NET_QUANTITY_LIMIT } from './decimal.ts'
import { compareSymbols } from './symbol.ts'
import { compareTradeOrder, type Trade } from './trade.ts'

/**
 * A position: the net holding in one symbol. `netQuantity` is signed, positive long and negative
 * short. `averageCost` is the quantity-weighted average price of the open quantity, and zero when
 * the position is flat.
 */
export interface Position {
  readonly symbol: string
  readonly netQuantity: Dec
  readonly averageCost: Dec
}

/** What a trade contributes to a position. */
export type PositionTrade = Pick<Trade, 'symbol' | 'side' | 'quantity' | 'price' | 'executedAt' | 'bookingSequence'>

/**
 * The net quantity of a position would reach or pass NET_QUANTITY_LIMIT. Raised when a trade is
 * proposed, before it is stored, so a stored history never breaches the limit.
 */
export class PositionLimitError extends Error {
  readonly symbol: string

  constructor(symbol: string) {
    super(`The net quantity of ${symbol} reached the position limit of ${NET_QUANTITY_LIMIT}.`)
    this.name = 'PositionLimitError'
    this.symbol = symbol
  }
}

const ZERO = new Dec(0)
const LIMIT = new Dec(NET_QUANTITY_LIMIT)

export function flatPosition(symbol: string): Position {
  return Object.freeze({ symbol, netQuantity: ZERO, averageCost: ZERO })
}

/**
 * Applies one trade to a position. A Buy adds and a Sell subtracts, so longs and shorts share one
 * path, and each trade falls under exactly one rule:
 *
 * - open from flat: the average cost is the trade price;
 * - increase (same direction): the quantity-weighted average of the position and the trade;
 * - reduce (opposite direction, smaller): the average cost is unchanged;
 * - close (opposite direction, equal): flat, with zero average cost;
 * - cross (opposite direction, larger): the remaining position was opened by this trade, so the
 *   average cost is the trade price.
 */
export function applyTrade(position: Position, trade: Pick<Trade, 'side' | 'quantity' | 'price'>): Position {
  const current = position.netQuantity
  const signed = trade.side === 'Buy' ? trade.quantity : trade.quantity.negated()
  const next = current.plus(signed)
  if (next.abs().gte(LIMIT)) throw new PositionLimitError(position.symbol)

  let averageCost: Dec
  if (current.isZero()) {
    averageCost = trade.price
  } else if (current.isPositive() === signed.isPositive()) {
    averageCost = current.abs().times(position.averageCost).plus(trade.quantity.times(trade.price)).dividedBy(next.abs())
  } else if (next.isZero()) {
    averageCost = ZERO
  } else if (next.isPositive() !== current.isPositive()) {
    averageCost = trade.price
  } else {
    averageCost = position.averageCost
  }
  return Object.freeze({ symbol: position.symbol, netQuantity: next.isZero() ? ZERO : next, averageCost })
}

/**
 * Checks that a proposed trade keeps its symbol's position valid: the whole history, including
 * the trade, must fold without breaching the position limit at any step. The trade is placed at its
 * execution time, after every stored trade with the same execution time, because the store will
 * give it a higher booking sequence than any it holds. Trades executed after it are replayed on top
 * of it, so a trade inserted into the past is checked against everything that follows.
 *
 * Returns the resulting position (flat or not) and throws PositionLimitError otherwise.
 * `history` must hold every stored trade for the symbol; trades for other symbols are ignored.
 */
export function positionAfterTrade(history: readonly PositionTrade[], proposed: Omit<PositionTrade, 'bookingSequence'>): Position {
  const ordered = [...history.filter((trade) => trade.symbol === proposed.symbol), { ...proposed, bookingSequence: Infinity }]
    .sort(compareTradeOrder)
  return ordered.reduce(applyTrade, flatPosition(proposed.symbol))
}

/**
 * Derives every open position from the trade history. Trades apply in trade order (execution time,
 * then booking sequence) whatever order they are given in. Flat positions are omitted; the rest are
 * sorted by symbol in code-point order.
 */
export function calculatePositions(trades: readonly PositionTrade[]): Position[] {
  const positions = new Map<string, Position>()
  for (const trade of [...trades].sort(compareTradeOrder)) {
    positions.set(trade.symbol, applyTrade(positions.get(trade.symbol) ?? flatPosition(trade.symbol), trade))
  }
  return [...positions.values()]
    .filter((position) => !position.netQuantity.isZero())
    .sort((a, b) => compareSymbols(a.symbol, b.symbol))
}
