import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/api/app.ts'
import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTestServer, inMemoryServices, SERVER_CLOCK } from '../support/app.ts'
import { postTrade, PROBLEM_TYPE, rawNumbers } from '../support/http.ts'
import { newTrade } from '../support/trades.ts'

let server: Awaited<ReturnType<typeof createTestServer>>

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(async () => {
  await server.dispose()
})

const post = (members: Record<string, unknown>) => postTrade(server.app, JSON.stringify(members))
const get = async (url: string) => server.app.inject({ method: 'GET', url })
const trade = (symbol: string, side: string, quantity: string, price: string, executedAt?: string) =>
  postTrade(server.app, `{"symbol":"${symbol}","side":"${side}","quantity":${quantity},"price":${price}` +
    `${executedAt === undefined ? '' : `,"executedAt":"${executedAt}"`}}`)

describe('API: POST /trades', () => {
  it('creates a trade and returns it, exactly as stored, with 201', async () => {
    const response = await postTrade(server.app,
      '{"symbol":" msft ","side":"buy","quantity":10.5,"price":"301.25","executedAt":"2026-01-02T09:30:00.123-05:00"}')

    expect(response.statusCode).toBe(201)
    expect(response.body).toBe(
      '{"id":"00000000-0000-4000-8000-1","bookingSequence":1,"symbol":"MSFT","side":"Buy","quantity":10.5,"price":301.25,' +
        '"notional":3163.125,"executedAt":"2026-01-02T14:30:00.123Z","createdAt":"2026-03-01T12:00:00.000Z",' +
        '"updatedAt":"2026-03-01T12:00:00.000Z"}',
    )
    expect((await get('/trades')).body).toBe(`[${response.body}]`)
  })

  it('uses the server clock for executedAt when it is omitted or null, and for createdAt and updatedAt always', async () => {
    const omitted = (await post({ symbol: 'A', side: 'Buy', quantity: 1, price: 1 })).json<Record<string, string>>()
    server.clock.set('2026-03-01T12:00:05.000Z')
    const nulled = (await post({ symbol: 'A', side: 'Buy', quantity: 1, price: 1, executedAt: null })).json<Record<string, string>>()

    expect([omitted['executedAt'], omitted['createdAt'], omitted['updatedAt']]).toEqual([SERVER_CLOCK, SERVER_CLOCK, SERVER_CLOCK])
    expect([nulled['executedAt'], nulled['createdAt'], nulled['updatedAt']])
      .toEqual(['2026-03-01T12:00:05.000Z', '2026-03-01T12:00:05.000Z', '2026-03-01T12:00:05.000Z'])
  })

  it.each([
    ['2026-01-01T09:00:00Z', '2026-01-01T09:00:00.000Z'],
    ['2026-01-01T09:00:00.5+05:30', '2026-01-01T03:30:00.500Z'],
    ['2026-01-01T23:30:00-08:00', '2026-01-02T07:30:00.000Z'],
    ['2026-01-01t09:00:00.999z', '2026-01-01T09:00:00.999Z'],
    ['2099-12-31T23:59:59.999+00:00', '2099-12-31T23:59:59.999Z'],
  ])('normalises executedAt %s to UTC as %s, keeping server-owned createdAt', async (sent, utc) => {
    const created = (await post({ symbol: 'A', side: 'Sell', quantity: 1, price: 1, executedAt: sent })).json<Record<string, string>>()

    expect(created['executedAt']).toBe(utc)
    expect(created['createdAt']).toBe(SERVER_CLOCK)
  })

  it('ignores server-managed fields sent by the client', async () => {
    const response = await post({
      symbol: 'A', side: 'Buy', quantity: 2, price: 3,
      id: 'client-chosen', bookingSequence: 999, createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z', notional: 1,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: '00000000-0000-4000-8000-1', bookingSequence: 1, notional: 6, createdAt: SERVER_CLOCK, updatedAt: SERVER_CLOCK,
    })
  })

  it('reports every invalid field together, in field order, with one message each', async () => {
    const response = await postTrade(server.app,
      '{"executedAt":"yesterday","price":-1,"quantity":"1e15","side":"hold","symbol":"   "}')

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.body).toBe(JSON.stringify({
      type: 'urn:trade-blotter:problem:invalid-trade',
      title: 'Invalid trade',
      status: 400,
      detail: 'Symbol is required.',
      errors: {
        symbol: ['Symbol is required.'],
        side: ['Side must be Buy or Sell.'],
        quantity: ['Quantity must be less than 10^15 with at most 10 decimal places.'],
        price: ['Price must be greater than zero.'],
        executedAt: ['Execution time must be an RFC 3339 date-time with an offset, such as 2026-01-01T09:00:00Z.'],
      },
    }))
  })

  it('explains a body that is not an object or not JSON', async () => {
    const array = await postTrade(server.app, '[]')
    const malformed = await postTrade(server.app, '{"symbol":')

    expect(array.json()).toEqual({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'The request body must be a JSON object.' })
    expect(malformed.json()).toEqual({
      type: 'about:blank', title: 'Bad Request', status: 400, detail: 'The request body is not valid JSON.',
    })
  })

  it.each([
    ['a syntax error', '{"symbol":"C:/Users/someone/secret.db" "side"}', 'The request body is not valid JSON (at character 39).'],
    ['a truncated body', '{"symbol":"SECRET_MARKER', 'The request body is not valid JSON (at character 24).'],
    ['a body that ends early', 'tru', 'The request body is not valid JSON.'],
    ['a __proto__ key', '{"__proto__":{"isAdmin":true}}',
      'The request body contains a forbidden property name (__proto__, or constructor with prototype).'],
    ['a constructor.prototype key', '{"constructor":{"prototype":{"isAdmin":true}}}',
      'The request body contains a forbidden property name (__proto__, or constructor with prototype).'],
    ['an empty body', '', 'The request body is empty.'],
  ])('answers %s with a fixed message that reveals nothing of the body or the server', async (_name, body, detail) => {
    const response = await postTrade(server.app, body)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ type: 'about:blank', title: 'Bad Request', status: 400, detail })
    for (const leak of ['secret', 'SECRET_MARKER', 'C:/', 'node_modules', 'secure-json', 'reviver', '    at ', 'SyntaxError']) {
      expect(response.body).not.toContain(leak)
    }
  })

  it('refuses a body larger than 1 MiB with 413', async () => {
    const response = await postTrade(server.app, `{"symbol":"A","padding":"${'x'.repeat(1024 * 1024)}"}`)

    expect(response.statusCode).toBe(413)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.json()).toEqual({ type: 'about:blank', title: 'Payload Too Large', status: 413 })
  })

  it.each([
    ['ten decimal places', '0.0000000001', '123.4567890123'],
    ['the largest values', '999999999999999.9999999999', '999999999999999.9999999999'],
    ['more digits than a double holds', '123456789012345.1234567891', '0.1'],
    ['numeric strings', '"10.0000000001"', '"7.5"'],
  ])('round-trips %s exactly, on creation and when listed', async (_name, quantity, price) => {
    const response = await trade('A', 'Buy', quantity, price)
    const listed = await get('/trades')
    const plain = (text: string) => text.replaceAll('"', '')

    expect(response.statusCode).toBe(201)
    for (const body of [response.body, listed.body]) {
      expect(rawNumbers(body, 'quantity')).toEqual([plain(quantity)])
      expect(rawNumbers(body, 'price')).toEqual([plain(price)])
    }
  })

  it('sends the largest notional exactly', async () => {
    const response = await trade('A', 'Buy', '999999999999999.9999999999', '999999999999999.9999999999')

    expect(rawNumbers(response.body, 'notional')).toEqual(['999999999999999999999999800000.00000000000000000001'])
  })

  it('refuses a trade that would breach the position limit with 400, storing nothing and using no booking sequence', async () => {
    // Reaching 10^30 takes about 10^15 maximum-size trades, which no test can send. One oversized
    // trade is stored directly through the repository instead: this exercises the API's rejection
    // and rollback, not a limit that ordinary valid requests can reach.
    const seeding = openDatabase(server.config.databasePath)
    await createDrizzleTradeRepository(seeding).add(newTrade({ symbol: 'BIG', quantity: '999999999999999000000000000001' }))
    closeDatabase(seeding)
    const before = (await get('/trades')).body

    const response = await trade('BIG', 'Buy', '999999999999999', '1')

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.json()).toEqual({
      type: 'urn:trade-blotter:problem:position-limit',
      title: 'Position limit exceeded',
      status: 400,
      detail: 'The net quantity of BIG reached the position limit of 1e30.',
      symbol: 'BIG',
    })
    expect((await get('/trades')).body).toBe(before)
    expect((await trade('BIG', 'Sell', '1', '1')).json()).toMatchObject({ bookingSequence: 2 })
  })

  it('answers an unexpected database error with a bare 500 and stores nothing', async () => {
    const sabotage = openDatabase(server.config.databasePath)
    sabotage.$client.exec('alter table trades rename to trades_elsewhere')
    closeDatabase(sabotage)

    const response = await trade('A', 'Buy', '1', '1')

    expect(response.statusCode).toBe(500)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.body).toBe('{"type":"about:blank","title":"Internal Server Error","status":500}')
  })

  it('never shows an internal error message to the client', async () => {
    const services = inMemoryServices()
    const failing = {
      ...services,
      tradeService: { ...services.tradeService, listTrades: () => Promise.reject(new Error('secret: C:/data/trades.db is corrupt')) },
    }
    const app = await buildApp({ logger: false, docs: false, services: failing })

    const response = await app.inject({ method: 'GET', url: '/trades' })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('secret')
    await app.close()
  })
})

