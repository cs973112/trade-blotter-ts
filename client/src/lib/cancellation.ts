import type { Trade } from '../api/contracts.ts'
import { formatDecimal, formatMoney } from './decimal-text.ts'

/**
 * The cancellation reason as the API checks it (validateCancellationReason on the server): required,
 * trimmed, at most 500 characters (code points, after NFC), and no control or invisible characters.
 * Checked here only so an obvious mistake is caught before sending; the server decides.
 */
export const REASON_MAX_LENGTH = 500

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export type ReasonCheck = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }

/** Characters in a reason as the API counts them: code points of the trimmed, NFC text. */
export function reasonLength(raw: string): number {
  return Array.from(raw.trim().normalize('NFC')).length
}

export function checkReason(raw: string): ReasonCheck {
  const value = raw.trim().normalize('NFC')
  if (value === '') return { ok: false, message: 'Enter a reason for the cancellation.' }
  if (CONTROL.test(value)) return { ok: false, message: 'The reason cannot contain control or invisible characters, such as a line break or a tab.' }
  if (Array.from(value).length > REASON_MAX_LENGTH) return { ok: false, message: `The reason can be at most ${String(REASON_MAX_LENGTH)} characters.` }
  return { ok: true, value }
}

/** Whether a trade can be cancelled: only a Pending one. Executed and Cancelled trades never offer it. */
export function isCancellable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {
  return trade.status === 'Pending' && trade.originalTradeId === null
}

/** Whether a trade can be executed: only a Pending one, as for cancelling. Executed and Cancelled are final. */
export function isExecutable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {
  return trade.status === 'Pending' && trade.originalTradeId === null
}

/** "Buy 100 MSFT at 301.25": a trade in words, the price to 2 places, as the grids show it. */
export function describeTrade(trade: Pick<Trade, 'side' | 'quantity' | 'symbol' | 'price'>): string {
  return `${trade.side} ${formatDecimal(trade.quantity)} ${trade.symbol} at ${formatMoney(trade.price).shown}`
}
