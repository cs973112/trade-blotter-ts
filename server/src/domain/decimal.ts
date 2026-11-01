import { Decimal } from 'decimal.js'

/**
 * The numeric policy for every quantity, price, notional and average cost. No value in these
 * calculations is ever a JavaScript number. docs/architecture.md ("Numeric policy") explains
 * how the limits below make every result exact except the average cost, which involves division
 * and is the only value ever rounded.
 */

/** Significant digits kept by every operation. Enough for a maximum-size notional to be exact. */
export const WORKING_PRECISION = 50

/** Quantities and prices are below 10^15 ... */
export const MAX_INTEGER_DIGITS = 15

/** ... with at most ten decimal places (after trailing zeros are removed). */
export const MAX_DECIMAL_PLACES = 10

/**
 * A net quantity at or beyond this magnitude is a position limit breach. Unreachable with valid
 * trades in practice: it takes 10^15 maximum-size trades on one symbol.
 */
export const NET_QUANTITY_LIMIT = '1e30'

/**
 * The application's decimal type: decimal.js configured with the policy above. A private clone,
 * so no other code that uses decimal.js can change these settings.
 */
export const Dec = Decimal.clone({
  precision: WORKING_PRECISION,
  rounding: Decimal.ROUND_HALF_EVEN,
  // Never switch to exponential notation in toString().
  toExpNeg: -9e15,
  toExpPos: 9e15,
})

export type Dec = Decimal

/** Canonical text: plain notation, no trailing zeros, and never "-0". The form stored and sent. */
export function decimalText(value: Dec): string {
  return value.isZero() ? '0' : value.toFixed()
}

/**
 * JSON number grammar (RFC 8259): the only text accepted as a decimal input, whether it arrives
 * as a JSON number or as a string. No spaces, plus signs, separators or leading zeros.
 */
export const DECIMAL_TEXT_PATTERN = '^-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$'

const DECIMAL_TEXT = new RegExp(DECIMAL_TEXT_PATTERN)
const INPUT_LIMIT = new Dec(10).pow(MAX_INTEGER_DIGITS)

/** Why a quantity or price input was refused. */
export type DecimalInputProblem = 'missing' | 'not-a-number' | 'not-positive' | 'out-of-range'

export type DecimalInputResult =
  | { readonly ok: true; readonly value: Dec }
  | { readonly ok: false; readonly problem: DecimalInputProblem }

/**
 * Reads a quantity or price: decimal text in JSON number grammar, greater than zero, below
 * 10^MAX_INTEGER_DIGITS and with at most MAX_DECIMAL_PLACES decimal places. The value is exact;
 * the constructor never rounds. A JavaScript number is refused, because it may already have lost
 * digits.
 */
export function parseDecimalInput(input: unknown): DecimalInputResult {
  if (input === undefined || input === null) return { ok: false, problem: 'missing' }
  if (typeof input !== 'string' || !DECIMAL_TEXT.test(input)) return { ok: false, problem: 'not-a-number' }

  const value = new Dec(input)
  // An exponent beyond decimal.js's range parses as Infinity, or as zero when it is negative.
  const mantissaIsZero = !/[1-9]/.test(input.split(/[eE]/)[0] ?? '')
  if (value.isNegative() || mantissaIsZero) return { ok: false, problem: 'not-positive' }
  if (!value.isFinite() || value.isZero() || value.gte(INPUT_LIMIT) || value.decimalPlaces() > MAX_DECIMAL_PLACES) {
    return { ok: false, problem: 'out-of-range' }
  }
  return { ok: true, value }
}
