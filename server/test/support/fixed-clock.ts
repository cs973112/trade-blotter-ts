import type { Clock, IdGenerator } from '../../src/application/ports.ts'

/** A clock that reads `start` until moved, and counts how often it was read. */
export function createFixedClock(start: string) {
  let current = new Date(start)
  let reads = 0
  return {
    now(): Date {
      reads++
      return new Date(current)
    },
    set(time: string): void {
      current = new Date(time)
    },
    get reads(): number {
      return reads
    },
  } satisfies Clock & Record<string, unknown>
}

/** Ids `trade-1`, `trade-2`, ... in the order they are requested. */
export function createSequentialIds(prefix = 'trade-'): IdGenerator {
  let count = 0
  return { next: () => `${prefix}${String(++count)}` }
}
