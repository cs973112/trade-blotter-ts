import { Dec, NET_QUANTITY_LIMIT } from './decimal.ts'
import { applyTrade, flatPosition, positionAfterTrade, positionWithTrade, PositionLimitError, type Position, type PositionTrade } from './position.ts'
import { compareSymbols } from './symbol.ts'
import { compareTradeOrder } from './trade.ts'
import type { LifecycleTrade } from './trade-status.ts'

/**
 * Positions by status (M2, domain only: not yet served or shown). For each symbol:
 *
 * - executedNet: the net quantity of its Executed trades, applied in trade order (execution time,
 *   then booking sequence), as calculatePositions (position.ts) applies every trade today;
 * - pendingNet: the signed sum of its Pending trades (a Buy adds, a Sell subtracts). Pending
 *   trades have no execution time, so they are not ordered: a sum needs no order;
 * - projectedNet: executedNet + pendingNet, the position if every Pending trade executed;
 * - averageCost: from the Executed trades only, by calculatePositions' rules, so a Pending trade
 *   never changes it; zero when executedNet is zero.
 *
 * Cancelled rows count for nothing: a cancelled original, and every cancellation row (a row with
 * an originalTradeId, whatever its status). A symbol is listed while executedNet or pendingNet is
 * not zero, so a symbol with only Pending trades is listed.
 */

export interface StatusPosition {
  readonly symbol: string
  readonly executedNet: Dec
  readonly pendingNet: Dec
  readonly projectedNet: Dec
  readonly averageCost: Dec
}

/** What a row contributes to positions. */
export type StatusPositionTrade = Pick<LifecycleTrade, 'symbol' | 'side' | 'quantity' | 'price' | 'status' | 'executedAt' | 'bookingSequence' | 'originalTradeId'>

const ZERO = new Dec(0)
const LIMIT = new Dec(NET_QUANTITY_LIMIT)
const signed = (trade: Pick<PositionTrade, 'side' | 'quantity'>): Dec => trade.side === 'Buy' ? trade.quantity : trade.quantity.negated()
/** Never negative zero. */
const plain = (value: Dec): Dec => value.isZero() ? ZERO : value

/** The rows that are Executed trades, as the position rules take them. A cancellation row never is one. */
function executedTrades(trades: readonly StatusPositionTrade[]): PositionTrade[] {
  return trades.flatMap((trade) => trade.status === 'Executed' && trade.originalTradeId === null && trade.executedAt !== null
    ? [{ symbol: trade.symbol, side: trade.side, quantity: trade.quantity, price: trade.price, executedAt: trade.executedAt, bookingSequence: trade.bookingSequence }]
    : [])
}

/** Every listed position, sorted by symbol in code-point order, whatever order the rows arrive in. */
export function calculateStatusPositions(trades: readonly StatusPositionTrade[]): StatusPosition[] {
  const executed = new Map<string, Position>()
  for (const trade of executedTrades(trades).sort(compareTradeOrder)) {
    executed.set(trade.symbol, applyTrade(executed.get(trade.symbol) ?? flatPosition(trade.symbol), trade))
  }
  const pending = new Map<string, Dec>()
  for (const trade of trades) {
    if (trade.status === 'Pending' && trade.originalTradeId === null) pending.set(trade.symbol, (pending.get(trade.symbol) ?? ZERO).plus(signed(trade)))
  }
  return [...new Set([...executed.keys(), ...pending.keys()])]
    .map((symbol): StatusPosition => {
      const position = executed.get(symbol) ?? flatPosition(symbol)
      const pendingNet = plain(pending.get(symbol) ?? ZERO)
      return Object.freeze({
        symbol, executedNet: position.netQuantity, pendingNet, projectedNet: plain(position.netQuantity.plus(pendingNet)), averageCost: position.averageCost,
      })
    })
    .filter((position) => !position.executedNet.isZero() || !position.pendingNet.isZero())
    .sort((a, b) => compareSymbols(a.symbol, b.symbol))
}

/**
 * The position-limit rules (approved for M3):
 *
 * - An Executed booking: the existing rule, unchanged. It is checked against the symbol's Executed
 *   history at every intermediate step in trade order (positionAfterTrade). Pending, Cancelled and
 *   cancellation rows are not part of that history.
 * - A Pending booking: checked against the final projected position only, Executed Net plus Pending
 *   Net with the proposal included. Pending trades have no execution time, so no intermediate steps
 *   are invented for them. The boundary is the existing one: refused when the absolute value reaches
 *   NET_QUANTITY_LIMIT, long or short.
 * - A cancellation is never checked: it may leave the projected position beyond the limit, when it
 *   removes a Pending trade that offset others.
 * - An execution (M7): the Executed rule, as for an Executed booking before M7. The trade joins the
 *   symbol's Executed history at its execution time and booking sequence, and every intermediate
 *   step must stay within the limit. The projected position does not change (the trade moves from
 *   Pending to Executed), so it is not checked again.
 *
 * Each throws PositionLimitError, and returns the symbol's position with the proposal otherwise.
 */
export function executedPositionAfterTrade(history: readonly StatusPositionTrade[], proposed: Omit<PositionTrade, 'bookingSequence'>): Position {
  return positionAfterTrade(executedTrades(history), proposed)
}

/** The symbol's Executed position once `trade`, a stored Pending trade, executes at `executedAt`. */
export function executedPositionAfterExecution(history: readonly StatusPositionTrade[], trade: Pick<PositionTrade, 'symbol' | 'side' | 'quantity' | 'price' | 'executedAt' | 'bookingSequence'>): Position {
  return positionWithTrade(executedTrades(history).filter((stored) => stored.bookingSequence !== trade.bookingSequence), trade)
}

export function pendingPositionAfterTrade(history: readonly StatusPositionTrade[], proposed: Pick<PositionTrade, 'symbol' | 'side' | 'quantity'>): StatusPosition {
  const own = history.filter((trade) => trade.symbol === proposed.symbol)
  const before = calculateStatusPositions(own)[0]
  const executedNet = before?.executedNet ?? ZERO
  const pendingNet = plain((before?.pendingNet ?? ZERO).plus(signed(proposed)))
  const projectedNet = plain(executedNet.plus(pendingNet))
  if (projectedNet.abs().gte(LIMIT)) throw new PositionLimitError(proposed.symbol)
  return Object.freeze({ symbol: proposed.symbol, executedNet, pendingNet, projectedNet, averageCost: before?.averageCost ?? ZERO })
}