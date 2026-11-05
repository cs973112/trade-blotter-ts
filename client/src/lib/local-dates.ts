import { browserOffsetAt, type OffsetAt } from './timestamps.ts'

/**
 * Turning a calendar date the user picks, in their own time zone, into the instants where that
 * local day begins and ends, as UTC timestamps for the API.
 *
 * A local day is not always 24 hours long. On the day the clocks go forward it has 23 hours (or
 * 23.5, or fewer), and on the day they go back, 25. In a few zones the clocks change at midnight,
 * so midnight itself is skipped and the day begins at 01:00. Nothing here adds 24 hours: each
 * boundary is found from the offsets actually in force, so every such day is covered exactly.
 */

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** The value of an <input type="date">: "2026-03-08". */
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The API accepts instants in the years 0001 to 9999. */
const API_TIMESTAMP = /^(?!0000)\d{4}-/

/** The date's midnight with the wall clock read as UTC, or undefined if there is no such date. */
function wallMidnight(date: string): number | undefined {
  const match = LOCAL_DATE.exec(date)
  if (match === null) return undefined
  const [, year = '', month = '', day = ''] = match
  // setUTCFullYear, unlike Date.UTC, keeps the years 0 to 99 as written.
  const wall = new Date(0)
  wall.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  const exists = Number(year) >= 1 && wall.getUTCFullYear() === Number(year) && wall.getUTCMonth() === Number(month) - 1 &&
    wall.getUTCDate() === Number(day)
  return exists ? wall.getTime() : undefined
}

/**
 * The first instant of the local day whose midnight, read as UTC, is `wall`. When midnight
 * happens twice, the first occurrence. When the clocks skip midnight, the moment they change: the
 * last instant before it still belongs to the previous day.
 */
function startOfDay(wall: number, offsetAt: OffsetAt): number {
  // Every offset in force within a day either side is a candidate, as for a local date-time.
  const offsets = [...new Set([offsetAt(wall - DAY_MS), offsetAt(wall), offsetAt(wall + DAY_MS)])]
  const midnights = offsets.map((offset) => wall - offset * MINUTE_MS).filter((instant, index) => offsetAt(instant) === offsets[index])
  if (midnights.length > 0) return Math.min(...midnights)

  // Midnight is skipped. Midnight read at the larger offset falls before the change, and read at
  // the smaller one, after it: search between them for the first millisecond of the new offset.
  let before = wall - Math.max(...offsets) * MINUTE_MS
  let after = wall - Math.min(...offsets) * MINUTE_MS
  const earlier = offsetAt(before)
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2)
    if (offsetAt(middle) === earlier) before = middle
    else after = middle
  }
  return after
}

function apiTimestamp(instant: number): string | undefined {
  const text = new Date(instant).toISOString()
  return API_TIMESTAMP.test(text) ? text : undefined
}

/**
 * The first instant of a local calendar date, as a UTC timestamp such as
 * "2026-03-08T05:00:00.000Z". Undefined if the date is not a real date or the instant is outside
 * the years 0001 to 9999.
 */
export function localDayStart(date: string, offsetAt: OffsetAt = browserOffsetAt): string | undefined {
  const wall = wallMidnight(date)
  return wall === undefined ? undefined : apiTimestamp(startOfDay(wall, offsetAt))
}

/**
 * The last millisecond of a local calendar date: the start of the next local day, less one
 * millisecond. As a UTC timestamp, or undefined like localDayStart.
 */
export function localDayEnd(date: string, offsetAt: OffsetAt = browserOffsetAt): string | undefined {
  const wall = wallMidnight(date)
  return wall === undefined ? undefined : apiTimestamp(startOfDay(wall + DAY_MS, offsetAt) - 1)
}
