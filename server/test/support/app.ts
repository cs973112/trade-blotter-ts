import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'

import type { AppServices } from '../../src/api/app.ts'
import { createPositionService } from '../../src/application/position-service.ts'
import { createTradeService } from '../../src/application/trade-service.ts'
import { loadConfig, type Config } from '../../src/config.ts'
import { createServer } from '../../src/server.ts'
import { createFixedClock, createSequentialIds } from './fixed-clock.ts'
import { createInMemoryTradeRepository } from './in-memory-trade-repository.ts'
import { createTempDir, removeTempDir } from './temp-dir.ts'

/** Services over an in-memory repository, for platform tests that only need an app to exist. */
export function inMemoryServices(): AppServices {
  const trades = createInMemoryTradeRepository()
  return {
    tradeService: createTradeService({ trades, clock: createFixedClock('2026-03-01T12:00:00.000Z'), ids: createSequentialIds() }),
    positionService: createPositionService({ trades }),
  }
}

/** The clock reading every test server starts with. */
export const SERVER_CLOCK = '2026-03-01T12:00:00.000Z'

/**
 * The real application, composed exactly as in production (migrations, Drizzle repository,
 * services, routes) over a database file in a temporary folder, with a fixed clock and sequential
 * ids. `restart()` closes the app and composes a new one on the same file.
 */
export async function createTestServer(env: NodeJS.ProcessEnv = {}) {
  const dir = createTempDir()
  const config: Config = loadConfig({ DOCS_ENABLED: 'true', ...env, DATABASE_PATH: join(dir, 'trade-blotter.db') })
  const clock = createFixedClock(SERVER_CLOCK)
  // One generator for the server's whole life, restarts included, as unique as real UUIDs.
  const ids = createSequentialIds('00000000-0000-4000-8000-')
  const compose = (): Promise<FastifyInstance> => createServer(config, { logger: false, clock, ids })

  let app = await compose()
  return {
    get app(): FastifyInstance {
      return app
    },
    config,
    clock,
    async restart(): Promise<FastifyInstance> {
      await app.close()
      app = await compose()
      return app
    },
    async dispose(): Promise<void> {
      await app.close()
      removeTempDir(dir)
    },
  }
}
