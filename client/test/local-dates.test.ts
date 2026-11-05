import { describe, expect, it } from 'vitest'

import { localDayEnd, localDayStart } from '../src/lib/local-dates.ts'
import { browserOffsetAt, type OffsetAt } from '../src/lib/timestamps.ts'
import { localWallTime, zoneOffsetAt } from './support/time-zones.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const NEW_YORK = zoneOffsetAt('America/New_York')
const LONDON = zoneOffsetAt('Europe/London')
const SANTIAGO = zoneOffsetAt('America/Santiago')
const LORD_HOWE = zoneOffsetAt('Australia/Lord_Howe')

/** The local day's length in hours: from its first instant to the instant after its last. */
function hoursIn(date: string, offsetAt: OffsetAt): number {
  return (Date.parse(localDayEnd(date, offsetAt) ?? '') + 1 - Date.parse(localDayStart(date, offsetAt) ?? '')) / HOUR_MS
}

describe('local dates: the zone the tests run in', () => {
  it('is applied to the browser offset exactly as the time-zone data defines New York, across both clock changes', () => {
    // TZ is set in vite.config.ts. Rather than assume the operating system honours it, compare it
    // hour by hour through 2026 with the engine's own data for America/New_York.
    const start = Date.parse('2026-01-01T00:00:00Z')
    const mismatches: string[] = []
    for (let instant = start; instant < start + 365 * DAY_MS; instant += HOUR_MS) {
      if (browserOffsetAt(instant) !== NEW_YORK(instant)) mismatches.push(new Date(instant).toISOString())
    }

    expect(mismatches).toEqual([])
    expect(new Set([browserOffsetAt(start), browserOffsetAt(Date.parse('2026-07-01T00:00:00Z'))])).toEqual(new Set([-300, -240]))
  })
})

