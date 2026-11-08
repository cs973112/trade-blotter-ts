import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { Agent, get, type IncomingHttpHeaders } from 'node:http'
import { arch, cpus, release, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

import { drizzle } from 'drizzle-orm/node-sqlite'

import { parseJsonPreservingDecimals } from '../src/api/json.ts'
import { decimalText } from '../src/domain/decimal.ts'
import { calculatePositions } from '../src/domain/position.ts'
import { compareTrades, DEFAULT_TRADE_SORT, type TradeSort } from '../src/domain/trade-query.ts'
import { notional, type Trade } from '../src/domain/trade.ts'
import { createDrizzleTradeRepository } from '../src/infrastructure/drizzle-trade-repository.ts'
import { canonicalPath, defaultRunDir, processStatus, readState, type AppRecord } from './lifecycle.ts'
import { listenersOnPort, processMemory, type ProcessMemory } from './process-probe.ts'
import { DEFAULT_PROTECTION, refuseProtectedDatabase, TargetError, type Protection } from './trade-data.ts'

/**
 * npm run perf:api -- --database <path> [--api-url <url>] [--warmup <n>] [--iterations <n>] [--json <file>]
 *
 * Measures the running API, started with app:start, on the database it names: GET /trades (every
 * match) with each search, filter and sort; GET /trades/page, first, middle and last pages of
 * every sort, both page sizes, the filters and deep filtered pages; and GET /positions. It only
 * reads: it never starts, stops, seeds or clears anything, and checks at the end that the trade
 * records are exactly as they were.
 *
 * Before measuring, it checks that the API is the one app:start started on that exact database
 * (its process, holding its token, is the one listening on the port) and that the API serves
 * exactly the trades the file holds. Every response, warmup included, is checked: the status, and
 * the same bytes as the first response, which is checked trade by trade against the database.
 * Requests are sequential, one at a time, over one kept-alive connection.
 */

export const DEFAULT_WARMUP = 5
export const DEFAULT_ITERATIONS = 10

export class BenchmarkError extends Error {}

/** The API started with app:start on the selected database. */
export interface ManagedApi {
  readonly databasePath: string
  readonly url: URL
  /** The API process: measured for memory. */
  readonly pid: number
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

/** The record's URL, or the given one when it is another spelling of the same local address. */
export function managedUrl(record: AppRecord, apiUrl: string | undefined, option = '--api-url'): URL {
  if (apiUrl === undefined) return new URL(record.url)
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new TargetError(`${option} ${apiUrl} is not a URL; give the ${record.label}'s address, such as ${record.url}.`)
  }
  const port = url.port === '' ? 80 : Number(url.port)
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TargetError(`${option} must be only the ${record.label}'s http address, such as ${record.url}; got ${apiUrl}.`)
  }
  if (port !== record.port || ![record.host, ...LOCAL_HOSTS].includes(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new TargetError(`${option} ${apiUrl} is not the ${record.label} started with app:start, which listens at ${record.url}. Nothing was measured.`)
  }
  return url
}

/**
 * The API that app:start started on this database, after checking that it is that API: the run
 * state names this database, the API's process is alive and holds its token, and that process,
 * and no other, listens on its port. Anything else is refused with a TargetError.
 */
export function findManagedApi(options: {
  readonly databasePath: string | undefined
  readonly apiUrl?: string
  readonly protection?: Protection
}): ManagedApi {
  const protection = options.protection ?? DEFAULT_PROTECTION
  const databasePath = refuseProtectedDatabase(options.databasePath, protection)
  if (!existsSync(databasePath) || statSync(databasePath).isDirectory()) {
    throw new TargetError(`${databasePath} does not exist. Seed it first: npm run db:seed -- --count 1000 --database "${databasePath}"`)
  }
  const start = `npm run app:start -- --database "${databasePath}"`
  const state = readState(protection.runDir)
  if (state === undefined) throw new TargetError(`No application started with app:start is recorded. Start the API on this database first: ${start}`)
  if (canonicalPath(state.databasePath) !== canonicalPath(databasePath)) {
    throw new TargetError(`The API started with app:start uses ${state.databasePath}, not ${databasePath}. Nothing was measured. ` +
      `Stop it (npm run app:stop) and start it on this database: ${start}`)
  }
  const record = state.apps.find((app) => app.name === 'api')
  if (record === undefined || state.phase !== 'ready') throw new TargetError(`app:start has not finished starting the API. Wait, or run npm run app:stop and ${start}`)
  const status = processStatus(record)
  if (status !== 'running') {
    throw new TargetError(`The API started with app:start (process ${String(record.pid)}) is not running` +
      `${status === 'reused' ? ': its process id now belongs to another program' : status === 'unverified' ? ', or could not be checked' : ''}. ` +
      `Nothing was measured. Run npm run app:stop, then ${start}`)
  }
  const url = managedUrl(record, options.apiUrl)
  const listeners = listenersOnPort(record.port, record.pid)
  if (listeners !== 'only') {
    throw new TargetError({
      others: `Another process also listens on port ${String(record.port)}, so a request might not reach the API started with app:start (process ${String(record.pid)}). Nothing was measured.`,
      none: `Nothing listens on port ${String(record.port)}, where the API started with app:start should be. Nothing was measured.`,
      unknown: `Could not check which process listens on port ${String(record.port)}, so the API could not be confirmed. Nothing was measured.`,
    }[listeners])
  }
  return { databasePath, url, pid: record.pid }
}

/** The trades in the file, read through the application's repository on a read-only connection. */
export interface Snapshot {
  readonly trades: readonly Trade[]
  /** SHA-256 of every stored field of every trade, in trade order. */
  readonly fingerprint: string
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  const client = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = client.prepare("select name from sqlite_master where type = 'table' and name = 'trades'").all()
    if (tables.length === 0) throw new TargetError(`${path} is not a Trade Blotter database: it has no trades table.`)
    const trades = await createDrizzleTradeRepository(drizzle({ client })).listInTradeOrder()
    const hash = createHash('sha256')
    for (const t of trades) {
      hash.update(`${String(t.bookingSequence)}|${t.id}|${t.symbol}|${t.side}|${decimalText(t.quantity)}|${decimalText(t.price)}|${t.executedAt}|${t.createdAt}|${t.updatedAt}\n`)
    }
    return { trades, fingerprint: hash.digest('hex') }
  } finally {
    client.close()
  }
}

