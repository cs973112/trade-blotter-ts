import type { TradePage } from '../application/trade-service.ts'
import { decimalText, type Dec } from '../domain/decimal.ts'
import type { Position } from '../domain/position.ts'
import { notional, type Trade } from '../domain/trade.ts'
import { rawJsonNumber } from './json.ts'

/** A decimal as an exact JSON number in canonical form. */
const exact = (value: Dec): JsonRawNumber => rawJsonNumber(decimalText(value))

/** The JSON shape of a trade (schema: Trade). */
export function toTradeResponse(trade: Trade) {
  return {
    id: trade.id,
    bookingSequence: trade.bookingSequence,
    symbol: trade.symbol,
    side: trade.side,
    quantity: exact(trade.quantity),
    price: exact(trade.price),
    notional: exact(notional(trade)),
    executedAt: trade.executedAt,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
  }
}

/** The JSON shape of a page of trades (schema: TradePage). */
export function toTradePageResponse(page: TradePage) {
  return {
    items: page.trades.map(toTradeResponse),
    page: page.page,
    pageSize: page.pageSize,
    totalCount: page.totalCount,
    totalPages: page.totalPages,
  }
}

/** The JSON shape of a position (schema: Position). */
export function toPositionResponse(position: Position) {
  return {
    symbol: position.symbol,
    netQuantity: exact(position.netQuantity),
    averageCost: exact(position.averageCost),
  }
}
