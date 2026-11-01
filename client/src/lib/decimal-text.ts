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
