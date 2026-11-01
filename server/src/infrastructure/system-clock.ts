import type { Clock } from '../application/ports.ts'

export const systemClock: Clock = {
  now: () => new Date(),
}
