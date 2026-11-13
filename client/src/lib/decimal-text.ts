/**
 * Decimal values are text from input to display: never a JavaScript number, so no digit is lost
 * or invented. The server owns the rules (range, decimal places); these helpers only check that
 * what the user typed is a plain positive number, and format text for reading.
 */

/** A plain decimal as the API accepts it: no sign, exponent, separators or leading zeros. */
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$/

export type DecimalInputProblem = 'required' | 'format' | 'zero'

/** Checks typed quantity or price text. Returns the trimmed text to send, or why it cannot be sent. */
export function checkDecimalInput(raw: string): { ok: true; text: string } | { ok: false; problem: DecimalInputProblem } {
  const text = raw.trim()
  if (text === '') return { ok: false, problem: 'required' }
  if (!PLAIN_DECIMAL.test(text)) return { ok: false, problem: 'format' }
  if (!/[1-9]/.test(text)) return { ok: false, problem: 'zero' }
  return { ok: true, text }
}

/**
 * Groups the integer digits in threes for reading and keeps every fractional digit:
 * "-1234567.890123" becomes "-1,234,567.890123". Text in, text out.
 */
export function formatDecimal(text: string): string {
  const negative = text.startsWith('-')
  const [integer = '', fraction] = (negative ? text.slice(1) : text).split('.')
  const grouped = integer.replace(/\B(?=([0-9]{3})+$)/g, ',')
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

/** Decimal text as the API sends it: an optional minus, digits, and optionally a point and digits. */
const DECIMAL_TEXT = /^-?[0-9]+(?:[.][0-9]+)?$/

/** Adds one to a string of decimal digits, carrying: "0999" becomes "1000", "99" becomes "100". */
function incrementDigits(digits: string): string {
  const out = digits.split('')
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index] !== '9') {
      out[index] = String.fromCharCode((out[index] ?? '0').charCodeAt(0) + 1)
      return out.join('')
    }
    out[index] = '0'
  }
  return `1${out.join('')}`
}

/**
 * Decimal text rounded to `places` decimal places for display, half to even (the server's rounding
 * mode), padded with zeros, and grouped as formatDecimal groups it: "90.125" becomes "90.12",
 * "90.135" becomes "90.14", "1234567.5" becomes "1,234,567.50". Text in, text out: the digits are
 * rounded as digits, never through a JavaScript number, so any length and precision is exact. A
 * value that rounds to zero is shown as zero, without a minus sign. Only for display; the value
 * itself is left as it was. Throws RangeError for text that is not a decimal.
 */
export function formatDecimalPlaces(text: string, places = 2): string {
  if (!DECIMAL_TEXT.test(text)) throw new RangeError(`Not decimal text: ${JSON.stringify(text)}`)
  if (!Number.isSafeInteger(places) || places < 0) throw new RangeError(`Decimal places must be a whole number from 0, got ${String(places)}`)
  const negative = text.startsWith('-')
  const [integer = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.')
  let digits = `${integer}${fraction.slice(0, places).padEnd(places, '0')}`
  const dropped = fraction.slice(places)
  // Half to even: up when the dropped part is over a half, or exactly a half after an odd digit.
  const first = dropped.charAt(0)
  const overHalf = first > '5' || (first === '5' && /[1-9]/.test(dropped.slice(1)))
  const exactlyHalf = first === '5' && !overHalf
  const lastKeptIsOdd = '13579'.includes(digits.charAt(digits.length - 1))
  if (overHalf || (exactlyHalf && lastKeptIsOdd)) digits = incrementDigits(digits)

  const whole = digits.slice(0, digits.length - places).replace(/^0+(?=[0-9])/, '')
  const shown = `${whole}${places > 0 ? `.${digits.slice(digits.length - places)}` : ''}`
  const zero = !/[1-9]/.test(digits)
  return formatDecimal(`${negative && !zero ? '-' : ''}${shown}`)
}

/** Decimal places for money on screen: prices, notionals and average costs. Quantities keep every digit. */
export const MONEY_PLACES = 2

/** Whether showing decimal text to `places` places hides any digit: a non-zero digit after them. */
export function hidesDigits(text: string, places = MONEY_PLACES): boolean {
  const fraction = text.split('.')[1] ?? ''
  return /[1-9]/.test(fraction.slice(places))
}

/**
 * Money for display: two decimal places, half to even (formatDecimalPlaces), and the exact value
 * grouped for reading, with whether the two differ, so the page can offer the exact value.
 */
export function formatMoney(text: string): { readonly shown: string; readonly exact: string; readonly rounded: boolean } {
  return { shown: formatDecimalPlaces(text, MONEY_PLACES), exact: formatDecimal(text), rounded: hidesDigits(text, MONEY_PLACES) }
}
