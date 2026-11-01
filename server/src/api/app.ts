import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'

import type { PositionService } from '../application/position-service.ts'
import type { TradeService } from '../application/trade-service.ts'
import { registerLosslessJson } from './json.ts'
import { registerOpenApi } from './openapi.ts'
import { registerProblemDetails } from './problem-details.ts'
import { positionRoutes } from './routes/positions.ts'
import { tradeRoutes } from './routes/trades.ts'
import { SHARED_SCHEMAS } from './schemas.ts'

export interface AppServices {
  readonly tradeService: TradeService
  readonly positionService: PositionService
}

export interface AppOptions {
  readonly logger: NonNullable<FastifyServerOptions['logger']>
  readonly docs: boolean
  readonly services: AppServices
}

/** Request fields carried as exact decimals. */
const DECIMAL_FIELDS = ['quantity', 'price']

/**
 * Builds the Fastify application around the given services, without starting it, so tests can
 * drive it through inject(). A trailing slash is ignored (/trades/ is /trades), and validation
 * never coerces types.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger,
    routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { coerceTypes: false } },
  })

  registerLosslessJson(app, { decimalFields: DECIMAL_FIELDS })
  registerProblemDetails(app)
  for (const schema of SHARED_SCHEMAS) app.addSchema(schema)
  if (options.docs) {
    await registerOpenApi(app)
  }

  await app.register(tradeRoutes, { tradeService: options.services.tradeService })
  await app.register(positionRoutes, { positionService: options.services.positionService })

  return app
}
