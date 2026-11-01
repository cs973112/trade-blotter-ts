import { randomUUID } from 'node:crypto'

import type { IdGenerator } from '../application/ports.ts'

/** Random (version 4) UUIDs from the platform's cryptographic generator. */
export const uuidGenerator: IdGenerator = {
  next: () => randomUUID(),
}
