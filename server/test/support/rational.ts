/**
 * Exact rational numbers over BigInt. A test oracle, deliberately independent of decimal.js, so
 * scenario expectations are checked by different code from the code under test.
 */
export interface Rational {
  readonly n: bigint
  readonly d: bigint
}

const ZERO: Rational = { n: 0n, d: 1n }

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

function make(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new RangeError('Division by zero.')
  const sign = d < 0n ? -1n : 1n
  const divisor = gcd(n, d)
  return { n: (sign * n) / divisor, d: (sign * d) / divisor }
}

/** Parses "a/b" or a JSON-number-like decimal such as "-12.5", "1e-3" or "1.50E+1". */
export function rational(text: string): Rational {
  const fraction = /^(-?\d+)\/(\d+)$/.exec(text)
  if (fraction?.[1] !== undefined && fraction[2] !== undefined) return make(BigInt(fraction[1]), BigInt(fraction[2]))

  const decimal = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (decimal?.[2] === undefined) throw new SyntaxError(`Not a rational: "${text}".`)
  const [, sign = '', integer, fractionDigits = '', exponentText = '0'] = decimal
  const exponent = Number(exponentText) - fractionDigits.length
  const digits = BigInt(`${sign}${integer}${fractionDigits}`)
  return exponent >= 0 ? make(digits * 10n ** BigInt(exponent), 1n) : make(digits, 10n ** BigInt(-exponent))
}

export const add = (a: Rational, b: Rational): Rational => make(a.n * b.d + b.n * a.d, a.d * b.d)
export const sub = (a: Rational, b: Rational): Rational => make(a.n * b.d - b.n * a.d, a.d * b.d)
export const mul = (a: Rational, b: Rational): Rational => make(a.n * b.n, a.d * b.d)
export const div = (a: Rational, b: Rational): Rational => make(a.n * b.d, a.d * b.n)
export const neg = (a: Rational): Rational => make(-a.n, a.d)
export const abs = (a: Rational): Rational => (a.n < 0n ? neg(a) : a)
export const sign = (a: Rational): -1 | 0 | 1 => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0)
export const compare = (a: Rational, b: Rational): -1 | 0 | 1 => sign(sub(a, b))
export const equals = (a: Rational, b: Rational): boolean => a.n === b.n && a.d === b.d
export { ZERO }

/** Rounds half to even at the given number of decimal places; canonical text, no trailing zeros. */
export function roundHalfEven(value: Rational, places: number): string {
  const scale = 10n ** BigInt(places)
  const scaled = value.n * scale
  let quotient = scaled / value.d
  const remainder = (scaled % value.d) * 2n
  const magnitude = remainder < 0n ? -remainder : remainder
  const direction = scaled < 0n ? -1n : 1n
  if (magnitude > value.d || (magnitude === value.d && quotient % 2n !== 0n)) quotient += direction
  return canonicalText(make(quotient, scale))
}

/** Rounds half to even to the given number of significant digits; canonical text. */
export function roundHalfEvenSignificant(value: Rational, digits: number): string {
  if (value.n === 0n) return '0'
  const magnitude = abs(value)
  // exponent = floor(log10(|value|)), from the digit counts and one correction step.
  let exponent = magnitude.n.toString().length - magnitude.d.toString().length
  const power = (e: number): Rational => (e >= 0 ? make(10n ** BigInt(e), 1n) : make(1n, 10n ** BigInt(-e)))
  if (compare(magnitude, power(exponent)) < 0) exponent--
  const places = digits - 1 - exponent
  if (places < 0) throw new RangeError('Rounding left of the decimal point is not supported.')
  return roundHalfEven(value, places)
}

/** Exact canonical decimal text of a rational whose denominator divides a power of ten. */
export function canonicalText(value: Rational): string {
  let places = 0
  let scale = 1n
  while (scale % value.d !== 0n) {
    scale *= 10n
    places++
    if (places > 1000) throw new RangeError('Not a terminating decimal.')
  }
  const scaled = value.n * (scale / value.d)
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0')
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`
  return negative ? `-${text}` : text
}

/** True when the value has a finite decimal expansion: its reduced denominator has no prime factor but 2 and 5. */
export function isTerminating(value: Rational): boolean {
  let d = value.d
  for (const factor of [2n, 5n]) while (d % factor === 0n) d /= factor
  return d === 1n
}
