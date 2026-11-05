import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from '../src/api/client.ts'
import type { CreateTradeRequest } from '../src/api/contracts.ts'
import { fakeApi, json, problem, tradeJson } from './support/fake-api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const TRADE = tradeJson({
  id: 't1', bookingSequence: 7, symbol: 'MSFT', side: 'Buy',
  quantity: '123456789012345.1234567891', price: '0.0000000001', notional: '12345.67890123451234567891',
  executedAt: '2026-01-02T14:30:00.123Z',
})

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Expected an ApiError.')
}

describe('API client: POST /trades', () => {
  it('sends only the request fields, with decimals as the exact text typed', async () => {
    const server = fakeApi({ 'POST /trades': json(TRADE, 201) })
    const request = {
      symbol: 'MSFT', side: 'Buy', quantity: '123456789012345.1234567891', price: '10.50', executedAt: '2026-01-02T09:30:00-05:00',
      id: 'mine', bookingSequence: 1, createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z',
    } as CreateTradeRequest

    await api.createTrade(request)

    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: 'POST', url: '/trades', headers: { 'content-type': 'application/json' } })
    expect(server.calls[0]?.body).toBe(
      '{"symbol":"MSFT","side":"Buy","quantity":"123456789012345.1234567891","price":"10.50","executedAt":"2026-01-02T09:30:00-05:00"}',
    )
  })

  it('leaves executedAt out when there is none', async () => {
    const server = fakeApi({ 'POST /trades': json(TRADE, 201) })

    await api.createTrade({ symbol: 'A', side: 'Sell', quantity: '1', price: '2' })

    expect(server.calls[0]?.body).toBe('{"symbol":"A","side":"Sell","quantity":"1","price":"2"}')
  })

  it('returns the stored trade with every digit of its decimals', async () => {
    fakeApi({ 'POST /trades': json(TRADE, 201) })

    expect(await api.createTrade({ symbol: 'MSFT', side: 'Buy', quantity: '1', price: '1' })).toEqual({
      id: 't1', bookingSequence: 7, symbol: 'MSFT', side: 'Buy',
      quantity: '123456789012345.1234567891', price: '0.0000000001', notional: '12345.67890123451234567891',
      executedAt: '2026-01-02T14:30:00.123Z', createdAt: '2026-03-01T12:00:00.000Z', updatedAt: '2026-03-01T12:00:00.000Z',
    })
  })

  it('turns an invalid-trade problem into field errors, keeping only known fields', async () => {
    fakeApi({
      'POST /trades': problem(400, {
        type: 'urn:trade-blotter:problem:invalid-trade',
        detail: 'Symbol is required.',
        errors: { symbol: ['Symbol is required.'], price: ['Price must be greater than zero.'], internal: ['x'], side: 'not a list' },
      }),
    })

    const error = await failure(api.createTrade({ symbol: '', side: 'Buy', quantity: '1', price: '0' }))

    expect(error.kind).toBe('invalid-trade')
    expect(error.fieldErrors).toEqual({ symbol: ['Symbol is required.'], price: ['Price must be greater than zero.'] })
  })

  it('reports a position limit rejection with its explanation', async () => {
    fakeApi({
      'POST /trades': problem(400, {
        type: 'urn:trade-blotter:problem:position-limit',
        detail: 'The net quantity of BIG reached the position limit of 1e30.',
        symbol: 'BIG',
      }),
    })

    const error = await failure(api.createTrade({ symbol: 'BIG', side: 'Buy', quantity: '1', price: '1' }))

    expect(error.kind).toBe('rejected')
    expect(error.message).toBe('The trade was not booked. The net quantity of BIG reached the position limit of 1e30.')
  })

  it('does not pass on the text of any other rejection', async () => {
    fakeApi({ 'POST /trades': problem(415, { detail: 'internal: content type parser x' }) })

    const error = await failure(api.createTrade({ symbol: 'A', side: 'Buy', quantity: '1', price: '1' }))

    expect(error.kind).toBe('rejected')
    expect(error.message).toBe('The request was not accepted (HTTP 415). Reload the page and try again.')
  })
})

describe('API client: failures', () => {
  it.each([
    ['a 500 problem', problem(500, { detail: 'SQLITE_BUSY at C:/data/trades.db' })],
    ['a bare 500', { status: 500, body: '', contentType: 'text/plain' }],
    ['a 501', { status: 501, body: 'Not Implemented', contentType: 'text/plain' }],
  ])('reports %s as a server failure without its details', async (_name, response) => {
    fakeApi({ 'GET /trades': response })

    const error = await failure(api.listTrades())

    expect(error.kind).toBe('server')
    expect(error.message).toBe('The server could not complete the request. Try again in a moment.')
    expect(error.message).not.toContain('SQLITE')
  })

  it.each([
    // What the development and preview servers answer when the API is not running.
    ['a bare 502 from the frontend server', { status: 502, body: '', contentType: 'text/plain' }],
    ['a 502 page from another proxy', { status: 502, body: '<html>Bad gateway at 10.0.0.7</html>', contentType: 'text/html' }],
    ['a 503 while the API shuts down', { status: 503, body: '{"statusCode":503,"error":"Service Unavailable"}' }],
    ['a 504 gateway timeout', { status: 504, body: '', contentType: 'text/plain' }],
  ])('reports %s as the API being unavailable, without its details', async (_name, response) => {
    fakeApi({ 'POST /trades': response })

    const error = await failure(api.createTrade({ symbol: 'A', side: 'Buy', quantity: '1', price: '1' }))

    expect(error.kind).toBe('unavailable')
    expect(error.message).toBe('The API is not available. Check that it is running, and try again in a moment.')
  })

  it('reports an unreachable server as a network failure', async () => {
    fakeApi({ 'GET /positions': new TypeError('Failed to fetch') })

    const error = await failure(api.listPositions())

    expect(error.kind).toBe('network')
    expect(error.message).toContain('could not be reached')
  })

  it.each([
    ['not JSON', '<html>'],
    ['not a list', '{"trades":[]}'],
    ['a trade missing a field', '[{"id":"t1"}]'],
    ['a trade with a non-decimal quantity', TRADE.replace('"quantity":123456789012345.1234567891', '"quantity":"many"').replace(/^/, '[') + ']'],
    ['a trade with an unknown side', `[${TRADE.replace('"Buy"', '"Hold"')}]`],
  ])('refuses a response that is %s', async (_name, body) => {
    fakeApi({ 'GET /trades': json(body) })

    const error = await failure(api.listTrades())

    expect(error.kind).toBe('server')
    expect(error.message).toContain('does not understand')
  })
})

