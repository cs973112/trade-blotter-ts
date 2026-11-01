import { Dec } from '../../src/domain/decimal.ts'
import { parseTimestamp, type UtcTimestamp } from '../../src/domain/timestamp.ts'
import type { NewTrade, TradeSide } from '../../src/domain/trade.ts'

export function utc(text: string): UtcTimestamp {
  const timestamp = parseTimestamp(text)
  if (timestamp === undefined) throw new Error(`Not a timestamp: ${text}`)
  return timestamp
}

let count = 0

/** A valid new trade (Buy 1 ABC at 1, executed and recorded at 2026-01-01 09:00 UTC) with overrides. */
export function newTrade(overrides: {
  readonly id?: string
  readonly symbol?: string
  readonly side?: TradeSide
  readonly quantity?: string
  readonly price?: string
  readonly executedAt?: string
  readonly createdAt?: string
  readonly updatedAt?: string
} = {}): NewTrade {
  const createdAt = utc(overrides.createdAt ?? '2026-01-01T09:00:00.000Z')
  return {
    id: overrides.id ?? `trade-${String(++count)}`,
    symbol: overrides.symbol ?? 'ABC',
    side: overrides.side ?? 'Buy',
    quantity: new Dec(overrides.quantity ?? '1'),
    price: new Dec(overrides.price ?? '1'),
    executedAt: utc(overrides.executedAt ?? '2026-01-01T09:00:00.000Z'),
    createdAt,
    updatedAt: overrides.updatedAt === undefined ? createdAt : utc(overrides.updatedAt),
  }
}
