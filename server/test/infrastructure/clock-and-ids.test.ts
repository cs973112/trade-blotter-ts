import { describe, expect, it } from 'vitest'

import { toUtcTimestamp } from '../../src/domain/timestamp.ts'
import { systemClock } from '../../src/infrastructure/system-clock.ts'
import { uuidGenerator } from '../../src/infrastructure/uuid-generator.ts'

describe('infrastructure: system clock and id generator', () => {
  it('reads the current time as a supported instant', () => {
    const before = Date.now()
    const now = systemClock.now().getTime()

    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
    expect(toUtcTimestamp(new Date(now))).toMatch(/Z$/)
  })

  it('returns a fresh Date each time, so callers cannot change the clock', () => {
    expect(systemClock.now()).not.toBe(systemClock.now())
  })

  it('generates distinct version 4 UUIDs', () => {
    const ids = Array.from({ length: 1000 }, () => uuidGenerator.next())

    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