interface TradeScenario {
  readonly kind: 'trades'
  readonly name: string
  readonly query: Readonly<Record<string, string>>
  readonly matches: (trade: Trade) => boolean
  readonly sort: TradeSort
}

/** Which page of the matches a page scenario asks for; the number depends on how many trades match. */
export type PagePosition = 'first' | 'middle' | 'last' | 'past the last'

interface PageScenario {
  readonly kind: 'page'
  readonly name: string
  readonly query: Readonly<Record<string, string>>
  readonly matches: (trade: Trade) => boolean
  readonly sort: TradeSort
  readonly pageSize: number
  readonly at: PagePosition
}

interface PositionScenario {
  readonly kind: 'positions'
  readonly name: string
}

export type Scenario = TradeScenario | PageScenario | PositionScenario

/** The page number for a position among `matched` trades: the last page past the end is one more than the last. */
export function pageNumber(at: PagePosition, matched: number, pageSize: number): number {
  const pages = Math.ceil(matched / pageSize)
  if (at === 'first') return 1
  if (at === 'middle') return Math.max(1, Math.ceil(pages / 2))
  if (at === 'last') return Math.max(1, pages)
  return pages + 1
}

const everything = (): boolean => true
const utc = (timestamp: string): string => new Date(timestamp).toISOString()
const executedBetween = (from: string, to: string) => (trade: Trade): boolean => trade.executedAt >= utc(from) && trade.executedAt <= utc(to)

// Local days in New York, written with their UTC offsets as the frontend sends them; both ranges
// cross a daylight-saving change.
const FIRST_HALF_2026 = { executedFrom: '2026-01-01T00:00:00.000-05:00', executedTo: '2026-06-30T23:59:59.999-04:00' }
const YEAR_TO_JUNE_2026 = { executedFrom: '2025-07-01T00:00:00.000-04:00', executedTo: '2026-06-30T23:59:59.999-04:00' }

const sorted = (field: TradeSort['field'], direction: TradeSort['direction']): TradeScenario => ({
  kind: 'trades', name: `Sort by ${field} ${direction}`, query: { sortBy: field, sortDirection: direction }, matches: everything, sort: { field, direction },
})

