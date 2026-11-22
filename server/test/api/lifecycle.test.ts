import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Dec, NET_QUANTITY_LIMIT } from '../../src/domain/decimal.ts'
import type { UtcTimestamp } from '../../src/domain/timestamp.ts'
import { compareTrades } from '../../src/domain/trade-query.ts'
import { createTestServer, SERVER_CLOCK } from '../support/app.ts'

/**
 * The trade lifecycle over HTTP (M4, M7), on the real application and a temporary database:
 * Pending-only bookings, execution of a Pending trade, cancellation, logical trade lists with the
 * status filter and mixed-status paging, positions by status, the read-only audit history, and
 * trades booked Executed before M7.
 */

let server: Awaited<ReturnType<typeof createTestServer>>

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(async () => {
  await server.dispose()
})

type Json = Record<string, unknown>
const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
  server.app.inject({ method, url, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: typeof body === 'string' ? body : JSON.stringify(body) }) })
const book = async (body: Json) => {
  const response = await inject('POST', '/trades', { symbol: 'MSFT', side: 'Buy', quantity: '10', price: '100', ...body })
  return { status: response.statusCode, body: response.json<Json>() }
}
const cancel = async (id: string, body: unknown = { reason: 'Client withdrew the order' }) => {
  const response = await inject('POST', `/trades/${id}/cancellation`, body)
  return { status: response.statusCode, body: response.json<Json>() }
}
const execute = async (id: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await server.app.inject({
    method: 'POST', url: `/trades/${id}/execution`,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return { status: response.statusCode, body: response.json<Json>() }
}
/** An Executed trade: booked, then executed with the clock reading `at` for both; the clock is put back. */
const bookExecuted = async (body: Json, at: string) => {
  const before = server.clock.peek()
  server.clock.set(at)
  try {
    const booked = await book(body)
    if (booked.status !== 201) throw new Error(JSON.stringify(booked.body))
    const executed = await execute(String(booked.body['id']))
    if (executed.status !== 200) throw new Error(JSON.stringify(executed.body))
    return executed
  } finally {
    server.clock.set(before)
  }
}
/** Every row and audit entry, to show a refusal wrote nothing. */
const everything = () => ({ trades: raw('select * from trades'), audit: raw('select * from trade_audit') })
const get = async (url: string) => (await inject('GET', url)).json<Json & Json[]>()
/** Rows and audit entries as SQLite stores them, through a second connection. */
const raw = (sql: string) => {
  const db = new DatabaseSync(server.config.databasePath)
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

describe('API: booking is Pending only', () => {
  it('books Pending, with no execution time, by User, whether status is omitted or Pending', async () => {
    const omitted = await book({})
    const named = await book({ status: 'pending' })

    for (const booked of [omitted, named]) {
      expect(booked).toMatchObject({ status: 201, body: { status: 'Pending', executedAt: null, createdAt: SERVER_CLOCK, updatedAt: SERVER_CLOCK, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null, cancellationTradeId: null } })
    }
  })

  it('refuses Executed, Cancelled and unknown statuses, and any execution time, storing nothing', async () => {
    const problem = (errors: Json) => ({ status: 400, body: { type: 'urn:trade-blotter:problem:invalid-trade', errors } })
    const executedAt = 'A trade is booked as Pending, with no execution time: omit executedAt. The server sets it when the trade is executed.'

    expect(await book({ status: 'Executed' })).toMatchObject(problem({ status: ['A trade cannot be booked as Executed: it is booked as Pending, then executed (POST /trades/{id}/execution).'] }))
    expect(await book({ status: 'Cancelled' })).toMatchObject(problem({ status: ['A trade cannot be booked as Cancelled.'] }))
    expect(await book({ status: 'Filled' })).toMatchObject(problem({ status: ['Status must be Pending, or omitted.'] }))
    expect(await book({ status: 3 })).toMatchObject(problem({ status: ['Status must be Pending, or omitted.'] }))
    expect(await book({ executedAt: '2026-01-01T09:00:00Z' })).toMatchObject(problem({ executedAt: [executedAt] }))
    expect(await book({ status: 'Pending', executedAt: '2026-01-01 09:00' })).toMatchObject(problem({ executedAt: [executedAt] }))
    expect(raw('select count(*) as n from trades')).toEqual([{ n: 0 }])
    expect(raw('select count(*) as n from trade_audit')).toEqual([{ n: 0 }])
  })

  it('sets the actors and server fields itself, whatever the request says', async () => {
    const { body } = await book({ status: 'Pending', createdBy: 'Admin', updatedBy: 'Admin', originalTradeId: 'x', cancellationReason: 'y', createdAt: '2000-01-01T00:00:00Z' })

    expect(body).toMatchObject({ createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null, createdAt: SERVER_CLOCK })
  })

  it('refuses a Pending booking whose final projected position reaches the limit, long or short, and accepts an offsetting one', async () => {
    // 10^30 cannot be reached with valid requests; one oversized Executed trade is written directly.
    const db = new DatabaseSync(server.config.databasePath)
    const near = new Dec(NET_QUANTITY_LIMIT).minus(10).toFixed()
    db.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by)
      values ('big', 'BIG', 'Buy', ?, '1', ?, ?, ?, 'Executed', 'User', 'User')`).run(near, SERVER_CLOCK, SERVER_CLOCK, SERVER_CLOCK)
    db.close()
    const pending = (side: string, quantity: string) => book({ symbol: 'BIG', side, quantity, status: 'Pending' })

    expect((await pending('Buy', '9.9999999999')).status).toBe(201)
    expect(await pending('Buy', '0.0000000001')).toMatchObject({ status: 400, body: { type: 'urn:trade-blotter:problem:position-limit', symbol: 'BIG' } })
    expect((await pending('Sell', '100')).status).toBe(201)
    expect((await pending('Buy', '50')).status).toBe(201)
    const short = await book({ symbol: 'SHORT', side: 'Sell', quantity: '999999999999999', status: 'Pending' })
    expect(short.status).toBe(201)
    expect(raw(`select count(*) as n from trades where symbol = 'BIG'`)).toEqual([{ n: 4 }])
  })
})

describe('API: executing a Pending trade', () => {
  const LATER = '2026-03-01T13:00:00.000Z'

  it('executes it as User: the same trade, Executed at the server clock, its booking kept, no record added', async () => {
    const { body: trade } = await book({ quantity: '12.5', price: '101.25' })
    server.clock.set(LATER)

    const response = await execute(String(trade['id']))

    expect(response).toMatchObject({ status: 200, body: {
      ...trade, status: 'Executed', executedAt: LATER, updatedAt: LATER, updatedBy: 'User', createdAt: SERVER_CLOCK, createdBy: 'User', cancellationReason: null, cancellationTradeId: null,
    } })
    expect(await get('/trades')).toEqual([response.body])
    // One physical row, updated in place, and one audit entry for the execution, by System.
    expect(raw('select id, booking_sequence, status, executed_at, created_at, updated_at, updated_by from trades')).toEqual([
      { id: trade['id'], booking_sequence: 1, status: 'Executed', executed_at: LATER, created_at: SERVER_CLOCK, updated_at: LATER, updated_by: 'User' },
    ])
    expect(raw('select audit_action, id, status, executed_at, updated_by, audit_by from trade_audit order by audit_id')).toEqual([
      { audit_action: 'Inserted', id: trade['id'], status: 'Pending', executed_at: null, updated_by: 'User', audit_by: 'System' },
      { audit_action: 'Updated', id: trade['id'], status: 'Executed', executed_at: LATER, updated_by: 'User', audit_by: 'System' },
    ])
  })

  it('takes the execution time from the server clock in canonical UTC, never from the request', async () => {
    const { body: trade } = await book({})
    server.clock.set('2026-03-02T04:05:06.789Z')

    const response = await execute(String(trade['id']), undefined, { 'x-actor': 'Admin', 'x-executed-at': '2000-01-01T00:00:00Z', date: 'Sat, 01 Jan 2000 00:00:00 GMT' })

    expect(response.body).toMatchObject({ executedAt: '2026-03-02T04:05:06.789Z', updatedAt: '2026-03-02T04:05:06.789Z', updatedBy: 'User' })
  })

  it('accepts no body or an empty JSON object, and refuses any member or any other body, writing nothing', async () => {
    const ids = await Promise.all([book({}), book({}), book({})]).then((all) => all.map((booked) => String(booked.body['id'])))
    const before = everything()
    const id = ids[2] ?? ''
    const refused = (errors?: Json) => ({ status: 400, body: { type: 'urn:trade-blotter:problem:invalid-execution', ...(errors === undefined ? {} : { errors }) } })

    expect(await execute(id, { executedAt: '2000-01-01T00:00:00Z' })).toMatchObject(refused({ executedAt: ['Not accepted: an execution takes no fields.'] }))
    expect(await execute(id, { updatedBy: 'Admin', actor: 'Admin' })).toMatchObject(refused({ updatedBy: ['Not accepted: an execution takes no fields.'], actor: ['Not accepted: an execution takes no fields.'] }))
    expect(await execute(id, { status: 'Executed' })).toMatchObject(refused({ status: ['Not accepted: an execution takes no fields.'] }))
    expect(await execute(id, '[]')).toMatchObject(refused())
    expect(await execute(id, '"now"')).toMatchObject(refused())
    expect(await execute(id, '{"executedAt":')).toMatchObject({ status: 400 })
    expect(everything()).toEqual(before)
    expect((await execute(ids[0] ?? '')).status).toBe(200)
    expect((await execute(ids[1] ?? '', {})).status).toBe(200)
  })

  it('answers 404 for an unknown trade and 409 for one that is not Pending, writing nothing', async () => {
    const executed = await bookExecuted({}, '2026-01-01T09:00:00.000Z')
    const { body: done } = await book({})
    const record = (await cancel(String(done['id']))).body['cancellationRecord'] as Json
    const before = everything()

    expect(await execute('no-such-trade')).toMatchObject({ status: 404, body: { type: 'urn:trade-blotter:problem:trade-not-found', tradeId: 'no-such-trade' } })
    expect(await execute(String(executed.body['id']))).toMatchObject({ status: 409, body: { type: 'urn:trade-blotter:problem:invalid-transition', detail: `Trade ${String(executed.body['id'])} is already executed.`, tradeId: executed.body['id'] } })
    expect(await execute(String(done['id']))).toMatchObject({ status: 409, body: { type: 'urn:trade-blotter:problem:invalid-transition', detail: `Trade ${String(done['id'])} is cancelled; only a Pending trade can be executed.` } })
    expect(await execute(String(record['id']))).toMatchObject({ status: 409, body: { type: 'urn:trade-blotter:problem:invalid-transition', detail: expect.stringContaining('records a cancellation') as unknown } })
    expect(await cancel(String(executed.body['id']))).toMatchObject({ status: 409, body: { type: 'urn:trade-blotter:problem:invalid-transition' } })
    expect(everything()).toEqual(before)
  })

  it('lets exactly one of several simultaneous executions succeed, and records one execution', async () => {
    const { body: trade } = await book({})

    const results = await Promise.all(Array.from({ length: 5 }, () => execute(String(trade['id']))))

    expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409, 409, 409])
    expect(raw(`select count(*) as n from trade_audit where audit_action = 'Updated'`)).toEqual([{ n: 1 }])
    expect(raw('select count(*) as n from trades')).toEqual([{ n: 1 }])
  })

  it('lets exactly one of a simultaneous execution and cancellation succeed, leaving a consistent trade', async () => {
    const outcomes: string[] = []
    for (let round = 0; round < 6; round++) {
      const id = String((await book({})).body['id'])
      const [executed, cancelled] = round % 2 === 0
        ? await Promise.all([execute(id), cancel(id)])
        : await Promise.all([cancel(id), execute(id)]).then(([c, e]) => [e, c] as const)
      expect([executed.status, cancelled.status].sort(), `round ${String(round)}`).toEqual(executed.status === 200 ? [200, 409] : [201, 409])
      const [row] = raw(`select status, executed_at from trades where id = '${id}'`) as Json[]
      const records = raw(`select count(*) as n from trades where original_trade_id = '${id}'`)
      if (executed.status === 200) {
        expect(row).toMatchObject({ status: 'Executed' })
        expect(records).toEqual([{ n: 0 }])
      } else {
        expect(row).toEqual({ status: 'Cancelled', executed_at: null })
        expect(records).toEqual([{ n: 1 }])
      }
      outcomes.push(String(row?.['status']))
    }
    expect(outcomes).toHaveLength(6)
  })

  it('refuses with 409 an execution that would take the Executed position to the limit, leaving the trade Pending', async () => {
    // 10^30 cannot be reached with valid requests; one oversized Executed trade is written directly.
    const db = new DatabaseSync(server.config.databasePath)
    const near = new Dec(NET_QUANTITY_LIMIT).minus(10).toFixed()
    db.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by)
      values ('big', 'BIG', 'Buy', ?, '1', ?, ?, ?, 'Executed', 'User', 'User')`).run(near, SERVER_CLOCK, SERVER_CLOCK, SERVER_CLOCK)
    db.close()
    // The projection stays within the limit (near - 10 + 15): the Sell offsets the Buy while both are Pending.
    const { body: sell } = await book({ symbol: 'BIG', side: 'Sell', quantity: '10' })
    const { body: buy } = await book({ symbol: 'BIG', quantity: '15' })
    const before = everything()

    expect(await execute(String(buy['id']))).toMatchObject({ status: 409, body: {
      type: 'urn:trade-blotter:problem:position-limit', symbol: 'BIG', tradeId: buy['id'],
      detail: `Trade ${String(buy['id'])} was not executed: The net quantity of BIG reached the position limit of 1e30. It stays Pending.`,
    } })
    expect(everything()).toEqual(before)
    // Executing the Sell first makes room for it.
    expect((await execute(String(sell['id']))).status).toBe(200)
    expect((await execute(String(buy['id']))).status).toBe(200)
  })

  it('rolls the execution back when the database refuses the write, leaving the trade Pending and the audit unchanged', async () => {
    const { body: trade } = await book({})
    const db = new DatabaseSync(server.config.databasePath)
    db.exec(`create trigger refuse_execution before update on trades when new.status = 'Executed' begin select raise(abort, 'refused'); end`)
    db.close()
    const before = everything()

    expect((await execute(String(trade['id']))).status).toBe(500)
    expect(everything()).toEqual(before)
  })
})

describe('API: cancelling a Pending trade', () => {
  it('cancels it as Admin: the logical trade Cancelled with the reason, and the cancellation record it inserted', async () => {
    const { body: trade } = await book({ status: 'Pending', quantity: '12.5' })
    server.clock.set('2026-03-01T13:00:00.000Z')

    const response = await cancel(String(trade['id']), { reason: '  Client withdrew  ', updatedBy: 'User', createdBy: 'User' })

    expect(response.status).toBe(201)
    const { trade: cancelled, cancellationRecord: record } = response.body as { trade: Json; cancellationRecord: Json }
    expect(cancelled).toMatchObject({
      id: trade['id'], bookingSequence: trade['bookingSequence'], status: 'Cancelled', executedAt: null, createdBy: 'User', updatedBy: 'Admin',
      createdAt: SERVER_CLOCK, updatedAt: '2026-03-01T13:00:00.000Z', originalTradeId: null, cancellationReason: 'Client withdrew', cancellationTradeId: record['id'],
    })
    expect(record).toMatchObject({
      status: 'Cancelled', originalTradeId: trade['id'], cancellationReason: 'Client withdrew', createdBy: 'Admin', updatedBy: 'Admin',
      createdAt: '2026-03-01T13:00:00.000Z', updatedAt: '2026-03-01T13:00:00.000Z', symbol: 'MSFT', side: 'Buy', quantity: 12.5, price: 100, executedAt: null,
    })
    expect(record['id']).not.toBe(trade['id'])
    // Two physical rows, two audit entries for the cancellation, by System.
    expect(raw('select id, status, original_trade_id from trades order by booking_sequence')).toEqual([
      { id: trade['id'], status: 'Cancelled', original_trade_id: null }, { id: record['id'], status: 'Cancelled', original_trade_id: trade['id'] },
    ])
    expect(raw('select audit_action, id, audit_by from trade_audit order by audit_id')).toEqual([
      { audit_action: 'Inserted', id: trade['id'], audit_by: 'System' }, { audit_action: 'Updated', id: trade['id'], audit_by: 'System' },
      { audit_action: 'Inserted', id: record['id'], audit_by: 'System' },
    ])
  })

  it('answers 400 for an invalid body or reason, 404 for an unknown trade, and 409 for a trade that cannot be cancelled, writing nothing', async () => {
    const { body: executed } = await bookExecuted({}, '2026-01-01T09:00:00.000Z')
    const { body: pending } = await book({ status: 'Pending' })
    const { body: done } = await book({ status: 'Pending' })
    const record = (await cancel(String(done['id']))).body['cancellationRecord'] as Json
    const before = { trades: raw('select * from trades'), audit: raw('select * from trade_audit') }
    const id = String(pending['id'])

    expect(await cancel(id, {})).toMatchObject({ status: 400, body: { type: 'urn:trade-blotter:problem:invalid-cancellation', errors: { reason: ['Reason is required.'] } } })
    expect(await cancel(id, { reason: '   ' })).toMatchObject({ status: 400, body: { errors: { reason: ['Reason is required.'] } } })
    expect(await cancel(id, { reason: 'x'.repeat(501) })).toMatchObject({ status: 400, body: { errors: { reason: ['Reason must be at most 500 characters.'] } } })
    expect(await cancel(id, { reason: 'a\u0000b' })).toMatchObject({ status: 400, body: { errors: { reason: ['Reason must not contain control or invisible characters.'] } } })
    expect(await cancel(id, '[1]')).toMatchObject({ status: 400 })
    expect(await cancel(id, '{"reason":')).toMatchObject({ status: 400 })
    expect(await cancel('no-such-trade')).toMatchObject({ status: 404, body: { type: 'urn:trade-blotter:problem:trade-not-found', tradeId: 'no-such-trade' } })
    expect(await cancel(String(executed['id']))).toMatchObject({ status: 409, body: { type: 'urn:trade-blotter:problem:invalid-transition', tradeId: executed['id'] } })
    expect(await cancel(String(done['id']))).toMatchObject({ status: 409, body: { detail: `Trade ${String(done['id'])} is already cancelled.` } })
    expect(await cancel(String(record['id']))).toMatchObject({ status: 409, body: { detail: expect.stringContaining('records a cancellation') as unknown } })
    expect({ trades: raw('select * from trades'), audit: raw('select * from trade_audit') }).toEqual(before)
  })

  it('lets exactly one of several simultaneous cancellations succeed, and records one cancellation', async () => {
    const { body: trade } = await book({ status: 'Pending' })

    const results = await Promise.all(Array.from({ length: 5 }, () => cancel(String(trade['id']))))

    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409, 409, 409])
    expect(raw(`select count(*) as n from trades where original_trade_id = '${String(trade['id'])}'`)).toEqual([{ n: 1 }])
  })

  it('never refuses a cancellation for the position limit', async () => {
    await book({ symbol: 'P', status: 'Pending', quantity: '5' })
    const { body: offset } = await book({ symbol: 'P', side: 'Sell', status: 'Pending', quantity: '5' })

    expect((await cancel(String(offset['id']))).status).toBe(201)
  })
})