describe('API: GET /trades', () => {
  it('lists newest execution first; equal execution times newest booking first; recording time plays no part', async () => {
    await trade('A', 'Buy', '1', '1', '2026-01-01T09:00:00Z') // 1
    await trade('B', 'Buy', '1', '1', '2026-01-01T10:00:00Z') // 2
    server.clock.set('2026-03-05T00:00:00.000Z')
    await trade('C', 'Buy', '1', '1', '2026-01-01T08:00:00Z') // 3: recorded last, executed first
    await trade('D', 'Buy', '1', '1', '2026-01-01T09:00:00Z') // 4: same execution time as A

    const listed = (await get('/trades')).json<{ symbol: string; bookingSequence: number }[]>()

    expect(listed.map((row) => [row.symbol, row.bookingSequence])).toEqual([['B', 2], ['D', 4], ['A', 1], ['C', 3]])
  })

  it('returns an empty array when there are no trades', async () => {
    const response = await get('/trades')

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('[]')
  })
})

describe('API: GET /positions', () => {
  it('applies the accounting rules through open, increase, reduce, close, reopen short, cross', async () => {
    const fills = [
      ['Buy', '100', '10'], ['Buy', '100', '20'], ['Sell', '50', '25'], ['Sell', '150', '18'],
      ['Sell', '100', '12'], ['Sell', '100', '16'], ['Buy', '50', '11'], ['Buy', '250', '13'],
    ] as const
    for (const [index, [side, quantity, price]] of fills.entries()) {
      await trade('WALK', side, quantity, price, `2026-01-01T09:00:0${String(index)}Z`)
    }

    expect((await get('/positions')).body).toBe('[{"symbol":"WALK","netQuantity":100,"averageCost":13}]')
  })

  it('omits flat positions, sorts by symbol and keeps recurring averages to 50 significant digits', async () => {
    await trade('msft', 'Buy', '1', '1')
    await trade('MSFT', 'Buy', '2', '2')
    await trade('aapl', 'Sell', '0.1', '3')
    await trade('flat', 'Buy', '0.1', '1')
    await trade('flat', 'Buy', '0.2', '1')
    await trade('FLAT', 'Sell', '0.3', '2')

    expect((await get('/positions')).body).toBe(
      `[{"symbol":"AAPL","netQuantity":-0.1,"averageCost":3},{"symbol":"MSFT","netQuantity":3,"averageCost":1.${'6'.repeat(48)}7}]`,
    )
  })

  it('places a trade booked late at its execution time', async () => {
    await trade('X', 'Buy', '100', '10', '2026-01-01T09:00:00Z')
    await trade('X', 'Sell', '100', '12', '2026-01-01T11:00:00Z')
    await trade('X', 'Buy', '100', '20', '2026-01-01T10:00:00Z') // executed between the two above

    expect((await get('/positions')).body).toBe('[{"symbol":"X","netQuantity":100,"averageCost":15}]')
  })

  it('breaks execution-time ties by booking sequence', async () => {
    const at = '2026-01-01T09:00:00Z'
    for (const [side, quantity, price] of [['Buy', '10', '20'], ['Sell', '17', '21'], ['Buy', '24', '22'], ['Sell', '31', '23'],
      ['Buy', '38', '24'], ['Sell', '45', '25']] as const) {
      await trade('TIE', side, quantity, price, at)
    }

    expect((await get('/positions')).body).toBe('[{"symbol":"TIE","netQuantity":-21,"averageCost":25}]')
  })

  it('returns an empty array when every position is flat', async () => {
    await trade('A', 'Buy', '1', '1')
    await trade('A', 'Sell', '1', '1')

    expect((await get('/positions')).body).toBe('[]')
  })
})