/**
 * Chosen for the deterministic sample data (db:seed): "ms" matches MS, MSFT and MSTR (about one
 * trade in seven), each side about half, the first half of 2026 about a quarter, and the combined
 * filter a few percent; every one matches some trades at 100 trades and more.
 */
const ALL_TRADES: Scenario = { kind: 'trades', name: 'All trades (default order)', query: {}, matches: everything, sort: DEFAULT_TRADE_SORT }

export const SCENARIOS: readonly Scenario[] = [
  ALL_TRADES,
  { kind: 'trades', name: 'Symbol search "ms"', query: { symbol: 'ms' }, matches: (t) => t.symbol.includes('MS'), sort: DEFAULT_TRADE_SORT },
  { kind: 'trades', name: 'Side Buy', query: { side: 'Buy' }, matches: (t) => t.side === 'Buy', sort: DEFAULT_TRADE_SORT },
  { kind: 'trades', name: 'Side Sell', query: { side: 'Sell' }, matches: (t) => t.side === 'Sell', sort: DEFAULT_TRADE_SORT },
  {
    kind: 'trades', name: 'Executed 2026-01-01 to 2026-06-30', query: FIRST_HALF_2026,
    matches: executedBetween(FIRST_HALF_2026.executedFrom, FIRST_HALF_2026.executedTo), sort: DEFAULT_TRADE_SORT,
  },
  {
    kind: 'trades', name: '"ms" + Sell + 2025-07-01 to 2026-06-30', query: { symbol: 'ms', side: 'Sell', ...YEAR_TO_JUNE_2026 },
    matches: (t) => t.symbol.includes('MS') && t.side === 'Sell' && executedBetween(YEAR_TO_JUNE_2026.executedFrom, YEAR_TO_JUNE_2026.executedTo)(t),
    sort: DEFAULT_TRADE_SORT,
  },
  sorted('executedAt', 'asc'), sorted('executedAt', 'desc'),
  sorted('symbol', 'asc'), sorted('symbol', 'desc'),
  sorted('quantity', 'asc'), sorted('quantity', 'desc'),
  sorted('price', 'asc'), sorted('price', 'desc'),
  ...pageScenarios(),
  { kind: 'positions', name: 'Positions' },
]

/**
 * GET /trades/page: the first, middle and last page of every sort at 50 a page, and the default
 * order and price at 100; the filters of the scenarios above, page by page; deep pages of filtered
 * lists sorted by something other than execution time, which no index serves directly; a page
 * past the last, and a search that matches nothing.
 */
