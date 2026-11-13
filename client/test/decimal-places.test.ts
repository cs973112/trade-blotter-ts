import { describe, expect, it } from 'vitest'

import { formatDecimal, formatDecimalPlaces, formatMoney, hidesDigits, MONEY_PLACES } from '../src/lib/decimal-text.ts'

/**
 * Two-decimal display of Price, Average Cost and Notional: round half to even, as the server's
 * decimals do, on the text itself. The expected values are written out, and checked again against
 * an independent BigInt implementation of the same rule.
 */

describe('decimal text to two places', () => {
  it.each([
    // Halves go to the even digit; anything over a half goes up.
    ['90.125', '90.12'],
    ['90.135', '90.14'],
    ['90.1250', '90.12'],
    ['90.12500000001', '90.13'],
    ['90.1349999999', '90.13'],
    ['0.005', '0.00'],
    ['0.015', '0.02'],
    ['0.025', '0.02'],
    ['0.0251', '0.03'],
    ['2.675', '2.68'],
    // Very small values.
    ['0.0000003598', '0.00'],
    ['0.0000000001', '0.00'],
    ['0.0049999999', '0.00'],
    ['0.0050000001', '0.01'],
    // Zero.
    ['0', '0.00'],
    ['0.00', '0.00'],
    ['0.0000000000', '0.00'],
    // Already two places, and values needing no rounding.
    ['101.25', '101.25'],
    ['0.10', '0.10'],
    ['100', '100.00'],
    ['1.5', '1.50'],
    ['7', '7.00'],
    // Negative values: the same digits, the same rule; a value that rounds to zero loses its sign.
    ['-90.125', '-90.12'],
    ['-90.135', '-90.14'],
    ['-1234.5', '-1,234.50'],
    ['-0.0000003598', '0.00'],
    ['-0.005', '0.00'],
    ['-0.015', '-0.02'],
    // Large values, grouped, with carries across the point and into a new digit.
    ['1234567.891', '1,234,567.89'],
    ['999999999999999.9999999999', '1,000,000,000,000,000.00'],
    ['123456789012345.1234567891', '123,456,789,012,345.12'],
    ['99.995', '100.00'],
    ['99.985', '99.98'],
    ['-999.995', '-1,000.00'],
    ['12345678901234567890123456789012345678.9012345678', '12,345,678,901,234,567,890,123,456,789,012,345,678.90'],
  ])('shows %s as %s', (text, shown) => {
    expect(formatDecimalPlaces(text)).toBe(shown)
  })

  it('rounds values a JavaScript number would round differently', () => {
    // 1.015 and 1.005 are just below their halves as binary numbers; 0.125 is exact there and
    // would be rounded up. As decimal text each is exactly a half, which goes to the even digit.
    expect(formatDecimalPlaces('1.015')).toBe('1.02')
    expect(formatDecimalPlaces('1.005')).toBe('1.00')
    expect(formatDecimalPlaces('0.125')).toBe('0.12')
    // More digits than a number holds, beyond its 53 bits.
    expect(formatDecimalPlaces('9007199254740993.125')).toBe('9,007,199,254,740,993.12')
    expect(formatDecimalPlaces('9007199254740993.135')).toBe('9,007,199,254,740,993.14')
  })

  it('leaves the text it was given unchanged, so the exact value stays available', () => {
    const exact = '0.0000003598'
    const shown = formatDecimalPlaces(exact)

    expect(exact).toBe('0.0000003598')
    expect(shown).toBe('0.00')
    expect(formatDecimal(exact)).toBe('0.0000003598')
  })

  it('rounds to other numbers of places by the same rule', () => {
    expect(formatDecimalPlaces('2.5', 0)).toBe('2')
    expect(formatDecimalPlaces('3.5', 0)).toBe('4')
    expect(formatDecimalPlaces('1234.5', 0)).toBe('1,234')
    expect(formatDecimalPlaces('1.23456', 4)).toBe('1.2346')
    expect(formatDecimalPlaces('1.23455', 4)).toBe('1.2346')
    expect(formatDecimalPlaces('1.23465', 4)).toBe('1.2346')
  })

  it.each(['', '-', '.5', '5.', '1e3', '+1', '1,000', ' 1', '1.2.3', 'NaN', 'Infinity', '٣'])('refuses %j, which is not decimal text', (text) => {
    expect(() => formatDecimalPlaces(text)).toThrow(RangeError)
  })

  it.each([-1, 1.5, Number.NaN])('refuses %d places', (places) => {
    expect(() => formatDecimalPlaces('1.5', places)).toThrow(RangeError)
  })
})

