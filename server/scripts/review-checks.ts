import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig } from '../src/config.ts'
import { compareTrades, DEFAULT_TRADE_SORT, type TradeSort } from '../src/domain/trade-query.ts'
import type { Trade } from '../src/domain/trade.ts'
import { createServer } from '../src/server.ts'
import {
  expectedDifference, expectedPage, expectedResponse, readSnapshot, scenarioPath, type Expected, type PagePosition, type Scenario, type Snapshot,
} from './perf-api.ts'
import type { Report } from './review-context.ts'
import { seedDatabase, type Protection } from './trade-data.ts'

/**
 * Step 04: functional checks against running applications. Every expected result is computed
 * independently from the database, read through a read-only connection, with the domain's own
 * order (compareTrades) and accounting (calculatePositions, through perf-api's expectedResponse);
 * a check passes only when the response matches it exactly, decimals included. These checks only
 * read the reviewer databases; bookings are made through an API of their own on a throwaway
 * database, removed afterwards.
 */

export interface CheckTarget {
  readonly label: string
  readonly apiUrl: string
  /** The frontend; its checks are skipped when absent. */
  readonly webUrl?: string
  readonly databasePath: string
}

export interface Disposable {
  /** A folder for the throwaway database; it is created, and the database removed afterwards. */
  readonly dir: string
  readonly seed: string
  readonly count: number
  readonly protection: Protection
}

interface Answer {
  readonly status: number
  readonly type: string
  readonly body: string
}

async function request(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
}

/** Runs one check: a problem (string) fails it, and so does an error, with its message. */
async function check(report: Report, name: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const problem = await run()
    if (problem === undefined) report.pass(name)
    else report.fail(name, problem)
  } catch (error) {
    report.fail(name, error instanceof Error ? error.message : String(error))
  }
}

const everything = (): boolean => true
const isMs = (t: Trade): boolean => t.symbol.includes('MS')
const isBuy = (t: Trade): boolean => t.side === 'Buy'
const HALF_2026 = { executedFrom: '2026-01-01T00:00:00.000Z', executedTo: '2026-06-30T23:59:59.999Z' }
const inHalf2026 = (t: Trade): boolean => t.executedAt >= HALF_2026.executedFrom && t.executedAt <= HALF_2026.executedTo

const sortQuery = (sort: TradeSort): Record<string, string> =>
  sort.field === DEFAULT_TRADE_SORT.field && sort.direction === DEFAULT_TRADE_SORT.direction ? {} : { sortBy: sort.field, sortDirection: sort.direction }

function pageAt(query: Record<string, string>, matches: (t: Trade) => boolean, sort: TradeSort, pageSize: number, at: PagePosition): Scenario {
  return { kind: 'page', name: 'check', query, matches, sort, pageSize, at }
}

/** GETs a path and compares the answer with what the database says it must be. */
async function answersAs(base: string, path: string, expected: Expected): Promise<string | undefined> {
  const answer = await request(`${base}${path}`)
  if (answer.status !== 200) return `status ${String(answer.status)}: ${answer.body.slice(0, 200)}`
  return expectedDifference(answer.body, expected)
}

/** A scenario's request, compared with its expected response. */
async function scenarioAnswers(base: string, scenario: Scenario, snapshot: Snapshot): Promise<string | undefined> {
  const expected = expectedResponse(scenario, snapshot)
  return answersAs(base, scenarioPath(scenario, expected.matched), expected)
}

const pagePath = (query: Record<string, string>, page: number, pageSize: number): string =>
  `/trades/page?${new URLSearchParams({ ...query, page: String(page), pageSize: String(pageSize) }).toString()}`

