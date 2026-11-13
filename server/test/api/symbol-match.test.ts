import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestServer } from '../support/app.ts'
import { JSON_TYPE, postTrade, PROBLEM_TYPE } from '../support/http.ts'

/**
 * symbolMatch on GET /trades and GET /trades/page: `contains` (the default, and what every request
 * without it gets) or `exact`. MS, MSFT and MSTR show the difference: each contains MS, only one is MS.
 */

let server: Awaited<ReturnType<typeof createTestServer>>

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(async () => {
  await server.dispose()
})

const get = (url: string) => server.app.inject({ method: 'GET', url })

interface Item { readonly symbol: string; readonly bookingSequence: number }
interface PageBody { readonly items: Item[]; readonly page: number; readonly pageSize: number; readonly totalCount: number; readonly totalPages: number }

async function list(query: string): Promise<Item[]> {
  const response = await get(`/trades${query}`)
  expect(response.statusCode, response.body).toBe(200)
  expect(response.headers['content-type']).toBe(JSON_TYPE)
  return response.json<Item[]>()
}

async function page(query: string): Promise<PageBody> {
  const response = await get(`/trades/page${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json<PageBody>()
}

async function trade(symbol: string, side: 'Buy' | 'Sell', executedAt: string): Promise<void> {
  const response = await postTrade(server.app, `{"symbol":"${symbol}","side":"${side}","quantity":"1","price":"10.5","executedAt":"${executedAt}"}`)
  expect(response.statusCode, response.body).toBe(201)
}

/** Seven MS trades (two of them sells), three MSFT, two MSTR, one XMS: booking sequences 1 to 13. */
async function bookSymbols(): Promise<void> {
  const symbols = ['MS', 'MSFT', 'ms', 'MSTR', 'MS', 'MSFT', ' Ms ', 'MSTR', 'MS', 'XMS', 'MS', 'msft', 'MS']
  for (const [index, symbol] of symbols.entries()) {
    await trade(symbol, index === 4 || index === 10 ? 'Sell' : 'Buy', `2026-03-${String(index + 1).padStart(2, '0')}T12:00:00Z`)
  }
}

const symbolsOf = (items: readonly Item[]): string[] => [...new Set(items.map((item) => item.symbol))].sort()
const sequences = (items: readonly Item[]): number[] => items.map((item) => item.bookingSequence)

describe('API: symbolMatch', () => {
  it('matches anywhere in the symbol by default and with contains, and only the whole symbol with exact', async () => {
    await bookSymbols()

    expect(symbolsOf(await list('?symbol=ms'))).toEqual(['MS', 'MSFT', 'MSTR', 'XMS'])
    expect(await list('?symbol=ms&symbolMatch=contains')).toEqual(await list('?symbol=ms'))
    expect(symbolsOf(await list('?symbol=ms&symbolMatch=exact'))).toEqual(['MS'])
    expect(sequences(await list('?symbol=ms&symbolMatch=exact'))).toEqual([13, 11, 9, 7, 5, 3, 1])
    expect(symbolsOf(await list('?symbol=MSFT&symbolMatch=exact'))).toEqual(['MSFT'])
    expect(symbolsOf(await list('?symbol=mstr&symbolMatch=exact'))).toEqual(['MSTR'])
  })

  it('normalises the symbol for exact matching as for contains: trimmed, NFC and upper-cased', async () => {
    await trade('Café', 'Buy', '2026-03-01T12:00:00Z')
    await trade('CAFÉS', 'Buy', '2026-03-02T12:00:00Z')

    // e + combining acute accent (NFD), lower case, with spaces: the same symbol once normalised.
    expect(symbolsOf(await list(`?symbol=${encodeURIComponent(` cafe${String.fromCodePoint(0x301)} `)}&symbolMatch=exact`))).toEqual(['CAFÉ'])
    expect(symbolsOf(await list(`?symbol=${encodeURIComponent('café')}`))).toEqual(['CAFÉ', 'CAFÉS'])
  })

  it('pages, counts and sorts one symbol\'s trades on the server', async () => {
    await bookSymbols()

    const first = await page('?symbol=MS&symbolMatch=exact&pageSize=3')
    expect(first).toMatchObject({ page: 1, pageSize: 3, totalCount: 7, totalPages: 3 })
    expect(sequences(first.items)).toEqual([13, 11, 9])
    expect(sequences((await page('?symbol=MS&symbolMatch=exact&pageSize=3&page=3')).items)).toEqual([1])
    expect(await page('?symbol=MS&symbolMatch=exact&pageSize=3&page=4')).toMatchObject({ items: [], totalCount: 7, totalPages: 3 })
    expect(sequences((await page('?symbol=MS&symbolMatch=exact&sortBy=executedAt&sortDirection=asc&pageSize=3&page=2')).items)).toEqual([7, 9, 11])
    expect(sequences((await page('?symbol=MS&symbolMatch=exact&sortBy=symbol&pageSize=100')).items)).toEqual([13, 11, 9, 7, 5, 3, 1])
    expect(await page('?symbol=MS&symbolMatch=exact&side=Sell')).toMatchObject({ totalCount: 2, totalPages: 1 })

    // The same page as GET /trades lists for the same query.
    expect(sequences((await page('?symbol=ms&symbolMatch=exact&pageSize=100')).items)).toEqual(sequences(await list('?symbol=ms&symbolMatch=exact')))
    expect(await page('?symbol=ms')).toMatchObject({ totalCount: 13 })
  })

  it('answers a symbol that only part-matches with no trades, and no pages', async () => {
    await bookSymbols()

    expect(await list('?symbol=M&symbolMatch=exact')).toEqual([])
    expect(await page('?symbol=MSF&symbolMatch=exact')).toEqual({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0 })
    expect(await page('?symbol=M')).toMatchObject({ totalCount: 13 })
  })

  it('changes nothing without a symbol, and treats an empty symbolMatch as omitted', async () => {
    await bookSymbols()
    const every = await list('')

    expect(await list('?symbolMatch=exact')).toEqual(every)
    expect(await list('?symbol=&symbolMatch=exact')).toEqual(every)
    expect(await list('?symbol=ms&symbolMatch=')).toEqual(await list('?symbol=ms'))
  })

  it.each(['EXACT', 'Exact', 'equals', 'prefix', ' exact', 'true'])('refuses symbolMatch=%j on both endpoints, naming it', async (value) => {
    await bookSymbols()
    for (const path of ['/trades', '/trades/page']) {
      const response = await get(`${path}?symbol=MS&symbolMatch=${encodeURIComponent(value)}`)
      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
      expect(response.json()).toMatchObject({
        type: 'urn:trade-blotter:problem:invalid-query',
        errors: { symbolMatch: ['symbolMatch must be one of contains, exact.'] },
      })
    }
  })

  it('refuses a repeated symbolMatch, and reports it in parameter order with the others', async () => {
    const repeated = await get('/trades/page?symbol=MS&symbolMatch=exact&symbolMatch=contains')
    expect(repeated.statusCode).toBe(400)
    expect(repeated.json<{ errors: unknown }>().errors).toEqual({ symbolMatch: ['symbolMatch must be given at most once.'] })

    const several = await get('/trades/page?pageSize=0&side=hold&symbolMatch=nope&symbol=MS')
    expect(Object.keys(several.json<{ errors: Record<string, unknown> }>().errors)).toEqual(['symbolMatch', 'side', 'pageSize'])
  })

  it('leaves positions covering every trade', async () => {
    await bookSymbols()
    const before = (await get('/positions')).body

    await page('?symbol=MS&symbolMatch=exact&pageSize=1&page=2')

    expect((await get('/positions')).body).toBe(before)
    expect((await get('/positions')).json<{ symbol: string }[]>().map((position) => position.symbol)).toEqual(['MS', 'MSFT', 'MSTR', 'XMS'])
  })
})
