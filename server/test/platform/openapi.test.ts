import { Validator } from '@seriousme/openapi-schema-validator'
import type { FastifyInstance } from 'fastify'
import { Type } from 'typebox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/api/app.ts'
import { JSON_NUMBER_PATTERN } from '../../src/api/json.ts'
import { inMemoryServices } from '../support/app.ts'

/**
 * S3: TypeBox route schemas generate a valid OpenAPI 3.1 document, shared schemas keep their
 * names under components.schemas, and Swagger UI is served at /documentation. The route here
 * is a test fixture only.
 */
interface OpenApiDocument {
  openapi: string
  info: { title: string }
  paths: Record<string, Record<string, Record<string, unknown>>>
  components?: { schemas?: Record<string, Record<string, unknown>> }
}

describe('platform: OpenAPI and Swagger UI', () => {
  let app: FastifyInstance
  let document: OpenApiDocument

  beforeAll(async () => {
    app = await buildApp({ logger: false, docs: true, services: inMemoryServices() })

    app.addSchema(
      Type.Object(
        {
          quantity: Type.Union([Type.Number(), Type.String({ pattern: JSON_NUMBER_PATTERN })]),
          executedAt: Type.Optional(
            Type.Union([Type.String({ format: 'date-time', description: 'RFC 3339 date-time with offset.' }), Type.Null()]),
          ),
        },
        { $id: 'SampleRequest' },
      ),
    )
    app.addSchema(Type.Object({ quantity: Type.Number() }, { $id: 'SampleResponse' }))

    app.post('/samples', {
      schema: {
        tags: ['Samples'],
        operationId: 'CreateSample',
        summary: 'Fixture route for the OpenAPI platform test.',
        body: Type.Ref('SampleRequest'),
        response: { 201: Type.Ref('SampleResponse') },
      },
      handler: async (_request, reply) => reply.code(201).send({ quantity: 1 }),
    })

    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/documentation/json' })
    expect(response.statusCode).toBe(200)
    document = response.json<OpenApiDocument>()
  })

  afterAll(async () => {
    await app.close()
  })

  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(document as unknown as Record<string, unknown>)

    expect(result.errors ?? []).toEqual([])
    expect(result.valid).toBe(true)
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.title).toBe('Trade Blotter API')
  })

  it('describes the route from its schema, with named shared components', () => {
    const operation = document.paths['/samples']?.['post']

    expect(operation).toMatchObject({ operationId: 'CreateSample', tags: ['Samples'] })
    expect(document.components?.schemas).toHaveProperty('SampleRequest')
    expect(document.components?.schemas).toHaveProperty('SampleResponse')
    expect(JSON.stringify(operation)).toContain('#/components/schemas/SampleRequest')
  })

  it('documents a decimal as number-or-numeric-string and an execution time as an RFC 3339 date-time', () => {
    const request = document.components?.schemas?.['SampleRequest'] as {
      properties: Record<string, unknown>
    }

    expect(request.properties['quantity']).toEqual({
      anyOf: [{ type: 'number' }, { type: 'string', pattern: JSON_NUMBER_PATTERN }],
    })
    expect(JSON.stringify(request.properties['executedAt'])).toContain('"format":"date-time"')
  })

  it('serves Swagger UI at /documentation', async () => {
    const entry = await app.inject({ method: 'GET', url: '/documentation' })
    const location = entry.headers.location
    const page =
      entry.statusCode === 200 || typeof location !== 'string'
        ? entry
        : await app.inject({ method: 'GET', url: new URL(location, 'http://localhost/documentation/').pathname })

    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('swagger-ui')
  })
})
