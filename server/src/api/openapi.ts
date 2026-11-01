import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'

export const DOCUMENTATION_PREFIX = '/documentation'

/**
 * Generates the OpenAPI 3.1 document from the route schemas and serves Swagger UI at
 * /documentation (JSON at /documentation/json). Must be registered before the routes.
 * Shared schemas added with app.addSchema keep their $id as their components.schemas name.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Trade Blotter API',
        version: '1.0.0',
        description: 'Book trades, list the blotter, and read positions derived from trade history.',
      },
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) => {
        const id = json['$id']
        return typeof id === 'string' ? id : `def-${String(index)}`
      },
    },
  })
  await app.register(swaggerUi, { routePrefix: DOCUMENTATION_PREFIX })
}
