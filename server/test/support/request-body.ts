import { parseJsonPreservingDecimals } from '../../src/api/json.ts'
import type { TradeRequest } from '../../src/domain/trade.ts'

const DECIMAL_FIELDS = new Set(['quantity', 'price'])

/**
 * Reads a scenario's raw JSON body the way the API will: decimals as exact source text. Returns
 * undefined for a body that is not a JSON object, which the API rejects before any service runs.
 */
export function parseTradeRequestBody(text: string): TradeRequest | undefined {
  let parsed: unknown
  try {
    parsed = parseJsonPreservingDecimals(text, DECIMAL_FIELDS)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
}