function pageScenarios(): PageScenario[] {
  const page = (base: Omit<PageScenario, 'kind' | 'name' | 'pageSize' | 'at'> & { label: string }, pageSize: number, at: PagePosition): PageScenario => {
    const { label, ...rest } = base
    return { kind: 'page', name: `Page: ${label}, ${at} page of ${String(pageSize)}`, pageSize, at, ...rest }
  }
  const order = (field: TradeSort['field'], direction: TradeSort['direction']) => ({
    label: field === DEFAULT_TRADE_SORT.field && direction === DEFAULT_TRADE_SORT.direction ? 'default order' : `${field} ${direction}`,
    query: field === DEFAULT_TRADE_SORT.field && direction === DEFAULT_TRADE_SORT.direction ? {} : { sortBy: field, sortDirection: direction },
    matches: everything, sort: { field, direction },
  })
  const ms = { label: '"ms"', query: { symbol: 'ms' }, matches: (t: Trade) => t.symbol.includes('MS'), sort: DEFAULT_TRADE_SORT }
  const buy = { label: 'side Buy', query: { side: 'Buy' }, matches: (t: Trade) => t.side === 'Buy', sort: DEFAULT_TRADE_SORT }
  const half = { label: '2026-01-01 to 2026-06-30', query: FIRST_HALF_2026, matches: executedBetween(FIRST_HALF_2026.executedFrom, FIRST_HALF_2026.executedTo), sort: DEFAULT_TRADE_SORT }
  const combined = {
    label: '"ms" + Sell + 2025-07-01 to 2026-06-30', query: { symbol: 'ms', side: 'Sell', ...YEAR_TO_JUNE_2026 },
    matches: (t: Trade) => t.symbol.includes('MS') && t.side === 'Sell' && executedBetween(YEAR_TO_JUNE_2026.executedFrom, YEAR_TO_JUNE_2026.executedTo)(t),
    sort: DEFAULT_TRADE_SORT,
  }
  const positions: PagePosition[] = ['first', 'middle', 'last']
  const sorts = [['executedAt', 'desc'], ['executedAt', 'asc'], ['symbol', 'asc'], ['symbol', 'desc'], ['quantity', 'asc'], ['quantity', 'desc'], ['price', 'asc'], ['price', 'desc']] as const
  type Filter = Omit<PageScenario, 'kind' | 'name' | 'pageSize' | 'at'> & { readonly label: string }
  const sortedBy = (base: Filter, field: TradeSort['field'], direction: TradeSort['direction']): Filter => ({
    ...base, label: `${base.label} by ${field} ${direction}`, query: { ...base.query, sortBy: field, sortDirection: direction }, sort: { field, direction },
  })
  return [
    ...sorts.flatMap(([field, direction]) => positions.map((at) => page(order(field, direction), 50, at))),
    page(order('executedAt', 'desc'), 50, 'past the last'),
    ...positions.map((at) => page(order('executedAt', 'desc'), 100, at)),
    ...positions.map((at) => page(order('price', 'asc'), 100, at)),
    ...[ms, buy, half, combined].flatMap((filter) => positions.map((at) => page(filter, 50, at))),
    page(sortedBy(ms, 'price', 'asc'), 50, 'middle'),
    page(sortedBy(buy, 'quantity', 'desc'), 50, 'middle'),
    page(sortedBy({ ...half, query: YEAR_TO_JUNE_2026, label: '2025-07-01 to 2026-06-30', matches: executedBetween(YEAR_TO_JUNE_2026.executedFrom, YEAR_TO_JUNE_2026.executedTo) }, 'symbol', 'asc'), 50, 'middle'),
    page({ label: 'search matching nothing', query: { symbol: 'zzzz' }, matches: () => false, sort: DEFAULT_TRADE_SORT }, 50, 'first'),
  ]
}

/** The endpoint a scenario measures. */
export function endpointOf(scenario: Scenario): ScenarioResult['endpoint'] {
  return scenario.kind === 'positions' ? 'GET /positions' : scenario.kind === 'page' ? 'GET /trades/page' : 'GET /trades'
}

/** The request path of a scenario; a page scenario's page number depends on how many trades match. */
export function scenarioPath(scenario: Scenario, matched = 0): string {
  if (scenario.kind === 'positions') return '/positions'
  if (scenario.kind === 'page') {
    const query = new URLSearchParams({ ...scenario.query, page: String(pageNumber(scenario.at, matched, scenario.pageSize)), pageSize: String(scenario.pageSize) })
    return `/trades/page?${query.toString()}`
  }
  const query = new URLSearchParams(scenario.query).toString()
  return query === '' ? '/trades' : `/trades?${query}`
}

/** Response fields that are exact decimals: read from their JSON source text, never through a JavaScript number. */
const DECIMAL_FIELDS: ReadonlySet<string> = new Set(['quantity', 'price', 'notional', 'netQuantity', 'averageCost'])

type Row = Record<string, string | number>

/** A trade as the API writes it, decimals as canonical text (decimalText). */
const tradeRow = (t: Trade): Row => ({
  id: t.id, bookingSequence: t.bookingSequence, symbol: t.symbol, side: t.side,
  quantity: decimalText(t.quantity), price: decimalText(t.price), notional: decimalText(notional(t)), executedAt: t.executedAt,
})

