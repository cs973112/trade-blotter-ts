import type { OffsetAt } from '../../src/lib/timestamps.ts'

/**
 * The offset in force in a named IANA time zone, from the time-zone data bundled with the
 * JavaScript engine (Intl), not from the process's TZ setting. Tests can therefore check any zone
 * in one run, and do not rely on how an operating system applies TZ.
 */
export function zoneOffsetAt(timeZone: string): OffsetAt {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
  return (epochMs) => {
    const name = format.formatToParts(new Date(epochMs)).find((part) => part.type === 'timeZoneName')?.value ?? ''
    // "GMT", "GMT+05:30", or "GMT-04:56:02" for local mean time.
    const match = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(name)
    if (match === null) throw new Error(`Unexpected offset name "${name}" in ${timeZone}.`)
    const [, sign, hours = '0', minutes = '0', seconds = '0'] = match
    const offset = (Number(hours) * 60 + Number(minutes) + Number(seconds) / 60) * (sign === '-' ? -1 : 1)
    return offset === 0 ? 0 : offset
  }
}

/** The local calendar date and wall time of an instant in a zone: "2026-03-08 01:00:00.000". */
export function localWallTime(epochMs: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hourCycle: 'h23',
  }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]))
  return `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''} ` +
    `${parts['hour'] ?? ''}:${parts['minute'] ?? ''}:${parts['second'] ?? ''}.${parts['fractionalSecond'] ?? ''}`
}