describe('local dates: day boundaries in UTC', () => {
  it.each([
    // An ordinary day: 24 hours from local midnight.
    ['America/New_York', NEW_YORK, '2026-01-15', '2026-01-15T05:00:00.000Z', '2026-01-16T04:59:59.999Z', 24],
    ['America/New_York', NEW_YORK, '2026-07-15', '2026-07-15T04:00:00.000Z', '2026-07-16T03:59:59.999Z', 24],
    // Clocks go forward at 02:00: a 23-hour day that starts at UTC-5 and ends at UTC-4.
    ['America/New_York', NEW_YORK, '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z', 23],
    // Clocks go back at 02:00: a 25-hour day that starts at UTC-4 and ends at UTC-5.
    ['America/New_York', NEW_YORK, '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z', 25],
    ['Europe/London', LONDON, '2026-03-29', '2026-03-29T00:00:00.000Z', '2026-03-29T22:59:59.999Z', 23],
    ['Europe/London', LONDON, '2026-10-25', '2026-10-24T23:00:00.000Z', '2026-10-25T23:59:59.999Z', 25],
    // Clocks go forward at midnight: there is no 00:00, and the day starts at 01:00.
    ['America/Santiago', SANTIAGO, '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T02:59:59.999Z', 23],
    // Clocks go back at midnight, to 23:00 on the 4th: the 4th has 25 hours, the 5th starts at its only midnight.
    ['America/Santiago', SANTIAGO, '2026-04-04', '2026-04-04T03:00:00.000Z', '2026-04-05T03:59:59.999Z', 25],
    ['America/Santiago', SANTIAGO, '2026-04-05', '2026-04-05T04:00:00.000Z', '2026-04-06T03:59:59.999Z', 24],
    // A half-hour change: a 23.5-hour day.
    ['Australia/Lord_Howe', LORD_HOWE, '2026-10-04', '2026-10-03T13:30:00.000Z', '2026-10-04T12:59:59.999Z', 23.5],
  ])('%s %s: from %s to %s, %s hours', (_zone, offsetAt, date, start, end, hours) => {
    expect(localDayStart(date, offsetAt)).toBe(start)
    expect(localDayEnd(date, offsetAt)).toBe(end)
    expect(hoursIn(date, offsetAt)).toBe(hours)
  })

  it('names the first and last instants that are on that date in local time', () => {
    for (const [zone, date, first, last] of [
      ['America/New_York', '2026-03-08', '2026-03-08 00:00:00.000', '2026-03-08 23:59:59.999'],
      ['America/New_York', '2026-11-01', '2026-11-01 00:00:00.000', '2026-11-01 23:59:59.999'],
      ['America/Santiago', '2026-09-06', '2026-09-06 01:00:00.000', '2026-09-06 23:59:59.999'],
      ['America/Santiago', '2026-04-04', '2026-04-04 00:00:00.000', '2026-04-04 23:59:59.999'],
    ] as const) {
      const offsetAt = zoneOffsetAt(zone)
      const start = Date.parse(localDayStart(date, offsetAt) ?? '')
      const end = Date.parse(localDayEnd(date, offsetAt) ?? '')

      expect([localWallTime(start, zone), localWallTime(end, zone)]).toEqual([first, last])
      // One millisecond outside is the neighbouring date.
      expect(localWallTime(start - 1, zone).slice(0, 10)).not.toBe(date)
      expect(localWallTime(end + 1, zone).slice(0, 10)).not.toBe(date)
    }
  })

  it.each([
    ['America/New_York'], ['Europe/London'], ['America/Santiago'], ['Australia/Lord_Howe'], ['Asia/Kolkata'], ['Pacific/Chatham'],
  ])('covers every instant of 2026 in %s exactly once, with each day ending a millisecond before the next begins', (zone) => {
    const offsetAt = zoneOffsetAt(zone)
    const lengths = new Map<number, number>()
    let day = Date.parse('2026-01-01T00:00:00Z')
    for (let count = 0; count < 365; count++, day += DAY_MS) {
      const date = new Date(day).toISOString().slice(0, 10)
      const next = new Date(day + DAY_MS).toISOString().slice(0, 10)
      const start = Date.parse(localDayStart(date, offsetAt) ?? '')
      const end = Date.parse(localDayEnd(date, offsetAt) ?? '')

      expect(end + 1).toBe(Date.parse(localDayStart(next, offsetAt) ?? ''))
      expect(localWallTime(start, zone).slice(0, 10)).toBe(date)
      expect(localWallTime(end, zone).slice(0, 10)).toBe(date)
      const hours = (end + 1 - start) / HOUR_MS
      lengths.set(hours, (lengths.get(hours) ?? 0) + 1)
    }

    // A zone with daylight saving has one short and one long day a year; one without, none.
    const expected: Record<string, [number, number][]> = {
      'America/New_York': [[23, 1], [24, 363], [25, 1]],
      'Europe/London': [[23, 1], [24, 363], [25, 1]],
      'America/Santiago': [[23, 1], [24, 363], [25, 1]],
      'Australia/Lord_Howe': [[23.5, 1], [24, 363], [24.5, 1]],
      'Asia/Kolkata': [[24, 365]],
      'Pacific/Chatham': [[23, 1], [24, 363], [25, 1]],
    }
    expect([...lengths.entries()].sort(([a], [b]) => a - b)).toEqual(expected[zone])
  })

  it('works in any fixed offset, east or west', () => {
    expect(localDayStart('2026-01-01', () => 330)).toBe('2025-12-31T18:30:00.000Z')
    expect(localDayEnd('2026-01-01', () => 330)).toBe('2026-01-01T18:29:59.999Z')
    expect(localDayStart('2026-01-01', () => -600)).toBe('2026-01-01T10:00:00.000Z')
    expect(localDayEnd('2026-01-01', () => 0)).toBe('2026-01-01T23:59:59.999Z')
  })

  it('handles leap days and the turn of the year', () => {
    expect(localDayStart('2028-02-29', NEW_YORK)).toBe('2028-02-29T05:00:00.000Z')
    expect(localDayEnd('2028-02-29', NEW_YORK)).toBe('2028-03-01T04:59:59.999Z')
    expect(localDayEnd('2026-12-31', NEW_YORK)).toBe('2027-01-01T04:59:59.999Z')
  })

  it('finds where a day starts when the clocks skip midnight, in any zone that does', () => {
    // A synthetic zone: UTC-4 until 2030-06-01T04:00Z (local midnight), then UTC-3, so local 00:00 to 00:59 never happens.
    const change = Date.parse('2030-06-01T04:00:00Z')
    const skipping: OffsetAt = (instant) => (instant < change ? -240 : -180)

    expect(localDayStart('2030-06-01', skipping)).toBe('2030-06-01T04:00:00.000Z')
    expect(localDayEnd('2030-05-31', skipping)).toBe('2030-06-01T03:59:59.999Z')
  })

  it('gives a skipped calendar date no time at all: its end comes before its start', () => {
    // Samoa moved across the date line: 2011-12-29 at 23:59:59.999 (UTC-10) was followed by 2011-12-31 at 00:00 (UTC+14).
    const apia = zoneOffsetAt('Pacific/Apia')

    expect(localDayEnd('2011-12-29', apia)).toBe('2011-12-30T09:59:59.999Z')
    expect(localDayStart('2011-12-31', apia)).toBe('2011-12-30T10:00:00.000Z')
    expect(Date.parse(localDayEnd('2011-12-30', apia) ?? '')).toBeLessThan(Date.parse(localDayStart('2011-12-30', apia) ?? ''))
  })

  it.each(['', 'yesterday', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '26-01-01', '0000-01-01',
    '2026-01-01T00:00', ' 2026-01-01'])('refuses %j, which is not a calendar date', (date) => {
    expect(localDayStart(date, NEW_YORK)).toBeUndefined()
    expect(localDayEnd(date, NEW_YORK)).toBeUndefined()
  })

  it('refuses a boundary outside the years 0001 to 9999, which the API cannot accept', () => {
    expect(localDayStart('0001-01-01', () => 60)).toBeUndefined()
    expect(localDayStart('0001-01-01', () => -60)).toBe('0001-01-01T01:00:00.000Z')
    expect(localDayEnd('9999-12-31', () => -60)).toBeUndefined()
    expect(localDayEnd('9999-12-31', () => 60)).toBe('9999-12-31T22:59:59.999Z')
  })
})