/** The same rule, written independently with BigInt: scale to whole units of 0.01, then round. */
function reference(text: string): string {
  const negative = text.startsWith('-')
  const [integer = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.')
  const scale = fraction.length
  let units = BigInt(`${integer}${fraction}`)
  if (scale <= 2) {
    units *= 10n ** BigInt(2 - scale)
  } else {
    const divisor = 10n ** BigInt(scale - 2)
    const [quotient, remainder] = [units / divisor, units % divisor]
    const twice = remainder * 2n
    units = twice > divisor || (twice === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient
  }
  const digits = units.toString().padStart(3, '0')
  const shown = `${digits.slice(0, -2)}.${digits.slice(-2)}`
  return formatDecimal(`${negative && units !== 0n ? '-' : ''}${shown}`)
}

describe('decimal text to two places, against an independent implementation', () => {
  it('agrees for every value from -20.000 to 20.000 in steps of 0.001', () => {
    const differences: string[] = []
    for (let thousandths = -20_000; thousandths <= 20_000; thousandths++) {
      const magnitude = String(Math.abs(thousandths)).padStart(4, '0')
      const text = `${thousandths < 0 ? '-' : ''}${magnitude.slice(0, -3)}.${magnitude.slice(-3)}`
      if (formatDecimalPlaces(text) !== reference(text)) differences.push(text)
    }
    expect(differences).toEqual([])
  })

  it('agrees for long values with ten decimal places and many integer digits', () => {
    const tails = ['0000000000', '0050000000', '0049999999', '0050000001', '0150000000', '9950000000', '9949999999', '3598000000']
    const heads = ['0', '1', '9', '99', '999999999999999', '123456789012345678901234567890']
    for (const head of heads) {
      for (const tail of tails) {
        for (const sign of ['', '-']) {
          const text = `${sign}${head}.${tail}`
          expect(formatDecimalPlaces(text), text).toBe(reference(text))
        }
      }
    }
  })
})

describe('money on screen', () => {
  it('is two decimal places, half to even, with the exact value grouped, and says whether digits were hidden', () => {
    expect(MONEY_PLACES).toBe(2)
    expect(formatMoney('90.125')).toEqual({ shown: '90.12', exact: '90.125', rounded: true })
    expect(formatMoney('90.135')).toEqual({ shown: '90.14', exact: '90.135', rounded: true })
    expect(formatMoney('187.5')).toEqual({ shown: '187.50', exact: '187.5', rounded: false })
    expect(formatMoney('1500.250000')).toEqual({ shown: '1,500.25', exact: '1,500.250000', rounded: false })
    expect(formatMoney('999999999999999.9999999999')).toEqual({ shown: '1,000,000,000,000,000.00', exact: '999,999,999,999,999.9999999999', rounded: true })
    expect(formatMoney('1.6666666666666666666666666666666666666666666666667').shown).toBe('1.67')
  })

  it('handles negative values, values that round to zero (no minus sign), and small fractions', () => {
    expect(formatMoney('-1234.565')).toEqual({ shown: '-1,234.56', exact: '-1,234.565', rounded: true })
    expect(formatMoney('-0.004')).toEqual({ shown: '0.00', exact: '-0.004', rounded: true })
    expect(formatMoney('-0')).toEqual({ shown: '0.00', exact: '-0', rounded: false })
    expect(formatMoney('-0.00')).toEqual({ shown: '0.00', exact: '-0.00', rounded: false })
    expect(formatMoney('0.0000000001')).toEqual({ shown: '0.00', exact: '0.0000000001', rounded: true })
    expect(formatMoney('0.005')).toEqual({ shown: '0.00', exact: '0.005', rounded: true })
    expect(formatMoney('0.015')).toEqual({ shown: '0.02', exact: '0.015', rounded: true })
  })

  it('hides digits only when a non-zero digit falls after the places shown', () => {
    expect(hidesDigits('1')).toBe(false)
    expect(hidesDigits('1.10')).toBe(false)
    expect(hidesDigits('1.100000')).toBe(false)
    expect(hidesDigits('1.101')).toBe(true)
    expect(hidesDigits('1.101', 3)).toBe(false)
  })

  it('never changes the text it is given', () => {
    const exact = '123456789012345678901234567890.123456789012345678901'
    formatMoney(exact)
    expect(exact).toBe('123456789012345678901234567890.123456789012345678901')
    expect(formatMoney(exact).exact.replace(/,/g, '')).toBe(exact)
  })
})