describe('API client: lists', () => {
  it('keeps the order the API sends', async () => {
    const newer = tradeJson({ id: 'b', bookingSequence: 2, symbol: 'B', side: 'Sell', quantity: '1', price: '1', notional: '1',
      executedAt: '2026-01-02T00:00:00.000Z' })
    const older = tradeJson({ id: 'a', bookingSequence: 1, symbol: 'A', side: 'Buy', quantity: '1', price: '1', notional: '1',
      executedAt: '2026-01-01T00:00:00.000Z' })
    fakeApi({ 'GET /trades': json(`[${newer},${older}]`) })

    expect((await api.listTrades()).map((trade) => trade.id)).toEqual(['b', 'a'])
  })

  it('reads positions with exact decimals', async () => {
    fakeApi({
      'GET /positions': json('[{"symbol":"AAPL","netQuantity":-0.1,"averageCost":3},' +
        '{"symbol":"MSFT","netQuantity":3,"averageCost":1.6666666666666666666666666666666666666666666666667}]'),
    })

    expect(await api.listPositions()).toEqual([
      { symbol: 'AAPL', netQuantity: '-0.1', averageCost: '3' },
      { symbol: 'MSFT', netQuantity: '3', averageCost: '1.6666666666666666666666666666666666666666666666667' },
    ])
  })
})

describe('API client: GET /trades query parameters', () => {
  it('requests plain /trades with no query, an empty one, or only empty values', async () => {
    const server = fakeApi({ 'GET /trades': json('[]') })

    await api.listTrades()
    await api.listTrades({})
    await api.listTrades({ symbol: '' })

    expect(server.calls.map((call) => call.url)).toEqual(['/trades', '/trades', '/trades'])
  })

  it('sends each parameter by its API name, in a fixed order, whatever order the query lists them', async () => {
    const server = fakeApi({ 'GET /trades': json('[]') })

    await api.listTrades({
      sortDirection: 'asc', sortBy: 'price', executedTo: '2026-03-09T03:59:59.999Z', executedFrom: '2026-03-08T05:00:00.000Z',
      side: 'Sell', symbol: 'ms',
    })

    const url = new URL(server.calls[0]?.url ?? '', 'http://localhost')
    expect(url.pathname).toBe('/trades')
    expect([...url.searchParams.entries()]).toEqual([
      ['symbol', 'ms'], ['side', 'Sell'], ['executedFrom', '2026-03-08T05:00:00.000Z'], ['executedTo', '2026-03-09T03:59:59.999Z'],
      ['sortBy', 'price'], ['sortDirection', 'asc'],
    ])
  })

  it('encodes values, so a symbol search cannot add or change parameters', async () => {
    const server = fakeApi({ 'GET /trades': json('[]') })

    await api.listTrades({ symbol: 'BRK B&side=Buy+%' })

    expect(server.calls[0]?.url).toBe('/trades?symbol=BRK+B%26side%3DBuy%2B%25')
    expect(new URL(server.calls[0]?.url ?? '', 'http://localhost').searchParams.get('symbol')).toBe('BRK B&side=Buy+%')
  })

  it('turns an invalid-query problem into a message for the trade list, with every reason in parameter order', async () => {
    fakeApi({
      'GET /trades': problem(400, {
        type: 'urn:trade-blotter:problem:invalid-query', title: 'Invalid query', detail: 'symbol must be at most 64 characters.',
        errors: { sortBy: ['sortBy must be one of executedAt, symbol, quantity, price.'], symbol: ['symbol must be at most 64 characters.'] },
      }),
    })

    const error = await failure(api.listTrades({ symbol: 'A'.repeat(65) }))

    expect(error.kind).toBe('invalid-query')
    expect(error.message).toBe(
      'The filters were not accepted. symbol must be at most 64 characters. sortBy must be one of executedAt, symbol, quantity, price.',
    )
  })

  it('reads a query rejection without an errors map as a plain rejection message', async () => {
    fakeApi({ 'GET /trades': problem(400, { type: 'urn:trade-blotter:problem:invalid-query', title: 'Invalid query' }) })

    expect(await failure(api.listTrades({ side: 'Buy' }))).toMatchObject({ kind: 'invalid-query', message: 'The filters were not accepted.' })
  })
})