/** The numbers of a GET /trades/page response. */
export interface PageNumbers {
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

/** What a scenario's response must hold, computed from the snapshot with the domain's own order and accounting. */
export interface Expected {
  /** Every matching trade (or position) for GET /trades and /positions; the page's trades for GET /trades/page. */
  readonly rows: readonly Row[]
  /** How many trades match the query, on every page. */
  readonly matched: number
  readonly page?: PageNumbers
}

export function expectedResponse(scenario: Scenario, snapshot: Snapshot): Expected {
  if (scenario.kind === 'positions') {
    const rows = calculatePositions(snapshot.trades).map((p) => ({ symbol: p.symbol, netQuantity: decimalText(p.netQuantity), averageCost: decimalText(p.averageCost) }))
    return { rows, matched: rows.length }
  }
  const matching = snapshot.trades.filter(scenario.matches).sort(compareTrades(scenario.sort))
  if (scenario.kind === 'trades') return { rows: matching.map(tradeRow), matched: matching.length }
  return pageFrom(matching, scenario.pageSize, pageNumber(scenario.at, matching.length, scenario.pageSize))
}

/** The response GET /trades/page must give for any page of the trades matching a query, in its sort order. */
export function expectedPage(snapshot: Snapshot, matches: (trade: Trade) => boolean, sort: TradeSort, pageSize: number, page: number): Expected {
  return pageFrom(snapshot.trades.filter(matches).sort(compareTrades(sort)), pageSize, page)
}

function pageFrom(ordered: readonly Trade[], pageSize: number, page: number): Expected {
  return {
    rows: ordered.slice((page - 1) * pageSize, page * pageSize).map(tradeRow),
    matched: ordered.length,
    page: { page, pageSize, totalCount: ordered.length, totalPages: Math.ceil(ordered.length / pageSize) },
  }
}

/** The first difference between a response body and what was expected, or undefined when it matches. */
export function expectedDifference(body: string, expected: Expected): string | undefined {
  if (expected.page === undefined) return responseDifference(body, expected.rows)
  let envelope: unknown
  try {
    envelope = parseJsonPreservingDecimals(body, DECIMAL_FIELDS)
  } catch {
    return 'the body is not JSON'
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return 'the body is not a JSON object'
  const members = envelope as Record<string, unknown>
  for (const [name, value] of Object.entries(expected.page)) {
    if (members[name] !== value) return `${name} is ${JSON.stringify(members[name])}, expected ${String(value)}`
  }
  return rowsDifference(members['items'], expected.rows, 'items')
}

/** The first difference between a response body and the expected rows, or undefined when it matches. */
export function responseDifference(body: string, expected: readonly Record<string, string | number>[]): string | undefined {
  let rows: unknown
  try {
    // The API's own lossless reading: each decimal arrives as its exact source text.
    rows = parseJsonPreservingDecimals(body, DECIMAL_FIELDS)
  } catch {
    return 'the body is not JSON'
  }
  return rowsDifference(rows, expected, 'the body')
}

function rowsDifference(rows: unknown, expected: readonly Record<string, string | number>[], what: string): string | undefined {
  if (!Array.isArray(rows)) return `${what} is not a JSON array`
  if (rows.length !== expected.length) return `${String(rows.length)} rows, expected ${String(expected.length)}`
  for (const [index, want] of expected.entries()) {
    const row = rows[index] as Record<string, unknown> | undefined
    for (const [field, value] of Object.entries(want)) {
      if (row?.[field] !== value) return `row ${String(index + 1)}: ${field} is ${JSON.stringify(row?.[field])}, expected ${JSON.stringify(value)}`
    }
  }
  return undefined
}

interface Response {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  /** From sending the request until the last byte of the body arrived. */
  readonly milliseconds: number
  /** From sending the request until the status line and headers arrived. */
  readonly headersMilliseconds: number
}

/** One GET, timed with the monotonic high-resolution clock; the whole body is read before the clock stops. */
function timedGet(url: URL, agent: Agent): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const started = performance.now()
    const request = get(url, { agent, headers: { accept: 'application/json' } }, (response) => {
      const headersMilliseconds = performance.now() - started
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => {
        const milliseconds = performance.now() - started
        resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), milliseconds, headersMilliseconds })
      })
    })
    request.setTimeout(300_000, () => { request.destroy(new BenchmarkError(`No response from ${url.href} within 300 seconds.`)) })
    request.once('error', reject)
  })
}

export interface Stats {
  readonly min: number
  readonly median: number
  /** Nearest rank: the smallest sample at or above 95 % of the samples. With 10 samples, the maximum. */
  readonly p95: number
  readonly max: number
  readonly mean: number
}

export function statistics(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new RangeError('No samples.')
  const ordered = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  const at = (index: number): number => ordered[Math.min(Math.max(index, 0), ordered.length - 1)] ?? Number.NaN
  return {
    min: at(0),
    median: ordered.length % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2,
    p95: at(Math.ceil(0.95 * ordered.length) - 1),
    max: at(ordered.length - 1),
    mean: ordered.reduce((sum, sample) => sum + sample, 0) / ordered.length,
  }
}

