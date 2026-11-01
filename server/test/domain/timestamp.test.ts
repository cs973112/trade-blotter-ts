import { describe, expect, it } from 'vitest'

import { parseTimestamp, toUtcTimestamp } from '../../src/domain/timestamp.ts'

describe('domain: timestamps', () => {
  it.each([
    ['2026-01-01T09:00:00Z', '2026-01-01T09:00:00.000Z'],
    ['2026-01-01T09:00:00+00:00', '2026-01-01T09:00:00.000Z'],
    ['2026-01-01T09:00:00-00:00', '2026-01-01T09:00:00.000Z'],
    ['2026-01-01T09:00:00+05:30', '2026-01-01T03:30:00.000Z'],
    ['2026-01-01T09:00:00-04:00', '2026-01-01T13:00:00.000Z'],
    ['2026-01-01T09:00:00+23:59', '2025-12-31T09:01:00.000Z'],
    ['2026-01-01T09:00:00.5Z', '2026-01-01T09:00:00.500Z'],
    ['2026-01-01T09:00:00.12Z', '2026-01-01T09:00:00.120Z'],
    ['2026-01-01T09:00:00.123+01:00', '2026-01-01T08:00:00.123Z'],
    ['2026-01-01t09:00:00z', '2026-01-01T09:00:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['0050-06-01T00:00:00Z', '0050-06-01T00:00:00.000Z'],
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
    ['0001-01-01T05:00:00+05:00', '0001-01-01T00:00:00.000Z'],
    ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
  ])('normalises %s to %s', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected)
  })

  it.each([
    ['no offset', '2026-01-01T09:00:00'],
    ['date only', '2026-01-01'],
    ['no seconds', '2026-01-01T09:00Z'],
    ['a space separator', '2026-01-01 09:00:00Z'],
    ['four fractional digits', '2026-01-01T09:00:00.1234Z'],
    ['an empty fraction', '2026-01-01T09:00:00.Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['month 0', '2026-00-01T00:00:00Z'],
    ['day 0', '2026-01-00T00:00:00Z'],
    ['February 29 outside a leap year', '2026-02-29T00:00:00Z'],
    ['February 29 in 1900', '1900-02-29T00:00:00Z'],
    ['April 31', '2026-04-31T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T09:60:00Z'],
    ['a leap second', '2026-06-30T23:59:60Z'],
    ['offset hour 24', '2026-01-01T09:00:00+24:00'],
    ['offset minute 60', '2026-01-01T09:00:00+01:60'],
    ['an offset without a colon', '2026-01-01T09:00:00+0530'],
    ['an hour-only offset', '2026-01-01T09:00:00+05'],
    ['basic format', '20260101T090000Z'],
    ['a five-digit year', '10000-01-01T00:00:00Z'],
    ['year 0', '0000-12-31T23:59:59Z'],
    ['before year 1 once normalised', '0001-01-01T00:00:00+01:00'],
    ['after year 9999 once normalised', '9999-12-31T23:59:59-01:00'],
    ['surrounding spaces', ' 2026-01-01T09:00:00Z '],
    ['text', 'not a date'],
    ['empty', ''],
  ])('refuses %s', (_name, input) => {
    expect(parseTimestamp(input)).toBeUndefined()
  })

  it('formats a clock reading as canonical UTC with milliseconds', () => {
    expect(toUtcTimestamp(new Date(Date.UTC(2026, 0, 1, 9, 0, 0, 7)))).toBe('2026-01-01T09:00:00.007Z')
  })

  it('refuses an invalid or out-of-range clock reading', () => {
    expect(() => toUtcTimestamp(new Date(Number.NaN))).toThrow(RangeError)
    expect(() => toUtcTimestamp(new Date('+010000-01-01T00:00:00Z'))).toThrow(RangeError)
  })

  it('produces text whose order is time order', () => {
    const inputs = ['2026-01-01T09:00:00+01:00', '2026-01-01T07:59:59.999Z', '0999-01-01T00:00:00Z', '2026-01-01T08:00:00.001Z']
    const canonical = inputs.map((input) => parseTimestamp(input) ?? '')

    expect([...canonical].sort()).toEqual([...canonical].sort((a, b) => Date.parse(a) - Date.parse(b)))
  })
})
