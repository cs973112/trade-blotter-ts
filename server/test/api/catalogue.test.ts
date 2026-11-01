import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HTTP_SCENARIOS } from '../scenarios/http.ts'
import { TRADE_REQUEST_SCENARIOS } from '../scenarios/trade-requests.ts'
import { createTestServer, SERVER_CLOCK } from '../support/app.ts'
import { JSON_TYPE, postTrade, PROBLEM_TYPE, rawNumbers } from '../support/http.ts'

/**
 * Every trade-request and HTTP scenario from the catalogue, through the real application over a
 * temporary SQLite database. Scenarios run in order against one database, so the booking
 * sequence also proves that a rejected request stores nothing and consumes no sequence number.
 */
let server: Awaited<ReturnType<typeof createTestServer>>
let booked = 0

beforeAll(async () => {
  server = await createTestServer()
})

afterAll(async () => {
  await server.dispose()
})

describe('API: trade request scenarios', () => {
  it.each(TRADE_REQUEST_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const response = await postTrade(server.app, scenario.body)
    const { expected } = scenario

    expect(response.statusCode).toBe(expected.status)

    if (expected.status === 400) {
      expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
      const problem = response.json<{ type: string; status: number; detail?: string; errors?: Record<string, string[]> }>()
      expect(problem.status).toBe(400)
      if (expected.fields.length === 0) {
        expect(problem.type).toBe('about:blank')
        expect(problem.errors).toBeUndefined()
      } else {
        expect(problem.type).toBe('urn:trade-blotter:problem:invalid-trade')
        expect(Object.keys(problem.errors ?? {})).toEqual(expected.fields)
        for (const messages of Object.values(problem.errors ?? {})) expect(messages).toEqual([expect.any(String)])
        expect(problem.detail).toBe(Object.values(problem.errors ?? {})[0]?.[0])
      }
      return
    }

    booked++
    expect(response.headers['content-type']).toBe(JSON_TYPE)
    const trade = response.json<Record<string, unknown>>()
    expect(trade).toMatchObject({
      bookingSequence: booked,
      symbol: expected.symbol,
      side: expected.side,
      executedAt: expected.executedAt === 'server clock' ? SERVER_CLOCK : expected.executedAt,
      createdAt: SERVER_CLOCK,
      updatedAt: SERVER_CLOCK,
    })
    expect(rawNumbers(response.body, 'quantity')).toEqual([expected.quantity])
    expect(rawNumbers(response.body, 'price')).toEqual([expected.price])
    expect(rawNumbers(response.body, 'notional')).toEqual([expected.notional])
  })

  it('stored exactly the accepted scenarios', async () => {
    const trades = (await server.app.inject({ method: 'GET', url: '/trades' })).json<unknown[]>()

    expect(trades).toHaveLength(booked)
    expect(booked).toBe(TRADE_REQUEST_SCENARIOS.filter((scenario) => scenario.expected.status === 201).length)
  })
})

describe('API: HTTP scenarios', () => {
  it.each(HTTP_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const response = await server.app.inject({
      method: scenario.method,
      url: scenario.path,
      ...(scenario.headers === undefined ? {} : { headers: scenario.headers }),
      ...(scenario.body === undefined ? {} : { payload: scenario.body }),
    })

    expect(response.statusCode).toBe(scenario.expected.status)
    expect(response.headers['allow']).toBe(scenario.expected.allow)
    if (scenario.expected.status >= 400) {
      expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
      expect(response.json()).toMatchObject({ type: 'about:blank', status: scenario.expected.status })
    }
  })
})
