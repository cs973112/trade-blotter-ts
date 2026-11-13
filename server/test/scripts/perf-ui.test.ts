import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { BrowserHost } from '../../scripts/browser.ts'
import { writeState, type AppRecord } from '../../scripts/lifecycle.ts'
import { readSnapshot, SCENARIOS } from '../../scripts/perf-api.ts'
import {
  DEFAULT_VIEW, expectedPage, findChrome, findManagedApplication, frontendParserSource, selectScenarios, sortAfterClick, UI_SCENARIOS, uiOptions,
} from '../../scripts/perf-ui.ts'
import { seedDatabase, TargetError, type Protection } from '../../scripts/trade-data.ts'
import { compareTrades, DEFAULT_TRADE_SORT } from '../../src/domain/trade-query.ts'
import { isolatedEnv, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * perf:ui without a browser: what it would measure and what it refuses. The browser benchmark
 * itself runs only on demand (npm run perf:ui), never in npm test.
 */

let dir = ''
let protection: Protection = { developmentDatabase: '', protectedFolder: '', runDir: '' }
let database = ''

beforeAll(() => {
  dir = createTempDir()
  protection = { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'run') }
  database = join(dir, 'perf.db')
  writeFileSync(database, '')
})

afterAll(() => {
  removeTempDir(dir)
})

describe('perf:ui: Chrome', () => {
  it('refuses a --chrome path that does not exist', () => {
    expect(() => findChrome(join(dir, 'no-chrome'))).toThrow(/does not exist/)
  })

  const nothing = (env: NodeJS.ProcessEnv): BrowserHost =>
    ({ platform: 'linux', env, home: '/home/a', wsl: false, kind: () => 'missing', list: () => [] })

  it('names what to do and where it looked when no browser is found, or CHROME_PATH is wrong', () => {
    expect(() => findChrome(undefined, nothing({ PATH: '/usr/bin' }))).toThrow(TargetError)
    expect(() => findChrome(undefined, nothing({ PATH: '/usr/bin' }))).toThrow(/No Chrome, Edge or Chromium was found[^]*CHROME_PATH: not set[^]*Nothing was installed/)
    expect(() => findChrome(undefined, nothing({ CHROME_PATH: '/nowhere/chrome' }))).toThrow('CHROME_PATH is set to /nowhere/chrome, which is not found.')
  })
})

describe('perf:ui: options and scenarios', () => {
  it('defaults to 2 warmup and 5 measured runs, and refuses counts that cannot work', () => {
    expect(uiOptions({})).toMatchObject({ warmup: 2, iterations: 5, timeoutSeconds: 180, maxHeapMb: 4096, scenarios: UI_SCENARIOS })
    expect(uiOptions({ warmup: '0', iterations: '1', chrome: '/c' })).toMatchObject({ warmup: 0, iterations: 1, chrome: '/c' })
    expect(() => uiOptions({ iterations: '0' })).toThrow(/--iterations/)
    expect(() => uiOptions({ warmup: 'two' })).toThrow(/whole number/)
    expect(() => uiOptions({ 'max-heap-mb': '10' })).toThrow(/--max-heap-mb/)
  })

  it('cover loading, Previous and Next, page sizes, every sortable header, the filters, Clear and typing, with the API benchmark queries', () => {
    const kinds = UI_SCENARIOS.map((scenario) => scenario.kind)
    const apiNames = new Set(SCENARIOS.map((scenario) => scenario.name))

    expect(kinds).toEqual(['load', 'next', 'previous', 'size', 'size', 'sort', 'sort', 'sort', 'sort', 'sort', 'apply', 'apply', 'apply', 'apply', 'next', 'clear', 'typing'])
    expect(UI_SCENARIOS.flatMap((s) => s.kind === 'sort' ? [s.field] : [])).toEqual(['price', 'price', 'quantity', 'symbol', 'executedAt'])
    expect(UI_SCENARIOS.flatMap((s) => s.kind === 'size' ? [s.size] : [])).toEqual([100, 25])
    for (const scenario of UI_SCENARIOS) {
      if (scenario.kind === 'apply' || scenario.kind === 'clear' || (scenario.kind === 'next' && scenario.filter !== undefined)) {
        expect(apiNames, scenario.name).toContain(scenario.filter)
      }
    }
    // Rendering every trade at once is gone, and with it the scenarios that measured it.
    expect(UI_SCENARIOS.map((s) => s.id)).not.toContain('scroll')
    expect(UI_SCENARIOS.map((s) => s.id)).not.toContain('jump')
  })

  it('sorts by header as the page does: the active column reverses, another starts ascending, or newest first for the execution date', () => {
    expect(sortAfterClick(DEFAULT_VIEW.sort, 'price')).toEqual({ field: 'price', direction: 'asc' })
    expect(sortAfterClick({ field: 'price', direction: 'asc' }, 'price')).toEqual({ field: 'price', direction: 'desc' })
    expect(sortAfterClick(DEFAULT_VIEW.sort, 'executedAt')).toEqual({ field: 'executedAt', direction: 'asc' })
    expect(sortAfterClick({ field: 'symbol', direction: 'asc' }, 'executedAt')).toEqual({ field: 'executedAt', direction: 'desc' })
  })

  it('expects the page of the database trades a view should show, and its position', async () => {
    const seeded = join(dir, 'pages.db')
    await seedDatabase({ path: seeded, count: 150, protection })
    const snapshot = await readSnapshot(seeded)
    const buys = snapshot.trades.filter((t) => t.side === 'Buy').length
    const ordered = [...snapshot.trades].sort(compareTrades(DEFAULT_TRADE_SORT))

    const page2 = expectedPage(snapshot, { ...DEFAULT_VIEW, page: 2, pageSize: 25 })
    const buysByPrice = expectedPage(snapshot, { ...DEFAULT_VIEW, filter: 'Side Buy', sort: { field: 'price', direction: 'asc' }, page: 1, pageSize: 25 })

    expect(page2).toMatchObject({ rows: 25, position: 'Page 2 of 6', matched: 150 })
    expect(page2.sha256).toBe(createHash('sha256').update(ordered.slice(25, 50).map((t) => `${t.symbol}|${t.side}|${t.executedAt}`).join('\n')).digest('hex'))
    expect(buysByPrice).toMatchObject({ rows: Math.min(25, buys), position: `Page 1 of ${String(Math.ceil(buys / 25))}`, matched: buys })
  }, 30_000)

  it('measures only the scenarios named by --scenarios, always with the initial load, and refuses unknown ids', () => {
    expect(selectScenarios(undefined)).toEqual(UI_SCENARIOS)
    expect(selectScenarios('typing, quantity-asc').map((s) => s.id)).toEqual(['load', 'quantity-asc', 'typing'])
    expect(selectScenarios('load').map((s) => s.id)).toEqual(['load'])
    expect(new Set(UI_SCENARIOS.map((s) => s.id)).size).toBe(UI_SCENARIOS.length)
    expect(() => selectScenarios('typing,nope')).toThrow(/unknown: nope/)
    expect(() => selectScenarios(',')).toThrow(/--scenarios takes ids/)
  })

  it("measures the frontend's own exact-decimal parser, loaded from its source", () => {
    // Evaluated as the page evaluates it: the expression perf:ui sends to Chrome.
    const parse = runInNewContext(frontendParserSource()) as (text: string) => unknown

    expect(parse('[{"quantity":0.12345678901234567890123,"symbol":"A\\"1"}]')).toEqual([{ quantity: '0.12345678901234567890123', symbol: 'A"1' }])
  })
})