/** The page parameters the API must refuse, each with the parameter its problem must name. */
const INVALID = [
  ['page=0', 'page'], ['page=-1', 'page'], ['page=abc', 'page'], ['page=1.5', 'page'], ['page=9007199254740992', 'page'],
  ['pageSize=0', 'pageSize'], ['pageSize=101', 'pageSize'], ['pageSize=fifty', 'pageSize'],
  ['page=1&page=2', 'page'], ['pageSize=50&pageSize=25', 'pageSize'],
] as const

/** Checks of a running API (and its frontend) that only read. */
export async function readOnlyChecks(report: Report, target: CheckTarget, snapshot: Snapshot): Promise<void> {
  const { label, apiUrl: api } = target
  const all = (sort: TradeSort): Scenario => ({ kind: 'trades', name: 'check', query: sortQuery(sort), matches: everything, sort })

  await check(report, `${label}: GET /trades is still a JSON array of every trade, newest first, exactly as stored`, () =>
    scenarioAnswers(api, all(DEFAULT_TRADE_SORT), snapshot))
  await check(report, `${label}: GET /trades still filters and sorts (symbol "ms", side Buy, by quantity ascending)`, () =>
    scenarioAnswers(api, { kind: 'trades', name: 'check', query: { symbol: 'ms', side: 'Buy', sortBy: 'quantity', sortDirection: 'asc' },
      matches: (t) => isMs(t) && isBuy(t), sort: { field: 'quantity', direction: 'asc' } }, snapshot))
  await check(report, `${label}: GET /trades ignores page and pageSize`, () =>
    answersAs(api, '/trades?page=2&pageSize=5', expectedResponse(all(DEFAULT_TRADE_SORT), snapshot)))
  await check(report, `${label}: GET /trades/page with no parameters is page 1 of 50, newest first, with consistent totals`, () =>
    answersAs(api, '/trades/page', expectedPage(snapshot, everything, DEFAULT_TRADE_SORT, 50, 1)))
  for (const size of [25, 50, 100]) {
    await check(report, `${label}: GET /trades/page, ${String(size)} a page: first page and totals`, () =>
      scenarioAnswers(api, pageAt({}, everything, DEFAULT_TRADE_SORT, size, 'first'), snapshot))
  }
  for (const at of ['first', 'middle', 'last', 'past the last'] as const) {
    await check(report, `${label}: GET /trades/page, ${at} page of 50`, () => scenarioAnswers(api, pageAt({}, everything, DEFAULT_TRADE_SORT, 50, at), snapshot))
  }
  await check(report, `${label}: GET /trades/page, a search matching nothing: no items, totalCount 0, totalPages 0`, () =>
    scenarioAnswers(api, pageAt({ symbol: 'zzzz-no-such-symbol' }, () => false, DEFAULT_TRADE_SORT, 50, 'first'), snapshot))
  for (const field of ['executedAt', 'symbol', 'quantity', 'price'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      const sort = { field, direction }
      await check(report, `${label}: sorted by ${field} ${direction}: first and last page of 100, exact decimals, ties in execution order`, async () =>
        await scenarioAnswers(api, pageAt(sortQuery(sort), everything, sort, 100, 'first'), snapshot) ??
        await scenarioAnswers(api, pageAt(sortQuery(sort), everything, sort, 100, 'last'), snapshot))
    }
  }
  for (const field of ['quantity', 'price'] as const) {
    await check(report, `${label}: every trade by ${field}, ascending: exact decimal order across the whole history`, () =>
      scenarioAnswers(api, all({ field, direction: 'asc' }), snapshot))
  }
  await check(report, `${label}: equal quantities on one page are ordered by execution time, then booking sequence`, async () => {
    const sort: TradeSort = { field: 'quantity', direction: 'asc' }
    const ordered = [...snapshot.trades].sort(compareTrades(sort))
    // Two neighbours with the same quantity, on the same page of 100.
    const tie = ordered.findIndex((t, i) => i % 100 !== 0 && t.quantity.equals(ordered[i - 1]?.quantity ?? t.quantity.plus(1)))
    if (tie < 0) return 'the data has no equal quantities on one page to check ties with'
    const page = Math.floor(tie / 100) + 1
    return answersAs(api, pagePath(sortQuery(sort), page, 100), expectedPage(snapshot, everything, sort, 100, page))
  })
  const filters = [
    ['symbol "ms"', { symbol: 'ms' }, isMs, DEFAULT_TRADE_SORT],
    ['side Buy', { side: 'Buy' }, isBuy, DEFAULT_TRADE_SORT],
    ['executed 2026-01-01 to 2026-06-30 (UTC)', HALF_2026, inHalf2026, DEFAULT_TRADE_SORT],
    ['"ms" + Buy + first half of 2026, by price', { symbol: 'ms', side: 'Buy', ...HALF_2026, sortBy: 'price', sortDirection: 'asc' },
      (t: Trade) => isMs(t) && isBuy(t) && inHalf2026(t), { field: 'price', direction: 'asc' }],
  ] as const
  for (const [name, query, matches, sort] of filters) {
    await check(report, `${label}: filter ${name}: first, middle and last page, totalCount and totalPages`, async () =>
      await scenarioAnswers(api, pageAt(query, matches, sort, 50, 'first'), snapshot) ??
      await scenarioAnswers(api, pageAt(query, matches, sort, 50, 'middle'), snapshot) ??
      await scenarioAnswers(api, pageAt(query, matches, sort, 50, 'last'), snapshot))
  }
  for (const [query, parameter] of INVALID) {
    await check(report, `${label}: GET /trades/page?${query} is refused with 400, naming ${parameter}`, async () => {
      const answer = await request(`${api}/trades/page?${query}`)
      if (answer.status !== 400) return `status ${String(answer.status)}`
      if (!answer.type.startsWith('application/problem+json')) return `content type ${answer.type}`
      const problem = JSON.parse(answer.body) as { type?: string; errors?: Record<string, string[]> }
      if (problem.type !== 'urn:trade-blotter:problem:invalid-query') return `problem type ${String(problem.type)}`
      return problem.errors?.[parameter]?.length === 1 ? undefined : `errors ${JSON.stringify(problem.errors)}`
    })
  }
  await check(report, `${label}: GET /positions covers every trade, whatever page or filter was read`, async () => {
    const before = await request(`${api}/positions`)
    await request(`${api}/trades/page?page=3&pageSize=25`)
    await request(`${api}/trades/page?side=Sell&sortBy=price&sortDirection=desc&page=2`)
    const after = await request(`${api}/positions`)
    if (before.body !== after.body) return 'positions changed after reading pages'
    return expectedDifference(after.body, expectedResponse({ kind: 'positions', name: 'check' }, snapshot))
  })

  if (target.webUrl === undefined) {
    report.skip(`${label}: frontend checks`, 'no frontend for this target')
    return
  }
  const web = target.webUrl
  await check(report, `${label}: the frontend serves its production build`, async () => {
    const page = await request(`${web}/`)
    if (page.status !== 200 || !page.body.includes('<title>Trade Blotter</title>')) return `status ${String(page.status)}, not the Trade Blotter page`
    if (page.body.includes('/@vite/client')) return 'it serves the development frontend'
    return /<script[^>]+src="\/assets\/[^"]+\.js"/.test(page.body) ? undefined : 'no built script in the page'
  })
  await check(report, `${label}: the frontend forwards to this API: page 2 by price, through its proxy, is the database's`, () =>
    answersAs(web, pagePath({ sortBy: 'price', sortDirection: 'asc' }, 2, 25), expectedPage(snapshot, everything, { field: 'price', direction: 'asc' }, 25, 2)))
}

