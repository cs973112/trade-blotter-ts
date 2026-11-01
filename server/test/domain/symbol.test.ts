import { describe, expect, it } from 'vitest'

import { compareSymbols, DEFAULT_SYMBOL_MAX_LENGTH, normaliseSymbol, type SymbolProblem } from '../../src/domain/symbol.ts'

const char = (codePoint: number): string => String.fromCodePoint(codePoint)

describe('domain: symbols', () => {
  it.each([
    ['trims and upper-cases', ' brk.b ', 'BRK.B'],
    ['trims tabs and line breaks', '\t msft \r\n', 'MSFT'],
    ['trims no-break spaces', `${char(0xa0)}nbsp${char(0xa0)}`, 'NBSP'],
    ['trims a byte-order mark', `${char(0xfeff)}bom`, 'BOM'],
    ['keeps an inner space', 'brk b', 'BRK B'],
    ['composes a decomposed accent', `cafe${char(0x301)}`, `CAF${char(0xc9)}`],
    ['upper-cases sharp s to SS', 'straße', 'STRASSE'],
    ['upper-cases dotless i without a locale', 'ıbm', 'IBM'],
    ['keeps punctuation', '^gspc', '^GSPC'],
    ['keeps currency signs', 'a$', 'A$'],
    ['keeps slashes and hyphens', 'eur/usd-1', 'EUR/USD-1'],
    ['keeps non-Latin scripts', '株式', '株式'],
    ['keeps characters outside the Basic Multilingual Plane', `x${char(0x1d400)}`, `X${char(0x1d400)}`],
  ])('%s', (_name, input, expected) => {
    expect(normaliseSymbol(input, DEFAULT_SYMBOL_MAX_LENGTH)).toEqual({ ok: true, value: expected })
  })

  it.each<[string, string, SymbolProblem]>([
    ['empty', '', 'required'],
    ['only spaces', '   ', 'required'],
    ['only a zero-width space', char(0x200b), 'invisible'],
    ['an inner zero-width space', `ab${char(0x200b)}c`, 'invisible'],
    ['a zero-width joiner', `a${char(0x200d)}b`, 'invisible'],
    ['a right-to-left mark', `a${char(0x200f)}b`, 'invisible'],
    ['a soft hyphen', `a${char(0xad)}b`, 'invisible'],
    ['a next-line control', `${char(0x85)}nel`, 'invisible'],
    ['an inner tab', 'a\tb', 'invisible'],
    ['a null character', `a${char(0)}`, 'invisible'],
    ['an inner line separator', `a${char(0x2028)}b`, 'invisible'],
    ['an unpaired surrogate', `a${String.fromCharCode(0xd800)}`, 'invisible'],
  ])('refuses %s', (_name, input, problem) => {
    expect(normaliseSymbol(input, DEFAULT_SYMBOL_MAX_LENGTH)).toEqual({ ok: false, problem })
  })

  it('allows exactly the maximum length, counted in code points after normalisation', () => {
    expect(normaliseSymbol('L'.repeat(64), 64).ok).toBe(true)
    expect(normaliseSymbol('L'.repeat(65), 64)).toEqual({ ok: false, problem: 'too-long' })
    expect(normaliseSymbol('ß'.repeat(33), 64)).toEqual({ ok: false, problem: 'too-long' })
    expect(normaliseSymbol(char(0x1d400).repeat(64), 64).ok).toBe(true)
  })

  it('applies a configured maximum length', () => {
    expect(normaliseSymbol('ABCDEFGH', 8).ok).toBe(true)
    expect(normaliseSymbol('ABCDEFGHI', 8)).toEqual({ ok: false, problem: 'too-long' })
  })

  it('orders symbols by code point, not UTF-16 unit or locale', () => {
    const symbols = ['b', 'a', 'B', 'A', 'ä', char(0xff21), char(0x1d400), 'AB']

    expect([...symbols].sort(compareSymbols)).toEqual(['A', 'AB', 'B', 'a', 'b', 'ä', char(0xff21), char(0x1d400)])
  })
})