export interface ScenarioResult {
  readonly name: string
  readonly endpoint: 'GET /trades' | 'GET /trades/page' | 'GET /positions'
  readonly path: string
  /** Trades (or positions) matching the query, on every page. */
  readonly matchedRows: number
  /** Rows in the response: every match for GET /trades and /positions, one page's for GET /trades/page. */
  readonly returnedRows: number
  readonly responseBytes: number
  readonly warmupIterations: number
  readonly measuredIterations: number
  /** Request sent until the whole body arrived. */
  readonly latencyMs: Stats
  /** Request sent until the headers arrived. */
  readonly headersMs: Stats
  /** UTF-8 decoding and JSON.parse, measured separately, after each measured response. */
  readonly jsonParseMs: Stats
  /** The API process's memory just after this scenario's last request. */
  readonly serverMemoryAfter: ProcessMemory | undefined
}

export interface BenchmarkResult {
  readonly tool: 'perf:api'
  readonly version: 1
  readonly startedAt: string
  readonly finishedAt: string
  readonly environment: {
    readonly platform: NodeJS.Platform
    readonly release: string
    readonly arch: string
    readonly node: string
    readonly cpu: string
    readonly logicalCores: number
    readonly totalMemoryBytes: number
  }
  readonly databasePath: string
  readonly apiUrl: string
  readonly apiPid: number
  readonly datasetTrades: number
  readonly datasetFingerprint: string
  /** True when the trade records were byte for byte the same after the benchmark as before it. */
  readonly datasetUnchanged: boolean
  readonly warmupIterations: number
  readonly measuredIterations: number
  readonly method: Readonly<Record<string, string>>
  readonly serverMemoryBefore: ProcessMemory | undefined
  readonly scenarios: readonly ScenarioResult[]
}

export interface BenchmarkOptions {
  readonly warmup?: number
  readonly iterations?: number
  /** Sample the API process's memory between scenarios (default true). */
  readonly memory?: boolean
  readonly scenarios?: readonly Scenario[]
  /** Told as each scenario finishes. */
  readonly onScenario?: (result: ScenarioResult) => void
}

export const METHOD: Readonly<Record<string, string>> = {
  timer: 'performance.now(): monotonic, high resolution',
  requests: 'sequential, one at a time, over one kept-alive HTTP/1.1 connection (node:http)',
  latency: 'from sending the request until the last byte of the body has arrived; the whole body is read before the clock stops',
  jsonParsing: 'not included in latency; measured separately after each measured response: UTF-8 decoding + JSON.parse, in Node. ' +
    'The frontend\'s own exact-decimal parsing is measured in the browser by perf:ui',
  validation: 'every response, warmup included, must be 200 application/json with the same bytes as the first, which is checked row by row ' +
    'against the database; checking happens outside the timed part; an invalid response stops the benchmark',
  pages: 'GET /trades/page scenarios ask for the first, middle (number of pages divided by 2, rounded up) or last page of the matches, ' +
    'or the page after the last; the expected items and the numbers (page, pageSize, totalCount, totalPages) are computed from the ' +
    'database with the domain\'s own order (compareTrades), and every response must match them exactly, decimals included',
  queryCounts: 'not measured: the API exposes no count of the SQL statements a request runs, and counting them would mean changing the ' +
    'application. By design a page is read with two or three statements in one read transaction (the count, the page, and for a deep ' +
    'filtered page sorted by symbol, quantity or price, the number of all trades)',
  p95: 'nearest rank; with 10 measured samples it equals the maximum',
  memory: 'the API process\'s resident memory, sampled between scenarios, not during requests; the peak is the process\'s own since it started',
}

/**
 * Measures every scenario against the API, sequentially. The database snapshot gives the expected
 * response of each scenario; the run fails with a BenchmarkError on any invalid response, and if
 * the trade records differ afterwards.
 */