describe('API: trade lists of logical trades', () => {
  /** 6 Executed (each booked, then executed at its time), 4 Pending and 3 cancelled trades, in booking order. */
  async function mixed() {
    const ids: Record<string, string> = {}
    const specs: [string, Json][] = [
      ['e1', { executedAt: '2026-01-01T09:00:00.000Z', price: '5' }], ['p1', { status: 'Pending', price: '7' }], ['e2', { executedAt: '2026-01-03T09:00:00.000Z', price: '1' }],
      ['c1', { status: 'Pending', price: '3' }], ['e3', { executedAt: '2026-01-02T09:00:00.000Z', price: '9' }], ['p2', { status: 'Pending', price: '2' }],
      ['e4', { executedAt: '2026-01-02T09:00:00.000Z', price: '4' }], ['c2', { status: 'Pending', price: '8' }], ['p3', { status: 'Pending', price: '6' }],
      ['e5', { executedAt: '2026-01-05T09:00:00.000Z', price: '10' }], ['c3', { status: 'Pending', price: '11' }], ['p4', { status: 'Pending', price: '12' }],
      ['e6', { executedAt: '2026-01-04T09:00:00.000Z', price: '13', side: 'Sell' }],
    ]
    for (const [name, { executedAt, ...body }] of specs) {
      const booking = { symbol: name.startsWith('e') ? 'EXEC' : 'PEND', ...body }
      ids[name] = String((typeof executedAt === 'string' ? await bookExecuted(booking, executedAt) : await book(booking)).body['id'])
    }
    for (const name of ['c1', 'c2', 'c3']) await cancel(ids[name] ?? '')
    return ids
  }
  const names = (ids: Record<string, string>, trades: Json[]) => trades.map((trade) => Object.entries(ids).find(([, id]) => id === trade['id'])?.[0] ?? `?${String(trade['id'])}`)

  it('lists each logical trade once, never a cancellation record, cancelled trades with their reason', async () => {
    const ids = await mixed()
    const all = await get('/trades')

    expect(all).toHaveLength(13)
    expect(all.every((trade) => trade['originalTradeId'] === null)).toBe(true)
    expect(all.filter((trade) => trade['status'] === 'Cancelled').map((trade) => [trade['cancellationReason'], typeof trade['cancellationTradeId']]))
      .toEqual([['Client withdrew the order', 'string'], ['Client withdrew the order', 'string'], ['Client withdrew the order', 'string']])
    expect(new Set(all.map((trade) => trade['id'])).size).toBe(13)
    expect(names(ids, all).filter((name) => name.startsWith('?'))).toEqual([])
  })

  it('orders newest execution first, then the trades without one, by booking sequence: deterministic and total', async () => {
    const ids = await mixed()

    expect(names(ids, await get('/trades'))).toEqual(['e5', 'e6', 'e2', 'e4', 'e3', 'e1', 'p4', 'c3', 'p3', 'c2', 'p2', 'c1', 'p1'])
    expect(names(ids, await get('/trades?sortDirection=asc'))).toEqual(['p1', 'c1', 'p2', 'c2', 'p3', 'c3', 'p4', 'e1', 'e3', 'e4', 'e2', 'e6', 'e5'])
  })

  it('filters by status, ignoring case, and refuses an unknown one', async () => {
    const ids = await mixed()

    expect(names(ids, await get('/trades?status=pending'))).toEqual(['p4', 'p3', 'p2', 'p1'])
    expect(names(ids, await get('/trades?status=Executed&sortBy=price&sortDirection=asc'))).toEqual(['e2', 'e4', 'e1', 'e3', 'e5', 'e6'])
    expect(names(ids, await get('/trades?status=CANCELLED'))).toEqual(['c3', 'c2', 'c1'])
    // A date range lists executed trades only: the others have no execution time.
    expect(names(ids, await get('/trades?executedFrom=2026-01-01T00:00:00Z'))).toEqual(['e5', 'e6', 'e2', 'e4', 'e3', 'e1'])
    expect(await get('/trades?status=Open')).toMatchObject({ type: 'urn:trade-blotter:problem:invalid-query', errors: { status: ['status must be Pending, Executed or Cancelled.'] } })
  })

  it('pages through exactly what the list holds, for every sort, with no repeat or gap across page boundaries', async () => {
    await mixed()
    for (const sortBy of ['executedAt', 'symbol', 'quantity', 'price']) {
      for (const sortDirection of ['asc', 'desc']) {
        for (const status of ['', 'Pending', 'Cancelled']) {
          const query = `sortBy=${sortBy}&sortDirection=${sortDirection}${status === '' ? '' : `&status=${status}`}`
          const all = (await get(`/trades?${query}`)).map((trade) => trade['id'])
          const pages: unknown[] = []
          for (let page = 1; page <= 5; page++) {
            const body = await get(`/trades/page?${query}&page=${String(page)}&pageSize=3`)
            expect(body['totalCount'], query).toBe(all.length)
            pages.push(...(body['items'] as Json[]).map((trade) => trade['id']))
          }
          expect(pages, query).toEqual(all)
          // The same again: the order does not change between reads.
          expect((await get(`/trades?${query}`)).map((trade) => trade['id']), query).toEqual(all)
        }
      }
    }
  })

  it('orders as the domain defines it (compareTrades)', async () => {
    await mixed()
    const listed = await get('/trades?sortBy=price&sortDirection=desc')
    const asTrades = listed.map((trade) => ({
      id: String(trade['id']), symbol: String(trade['symbol']), quantity: new Dec(String(trade['quantity'])), price: new Dec(String(trade['price'])),
      bookingSequence: Number(trade['bookingSequence']), executedAt: trade['executedAt'] as UtcTimestamp | null,
    }))

    const sorted = [...asTrades].sort(compareTrades({ field: 'price', direction: 'desc' }))
    expect(sorted.map((trade) => trade.id)).toEqual(listed.map((trade) => trade['id']))
  })
})

