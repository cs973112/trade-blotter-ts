/**
 * Turning the local date and time a user picks into an RFC 3339 timestamp with an explicit offset,
 * and showing the API's UTC timestamps in local time.
 *
 * A local wall time does not always name exactly one instant. When clocks move forward, some local
 * times never happen; when they move back, some happen twice. Instead of guessing, resolveLocalDateTime
 * reports both cases so the form can refuse the first and ask about the second.
 */

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Minutes east of UTC in force at an instant. The browser's own zone by default. */
export type OffsetAt = (epochMs: number) => number

export const browserOffsetAt: OffsetAt = (epochMs) => {
  const offset = -new Date(epochMs).getTimezoneOffset()
  return offset === 0 ? 0 : offset // never -0
}

export interface ResolvedTime {
  /** RFC 3339 with an offset, as the user's wall time plus the offset in force: "2026-11-01T01:30:00-04:00". */
  readonly value: string
  /** Minutes east of UTC. */
  readonly offsetMinutes: number
  /** "UTC−04:00". */
  readonly offsetLabel: string
}

export type LocalTimeResolution =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'exact'; readonly time: ResolvedTime }
  /** Happens twice: the earlier occurrence first. */
  | { readonly kind: 'ambiguous'; readonly times: readonly ResolvedTime[] }
  /** Skipped by a clock change. */
  | { readonly kind: 'nonexistent' }

/** The value of an <input type="datetime-local">: "2026-01-02T09:30", optionally with seconds and milliseconds. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.](\d{1,3}))?)?$/

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+'
  const magnitude = Math.abs(offsetMinutes)
  return `UTC${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`
}

function rfc3339Offset(offsetMinutes: number): string {
  const magnitude = Math.abs(offsetMinutes)
  return `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`
}

/**
 * Resolves a datetime-local value in a time zone. The wall time the user chose is kept as typed;
 * only the offset is added, so the intended instant is preserved exactly.
 */
export function resolveLocalDateTime(input: string, offsetAt: OffsetAt = browserOffsetAt): LocalTimeResolution {
  if (input.trim() === '') return { kind: 'empty' }
  const match = LOCAL_DATE_TIME.exec(input.trim())
  if (match === null) return { kind: 'invalid' }
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '00', fraction = ''] = match

  // The wall time read as if it were UTC; setUTCFullYear keeps years below 100 as typed.
  const wall = new Date(0)
  wall.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  wall.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')))
  const wallMs = wall.getTime()
  if (
    Number(year) < 1 || wall.getUTCFullYear() !== Number(year) || wall.getUTCMonth() !== Number(month) - 1 ||
    wall.getUTCDate() !== Number(day) || wall.getUTCHours() !== Number(hour) || wall.getUTCMinutes() !== Number(minute) ||
    wall.getUTCSeconds() !== Number(second)
  ) {
    return { kind: 'invalid' }
  }

  // Every offset in force within a day either side is a candidate; keep those that map back to this wall time.
  const candidates = new Set([offsetAt(wallMs - DAY_MS), offsetAt(wallMs), offsetAt(wallMs + DAY_MS)])
  const text = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction === '' ? '' : `.${fraction}`}`
  const times = [...candidates]
    .filter((offset) => offsetAt(wallMs - offset * MINUTE_MS) === offset)
    .sort((a, b) => b - a) // larger offset east = earlier instant
    .map((offset) => ({ value: `${text}${rfc3339Offset(offset)}`, offsetMinutes: offset, offsetLabel: offsetLabel(offset) }))

  const [first] = times
  if (first === undefined) return { kind: 'nonexistent' }
  return times.length === 1 ? { kind: 'exact', time: first } : { kind: 'ambiguous', times }
}

/** The browser's time zone name, such as "Europe/London", for labels. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export interface DisplayTime {
  /** "2026-01-02 09:30:00.123" in local time. */
  readonly local: string
  /** "UTC−05:00", the offset in force at that instant. */
  readonly offset: string
  /** The API's UTC value, for the datetime attribute and a tooltip. */
  readonly utc: string
}

/** Shows a UTC timestamp from the API in local time, with its offset, in one fixed format. */
export function displayTime(utc: string, offsetAt: OffsetAt = browserOffsetAt): DisplayTime {
  const instant = Date.parse(utc)
  if (Number.isNaN(instant)) return { local: utc, offset: '', utc }
  const offset = offsetAt(instant)
  const local = new Date(instant + offset * MINUTE_MS)
  const text = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}`
  return { local: text, offset: offsetLabel(offset), utc }
}