export async function runBenchmark(api: ManagedApi, options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const warmup = options.warmup ?? DEFAULT_WARMUP
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  if (!Number.isInteger(warmup) || warmup < 0 || !Number.isInteger(iterations) || iterations < 1) {
    throw new BenchmarkError(`--warmup must be 0 or more and --iterations 1 or more, got ${String(warmup)} and ${String(iterations)}.`)
  }
  const startedAt = new Date().toISOString()
  const memory = (): ProcessMemory | undefined => (options.memory ?? true) ? processMemory(api.pid) : undefined
  const before = await readSnapshot(api.databasePath)
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  try {
    // The API must serve exactly the trades in this file, or the numbers describe another database.
    const all = await timedGet(new URL('/trades', api.url), agent)
    const served = all.status === 200 ? expectedDifference(all.body.toString('utf8'), expectedResponse(ALL_TRADES, before)) : `status ${String(all.status)}`
    if (served !== undefined) {
      throw new TargetError(`The API at ${api.url.origin} does not serve the trades in ${api.databasePath} (${served}). Nothing was measured.`)
    }

    const serverMemoryBefore = memory()
    const results: ScenarioResult[] = []
    for (const scenario of options.scenarios ?? SCENARIOS) {
      const expected = expectedResponse(scenario, before)
      const path = scenarioPath(scenario, expected.matched)
      const url = new URL(path, api.url)
      let reference: string | undefined
      const check = (response: Response, label: string): void => {
        const type = response.headers['content-type'] ?? ''
        if (response.status !== 200 || !type.startsWith('application/json')) {
          throw new BenchmarkError(`${scenario.name} (${path}), ${label}: status ${String(response.status)} ${type}; expected 200 application/json. No result was recorded.`)
        }
        const hash = createHash('sha256').update(response.body).digest('hex')
        if (reference === undefined) {
          const problem = expectedDifference(response.body.toString('utf8'), expected)
          if (problem !== undefined) throw new BenchmarkError(`${scenario.name} (${path}), ${label}: ${problem}. No result was recorded.`)
          reference = hash
        } else if (hash !== reference) {
          throw new BenchmarkError(`${scenario.name} (${path}), ${label}: the response differs from the first one. No result was recorded.`)
        }
      }

      for (let index = 0; index < warmup; index++) check(await timedGet(url, agent), `warmup ${String(index + 1)}`)
      const samples: Response[] = []
      const jsonParse: number[] = []
      for (let index = 0; index < iterations; index++) {
        const response = await timedGet(url, agent)
        check(response, `measurement ${String(index + 1)}`)
        samples.push(response)
        const parseStart = performance.now()
        JSON.parse(response.body.toString('utf8'))
        jsonParse.push(performance.now() - parseStart)
      }
      const result: ScenarioResult = {
        name: scenario.name, endpoint: endpointOf(scenario), path, matchedRows: expected.matched, returnedRows: expected.rows.length, responseBytes: samples[0]?.body.length ?? 0,
        warmupIterations: warmup, measuredIterations: iterations,
        latencyMs: statistics(samples.map((sample) => sample.milliseconds)),
        headersMs: statistics(samples.map((sample) => sample.headersMilliseconds)),
        jsonParseMs: statistics(jsonParse),
        serverMemoryAfter: memory(),
      }
      results.push(result)
      options.onScenario?.(result)
    }

    const after = await readSnapshot(api.databasePath)
    if (after.fingerprint !== before.fingerprint) {
      throw new BenchmarkError(`The trades in ${api.databasePath} changed during the benchmark (${String(before.trades.length)} before, ` +
        `${String(after.trades.length)} after); the results were discarded. Something else wrote to the database.`)
    }
    const cpu = cpus()
    return {
      tool: 'perf:api', version: 1, startedAt, finishedAt: new Date().toISOString(),
      environment: {
        platform: process.platform, release: release(), arch: arch(), node: process.version,
        cpu: cpu[0]?.model.trim() ?? 'unknown', logicalCores: cpu.length, totalMemoryBytes: totalmem(),
      },
      databasePath: api.databasePath, apiUrl: api.url.origin, apiPid: api.pid,
      datasetTrades: before.trades.length, datasetFingerprint: before.fingerprint, datasetUnchanged: true,
      warmupIterations: warmup, measuredIterations: iterations, method: METHOD, serverMemoryBefore, scenarios: results,
    }
  } finally {
    agent.destroy()
  }
}

export const grouped = (value: number): string => value.toLocaleString('en-US')

/** Milliseconds with the precision a reader needs: two decimals below 10, one below 100. */
export function ms(value: number): string {
  return value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0)
}

export const mib = (bytes: number | undefined): string => bytes === undefined ? 'n/a' : `${(bytes / 2 ** 20).toFixed(1)} MiB`

