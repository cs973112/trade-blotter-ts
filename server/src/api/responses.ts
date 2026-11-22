import type { AuditTrail, Cancellation, TradePage } from '../application/trade-service.ts'
import type { AuditSnapshot } from '../application/ports.ts'
import { decimalText, type Dec } from '../domain/decimal.ts'
import type { StatusPosition } from '../domain/position-summary.ts'
import type { LifecycleTrade, ListedTrade } from '../domain/trade-status.ts'
import { notional } from '../domain/trade.ts'
import { rawJsonNumber } from './json.ts'

/** A decimal as an exact JSON number in canonical form. */
const exact = (value: Dec): JsonRawNumber => rawJsonNumber(decimalText(value))

/**
 * The JSON shape of a trade (schema: Trade): a listed logical trade, or (in a cancellation's
 * response) the physical cancellation row, which names its original and carries the reason.
 */
export function toTradeResponse(trade: ListedTrade | (LifecycleTrade & { readonly cancellation?: undefined })) {
  return {
    id: trade.id,
    bookingSequence: trade.bookingSequence,
    symbol: trade.symbol,
    side: trade.side,
    quantity: exact(trade.quantity),
    price: exact(trade.price),
    notional: exact(notional(trade)),
    status: trade.status,
    executedAt: trade.executedAt,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
    createdBy: trade.createdBy,
    updatedBy: trade.updatedBy,
    originalTradeId: trade.originalTradeId,
    cancellationReason: trade.cancellation?.reason ?? trade.cancellationReason,
    cancellationTradeId: trade.cancellation?.id ?? null,
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

/** The JSON shape of a cancellation (schema: Cancellation). */
export function toCancellationResponse(cancellation: Cancellation) {
  return { trade: toTradeResponse(cancellation.trade), cancellationRecord: toTradeResponse(cancellation.cancellationRecord) }
}

/**
 * The JSON shape of a position (schema: Position). netQuantity is the Executed Net, as it has
 * always been; the three nets by status are given beside it.
 */
export function toPositionResponse(position: StatusPosition) {
  return {
    symbol: position.symbol,
    netQuantity: exact(position.executedNet),
    averageCost: exact(position.averageCost),
    executedNetQuantity: exact(position.executedNet),
    pendingNetQuantity: exact(position.pendingNet),
    projectedNetQuantity: exact(position.projectedNet),
  }
}

/** A snapshot as it was stored, the decimals as exact JSON numbers (schema: AuditTradeSnapshot). */
function toSnapshotResponse(snapshot: AuditSnapshot) {
  return { ...snapshot, quantity: rawJsonNumber(snapshot.quantity), price: rawJsonNumber(snapshot.price) }
}

/** The JSON shape of a page of a trade's audit trail (schema: AuditPage). */
export function toAuditPageResponse(trail: AuditTrail) {
  return {
    tradeId: trail.tradeId,
    scope: trail.scope,
    tradeIds: trail.tradeIds,
    items: trail.entries.map((entry) => ({
      auditId: entry.auditId, auditAction: entry.auditAction, auditOn: entry.auditOn, auditBy: entry.auditBy, trade: toSnapshotResponse(entry.trade),
    })),
    page: trail.page,
    pageSize: trail.pageSize,
    totalCount: trail.totalCount,
    totalPages: trail.totalPages,
  }
}