describe('API: positions by status', () => {
  it('gives Executed, Pending and Projected Net, the average cost from Executed trades only, and Pending-only symbols', async () => {
    await bookExecuted({ symbol: 'MSFT', quantity: '100', price: '10' }, '2026-01-01T09:00:00.000Z')
    await book({ symbol: 'MSFT', quantity: '30', price: '99', status: 'Pending' })
    await book({ symbol: 'MSFT', side: 'Sell', quantity: '10', price: '1', status: 'Pending' })
    const { body: gone } = await book({ symbol: 'MSFT', quantity: '1000', status: 'Pending' })
    await cancel(String(gone['id']))
    await book({ symbol: 'NEW', side: 'Sell', quantity: '5', status: 'Pending' })
    const { body: vanished } = await book({ symbol: 'GONE', quantity: '5', status: 'Pending' })
    await cancel(String(vanished['id']))

    expect((await inject('GET', '/positions')).body).toBe(
      '[{"symbol":"MSFT","netQuantity":100,"averageCost":10,"executedNetQuantity":100,"pendingNetQuantity":20,"projectedNetQuantity":120},' +
        '{"symbol":"NEW","netQuantity":0,"averageCost":0,"executedNetQuantity":0,"pendingNetQuantity":-5,"projectedNetQuantity":-5}]',
    )
  })
})

