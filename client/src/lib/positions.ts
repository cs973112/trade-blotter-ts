import type { Position } from '../api/contracts.ts'

export type Direction = 'Long' | 'Short' | 'Flat'

/**
 * The direction of a position's Executed net: Pending trades never change it, so a symbol listed
 * only for its Pending trades is Flat. Read from the exact text, never through a number.
 */
export function positionDirection(position: Pick<Position, 'executedNetQuantity'>): Direction {
  const net = position.executedNetQuantity
  if (net.startsWith('-')) return 'Short'
  return /^0(?:\.0+)?$/.test(net) ? 'Flat' : 'Long'
}
