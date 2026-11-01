/** The default maximum symbol length, in characters (code points), after normalisation. */
export const DEFAULT_SYMBOL_MAX_LENGTH = 64

/** The range a configured maximum symbol length must fall in. */
export const SYMBOL_MAX_LENGTH_RANGE = { min: 1, max: 255 } as const

/**
 * Characters that are invisible or control layout rather than represent text: controls (Cc),
 * format characters such as a zero-width space (Cf), unpaired surrogates (Cs), and line and
 * paragraph separators (Zl, Zp). Any of them would let two symbols that look the same be different
 * positions.
 */
const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export type SymbolProblem = 'required' | 'too-long' | 'invisible'

export type SymbolResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: SymbolProblem }

/**
 * Normalises a symbol: trims surrounding whitespace, composes to Unicode NFC and upper-cases
 * without a locale, so `brk.b` and ` BRK.B ` are the same symbol. Then requires at least one
 * character, at most `maxLength` code points, and no control or invisible characters. Every other
 * character, including punctuation and non-Latin scripts, is allowed.
 */
export function normaliseSymbol(raw: string, maxLength: number): SymbolResult {
  const symbol = raw.trim().normalize('NFC').toUpperCase()
  if (CONTROL_OR_INVISIBLE.test(symbol)) return { ok: false, problem: 'invisible' }
  if (symbol === '') return { ok: false, problem: 'required' }
  // Code points, not UTF-16 units: a character outside the Basic Multilingual Plane counts once.
  if (Array.from(symbol).length > maxLength) return { ok: false, problem: 'too-long' }
  return { ok: true, value: symbol }
}

/** Orders symbols by Unicode code point, independent of locale. */
export function compareSymbols(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}
