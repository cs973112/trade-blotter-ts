import { describe, expect, it } from 'vitest'

import { decimalText, parseDecimalInput, type DecimalInputProblem } from '../../src/domain/decimal.ts'

describe('domain: decimal input', () => {
  it.each([
    ['1', '1'],
    ['10.500', '10.5'],
    ['1e2', '100'],
    ['1.50E+1', '15'],
    ['25e-1', '2.5'],
    ['1.000000000000000', '1'],
    ['0.0000000001', '0.0000000001'],
    ['999999999999999.9999999999', '999999999999999.9999999999'],
    ['123456789012345.1234567891', '123456789012345.1234567891'],
  ])('accepts %s exactly as %s', (input, canonical) => {
    const result = parseDecimalInput(input)

    expect(result.ok && decimalText(result.value)).toBe(canonical)
  })

  it.each<[string, unknown, DecimalInputProblem]>([
    ['undefined', undefined, 'missing'],
    ['null', null, 'missing'],
    ['a JavaScript number, which may already have lost digits', 1, 'not-a-number'],
    ['a boolean', true, 'not-a-number'],
    ['an object', {}, 'not-a-number'],
    ['an empty string', '', 'not-a-number'],
    ['letters', 'abc', 'not-a-number'],
    ['surrounding spaces', ' 10 ', 'not-a-number'],
    ['a plus sign', '+10', 'not-a-number'],
    ['a thousands separator', '1,000', 'not-a-number'],
    ['a leading zero', '01', 'not-a-number'],
    ['a bare decimal point', '1.', 'not-a-number'],
    ['Infinity', 'Infinity', 'not-a-number'],
    ['NaN', 'NaN', 'not-a-number'],
    ['hexadecimal', '0x10', 'not-a-number'],
    ['zero', '0', 'not-positive'],
    ['zero with decimal places', '0.000', 'not-positive'],
    ['negative zero', '-0', 'not-positive'],
    ['a negative value', '-1', 'not-positive'],
    ['zero with an exponent', '0e5', 'not-positive'],
    ['10^15', '1000000000000000', 'out-of-range'],
    ['10^15 as an exponent', '1e15', 'out-of-range'],
    ['eleven decimal places', '0.00000000001', 'out-of-range'],
    ['a huge exponent', '1e400', 'out-of-range'],
    ['a tiny exponent', '1e-400', 'out-of-range'],
    ['an exponent beyond decimal.js range', '1e99999999999999999999', 'out-of-range'],
    ['a negative exponent beyond decimal.js range', '1e-99999999999999999999', 'out-of-range'],
  ])('refuses %s', (_name, input, problem) => {
    expect(parseDecimalInput(input)).toEqual({ ok: false, problem })
  })
})
