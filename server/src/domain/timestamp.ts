/**
 * Every timestamp is canonical UTC text with milliseconds, such as `2026-01-01T09:00:00.000Z`:
 * the output of Date.prototype.toISOString for the years 0001 to 9999. The text is fixed width, so
 * its order is time order, and it is a string, so a timestamp held by a trade cannot be mutated.
 */
declare const utcTimestampBrand: unique symbol

/** Canonical UTC timestamp text. Created only by parseTimestamp and toUtcTimestamp. */
export type UtcTimestamp = string & { readonly [utcTimestampBrand]: true }

/** RFC 3339 date-time with a required offset and at most millisecond precision. */
const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/

const EARLIEST = Date.parse('0001-01-01T00:00:00.000Z')
const LATEST = Date.parse('9999-12-31T23:59:59.999Z')

const MINUTE_MS = 60_000

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function fromEpochMilliseconds(milliseconds: number): UtcTimestamp | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < EARLIEST || milliseconds > LATEST) return undefined
  return new Date(milliseconds).toISOString() as UtcTimestamp
}

/**
 * Parses an RFC 3339 date-time with an offset and normalises it to canonical UTC. Returns
 * undefined for anything else: no offset, a date that does not exist, hour 24, a leap second,
 * more than three fractional digits, or an instant outside the years 0001 to 9999.
 */
export function parseTimestamp(text: string): UtcTimestamp | undefined {
  const match = RFC_3339.exec(text)
  if (match === null) return undefined
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', fraction = '', offsetSign = '+',
    offsetHour = '0', offsetMinute = '0'] = match
  const [y, mo, d, h, mi, s, oh, om] = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number) as
    [number, number, number, number, number, number, number, number]

  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) {
    return undefined
  }

  // setUTCFullYear, unlike Date.UTC, does not map the years 0 to 99 onto 1900 to 1999.
  const wallClock = new Date(0)
  wallClock.setUTCFullYear(y, mo - 1, d)
  wallClock.setUTCHours(h, mi, s, Number(fraction.padEnd(3, '0')))
  const offsetMinutes = (oh * 60 + om) * (offsetSign === '-' ? -1 : 1)
  return fromEpochMilliseconds(wallClock.getTime() - offsetMinutes * MINUTE_MS)
}

/** The canonical UTC timestamp of a clock reading. Throws if the date is invalid or out of range. */
export function toUtcTimestamp(date: Date): UtcTimestamp {
  const timestamp = fromEpochMilliseconds(date.getTime())
  if (timestamp === undefined) throw new RangeError(`The clock reading ${String(date.getTime())} is not a supported instant.`)
  return timestamp
}
