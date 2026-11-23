import { setTimeout as sleep } from 'node:timers/promises'

import type { UtcTimestamp } from '../../src/domain/timestamp.ts'
import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleLifecycleRepository } from '../../src/infrastructure/drizzle-lifecycle-repository.ts'

/**
 * A separate process that executes or cancels one trade, for the concurrent lifecycle tests:
 * node lifecycle-race-worker.ts <database> <execute|cancel> <trade id> <cancellation id> <now> <start at, epoch ms>
 * It waits until the start time, so several workers race, then prints one line of JSON.
 */
const [path = '', operation = '', tradeId = '', cancellationId = '', now = '', startAt = '0'] = process.argv.slice(2)

await sleep(Math.max(0, Number(startAt) - Date.now()))
const db = openDatabase(path)
try {
  const repository = createDrizzleLifecycleRepository(db)
  const result = operation === 'execute'
    ? await repository.execute(tradeId, () => now as UtcTimestamp)
    : await repository.cancel(tradeId, { reason: 'Concurrent request' }, { id: cancellationId, now: now as UtcTimestamp })
  console.log(JSON.stringify(result.ok ? { ok: true, operation } : { ok: false, operation, problem: result.problem }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, operation, error: error instanceof Error ? error.message : String(error) }))
} finally {
  closeDatabase(db)
}