describe('API: actual positions through the lifecycle', () => {
  /** The symbol's actual position: Executed Net and average cost (0 and 0 when it is not listed). */
  const actual = async (symbol: string) => {
    const row = (await get('/positions')).find((candidate) => candidate['symbol'] === symbol)
    return row === undefined ? [0, 0] : [row['executedNetQuantity'], row['averageCost']]
  }

  it('changes the Executed Net and average cost only when a trade is executed, by the accounting rules', async () => {
    const steps: [string, string, string, [number, number]][] = [
      ['Buy', '100', '10', [100, 10]], // open
      ['Buy', '100', '20', [200, 15]], // increase
      ['Sell', '50', '25', [150, 15]], // reduce
      ['Sell', '150', '18', [0, 0]], // close
      ['Sell', '100', '12', [-100, 12]], // open short
      ['Buy', '250', '13', [150, 13]], // cross
    ]
    let expected = [0, 0]
    for (const [index, [side, quantity, price, after]] of steps.entries()) {
      server.clock.set(`2026-03-02T09:00:0${String(index)}.000Z`)
      const { body: trade } = await book({ symbol: 'WALK', side, quantity, price })
      // Booked: nothing actual changes.
      expect(await actual('WALK'), `booked ${String(index)}`).toEqual(expected)
      expect((await execute(String(trade['id']))).status).toBe(200)
      expected = after
      expect(await actual('WALK'), `executed ${String(index)}`).toEqual(expected)
    }
  })

  it('leaves the Executed Net and average cost unchanged when a Pending trade is cancelled', async () => {
    await bookExecuted({ symbol: 'C', quantity: '10', price: '4' }, '2026-01-01T09:00:00.000Z')
    const { body: pending } = await book({ symbol: 'C', quantity: '90', price: '100' })
    const before = await actual('C')

    expect((await cancel(String(pending['id']))).status).toBe(201)
    expect(await actual('C')).toEqual(before)
    expect(before).toEqual([10, 4])
  })
})

