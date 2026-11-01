import type { FastifyInstance } from 'fastify'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/api/app.ts'
import { JSON_NUMBER_PATTERN, rawJsonNumber } from '../../src/api/json.ts'
import { inMemoryServices } from '../support/app.ts'

/**
 * S2: decimals pass through Fastify without touching a JavaScript number, in both directions,
 * while non-decimal values keep strict JSON typing. The route here is a test fixture only.
 */
const Decimal = Type.Union([Type.Number(), Type.String({ pattern: JSON_NUMBER_PATTERN })])

const EchoBody = Type.Object({
  symbol: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  quantity: Type.Optional(Decimal),
  price: Type.Optional(Decimal),
})

const EchoResponse = Type.Object({ quantity: Type.Number(), price: Type.Number(), received: Type.String() })

async function echoApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false, docs: false, services: inMemoryServices() })

  const handler = (request: { body: unknown }) => {
    const body = request.body as { quantity?: string; price?: string }
    return {
      quantity: rawJsonNumber(body.quantity ?? '0'),
      price: rawJsonNumber(body.price ?? '0'),
      received: typeof body.quantity,
    }
  }

  app.post('/echo', { schema: { body: EchoBody, response: { 200: EchoResponse } }, handler })
  app.post('/echo-unschematized', handler)

  await app.ready()
  return app
}

function post(app: FastifyInstance, payload: string, contentType = 'application/json', url = '/echo') {
  return app.inject({ method: 'POST', url, headers: { 'content-type': contentType }, payload })
}

describe('platform: lossless JSON through Fastify', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await echoApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it.each([
    ['the largest accepted quantity', '999999999999999.9999999999'],
    ['the smallest accepted price', '0.0000000001'],
    ['more digits than a double holds', '123456789012345.1234567891'],
    ['a value a double would round', '0.1000000000000000055511151231257827'],
    ['trailing zeros', '10.50'],
  ])('round-trips %s exactly as a JSON number', async (_name, digits) => {
    const response = await post(app, `{"quantity": ${digits}, "price": 1}`)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.body).toBe(`{"quantity":${digits},"price":1,"received":"string"}`)
  })

  it('also writes exact numbers from routes without a response schema', async () => {
    const response = await post(app, '{"quantity": 0.12345678901234567890}', 'application/json', '/echo-unschematized')

    expect(response.body).toBe('{"quantity":0.12345678901234567890,"price":0,"received":"string"}')
  })

  it('accepts a decimal sent as a numeric string', async () => {
    const response = await post(app, '{"quantity": "10.50", "price": "2"}')

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('{"quantity":10.50,"price":2,"received":"string"}')
  })

  it('keeps an out-of-range number as text instead of turning it into Infinity', async () => {
    const response = await post(app, '{"quantity": 1e400}')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('"quantity":1e400')
  })

  it('preserves only exactly named decimal fields; other names stay ordinary JSON values', async () => {
    const response = await post(app, '{"QUANTITY": 1.25, "price": 3}', 'application/json', '/echo-unschematized')

    expect(response.body).toBe('{"quantity":0,"price":3,"received":"undefined"}')
  })

  it('rejects a non-numeric decimal string and a number where a string is expected', async () => {
    const badDecimal = await post(app, '{"quantity": "abc"}')
    const numericSymbol = await post(app, '{"symbol": 123, "quantity": 1}')

    for (const response of [badDecimal, numericSymbol]) {
      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8')
      expect(response.json()).toMatchObject({ type: 'about:blank', status: 400, title: 'Bad Request' })
    }
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['an empty body', ''],
    ['a prototype-poisoning key', '{"__proto__": {"polluted": true}}'],
  ])('rejects %s with a 400 problem', async (_name, payload) => {
    const response = await post(app, payload)

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('accepts JSON media type variants and rejects non-JSON bodies with 415', async () => {
    const withCharset = await post(app, '{"quantity": 1}', 'application/json; charset=utf-8')
    const suffixed = await post(app, '{"quantity": 1}', 'application/vnd.trade+json')
    const plainText = await post(app, '{"quantity": 1}', 'text/plain')

    expect(withCharset.statusCode).toBe(200)
    expect(suffixed.statusCode).toBe(200)
    expect(plainText.statusCode).toBe(415)
    expect(plainText.headers['content-type']).toBe('application/problem+json; charset=utf-8')
    expect(plainText.json()).toMatchObject({ status: 415, title: 'Unsupported Media Type' })
  })

  it('ignores a trailing slash but matches path case exactly', async () => {
    const trailingSlash = await post(app, '{"quantity": 1}', 'application/json', '/echo/')
    const upperCase = await post(app, '{"quantity": 1}', 'application/json', '/ECHO')

    expect(trailingSlash.statusCode).toBe(200)
    expect(upperCase.statusCode).toBe(404)
  })
})
