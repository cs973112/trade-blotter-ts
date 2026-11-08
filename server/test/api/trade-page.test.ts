import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestServer } from '../support/app.ts'
import { JSON_TYPE, postTrade, PROBLEM_TYPE, rawNumbers } from '../support/http.ts'

let server: Awaited<ReturnType<typeof createTestServer>>

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(async () => {
  await server.dispose()
})

const get = (url: string) => server.app.inject({ method: 'GET', url })

interface PageBody {
  readonly items: { readonly bookingSequence: number; readonly id: string }[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

async function page(query: string): Promise<PageBody> {
  const response = await get(`/trades/page${query}`)
  expect(response.statusCode, response.body).toBe(200)
  expect(response.headers['content-type']).toBe(JSON_TYPE)
  return response.json<PageBody>()
}

async function trade(symbol: string, side: string, quantity: string, price: string, executedAt: string): Promise<void> {
  const response = await postTrade(server.app,
    `{"symbol":"${symbol}","side":"${side}","quantity":${quantity},"price":${price},"executedAt":"${executedAt}"}`)
  expect(response.statusCode, response.body).toBe(201)
}

/** Six trades with ties on every sort field, and decimals whose text order differs from their value (as in trade-history). */
async function bookHistory(): Promise<void> {
  await trade('MSFT', 'Buy', '10', '9', '2026-01-01T14:30:00.000Z') // 1
  await trade('aapl', 'Sell', '9', '100.25', '2026-01-02T09:00:00-05:00') // 2
  await trade('XMsFtX', 'Sell', '0.5', '2', '2026-01-03T09:00:00+01:00') // 3
  await trade('msft', 'Sell', '100', '0.0000000001', '2026-01-01T14:30:00Z') // 4
  await trade('BRK.B', 'Buy', '9', '1000', '2026-01-04T00:00:00Z') // 5
  await trade('MSFT', 'Buy', '123456789012345.1234567891', '2', '2026-01-05T00:00:00Z') // 6
}

/** `count` trades; every fourth is a Sell, so positions stay long. Execution times repeat in pairs. */
async function bookMany(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const minute = String(Math.floor(index / 2) % 60).padStart(2, '0')
    const hour = String(Math.floor(index / 120)).padStart(2, '0')
    await trade(['AAA', 'BBB', 'MSX'][index % 3] ?? 'AAA', index % 4 === 3 ? 'Sell' : 'Buy', '1', `1.${String(index)}`, `2026-02-01T${hour}:${minute}:00Z`)
  }
}

const sequences = (body: PageBody): number[] => body.items.map((item) => item.bookingSequence)

describe('API: GET /trades/page', () => {
  it('answers the first page of 50, newest execution first, with the totals', async () => {
    await bookMany(120)
    const listed = (await get('/trades')).json<{ bookingSequence: number }[]>().map((item) => item.bookingSequence)

    const body = await page('')

    expect(Object.keys(body)).toEqual(['items', 'page', 'pageSize', 'totalCount', 'totalPages'])
    expect(body).toMatchObject({ page: 1, pageSize: 50, totalCount: 120, totalPages: 3 })
    expect(sequences(body)).toEqual(listed.slice(0, 50))
  })

  it('answers an empty database with no items, no pages and the page asked for', async () => {
    expect(await page('')).toEqual({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0 })
    expect(await page('?page=3&pageSize=25')).toEqual({ items: [], page: 3, pageSize: 25, totalCount: 0, totalPages: 0 })
  })

  it('splits the list at exact page boundaries, the last page partly full', async () => {
    await bookMany(101)
    const listed = (await get('/trades')).json<{ bookingSequence: number }[]>().map((item) => item.bookingSequence)

    for (const size of [1, 25, 50, 100]) {
      const pages = Math.ceil(101 / size)
      const walked: number[] = []
      for (let number = 1; number <= pages; number++) {
        const body = await page(`?page=${String(number)}&pageSize=${String(size)}`)
        expect(body).toMatchObject({ page: number, pageSize: size, totalCount: 101, totalPages: pages })
        expect(body.items).toHaveLength(number < pages ? size : 101 - (pages - 1) * size)
        walked.push(...sequences(body))
      }
      expect(walked).toEqual(listed)
    }
  }, 30_000)

  it('answers a page past the last, however far, with no items and the real totals', async () => {
    await bookMany(30)

    for (const number of ['3', '4', '1000', '9007199254740991']) {
      expect(await page(`?page=${number}&pageSize=25`))
        .toEqual({ items: [], page: Number(number), pageSize: 25, totalCount: 30, totalPages: 2 })
    }
    expect(sequences(await page('?page=2&pageSize=25'))).toHaveLength(5)
  })

  it.each([
    ['executedAt', 'desc'], ['executedAt', 'asc'], ['symbol', 'asc'], ['symbol', 'desc'],
    ['quantity', 'asc'], ['quantity', 'desc'], ['price', 'asc'], ['price', 'desc'],
  ])('pages through exactly what GET /trades lists, sorted by %s %s', async (sortBy, sortDirection) => {
    await bookHistory()
    const query = `sortBy=${sortBy}&sortDirection=${sortDirection}`
    const listed = (await get(`/trades?${query}`)).json<{ bookingSequence: number }[]>().map((item) => item.bookingSequence)

    const walked = [...sequences(await page(`?${query}&pageSize=4`)), ...sequences(await page(`?${query}&pageSize=4&page=2`))]

    expect(walked).toEqual(listed)
  })

  it('sorts quantities and prices by exact value, ties in trade order, as GET /trades does', async () => {
    await bookHistory()

    expect(sequences(await page('?sortBy=quantity&sortDirection=asc'))).toEqual([3, 2, 5, 1, 4, 6])
    expect(sequences(await page('?sortBy=price&sortDirection=asc'))).toEqual([4, 3, 6, 1, 2, 5])
    expect(sequences(await page('?sortBy=price&sortDirection=desc&pageSize=3'))).toEqual([5, 2, 1])
  })

  it('filters before paging and counts only the matches', async () => {
    await bookHistory()

    const body = await page('?symbol=sf&side=Sell&executedFrom=2026-01-01T00:00:00Z&pageSize=1&page=2')

    expect(body).toMatchObject({ page: 2, pageSize: 1, totalCount: 2, totalPages: 2 })
    expect(sequences(body)).toEqual([4])
    expect(await page('?symbol=zzz')).toEqual({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0 })
  })

  it('writes every decimal exactly, as GET /trades does', async () => {
    await bookHistory()

    const response = await get('/trades/page?sortBy=quantity&sortDirection=desc&pageSize=2')

    expect(rawNumbers(response.body, 'quantity')).toEqual(['123456789012345.1234567891', '100'])
    expect(rawNumbers(response.body, 'notional')).toEqual(['246913578024690.2469135782', '0.00000001'])
    // The items are, character for character, the start of what GET /trades writes.
    const listed = await get('/trades?sortBy=quantity&sortDirection=desc')
    const items = response.body.slice('{"items":'.length, response.body.indexOf('],"page":'))
    expect(listed.body.startsWith(`${items},`)).toBe(true)
  })

  it('treats an empty page or pageSize as omitted, and ignores unknown parameters', async () => {
    await bookMany(3)

    expect(await page('?page=&pageSize=&limit=1&offset=2')).toMatchObject({ page: 1, pageSize: 50, totalCount: 3 })
  })
})

describe('API: GET /trades/page invalid parameters', () => {
  it('answers with an invalid-query problem naming every invalid parameter, the page last', async () => {
    const response = await get('/trades/page?pageSize=101&page=0&side=hold')

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.body).toBe(JSON.stringify({
      type: 'urn:trade-blotter:problem:invalid-query',
      title: 'Invalid query',
      status: 400,
      detail: 'side must be Buy or Sell.',
      errors: {
        side: ['side must be Buy or Sell.'],
        page: ['page must be a whole number from 1 to 9007199254740991.'],
        pageSize: ['pageSize must be a whole number from 1 to 100.'],
      },
    }))
  })

  it.each([
    ['page=-1'], ['page=1.5'], ['page=1e2'], ['page=%2B1'], ['page=abc'], ['page=9007199254740992'],
    ['page=99999999999999999999999999999999999999'], ['pageSize=0'], ['pageSize=1000'], ['pageSize=%2050'],
  ])('refuses %s', async (query) => {
    const response = await get(`/trades/page?${query}`)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'urn:trade-blotter:problem:invalid-query' })
  })

  it('refuses a repeated page or pageSize', async () => {
    const response = await get('/trades/page?page=1&page=2&pageSize=50&pageSize=50')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      errors: { page: ['page must be given at most once.'], pageSize: ['pageSize must be given at most once.'] },
    })
  })

  it('answers 405 for another method, naming the allowed ones', async () => {
    const response = await server.app.inject({ method: 'POST', url: '/trades/page', payload: {} })

    expect(response.statusCode).toBe(405)
    expect(response.headers['allow']).toBe('GET, HEAD')
  })
})

