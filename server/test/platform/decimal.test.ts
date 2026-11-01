import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import { Dec, decimalText, WORKING_PRECISION } from '../../src/domain/decimal.ts'
import { POSITION_SCENARIOS } from '../scenarios/positions.ts'
import { rational, roundHalfEvenSignificant } from '../support/rational.ts'

/**
 * S5: decimal.js, configured with the application's numeric policy, gives exact sums and
 * products within the input limits, rounds any result longer than the working precision (in
 * practice only a division) half to even, and always produces canonical plain-notation text.
 */
describe('platform: decimal arithmetic', () => {
  it('uses a private configuration that leaves the shared decimal.js defaults alone', () => {
    expect(Dec.precision).toBe(WORKING_PRECISION)
    expect(Dec.rounding).toBe(Decimal.ROUND_HALF_EVEN)
    expect(Decimal.precision).toBe(20)
  })

  it('adds without floating-point error', () => {
    expect(decimalText(new Dec('0.1').plus('0.2'))).toBe('0.3')
    expect(decimalText(new Dec('0.1').plus('0.2').minus('0.3'))).toBe('0')
  })

  it('multiplies the largest quantity by the largest price exactly', () => {
    const largest = '999999999999999.9999999999'

    expect(decimalText(new Dec(largest).times(largest))).toBe('999999999999999999999999800000.00000000000000000001')
  })

  it.each([
    ['trailing zeros', '10.500', '10.5'],
    ['an exponent', '1.50E+1', '15'],
    ['a small value', '1e-10', '0.0000000001'],
    ['a large value', '1e30', '1000000000000000000000000000000'],
    ['negative zero', '-0', '0'],
    ['a negative value', '-12.50', '-12.5'],
  ])('writes %s as canonical plain text', (_name, input, expected) => {
    expect(decimalText(new Dec(input))).toBe(expected)
  })

  it('rounds division half to even at the working precision', () => {
    expect(new Dec(5).div(3).toFixed()).toBe(`1.${'6'.repeat(WORKING_PRECISION - 2)}7`)
    expect(new Dec(2).div(3).precision()).toBe(WORKING_PRECISION)
  })

  it.each([
    ['a tie rounds down to even', `1.${'0'.repeat(49)}5`, '1'],
    ['a tie rounds up to even', `1.${'0'.repeat(48)}15`, `1.${'0'.repeat(48)}2`],
    ['a negative tie', `-1.${'0'.repeat(48)}25`, `-1.${'0'.repeat(48)}2`],
    ['past the tie rounds up', `1.${'0'.repeat(49)}51`, `1.${'0'.repeat(48)}1`],
  ])('rounds an operation result with more than 50 digits half to even: %s', (_name, input, expected) => {
    expect(decimalText(new Dec(input).plus(0))).toBe(expected)
    expect(roundHalfEvenSignificant(rational(input), WORKING_PRECISION)).toBe(expected)
  })

  it('divides every scenario average cost exactly as rational rounding to 50 significant digits', () => {
    for (const scenario of POSITION_SCENARIOS) {
      if (scenario.expected === 'flat') continue
      const exact = rational(scenario.expected.averageCost)
      const computed = decimalText(new Dec(exact.n.toString()).div(exact.d.toString()))

      expect(computed, scenario.symbol).toBe(roundHalfEvenSignificant(exact, WORKING_PRECISION))
    }
  })
})
