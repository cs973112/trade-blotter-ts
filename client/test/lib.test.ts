import { describe, expect, it } from 'vitest'

import { parseJsonKeepingNumberText } from '../src/api/json.ts'
import { checkDecimalInput, formatDecimal } from '../src/lib/decimal-text.ts'

describe('reading JSON with exact numbers', () => {
  it('keeps every digit of every number as text', () => {
    const text = '{"averageCost":1.6666666666666666666666666666666666666666666666667,"netQuantity":-0.1,' +
      '"big":999999999999999999999999800000.00000000000000000001,"n":[1,2e3,-0]}'

    expect(parseJsonKeepingNumberText(text)).toEqual({
      averageCost: '1.6666666666666666666666666666666666666666666666667',
      netQuantity: '-0.1',
      big: '999999999999999999999999800000.00000000000000000001',
      n: ['1', '2e3', '-0'],
    })
  })

  it('leaves strings alone, including digits and escaped quotes inside them', () => {
    expect(parseJsonKeepingNumberText('{"symbol":"A \\"1.5\\" -2","t":"2026-01-01T09:00:00.000Z","ok":true,"none":null}'))
      .toEqual({ symbol: 'A "1.5" -2', t: '2026-01-01T09:00:00.000Z', ok: true, none: null })
  })

  it('rejects malformed JSON', () => {
    expect(() => parseJsonKeepingNumberText('{"a":')).toThrow(SyntaxError)
  })
})

describe('decimal text', () => {
  it.each([
    ['100', '100'],
    [' 10.50 ', '10.50'],
    ['0.0000000001', '0.0000000001'],
    ['123456789012345.1234567891', '123456789012345.1234567891'],
  ])('accepts %j and sends exactly %j', (raw, text) => {
    expect(checkDecimalInput(raw)).toEqual({ ok: true, text })
  })

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['1,000', 'format'],
    ['1 000', 'format'],
    ['-5', 'format'],
    ['+5', 'format'],
    ['1e3', 'format'],
    ['01', 'format'],
    ['.5', 'format'],
    ['5.', 'format'],
    ['abc', 'format'],
    ['0', 'zero'],
    ['0.000', 'zero'],
  ])('refuses %j as %s', (raw, problem) => {
    expect(checkDecimalInput(raw)).toEqual({ ok: false, problem })
  })

  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['-1234567.890123', '-1,234,567.890123'],
    ['999999999999999999999999800000.00000000000000000001', '999,999,999,999,999,999,999,999,800,000.00000000000000000001'],
    ['1.6666666666666666666666666666666666666666666666667', '1.6666666666666666666666666666666666666666666666667'],
  ])('formats %s as %s, keeping every fractional digit', (text, formatted) => {
    expect(formatDecimal(text)).toBe(formatted)
  })
})