describe('perf:ui: which frontend it measures', () => {
  const apiToken = '44444444-4444-4444-8444-444444444444'
  const webToken = '55555555-5555-4555-8555-555555555555'

  /** A live process holding a token and listening on a port, as app:start starts each application. */
  const listening = async (token: string): Promise<{ pid: number; port: number; stop: () => Promise<void> }> => {
    const child = startNode(['-e', "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port))", token],
      isolatedEnv({ DATABASE_PATH: database }))
    const port = await new Promise<number>((resolve) => { child.stdout?.once('data', (data: Buffer) => { resolve(Number(String(data).trim())) }) })
    return { pid: child.pid ?? 0, port, stop: () => stopChild(child) }
  }
  const record = (name: 'api' | 'web', pid: number, token: string, port: number, details?: Record<string, string>): AppRecord => ({
    name, label: name === 'api' ? 'API' : 'Frontend', pid, token, host: '127.0.0.1', port, url: `http://127.0.0.1:${String(port)}`, log: join(dir, `${name}.log`),
    ...(details === undefined ? {} : { details }),
  })
  const recordState = (apps: AppRecord[]): void => {
    writeState(protection.runDir, { version: 1, startedAt: new Date().toISOString(), phase: 'ready', databasePath: database, apps })
  }

  it('needs the frontend recorded, running, listening on its port, and forwarding to the recorded API', async () => {
    const api = await listening(apiToken)
    const web = await listening(webToken)
    const exited = await listening('66666666-6666-4666-8666-666666666666')
    await exited.stop()
    try {
      const apiRecord = record('api', api.pid, apiToken, api.port)
      const forwards = { 'forwards API requests to': apiRecord.url }
      const find = (webUrl?: string) => findManagedApplication({ databasePath: database, protection, ...(webUrl === undefined ? {} : { webUrl }) })

      recordState([apiRecord])
      expect(() => find()).toThrow(/frontend started with app:start is not recorded/)
      recordState([apiRecord, record('web', exited.pid, '66666666-6666-4666-8666-666666666666', web.port, forwards)])
      expect(() => find()).toThrow(/is not running\. Nothing was measured/)
      recordState([apiRecord, record('web', web.pid, webToken, web.port, { 'forwards API requests to': 'http://127.0.0.1:1' })])
      expect(() => find()).toThrow(/forwards API requests to http:\/\/127\.0\.0\.1:1, not to the API/)
      recordState([apiRecord, record('web', web.pid, webToken, api.port, forwards)])
      expect(() => find()).toThrow(/Another process also listens on port/)

      recordState([apiRecord, record('web', web.pid, webToken, web.port, forwards)])
      expect(find()).toMatchObject({ webUrl: new URL(`http://127.0.0.1:${String(web.port)}`), webPid: web.pid, api: { pid: api.pid } })
      expect(() => find(`http://127.0.0.1:${String(api.port)}`)).toThrow(/--web-url .* is not the Frontend started with app:start/)
      expect(() => findManagedApplication({ databasePath: protection.developmentDatabase, protection })).toThrow(/is the development database/)
    } finally {
      await Promise.all([api.stop(), web.stop()])
    }
  }, 60_000)
})
