import { setTimeout as sleep } from 'node:timers/promises'

import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleLifecycleRepository } from '../../src/infrastructure/drizzle-lifecycle-repository.ts'
import type { UtcTimestamp } from '../../src/domain/timestamp.ts'

/**
 * A separate process that cancels one trade, for the concurrent-cancellation test:
 * node cancel-worker.ts <database> <trade id> <cancellation id> <now> <start at, epoch ms>
 * It waits until the start time, so several workers race, then prints one line of JSON.
 */
const [path = '', tradeId = '', cancellationId = '', now = '', startAt = '0'] = process.argv.slice(2)

await sleep(Math.max(0, Number(startAt) - Date.now()))
const db = openDatabase(path)
try {
  const result = await createDrizzleLifecycleRepository(db).cancel(tradeId, { reason: 'Concurrent request' }, { id: cancellationId, now: now as UtcTimestamp })
  console.log(JSON.stringify(result.ok ? { ok: true } : { ok: false, problem: result.problem }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
} finally {
  closeDatabase(db)
}
