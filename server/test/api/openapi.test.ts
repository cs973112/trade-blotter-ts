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
  readonly parameters?: { name: string; in: string; required: boolean; description: string; schema: Record<string, unknown> }[]
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

  it('documents exactly the four endpoints', () => {
    const operations = Object.entries(document.paths)
      .filter(([path]) => !path.startsWith('/documentation'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => `${method.toUpperCase()} ${path} ${op.operationId}`))

    expect(operations.sort()).toEqual([
      'GET /positions listPositions', 'GET /trades listTrades', 'GET /trades/page listTradePage', 'POST /trades createTrade',
    ])
  })

  it('documents GET /trades/page: the GET /trades parameters, then page and pageSize with their limits and defaults', () => {
    const page = operation('/trades/page', 'get')
    const parameters = page.parameters ?? []
    const byName = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter]))
    const list = operation('/trades', 'get').parameters ?? []

    expect(parameters.map((parameter) => [parameter.name, parameter.in, parameter.required])).toEqual([
      ...list.map((parameter) => [parameter.name, parameter.in, parameter.required]), ['page', 'query', false], ['pageSize', 'query', false],
    ])
    for (const parameter of list) expect(byName[parameter.name]).toEqual(parameter)
    expect(byName['page']?.schema).toEqual({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 })
    expect(byName['pageSize']?.schema).toEqual({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
    expect(byName['page']?.description).toContain('A page past the last is not an error')
    expect(page.responses['200']?.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/TradePage' })
    expect(page.responses['400']?.description).toContain('urn:trade-blotter:problem:invalid-query')
    expect(Object.keys(page.responses).sort()).toEqual(['200', '400', '500'])
  })

  it('documents the page envelope', () => {
    const envelope = schema('TradePage')

    expect(Object.keys(envelope.properties ?? {})).toEqual(['items', 'page', 'pageSize', 'totalCount', 'totalPages'])
    expect(envelope.required).toEqual(['items', 'page', 'pageSize', 'totalCount', 'totalPages'])
    expect(JSON.stringify(envelope.properties?.['items'])).toContain('#/components/schemas/Trade')
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

  it('documents the GET /trades query parameters, all optional, with their formats and defaults', () => {
    const parameters = operation('/trades', 'get').parameters ?? []
    const byName = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter]))

    expect(parameters.map((parameter) => [parameter.name, parameter.in, parameter.required])).toEqual([
      ['symbol', 'query', false], ['side', 'query', false], ['executedFrom', 'query', false],
      ['executedTo', 'query', false], ['sortBy', 'query', false], ['sortDirection', 'query', false],
    ])
    expect(byName['symbol']?.description).toContain('contains this text, anywhere in it, ignoring case')
    for (const name of ['executedFrom', 'executedTo']) {
      expect(byName[name]?.schema).toMatchObject({ type: 'string', format: 'date-time' })
      expect(byName[name]?.description).toContain('(inclusive)')
      expect(byName[name]?.description).toContain('a date alone or a time without an offset is refused')
      expect(byName[name]?.description).toContain('%2B')
    }
    expect(byName['sortBy']?.schema).toEqual({ enum: ['executedAt', 'symbol', 'quantity', 'price'], default: 'executedAt' })
    expect(byName['sortDirection']?.schema).toEqual({ enum: ['asc', 'desc'], default: 'desc' })
    expect(byName['sortBy']?.description).toContain('Ties are broken by executedAt, then bookingSequence')
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
    const list = operation('/trades', 'get').responses
    expect(Object.keys(list).sort()).toEqual(['200', '400', '500'])
    for (const status of ['400', '500']) expect(list[status]?.content).toEqual({ 'application/problem+json': problemRef })
    expect(list['400']?.description).toContain('urn:trade-blotter:problem:invalid-query')
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