/** A plain-text table, columns padded; numbers right-aligned. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0))).join('  ').trimEnd()
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n')
}

export function formatResult(result: BenchmarkResult): string {
  const memorySource = result.serverMemoryBefore?.source ?? result.scenarios.find((s) => s.serverMemoryAfter)?.serverMemoryAfter?.source
  const peak = result.scenarios.at(-1)?.serverMemoryAfter?.peakResidentBytes
  return [
    `API benchmark: ${grouped(result.datasetTrades)} trades in ${result.databasePath}`,
    `API ${result.apiUrl} (process ${String(result.apiPid)}); ${String(result.warmupIterations)} warmup + ${String(result.measuredIterations)} measured ` +
      'requests per scenario, sequential.',
    `${result.environment.platform} ${result.environment.release} ${result.environment.arch}, Node.js ${result.environment.node}, ` +
      `${result.environment.cpu} (${String(result.environment.logicalCores)} logical cores).`,
    '',
    table(
      ['Scenario', 'Matched', 'Returned', 'Bytes', 'Min ms', 'Median ms', 'p95 ms', 'Max ms', 'JSON.parse ms', 'Server RSS after'],
      result.scenarios.map((s) => [
        s.name, grouped(s.matchedRows), grouped(s.returnedRows), grouped(s.responseBytes), ms(s.latencyMs.min), ms(s.latencyMs.median), ms(s.latencyMs.p95),
        ms(s.latencyMs.max), ms(s.jsonParseMs.median), mib(s.serverMemoryAfter?.residentBytes),
      ]),
    ),
    '',
    'Measured: latency is from sending the request until the whole body has arrived. Parsing is not included;',
    'JSON.parse ms is the median of UTF-8 decoding and JSON.parse, measured separately in this process (the frontend\'s parsing: perf:ui).',
    `p95 is nearest rank${result.measuredIterations <= 19 ? `: with ${String(result.measuredIterations)} sample${result.measuredIterations === 1 ? '' : 's'} it equals the maximum` : ''}.`,
    memorySource === undefined ? 'Server memory: not available on this system.'
      : `Server memory (${memorySource}), sampled between scenarios: ${mib(result.serverMemoryBefore?.residentBytes)} before the first request` +
        `${peak === undefined ? '' : `; peak since the API started ${mib(peak)}`}.`,
    `Trade records unchanged afterwards: ${result.datasetUnchanged ? 'yes' : 'NO'} (SHA-256 ${result.datasetFingerprint.slice(0, 16)}...).`,
    'Matched: trades (or positions) matching the query; Returned: rows in the response, one page for GET /trades/page.',
    'SQL statements per request: not measured (no counter in the API; see the method in the JSON results).',
  ].join('\n')
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value)) throw new BenchmarkError(`${name} must be a whole number, got "${value}".`)
  return Number(value)
}

async function main(): Promise<number> {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        database: { type: 'string' }, 'api-url': { type: 'string' }, warmup: { type: 'string' }, iterations: { type: 'string' }, json: { type: 'string' },
      },
    })
    const cwd = process.env['INIT_CWD'] ?? process.cwd()
    const warmup = count(values.warmup, '--warmup', DEFAULT_WARMUP)
    const iterations = count(values.iterations, '--iterations', DEFAULT_ITERATIONS)
    if (iterations < 1) throw new BenchmarkError('--iterations must be 1 or more.')
    const api = findManagedApi({
      databasePath: values.database === undefined ? undefined : resolve(cwd, values.database),
      ...(values['api-url'] === undefined ? {} : { apiUrl: values['api-url'] }),
      protection: { ...DEFAULT_PROTECTION, runDir: defaultRunDir() },
    })
    console.log(`Measuring ${api.url.origin} on ${api.databasePath}...`)
    const result = await runBenchmark(api, {
      warmup, iterations,
      onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${ms(scenario.latencyMs.median)} ms`) },
    })
    console.log(`\n${formatResult(result)}`)
    if (values.json !== undefined) {
      const path = resolve(cwd, values.json)
      writeJson(path, result)
      console.log(`Results: ${path}`)
    }
    return 0
  } catch (error) {
    if (error instanceof TargetError || error instanceof BenchmarkError) {
      console.error(error.message)
      return 1
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(`${error.message}\nUsage: npm run perf:api -- --database <path> [--api-url <url>] [--warmup <n>] [--iterations <n>] [--json <file>]`)
      return 2
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main()
}