describe('API: trades booked Executed before M7', () => {
  /** A trade as M4 to M6 booked it: Executed at a time the client gave, earlier than when it was recorded. */
  function historical(id: string, side: string, quantity: string, executedAt: string) {
    const db = new DatabaseSync(server.config.databasePath)
    db.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by)
      values (?, 'OLD', ?, ?, '2', ?, ?, ?, 'Executed', 'User', 'User')`).run(id, side, quantity, executedAt, SERVER_CLOCK, SERVER_CLOCK)
    db.close()
  }

  it('lists them unchanged, counts them in positions, and refuses to execute or cancel them again', async () => {
    historical('old-1', 'Buy', '10', '2025-06-01T09:00:00.000Z')
    historical('old-2', 'Sell', '4', '2025-06-02T09:00:00.000Z')
    const before = everything()

    expect((await get('/trades')).map((trade) => [trade['id'], trade['status'], trade['executedAt'], trade['createdAt']])).toEqual([
      ['old-2', 'Executed', '2025-06-02T09:00:00.000Z', SERVER_CLOCK], ['old-1', 'Executed', '2025-06-01T09:00:00.000Z', SERVER_CLOCK],
    ])
    expect((await get('/positions')).map((row) => [row['symbol'], row['executedNetQuantity'], row['averageCost']])).toEqual([['OLD', 6, 2]])
    expect((await execute('old-1')).status).toBe(409)
    expect((await cancel('old-1')).status).toBe(409)
    expect(everything()).toEqual(before)
  })

  it('takes a newly executed trade into their history at its execution time', async () => {
    historical('old-1', 'Buy', '10', '2025-06-01T09:00:00.000Z')
    const { body: trade } = await book({ symbol: 'OLD', side: 'Buy', quantity: '10', price: '4' })
    expect((await execute(String(trade['id']))).status).toBe(200)

    expect((await get('/positions')).map((row) => [row['symbol'], row['executedNetQuantity'], row['averageCost']])).toEqual([['OLD', 20, 3]])
  })
})

describe('API: the read-only audit history', () => {
  async function cancelledTrade() {
    const { body: trade } = await book({ status: 'Pending', quantity: '2.5' })
    const record = (await cancel(String(trade['id']))).body['cancellationRecord'] as Json
    return { id: String(trade['id']), recordId: String(record['id']) }
  }

  it('lists a physical trade\'s entries, oldest first, with every column of the row at each write', async () => {
    const { id } = await cancelledTrade()

    const page = await get(`/trades/${id}/audit`)

    expect(page).toMatchObject({ tradeId: id, scope: 'trade', tradeIds: [id], page: 1, pageSize: 50, totalCount: 2, totalPages: 1 })
    const items = page['items'] as Json[]
    expect(items.map((entry) => [entry['auditAction'], entry['auditBy'], (entry['trade'] as Json)['status']])).toEqual([['Inserted', 'System', 'Pending'], ['Updated', 'System', 'Cancelled']])
    expect(items[0]?.['auditOn']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(items[0]?.['trade']).toEqual({
      bookingSequence: 1, id, symbol: 'MSFT', side: 'Buy', quantity: 2.5, price: 100, executedAt: null, createdAt: SERVER_CLOCK, updatedAt: SERVER_CLOCK,
      quantityKey: '00000000012.5', priceKey: '0000000003100', status: 'Pending', createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null,
    })
  })

  it('records an execution as one update of the trade\'s own row, and a refused one as nothing', async () => {
    const { body: trade } = await book({ quantity: '3' })
    const id = String(trade['id'])
    server.clock.set('2026-03-01T14:00:00.000Z')
    await execute(id)
    await execute(id)
    await execute(id, { executedAt: '2000-01-01T00:00:00Z' })

    const items = (await get(`/trades/${id}/audit?scope=logical`))['items'] as Json[]
    expect(items.map((entry) => [entry['auditAction'], (entry['trade'] as Json)['status'], (entry['trade'] as Json)['executedAt'], (entry['trade'] as Json)['updatedBy']])).toEqual([
      ['Inserted', 'Pending', null, 'User'], ['Updated', 'Executed', '2026-03-01T14:00:00.000Z', 'User'],
    ])
  })

  it('lists a logical trade\'s history, the original and its cancellation record, from either id', async () => {
    const { id, recordId } = await cancelledTrade()
    const expected = [['Inserted', id], ['Updated', id], ['Inserted', recordId]]
    const entries = (page: Json) => (page['items'] as Json[]).map((entry) => [entry['auditAction'], (entry['trade'] as Json)['id']])

    expect(entries(await get(`/trades/${id}/audit?scope=logical`))).toEqual(expected)
    expect(entries(await get(`/trades/${recordId}/audit?scope=logical`))).toEqual(expected)
    expect((await get(`/trades/${recordId}/audit?scope=logical`))['tradeIds']).toEqual([id, recordId].sort())
    expect(entries(await get(`/trades/${recordId}/audit`))).toEqual([['Inserted', recordId]])
  })

  it('pages deterministically, answers 404 for an unknown trade and 400 for invalid parameters', async () => {
    const { id } = await cancelledTrade()

    const first = await get(`/trades/${id}/audit?scope=logical&pageSize=2`)
    const second = await get(`/trades/${id}/audit?scope=logical&pageSize=2&page=2`)
    expect([first['totalCount'], first['totalPages'], (first['items'] as Json[]).length, (second['items'] as Json[]).length]).toEqual([3, 2, 2, 1])
    expect(((await get(`/trades/${id}/audit?scope=logical&page=3&pageSize=2`))['items'] as Json[])).toEqual([])
    expect((await inject('GET', '/trades/nope/audit')).statusCode).toBe(404)
    expect(await get(`/trades/${id}/audit?scope=all&page=0`)).toMatchObject({
      type: 'urn:trade-blotter:problem:invalid-query', errors: { scope: ['scope must be one of trade, logical.'], page: ['page must be a whole number from 1 to 9007199254740991.'] },
    })
  })

  it('exposes no way to write, change or remove an audit entry, and reading changes nothing', async () => {
    const { id } = await cancelledTrade()
    const before = raw('select * from trade_audit')

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await inject(method, `/trades/${id}/audit`, method === 'DELETE' ? undefined : { auditAction: 'Deleted' })
      expect([method, response.statusCode, response.headers.allow]).toEqual([method, 405, 'GET, HEAD'])
    }
    await get(`/trades/${id}/audit`)
    await get(`/trades/${id}/audit?scope=logical`)
    expect(raw('select * from trade_audit')).toEqual(before)
  })
})

describe('API: existing behaviour is kept', () => {
  it('lists and pages Executed trades as before, now with the lifecycle fields', async () => {
    await bookExecuted({}, '2026-01-01T09:00:00.000Z')
    await bookExecuted({ symbol: 'AAPL' }, '2026-01-02T09:00:00.000Z')

    expect((await get('/trades')).map((trade) => [trade['symbol'], trade['status']])).toEqual([['AAPL', 'Executed'], ['MSFT', 'Executed']])
    expect(await get('/trades/page?pageSize=1')).toMatchObject({ page: 1, pageSize: 1, totalCount: 2, totalPages: 2 })
    expect((await get('/positions')).map((position) => [position['symbol'], position['netQuantity']])).toEqual([['AAPL', 10], ['MSFT', 10]])
  })
})