/** Booking checks, on an API of their own over a throwaway copy of a dataset. */
export async function bookingChecks(report: Report, disposable: Disposable): Promise<void> {
  mkdirSync(disposable.dir, { recursive: true })
  const path = join(disposable.dir, `bookings-${String(process.pid)}-${String(Date.now())}.db`)
  const runDir = join(disposable.dir, 'run')
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    await seedDatabase({ path, count: disposable.count, seed: disposable.seed, protection: { ...disposable.protection, runDir } })
    server = await createServer(loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'fatal' }), { logger: false })
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    const api = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
    const post = (body: string) => request(`${api}/trades`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    report.info(`Bookings: a throwaway copy of the scratch dataset (${String(disposable.count)} trades) with an API of its own`, path)

    let booked: string | undefined
    await check(report, 'Booking: a valid trade is normalised, stored and returned with its booking sequence and exact decimals', async () => {
      const answer = await post('{"symbol":" zzreview ","side":"buy","quantity":"0.0000000001","price":"999999999999999.9999999999","executedAt":"2026-03-08T07:30:00-05:00"}')
      if (answer.status !== 201) return `status ${String(answer.status)}: ${answer.body}`
      booked = /"id":"([^"]+)"/.exec(answer.body)?.[1]
      const want = ['"symbol":"ZZREVIEW"', '"side":"Buy"', '"quantity":0.0000000001', '"price":999999999999999.9999999999',
        '"executedAt":"2026-03-08T12:30:00.000Z"', `"bookingSequence":${String(disposable.count + 1)}`]
      const missing = want.find((part) => !answer.body.includes(part))
      return missing === undefined ? undefined : `the response lacks ${missing}: ${answer.body}`
    })
    const snapshot = await readSnapshot(path)
    await check(report, 'Booking: the trade is counted, and is on the page the domain\'s order puts it, sorted and filtered', async () => {
      if (snapshot.trades.length !== disposable.count + 1) return `${String(snapshot.trades.length)} trades stored, expected ${String(disposable.count + 1)}`
      const views = [
        [{}, everything, DEFAULT_TRADE_SORT],
        [{ sortBy: 'price', sortDirection: 'desc' }, everything, { field: 'price', direction: 'desc' }],
        [{ symbol: 'review', side: 'Buy' }, (t: Trade) => t.symbol.includes('REVIEW') && isBuy(t), DEFAULT_TRADE_SORT],
      ] as const
      for (const [query, matches, sort] of views) {
        const index = snapshot.trades.filter(matches).sort(compareTrades(sort)).findIndex((t) => t.id === booked)
        if (index < 0) return `the trade does not match ${JSON.stringify(query)} in the database`
        const page = Math.floor(index / 25) + 1
        const problem = await answersAs(api, pagePath(query, page, 25), expectedPage(snapshot, matches, sort, 25, page))
        if (problem !== undefined) return `page ${String(page)} of ${JSON.stringify(query)}: ${problem}`
      }
      return undefined
    })
    await check(report, 'Booking: positions include the new trade, from the whole history', async () =>
      expectedDifference((await request(`${api}/positions`)).body, expectedResponse({ kind: 'positions', name: 'check' }, snapshot)))
    await check(report, 'Booking: an invalid trade is refused with every field\'s reason, and nothing is stored', async () => {
      const answer = await post('{"symbol":"","side":"hold","quantity":"-1","price":"1000000000000000"}')
      if (answer.status !== 400) return `status ${String(answer.status)}`
      const problem = JSON.parse(answer.body) as { type?: string; errors?: Record<string, string[]> }
      if (problem.type !== 'urn:trade-blotter:problem:invalid-trade') return `problem type ${String(problem.type)}`
      const fields = Object.keys(problem.errors ?? {})
      if (fields.join() !== 'symbol,side,quantity,price') return `errors for ${fields.join(', ')}`
      return (await readSnapshot(path)).fingerprint === snapshot.fingerprint ? undefined : 'the database changed'
    })
  } finally {
    await server?.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
    rmSync(runDir, { recursive: true, force: true })
  }
  report.pass('Booking: the throwaway database and its API were removed')
}
