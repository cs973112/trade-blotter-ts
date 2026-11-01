import { Validator } from '@seriousme/openapi-schema-validator'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'

import { createTestServer } from '../support/app.ts'

interface Schema {
  readonly type?: string
  readonly readOnly?: boolean
  readonly description?: string
  readonly properties?: Record<string, Schema>
  readonly required?: string[]
}

interface Operation {
  readonly operationId: string
  readonly requestBody?: { content: Record<string, { schema: { $ref: string } }> }
  readonly responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>
}

interface OpenApiDocument {
  readonly openapi: string
  readonly paths: Record<string, Record<string, Operation>>
  readonly components: { schemas: Record<string, Schema> }
}

let server: Awaited<ReturnType<typeof createTestServer>>
let document: OpenApiDocument

beforeAll(async () => {
  server = await createTestServer()
  const response = await server.app.inject({ method: 'GET', url: '/documentation/json' })
  expect(response.statusCode).toBe(200)
  document = response.json<OpenApiDocument>()
})

afterAll(async () => {
  await server.dispose()
})

const operation = (path: string, method: string): Operation => {
  const found = document.paths[path]?.[method]
  if (found === undefined) throw new Error(`${method.toUpperCase()} ${path} is not documented`)
  return found
}

const schema = (name: string): Schema => {
  const found = document.components.schemas[name]
  if (found === undefined) throw new Error(`${name} is not a component`)
  return found
}

describe('API: OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(document as unknown as Record<string, unknown>)

    expect(result.errors ?? []).toEqual([])
    expect(result.valid).toBe(true)
    expect(document.openapi).toBe('3.1.0')
  })

  it('documents exactly the three endpoints', () => {
    const operations = Object.entries(document.paths)
      .filter(([path]) => !path.startsWith('/documentation'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => `${method.toUpperCase()} ${path} ${op.operationId}`))

    expect(operations.sort()).toEqual(['GET /positions listPositions', 'GET /trades listTrades', 'POST /trades createTrade'])
  })

  it('documents the request body, its decimal rules and executedAt default', () => {
    const request = schema('CreateTradeRequest')
    const json = JSON.stringify(request)

    expect(operation('/trades', 'post').requestBody?.content['application/json']?.schema.$ref)
      .toBe('#/components/schemas/CreateTradeRequest')
    expect(Object.keys(request.properties ?? {})).toEqual(['symbol', 'side', 'quantity', 'price', 'executedAt'])
    expect(request.required).toEqual(['symbol', 'side', 'quantity', 'price'])
    expect(json).toContain('at most 10 decimal places')
    expect(json).toContain('Omitted or null: the server clock')
    expect(request.description).toContain('id, bookingSequence, createdAt and updatedAt are assigned by the server')
  })

  it('marks the server-managed response fields read-only', () => {
    const trade = schema('Trade').properties ?? {}
    const readOnly = Object.entries(trade).filter(([, property]) => property.readOnly === true).map(([name]) => name)

    expect(readOnly).toEqual(['id', 'bookingSequence', 'notional', 'createdAt', 'updatedAt'])
    expect(Object.keys(trade)).toEqual(
      ['id', 'bookingSequence', 'symbol', 'side', 'quantity', 'price', 'notional', 'executedAt', 'createdAt', 'updatedAt'],
    )
    expect(Object.keys(schema('Position').properties ?? {})).toEqual(['symbol', 'netQuantity', 'averageCost'])
  })

  it('documents error responses as problem details', () => {
    const create = operation('/trades', 'post').responses
    const problemRef = { schema: { $ref: '#/components/schemas/Problem' } }

    expect(Object.keys(create).sort()).toEqual(['201', '400', '415', '500'])
    for (const status of ['400', '415', '500']) expect(create[status]?.content).toEqual({ 'application/problem+json': problemRef })
    expect(create['400']?.description).toContain('urn:trade-blotter:problem:position-limit')
    expect(operation('/trades', 'get').responses['500']?.content).toEqual({ 'application/problem+json': problemRef })
    expect(operation('/positions', 'get').responses['500']?.content).toEqual({ 'application/problem+json': problemRef })
    expect(Object.keys(schema('Problem').properties ?? {})).toEqual(['type', 'title', 'status', 'detail', 'errors', 'symbol'])
  })

  it('serves Swagger UI at /documentation', async () => {
    const entry = await server.app.inject({ method: 'GET', url: '/documentation' })
    const location = entry.headers.location
    const page = entry.statusCode === 200 || typeof location !== 'string'
      ? entry
      : await server.app.inject({ method: 'GET', url: new URL(location, 'http://localhost/documentation/').pathname })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('swagger-ui')
  })

  it('can be switched off', async () => {
    const quiet = await createTestServer({ DOCS_ENABLED: 'false' })
    onTestFinished(() => quiet.dispose())

    expect((await quiet.app.inject({ method: 'GET', url: '/documentation/json' })).statusCode).toBe(404)
    expect((await quiet.app.inject({ method: 'GET', url: '/trades' })).statusCode).toBe(200)
  })
})
