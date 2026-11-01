import type { FastifyInstance, FastifyServerOptions } from 'fastify'

import { buildApp } from './api/app.ts'
import type { Clock, IdGenerator } from './application/ports.ts'
import { createPositionService } from './application/position-service.ts'
import { createTradeService } from './application/trade-service.ts'
import type { Config } from './config.ts'
import { closeDatabase, openDatabase } from './infrastructure/database/connection.ts'
import { applyMigrations } from './infrastructure/database/migrate.ts'
import { createDrizzleTradeRepository } from './infrastructure/drizzle-trade-repository.ts'
import { systemClock } from './infrastructure/system-clock.ts'
import { uuidGenerator } from './infrastructure/uuid-generator.ts'

export interface ServerOverrides {
  readonly logger?: NonNullable<FastifyServerOptions['logger']>
  readonly clock?: Clock
  readonly ids?: IdGenerator
}

/**
 * Composition: opens the database, applies pending migrations, and builds the repository, the
 * services and the Fastify app, passing each its dependencies. Does not listen. If a migration
 * fails, the database is closed and the error is thrown before any route exists, so no request is
 * ever served against an incompatible schema. Closing the app closes the database.
 */
export async function createServer(config: Config, overrides: ServerOverrides = {}): Promise<FastifyInstance> {
  const db = openDatabase(config.databasePath)
  try {
    applyMigrations(db)
    const trades = createDrizzleTradeRepository(db)
    const app = await buildApp({
      logger: overrides.logger ?? { level: config.logLevel },
      docs: config.docsEnabled,
      services: {
        tradeService: createTradeService({
          trades,
          clock: overrides.clock ?? systemClock,
          ids: overrides.ids ?? uuidGenerator,
          symbolMaxLength: config.symbolMaxLength,
        }),
        positionService: createPositionService({ trades }),
      },
    })
    app.addHook('onClose', (_instance, done) => {
      closeDatabase(db)
      done()
    })
    return app
  } catch (error) {
    closeDatabase(db)
    throw error
  }
}

/**
 * Starts the HTTP server. On SIGINT or SIGTERM it stops accepting connections, finishes
 * in-flight requests, closes the database and exits.
 */
export async function startServer(config: Config): Promise<void> {
  const app = await createServer(config)

  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'Shutting down')
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    await app.close()
    throw error
  }
  app.log.info({ databasePath: config.databasePath }, 'Database ready')
}