describe('API: GET /trades and positions are unchanged by paging', () => {
  it('still lists every match as a bare array, ignoring page and pageSize, valid or not', async () => {
    await bookMany(60)

    for (const query of ['', '?page=2', '?pageSize=10', '?page=0&pageSize=x', '?page=1&page=2']) {
      const response = await get(`/trades${query}`)
      expect(response.statusCode, query).toBe(200)
      const body = response.json<unknown>()
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(60)
    }
  })

  it('counts a newly booked trade at once', async () => {
    await bookHistory()

    expect(await page('?side=Buy&pageSize=1')).toMatchObject({ totalCount: 3, totalPages: 3 })
    await trade('NEW', 'Buy', '1', '1', '2026-01-06T00:00:00Z')

    expect(await page('?side=Buy&pageSize=1')).toMatchObject({ totalCount: 4, totalPages: 4 })
    expect(sequences(await page('?side=Buy&pageSize=1'))).toEqual([7])
  })

  it('leaves positions covering every trade, whatever page or filter is read', async () => {
    await bookHistory()
    const positions = await get('/positions')

    for (const query of ['?symbol=MSFT&page=2&pageSize=1', '?side=Sell', '?page=99', '?sortBy=price']) await page(query)

    expect((await get('/positions')).body).toBe(positions.body)
    // MSFT nets every MSFT trade (10 - 100 + 123456789012345.1234567891), not just one page of them.
    expect(rawNumbers(positions.body, 'netQuantity')).toEqual(['-9', '9', '123456789012255.1234567891', '-0.5'])
  })
})
