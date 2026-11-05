import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createTestServer } from '../support/app.ts'
import { rawRows } from '../support/database.ts'
import { JSON_TYPE, postTrade, PROBLEM_TYPE, rawNumbers } from '../support/http.ts'

let server: Awaited<ReturnType<typeof createTestServer>>

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(async () => {
  await server.dispose()
})

const get = (url: string) => server.app.inject({ method: 'GET', url })

async function trade(symbol: string, side: string, quantity: string, price: string, executedAt: string): Promise<void> {
  const response = await postTrade(server.app,
    `{"symbol":"${symbol}","side":"${side}","quantity":${quantity},"price":${price},"executedAt":"${executedAt}"}`)
  expect(response.statusCode).toBe(201)
}

/** The booking sequences GET /trades returns for a query string, in order. */
async function listed(query: string): Promise<number[]> {
  const response = await get(`/trades${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json<{ bookingSequence: number }[]>().map((row) => row.bookingSequence)
}

/** Every stored row, read through a separate connection exactly as SQLite holds it. */
function storedRows(): unknown[] {
  const db = openDatabase(server.config.databasePath)
  try {
    return rawRows(db)
  } finally {
    closeDatabase(db)
  }
}

/**
 * Six trades. Quantities and prices are chosen so text order and numeric order differ (9 < 10,
 * 0.5 < 2), and so ties exist on every sort field: 1 and 4 share an execution time, 2 and 5 a
 * quantity, 3 and 6 a price, and 1, 4 and 6 a symbol.
 */
async function bookHistory(): Promise<void> {
  await trade('MSFT', 'Buy', '10', '9', '2026-01-01T14:30:00.000Z') // 1
  await trade('aapl', 'Sell', '9', '100.25', '2026-01-02T09:00:00-05:00') // 2: 14:00Z
  await trade('XMsFtX', 'Sell', '0.5', '2', '2026-01-03T09:00:00+01:00') // 3: 08:00Z
  await trade('msft', 'Sell', '100', '0.0000000001', '2026-01-01T14:30:00Z') // 4
  await trade('BRK.B', 'Buy', '9', '1000', '2026-01-04T00:00:00Z') // 5
  await trade('MSFT', 'Buy', '123456789012345.1234567891', '2', '2026-01-05T00:00:00Z') // 6
}

describe('API: GET /trades without query parameters', () => {
  it('still lists every trade, newest execution first, then latest booking first', async () => {
    await bookHistory()

    expect(await listed('')).toEqual([6, 5, 3, 2, 4, 1])
    expect(await listed('?')).toEqual([6, 5, 3, 2, 4, 1])
  })

  it('answers a query that matches nothing with an empty array', async () => {
    await bookHistory()
    const response = await get('/trades?symbol=ZZZ')

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe(JSON_TYPE)
    expect(response.body).toBe('[]')
  })
})

describe('API: GET /trades symbol search', () => {
  beforeEach(bookHistory)

  it.each([
    ['a full symbol, which also matches symbols containing it', 'MSFT', [6, 3, 4, 1]],
    ['lower case', 'msft', [6, 3, 4, 1]],
    ['mixed case', 'mSfT', [6, 3, 4, 1]],
    ['the start of a symbol', 'aa', [2]],
    ['the middle of a symbol', 'sf', [6, 3, 4, 1]],
    ['the end of a symbol', 'PL', [2]],
    ['punctuation', '.b', [5]],
    ['surrounding spaces, trimmed', '%20%20sf%20', [6, 3, 4, 1]],
    ['a blank value, which matches every trade', '%20', [6, 5, 3, 2, 4, 1]],
    ['an empty value, the same as none', '', [6, 5, 3, 2, 4, 1]],
    ['a percent sign, matched literally', '%25', []],
    ['an underscore, matched literally', '_', []],
  ])('matches %s', async (_name, symbol, expected) => {
    expect(await listed(`?symbol=${symbol}`)).toEqual(expected)
  })

  it('returns the matching trades exactly as stored, decimals included', async () => {
    const response = await get('/trades?symbol=MSFT&sortBy=quantity&sortDirection=desc')

    expect(rawNumbers(response.body, 'quantity')).toEqual(['123456789012345.1234567891', '100', '10', '0.5'])
    expect(rawNumbers(response.body, 'price')).toEqual(['2', '0.0000000001', '9', '2'])
    expect(response.json<{ symbol: string }[]>().map((row) => row.symbol)).toEqual(['MSFT', 'MSFT', 'MSFT', 'XMSFTX'])
  })
})

describe('API: GET /trades side filter', () => {
  beforeEach(bookHistory)

  it.each([
    ['Buy', [6, 5, 1]],
    ['buy', [6, 5, 1]],
    ['SELL', [3, 2, 4]],
    ['%20Sell%20', [3, 2, 4]],
    ['', [6, 5, 3, 2, 4, 1]],
  ])('side=%s', async (side, expected) => {
    expect(await listed(`?side=${side}`)).toEqual(expected)
  })
})

describe('API: GET /trades execution time filter', () => {
  beforeEach(bookHistory)

  it('includes trades executed exactly at either bound', async () => {
    expect(await listed('?executedFrom=2026-01-01T14:30:00Z&executedTo=2026-01-03T08:00:00Z')).toEqual([3, 2, 4, 1])
    expect(await listed('?executedFrom=2026-01-01T14:30:00.001Z&executedTo=2026-01-03T07:59:59.999Z')).toEqual([2])
    expect(await listed('?executedFrom=2026-01-01T14:30:00Z&executedTo=2026-01-01T14:30:00Z')).toEqual([4, 1])
  })

  it('accepts either bound alone', async () => {
    expect(await listed('?executedFrom=2026-01-04T00:00:00Z')).toEqual([6, 5])
    expect(await listed('?executedTo=2026-01-02T14:00:00Z')).toEqual([2, 4, 1])
  })

  it('compares instants, whatever offset each bound is written in', async () => {
    // 2026-01-02 09:00 in New York is 14:00Z, the execution time of trade 2.
    expect(await listed('?executedFrom=2026-01-02T09:00:00-05:00&executedTo=2026-01-02T09:00:00-05:00')).toEqual([2])
    // 2026-01-03 09:00 at +01:00, written with + encoded as %2B, is 08:00Z: trade 3.
    expect(await listed('?executedFrom=2026-01-03T09:00:00%2B01:00&executedTo=2026-01-03T13:30:00%2B05:30')).toEqual([3])
    // A whole UTC day: from its first to its last millisecond.
    expect(await listed('?executedFrom=2026-01-01T00:00:00Z&executedTo=2026-01-01T23:59:59.999Z')).toEqual([4, 1])
    // 2026-01-02 in Tokyo (+09:00) is 2026-01-01T15:00Z to 2026-01-02T14:59:59.999Z: it holds trade 2 (14:00Z on
    // the 2nd) but not trades 1 and 4 (14:30Z on the 1st), unlike the UTC day 2026-01-01 above.
    expect(await listed('?executedFrom=2026-01-02T00:00:00%2B09:00&executedTo=2026-01-02T23:59:59.999%2B09:00')).toEqual([2])
  })
})

describe('API: GET /trades combined filters', () => {
  beforeEach(bookHistory)

  it('combines symbol, side and both bounds with AND', async () => {
    expect(await listed('?symbol=sf&side=sell&executedFrom=2026-01-01T00:00:00Z&executedTo=2026-01-03T08:00:00Z')).toEqual([3, 4])
    expect(await listed('?symbol=sf&side=buy&executedFrom=2026-01-01T00:00:00Z&executedTo=2026-01-03T08:00:00Z')).toEqual([1])
    expect(await listed('?symbol=sf&side=buy&executedFrom=2026-01-02T00:00:00Z&executedTo=2026-01-03T08:00:00Z')).toEqual([])
  })

  it('sorts only the trades the filters kept', async () => {
    expect(await listed('?side=Sell&sortBy=price&sortDirection=asc')).toEqual([4, 3, 2])
    expect(await listed('?symbol=msft&executedTo=2026-01-04T00:00:00Z&sortBy=quantity&sortDirection=asc')).toEqual([3, 1, 4])
  })
})

describe('API: GET /trades sorting', () => {
  beforeEach(bookHistory)

  it.each([
    // Ties on executedAt (1, 4) fall back to booking sequence.
    ['executedAt', 'asc', [1, 4, 2, 3, 5, 6]],
    ['executedAt', 'desc', [6, 5, 3, 2, 4, 1]],
    // Code-point order; equal symbols (1, 4, 6) by execution time, then booking sequence.
    ['symbol', 'asc', [2, 5, 1, 4, 6, 3]],
    ['symbol', 'desc', [3, 6, 4, 1, 5, 2]],
    // Numeric: 0.5 < 9 = 9 < 10 < 100 < 123456789012345.1234567891. As text, "10" and "100" would precede "9".
    ['quantity', 'asc', [3, 2, 5, 1, 4, 6]],
    ['quantity', 'desc', [6, 4, 1, 5, 2, 3]],
    // Numeric: 0.0000000001 < 2 = 2 < 9 < 100.25 < 1000. As text, "1000" and "100.25" would precede "2".
    ['price', 'asc', [4, 3, 6, 1, 2, 5]],
    ['price', 'desc', [5, 2, 1, 6, 3, 4]],
  ])('sortBy=%s&sortDirection=%s', async (sortBy, sortDirection, expected) => {
    expect(await listed(`?sortBy=${sortBy}&sortDirection=${sortDirection}`)).toEqual(expected)
  })

  it('defaults the direction to desc and the field to executedAt', async () => {
    expect(await listed('?sortBy=price')).toEqual(await listed('?sortBy=price&sortDirection=desc'))
    expect(await listed('?sortDirection=asc')).toEqual([1, 4, 2, 3, 5, 6])
    expect(await listed('?sortBy=&sortDirection=')).toEqual([6, 5, 3, 2, 4, 1])
  })

  it('gives the same order on every request, and desc is exactly asc reversed', async () => {
    for (const sortBy of ['executedAt', 'symbol', 'quantity', 'price']) {
      const ascending = await listed(`?sortBy=${sortBy}&sortDirection=asc`)

      expect(await listed(`?sortBy=${sortBy}&sortDirection=asc`)).toEqual(ascending)
      expect(await listed(`?sortBy=${sortBy}&sortDirection=desc`)).toEqual([...ascending].reverse())
    }
  })

  it('orders many trades with identical sort values by execution time, then booking sequence', async () => {
    for (let index = 0; index < 4; index++) await trade('SAME', 'Buy', '5', '5', '2026-02-01T00:00:00Z') // 7 to 10
    await trade('SAME', 'Buy', '5', '5', '2026-01-31T00:00:00Z') // 11: same values, executed earlier

    for (const sortBy of ['symbol', 'quantity', 'price']) {
      expect(await listed(`?symbol=SAME&sortBy=${sortBy}&sortDirection=asc`)).toEqual([11, 7, 8, 9, 10])
      expect(await listed(`?symbol=SAME&sortBy=${sortBy}&sortDirection=desc`)).toEqual([10, 9, 8, 7, 11])
    }
  })
})

describe('API: GET /trades invalid parameters', () => {
  beforeEach(bookHistory)

  const TIMESTAMP_MESSAGE = (name: string) =>
    `${name} must be an RFC 3339 date-time with Z or an offset, such as 2026-01-01T09:00:00Z; write + in an offset as %2B.`

  it('answers with an invalid-query problem naming every invalid parameter, in parameter order', async () => {
    const response = await get('/trades?sortDirection=up&sortBy=notional&executedTo=2026-01-01&executedFrom=yesterday&side=hold')

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toBe(PROBLEM_TYPE)
    expect(response.body).toBe(JSON.stringify({
      type: 'urn:trade-blotter:problem:invalid-query',
      title: 'Invalid query',
      status: 400,
      detail: 'side must be Buy or Sell.',
      errors: {
        side: ['side must be Buy or Sell.'],
        executedFrom: [TIMESTAMP_MESSAGE('executedFrom')],
        executedTo: [TIMESTAMP_MESSAGE('executedTo')],
        sortBy: ['sortBy must be one of executedAt, symbol, quantity, price.'],
        sortDirection: ['sortDirection must be one of asc, desc.'],
      },
    }))
  })

  it.each([
    ['a date alone', '2026-01-01'],
    ['no offset', '2026-01-01T09:00:00'],
    ['an offset whose + was not encoded, and so arrived as a space', '2026-01-01T09:00:00+05:00'],
    ['a day that does not exist', '2026-02-30T00:00:00Z'],
    ['more than millisecond precision', '2026-01-01T09:00:00.1234Z'],
    ['an invalid hour', '2026-01-01T25:00:00Z'],
  ])('refuses %s as an execution bound', async (_name, text) => {
    for (const name of ['executedFrom', 'executedTo']) {
      const response = await get(`/trades?${name}=${text}`)

      expect(response.statusCode).toBe(400)
      expect(response.json())
        .toMatchObject({ type: 'urn:trade-blotter:problem:invalid-query', errors: { [name]: [TIMESTAMP_MESSAGE(name)] } })
    }
  })

  it('refuses a start later than the end', async () => {
    const response = await get('/trades?executedFrom=2026-01-02T00:00:00Z&executedTo=2026-01-01T23:59:59.999Z')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      type: 'urn:trade-blotter:problem:invalid-query',
      title: 'Invalid query',
      status: 400,
      detail: 'executedTo must not be earlier than executedFrom.',
      errors: { executedTo: ['executedTo must not be earlier than executedFrom.'] },
    })
  })

  it('refuses a repeated parameter', async () => {
    const response = await get('/trades?side=Buy&side=Sell&sortBy=price')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ errors: { side: ['side must be given at most once.'] } })
  })

  it('refuses a symbol search longer than any symbol, or with invisible characters', async () => {
    expect((await get(`/trades?symbol=${'A'.repeat(65)}`)).json())
      .toMatchObject({ errors: { symbol: ['symbol must be at most 64 characters.'] } })
    expect((await get('/trades?symbol=A%E2%80%8BB')).json())
      .toMatchObject({ errors: { symbol: ['symbol must not contain control or invisible characters.'] } })
  })

  it.each([['sortBy=Price'], ['sortDirection=DESC'], ['side=all']])('treats values as written: refuses %s', async (query) => {
    expect((await get(`/trades?${query}`)).statusCode).toBe(400)
  })

  it('ignores unknown parameters, as the API ignores unknown body members', async () => {
    expect(await listed('?page=2&limit=1&filter=x&symbol=aapl')).toEqual([2])
    expect(await listed('?SIDE=hold&Symbol=zzz')).toEqual([6, 5, 3, 2, 4, 1])
  })

  it('applies to /trades/ with a trailing slash too', async () => {
    expect(await listed('/?symbol=aapl')).toEqual([2])
    expect((await get('/trades/?side=hold')).statusCode).toBe(400)
  })
})

describe('API: GET /trades leaves stored trades and positions alone', () => {
  it('changes no stored row and no position, however the history is filtered or sorted', async () => {
    await bookHistory()
    const rows = storedRows()
    const positions = (await get('/positions')).body

    for (const query of [
      '?symbol=msft', '?side=Sell', '?executedFrom=2026-01-03T00:00:00Z', '?executedTo=2026-01-01T00:00:00Z',
      '?symbol=sf&side=buy&executedFrom=2026-01-01T00:00:00Z&executedTo=2026-01-02T00:00:00Z', '?symbol=ZZZ',
      '?sortBy=price&sortDirection=asc', '?sortBy=symbol', '?side=hold',
    ]) {
      await get(`/trades${query}`)
      expect((await get('/positions')).body).toBe(positions)
    }

    expect(storedRows()).toEqual(rows)
    expect(positions).toBe(
      '[{"symbol":"AAPL","netQuantity":-9,"averageCost":100.25},{"symbol":"BRK.B","netQuantity":9,"averageCost":1000},' +
        // MSFT: +10 at 9, crossed short by the Sell of 100 booked later at the same instant, then crossed long at 2.
        '{"symbol":"MSFT","netQuantity":123456789012255.1234567891,"averageCost":2},' +
        '{"symbol":"XMSFTX","netQuantity":-0.5,"averageCost":2}]',
    )
  })

  it('books the next trade with the next booking sequence after filtered reads', async () => {
    await bookHistory()
    await get('/trades?symbol=msft&sortBy=price')

    await trade('NEW', 'Buy', '1', '1', '2026-01-06T00:00:00Z')

    expect(await listed('?symbol=NEW')).toEqual([7])
  })
})
