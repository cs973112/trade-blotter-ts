import { describe, expect, it } from 'vitest'

import { displayTime, offsetLabel, resolveLocalDateTime, type OffsetAt } from '../src/lib/timestamps.ts'

const MINUS = String.fromCodePoint(0x2212)

describe('timestamps: test time zone', () => {
  it('runs in America/New_York, which has daylight-saving changes', () => {
    expect(new Date('2026-01-02T12:00:00Z').getTimezoneOffset()).toBe(300)
    expect(new Date('2026-07-02T12:00:00Z').getTimezoneOffset()).toBe(240)
  })
})

describe('timestamps: local input to RFC 3339', () => {
  it.each([
    ['2026-01-02T09:30', '2026-01-02T09:30:00-05:00', '2026-01-02T14:30:00.000Z'],
    ['2026-01-02T09:30:15', '2026-01-02T09:30:15-05:00', '2026-01-02T14:30:15.000Z'],
    ['2026-07-01T09:30:15.250', '2026-07-01T09:30:15.250-04:00', '2026-07-01T13:30:15.250Z'],
    ['2026-03-08T03:00', '2026-03-08T03:00:00-04:00', '2026-03-08T07:00:00.000Z'],
    ['2026-03-08T01:59:59', '2026-03-08T01:59:59-05:00', '2026-03-08T06:59:59.000Z'],
  ])('sends %s as %s, the same instant (%s)', (input, value, instant) => {
    const result = resolveLocalDateTime(input)

    expect(result).toMatchObject({ kind: 'exact', time: { value } })
    expect(new Date(value).toISOString()).toBe(instant)
  })

  it('refuses a local time skipped when the clocks go forward', () => {
    expect(resolveLocalDateTime('2026-03-08T02:30')).toEqual({ kind: 'nonexistent' })
  })

  it('reports both instants of a local time repeated when the clocks go back, earlier first', () => {
    const result = resolveLocalDateTime('2026-11-01T01:30')

    expect(result).toEqual({
      kind: 'ambiguous',
      times: [
        { value: '2026-11-01T01:30:00-04:00', offsetMinutes: -240, offsetLabel: `UTC${MINUS}04:00` },
        { value: '2026-11-01T01:30:00-05:00', offsetMinutes: -300, offsetLabel: `UTC${MINUS}05:00` },
      ],
    })
    if (result.kind !== 'ambiguous') return
    expect(result.times.map((time) => new Date(time.value).toISOString()))
      .toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'])
  })

  it.each(['', '   '])('treats %j as no execution time', (input) => {
    expect(resolveLocalDateTime(input)).toEqual({ kind: 'empty' })
  })

  it.each(['yesterday', '2026-01-02', '2026-01-02 09:30', '2026-02-30T10:00', '2026-01-02T24:00', '0000-01-01T00:00'])(
    'refuses %j',
    (input) => {
      expect(resolveLocalDateTime(input)).toEqual({ kind: 'invalid' })
    },
  )

  it('uses the offset of whatever zone it is given', () => {
    const india: OffsetAt = () => 330
    const utc: OffsetAt = () => 0

    expect(resolveLocalDateTime('2026-01-02T09:30', india)).toMatchObject({ kind: 'exact', time: { value: '2026-01-02T09:30:00+05:30' } })
    expect(resolveLocalDateTime('2026-01-02T09:30', utc)).toMatchObject({ kind: 'exact', time: { value: '2026-01-02T09:30:00+00:00' } })
  })

  it('labels offsets with a true minus sign', () => {
    expect([offsetLabel(-300), offsetLabel(330), offsetLabel(0)]).toEqual([`UTC${MINUS}05:00`, 'UTC+05:30', 'UTC+00:00'])
  })
})

describe('timestamps: API values for display', () => {
  it.each([
    ['2026-01-02T14:30:00.123Z', '2026-01-02 09:30:00.123', `UTC${MINUS}05:00`],
    ['2026-07-01T13:30:15.250Z', '2026-07-01 09:30:15.250', `UTC${MINUS}04:00`],
    ['2026-11-01T05:30:00.000Z', '2026-11-01 01:30:00.000', `UTC${MINUS}04:00`],
    ['2026-11-01T06:30:00.000Z', '2026-11-01 01:30:00.000', `UTC${MINUS}05:00`],
  ])('shows %s as %s %s', (utc, local, offset) => {
    expect(displayTime(utc)).toEqual({ local, offset, utc })
  })

  it('shows an unreadable value unchanged', () => {
    expect(displayTime('not a time')).toEqual({ local: 'not a time', offset: '', utc: 'not a time' })
  })
})
