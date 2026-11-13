import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { arch, cpus, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { calculatePositions } from '../src/domain/position.ts'
import { compareTrades, DEFAULT_TRADE_SORT, type TradeSort, type TradeSortField } from '../src/domain/trade-query.ts'
import type { Trade } from '../src/domain/trade.ts'
import { explicitBrowserProblem, lookUpBrowser, systemHost, type BrowserHost } from './browser.ts'
import { defaultRunDir, processStatus, readState, REPOSITORY_ROOT } from './lifecycle.ts'
import {
  BenchmarkError, count, expectedDifference, expectedResponse, findManagedApi, grouped, managedUrl, mib, ms, readSnapshot, SCENARIOS, statistics, table,
  writeJson, type ManagedApi, type Scenario, type Snapshot, type Stats,
} from './perf-api.ts'
import { listenersOnPort, processesMemory } from './process-probe.ts'
import { DEFAULT_PROTECTION, TargetError, type Protection } from './trade-data.ts'

/**
 * npm run perf:ui -- --database <path> [--web-url <url>] [--warmup <n>] [--iterations <n>] [--json <file>]
 *                    [--chrome <path>] [--timeout <seconds>] [--max-heap-mb <n>] [--scenarios <id,id,...>]
 *
 * With --json, the file is rewritten after every scenario (complete: false until the end), so an
 * interrupted run keeps what it finished. --scenarios measures only some scenarios; the initial
 * load always runs, as it opens the page.
 *
 * Measures the built frontend in headless Chrome, on the API and frontend that app:start started
 * on the selected database: loading the first page, paging with Previous and Next, choosing the
 * page size, sorting by column header, searching, filtering, clearing and typing, through the
 * page's own controls. Chrome is driven over the
 * DevTools protocol on Node.js built-ins (WebSocket); it runs with its own temporary profile and is
 * closed at the end. Nothing is booked, seeded or cleared; the trades are checked unchanged at the
 * end.
 *
 * An action is done when a GET /trades/page request made after it has finished, the table shows the
 * expected page (rows checked against the database, in order) and both pagers its position, with no
 * update in progress, and the browser has produced the next frame. Times are
 * read in the page, from the browser's own clocks: Resource Timing for the request, Long Tasks for
 * main-thread blocking, Event Timing and animation frames for typing.
 */

export const DEFAULT_UI_WARMUP = 2
export const DEFAULT_UI_ITERATIONS = 5
const DEFAULT_TIMEOUT_SECONDS = 180
const DEFAULT_MAX_HEAP_MB = 4096
const VIEWPORT = { width: 1280, height: 900 }
const TIME_ZONE = 'America/New_York'

// ---------------------------------------------------------------------------------------------
// Chrome

/**
 * The browser: --chrome as given, else CHROME_PATH, else the usual places (see browser.ts). Any
 * Chromium-based browser with the DevTools protocol works: Google Chrome, Microsoft Edge, Chromium.
 */
export function findChrome(explicit: string | undefined, host: BrowserHost = systemHost()): string {
  if (explicit !== undefined) {
    const problem = explicitBrowserProblem(explicit, host)
    if (problem !== undefined) throw new TargetError(problem)
    return explicit
  }
  const lookup = lookUpBrowser(host)
  if (lookup.kind === 'found') return lookup.path
  if (lookup.kind === 'invalid-setting') throw new TargetError(lookup.message)
  throw new TargetError(`No Chrome, Edge or Chromium was found, so the browser cannot run. Name one with --chrome <path> or CHROME_PATH.\n${lookup.diagnostics}`)
}

type Json = Record<string, unknown>

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: Json
  readonly result?: Json
  readonly error?: { readonly message: string }
  readonly sessionId?: string
}

/** One DevTools protocol connection to the browser, with sessions for its pages (flattened). */
class Cdp {
  #next = 0
  readonly #pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>()
  readonly #listeners = new Set<(message: CdpMessage) => void>()
  #closed: Error | undefined

  readonly #socket: WebSocket

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id)
        this.#pending.delete(message.id)
        if (message.error !== undefined) pending?.reject(new BenchmarkError(`Chrome: ${message.error.message}`))
        else pending?.resolve(message.result ?? {})
        return
      }
      for (const listener of this.#listeners) listener(message)
    })
    socket.addEventListener('close', () => {
      this.#closed = new BenchmarkError('The connection to Chrome closed (Chrome exited or crashed).')
      for (const pending of this.#pending.values()) pending.reject(this.#closed)
      this.#pending.clear()
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener('open', () => { resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { reject(new BenchmarkError(`Could not connect to Chrome at ${url}.`)) }, { once: true })
    })
    return new Cdp(socket)
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed)
    const id = ++this.#next
    return new Promise<T>((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new BenchmarkError(`Chrome did not answer ${method} within ${String(Math.round(timeoutMs / 1000))} s.`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value as T) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  on(listener: (message: CdpMessage) => void): void {
    this.#listeners.add(listener)
  }

  close(): void {
    this.#socket.close()
  }
}

/** Headless Chrome with a temporary profile, started and stopped by this tool only. */
export class Browser {
  readonly cdp: Cdp
  readonly product: string
  readonly #child: ChildProcess
  readonly #profile: string

  private constructor(cdp: Cdp, child: ChildProcess, profile: string, product: string) {
    this.cdp = cdp
    this.#child = child
    this.#profile = profile
    this.product = product
  }

  /** hideScrollbars: false draws scroll bars as the system does (the UI checks measure the room they take). */
  static async launch(path: string, maxHeapMb: number, options: { readonly hideScrollbars?: boolean } = {}): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'trade-blotter-perf-ui-'))
    const child = spawn(path, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--mute-audio', ...(options.hideScrollbars === false ? [] : ['--hide-scrollbars']), `--window-size=${String(VIEWPORT.width)},${String(VIEWPORT.height)}`,
      // A page that grows past this fails with an out-of-memory crash, which is reported, instead of exhausting the machine.
      `--js-flags=--max-old-space-size=${String(maxHeapMb)}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const started = { exited: false }
    child.once('exit', () => { started.exited = true })
    child.once('error', () => { started.exited = true })
    try {
      // Chrome writes its DevTools port and path to this file once it listens.
      const portFile = join(profile, 'DevToolsActivePort')
      const deadline = Date.now() + 30_000
      while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
        if (started.exited) throw new BenchmarkError(`Chrome (${path}) exited at startup.`)
        if (Date.now() > deadline) throw new BenchmarkError(`Chrome (${path}) did not open its DevTools port within 30 seconds.`)
        await sleep(100)
      }
      const [port, socketPath] = readFileSync(portFile, 'utf8').split('\n').map((line) => line.trim())
      const cdp = await Cdp.connect(`ws://127.0.0.1:${port ?? ''}${socketPath ?? ''}`)
      const version = await cdp.send<{ product: string }>('Browser.getVersion')
      return new Browser(cdp, child, profile, version.product)
    } catch (error) {
      child.kill('SIGKILL')
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      throw error
    }
  }

  get pid(): number {
    return this.#child.pid ?? 0
  }

  /** Chrome's own process ids (browser, renderers, GPU, utilities), where Chrome reports them. */
  async processIds(): Promise<number[]> {
    try {
      const info = await this.cdp.send<{ processInfo: { id: number }[] }>('SystemInfo.getProcessInfo', {}, undefined, 10_000)
      return [...new Set([this.pid, ...info.processInfo.map((process) => process.id)])]
    } catch {
      return [this.pid]
    }
  }

  async close(): Promise<void> {
    const exit = new Promise<void>((resolveExit) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) resolveExit()
      else this.#child.once('exit', () => { resolveExit() })
    })
    try {
      await this.cdp.send('Browser.close', {}, undefined, 5_000)
    } catch {
      // Already closing, or not answering: stopped below.
    }
    this.cdp.close()
    const closed = await Promise.race([exit.then(() => true), sleep(10_000).then(() => false)])
    if (!closed) {
      this.#child.kill('SIGKILL')
      await Promise.race([exit, sleep(5_000)])
    }
    rmSync(this.#profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

// ---------------------------------------------------------------------------------------------
// The page

/**
 * Installed in every page before the application's scripts: observers of the browser's own
 * performance entries, and helpers that read the page. It listens passively and changes nothing
 * the application does.
 */
const PAGE_HELPERS = String.raw`(() => {
  if (window.__tradeBlotterPerf) return
  const perf = window.__tradeBlotterPerf = { longTasks: [], events: [], clicks: [], keys: [], errors: [] }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.longTasks.push([e.startTime, e.duration]) })
      .observe({ type: 'longtask', buffered: true })
    perf.longTasksObserved = true
  } catch { perf.longTasksObserved = false }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.events.push([e.name, e.startTime, e.duration]) })
      .observe({ type: 'event', durationThreshold: 16, buffered: true })
    perf.eventsObserved = true
  } catch { perf.eventsObserved = false }
  addEventListener('click', (e) => { perf.clicks.push(e.timeStamp) }, { capture: true, passive: true })
  addEventListener('keydown', (e) => {
    const at = e.timeStamp
    requestAnimationFrame(() => requestAnimationFrame((frame) => { perf.keys.push([at, frame - at]) }))
  }, { capture: true, passive: true })
  performance.setResourceTimingBufferSize(100000)

  const blotter = () => document.querySelector('section[aria-labelledby="blotter-heading"]')
  const statuses = (section) => [...section.querySelectorAll('p.state')].map((p) => p.textContent)
  const fetched = (path, since) => performance.getEntriesByType('resource')
    .filter((e) => e.initiatorType === 'fetch' && new URL(e.name).pathname === path && e.startTime >= since)
  perf.failure = () => {
    const alert = document.querySelector('[role="alert"]')
    return alert ? alert.textContent.trim() : undefined
  }
  /** True once the trade table shows this many rows, loaded by a request started at or after since, with no update in progress. */
  perf.tradesShown = (rows, since) => {
    const section = blotter()
    if (!section || section.querySelector('.table-scroll[aria-busy="true"]')) return false
    if (statuses(section).some((text) => /Loading trades|Updating trades/.test(text))) return false
    if (fetched('/trades/page', since).length === 0) return false
    const body = section.querySelector('table tbody')
    return (body ? body.rows.length : 0) === rows
  }
  /** Both pagers show this position, such as "Page 2 of 500". */
  perf.pagerShows = (position) => {
    const pagers = [...(blotter()?.querySelectorAll('nav.pager .pager-position') ?? [])].map((e) => e.textContent.trim())
    return pagers.length === 2 && pagers.every((text) => text === position)
  }
  perf.pagerPositions = () => [...(blotter()?.querySelectorAll('nav.pager .pager-position') ?? [])].map((e) => e.textContent.trim())
  perf.positionsShown = (rows) => {
    const section = document.querySelector('section[aria-labelledby="positions-heading"]')
    if (!section || statuses(section).some((text) => /Loading positions/.test(text))) return false
    const body = section.querySelector('table tbody')
    return (body ? body.rows.length : 0) === rows
  }
  /** Resolves with the time of the animation frame after the one in which check() first held. */
  perf.when = (check, timeoutMs) => new Promise((resolveWhen, reject) => {
    const until = performance.now() + timeoutMs
    const tick = () => {
      const failure = perf.failure()
      if (failure !== undefined) { reject(new Error('The page shows an error: ' + failure)); return }
      if (check()) { requestAnimationFrame((frame) => { resolveWhen(frame) }); return }
      if (performance.now() > until) { reject(new Error('timed out')); return }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  /** Each shown trade as symbol|side|executedAt (UTC), in order, hashed: compared with the database. */
  perf.signature = async () => {
    const body = blotter()?.querySelector('table tbody')
    const rows = body ? [...body.rows] : []
    const text = rows.map((row) => row.cells[0].textContent.trim() + '|' + row.cells[1].textContent.trim() + '|' +
      (row.querySelector('td.executed time')?.getAttribute('datetime') ?? '')).join('\n')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
    return { rows: rows.length, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
  }
  perf.lastFetch = (path) => {
    const entry = fetched(path, 0).at(-1)
    return entry && { startTime: entry.startTime, responseStart: entry.responseStart, responseEnd: entry.responseEnd,
      transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize }
  }
  perf.nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
  /**
   * The measurement of the key press at this position in perf.keys, once it is there. By position,
   * not "the next one": on a busy page the key can be measured before this evaluation even starts.
   */
  perf.keyAt = (index) => new Promise((resolveKey) => {
    const tick = () => { if (perf.keys.length > index) resolveKey(perf.keys[index]); else requestAnimationFrame(tick) }
    tick()
  })
})()`

interface Metrics {
  readonly [name: string]: number
}

interface FetchTiming {
  readonly startTime: number
  readonly responseStart: number
  readonly responseEnd: number
  readonly transferSize: number
  readonly encodedBodySize: number
  readonly decodedBodySize: number
}

export class Page {
  crashed: string | undefined
  readonly consoleErrors: string[] = []

  readonly #browser: Browser
  readonly #targetId: string
  readonly #contextId: string
  readonly sessionId: string

  constructor(browser: Browser, sessionId: string, targetId: string, contextId: string) {
    this.#browser = browser
    this.sessionId = sessionId
    this.#targetId = targetId
    this.#contextId = contextId
  }

  static async open(browser: Browser): Promise<Page> {
    const { browserContextId } = await browser.cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })
    const { targetId } = await browser.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(browser, sessionId, targetId, browserContextId)
    browser.cdp.on((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method === 'Inspector.targetCrashed') page.crashed = 'The page crashed (possibly out of memory).'
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.['exceptionDetails'] as { exception?: { description?: string }; text?: string } | undefined
        page.consoleErrors.push(details?.exception?.description ?? details?.text ?? 'exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.['type'] === 'error') {
        const args = (message.params['args'] ?? []) as { value?: unknown; description?: string }[]
        page.consoleErrors.push(args.map((arg) => arg.description ?? String(arg.value)).join(' '))
      }
      if (message.method === 'Log.entryAdded') {
        const entry = message.params?.['entry'] as { level?: string; text?: string; url?: string } | undefined
        if (entry?.level === 'error') page.consoleErrors.push(`${entry.text ?? ''}${entry.url === undefined ? '' : ` (${entry.url})`}`)
      }
    })
    for (const domain of ['Page', 'Runtime', 'Log', 'Inspector']) await page.send(`${domain}.enable`)
    await page.send('Performance.enable', { timeDomain: 'timeTicks' })
    await page.send('Emulation.setTimezoneOverride', { timezoneId: TIME_ZONE })
    await page.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS })
    return page
  }

  send<T = Json>(method: string, params: Json = {}, timeoutMs = 60_000): Promise<T> {
    if (this.crashed !== undefined) return Promise.reject(new BenchmarkError(this.crashed))
    return this.#browser.cdp.send<T>(method, params, this.sessionId, timeoutMs)
  }

  /** Evaluates an expression in the page and returns its value, waiting for a promise; throws if it throws. */
  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const result = await this.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (result.exceptionDetails !== undefined) {
      const reason = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new BenchmarkError(this.crashed ?? reason.split('\n')[0] ?? reason)
    }
    return result.result.value as T
  }

  async metrics(): Promise<Metrics> {
    const { metrics } = await this.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]))
  }

  async click(selector: string): Promise<void> {
    const [x, y] = await this.evaluate<[number, number]>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) throw new Error('No element ' + ${JSON.stringify(selector)})
      element.scrollIntoView({ block: 'center' })
      const box = element.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2]
    })()`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  async key(key: string, code: string, keyCode: number, text?: string): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text === undefined ? {} : { text }) })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }

  async close(): Promise<void> {
    try {
      await this.#browser.cdp.send('Target.closeTarget', { targetId: this.#targetId }, undefined, 10_000)
      await this.#browser.cdp.send('Target.disposeBrowserContext', { browserContextId: this.#contextId }, undefined, 10_000)
    } catch {
      // The browser is closing anyway.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios

/** The filter controls, by element id; values as a user would choose them. */
interface Controls {
  readonly symbol?: string
  readonly side?: '' | 'Buy' | 'Sell'
  readonly fromDate?: string
  readonly toDate?: string
}

/** Each sortable column header's position among the table's columns, counting from 1. */
const COLUMN = { symbol: 1, quantity: 3, price: 4, executedAt: 6 } as const

/**
 * A scenario; id is how --scenarios names it. `filter` names the perf:api scenario with the same
 * query, whose definition gives the trades that match.
 */
export type UiScenario = { readonly id: string; readonly name: string } & (
  | { readonly kind: 'load' }
  | { readonly kind: 'apply'; readonly controls: Controls; readonly filter: string }
  | { readonly kind: 'clear'; readonly from: Controls; readonly filter: string }
  | { readonly kind: 'sort'; readonly field: TradeSortField; readonly clicks: 1 | 2 }
  | { readonly kind: 'next'; readonly controls?: Controls; readonly filter?: string }
  | { readonly kind: 'previous' }
  | { readonly kind: 'size'; readonly size: 25 | 100 }
  | { readonly kind: 'typing'; readonly text: string }
)

/** The API benchmark's trade scenario of this name: the same query, so both describe the same results. */
function apiScenario(name: string): Extract<Scenario, { kind: 'trades' }> {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name)
  if (scenario?.kind !== 'trades') throw new Error(`No trade scenario named ${name}.`)
  return scenario
}

/** What the list shows: the applied filters (a perf:api scenario's name), the sort, the page and the page size. */
export interface View {
  readonly filter: string | undefined
  readonly sort: TradeSort
  readonly page: number
  readonly pageSize: number
}

/** The list as the page opens: every trade, newest first, page 1 of 50. */
export const DEFAULT_VIEW: View = Object.freeze({ filter: undefined, sort: DEFAULT_TRADE_SORT, page: 1, pageSize: 50 })

/**
 * The sort after choosing a column header, as the page does it: the active column reverses;
 * another starts ascending, or newest first for the execution date.
 */
export function sortAfterClick(sort: TradeSort, field: TradeSortField): TradeSort {
  if (sort.field === field) return { field, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
  return { field, direction: field === 'executedAt' ? 'desc' : 'asc' }
}

export const UI_SCENARIOS: readonly UiScenario[] = [
  { id: 'load', kind: 'load', name: 'Initial page load (page 1 of 50, newest first)' },
  { id: 'next', kind: 'next', name: 'Next page (1 to 2)' },
  { id: 'previous', kind: 'previous', name: 'Previous page (2 to 1)' },
  { id: 'size-100', kind: 'size', size: 100, name: '100 trades per page' },
  { id: 'size-25', kind: 'size', size: 25, name: '25 trades per page' },
  { id: 'price-asc', kind: 'sort', field: 'price', clicks: 1, name: 'Price header: ascending' },
  { id: 'price-desc', kind: 'sort', field: 'price', clicks: 2, name: 'Price header again: descending' },
  { id: 'quantity-asc', kind: 'sort', field: 'quantity', clicks: 1, name: 'Quantity header: ascending' },
  { id: 'symbol-asc', kind: 'sort', field: 'symbol', clicks: 1, name: 'Symbol header: ascending' },
  { id: 'executed-asc', kind: 'sort', field: 'executedAt', clicks: 1, name: 'Executed at header: oldest first' },
  { id: 'search', kind: 'apply', name: 'Search "ms"', controls: { symbol: 'ms' }, filter: 'Symbol search "ms"' },
  { id: 'buy', kind: 'apply', name: 'Side Buy', controls: { side: 'Buy' }, filter: 'Side Buy' },
  { id: 'sell', kind: 'apply', name: 'Side Sell', controls: { side: 'Sell' }, filter: 'Side Sell' },
  {
    id: 'combined', kind: 'apply', name: '"ms" + Sell + 2025-07-01 to 2026-06-30', controls: { symbol: 'ms', side: 'Sell', fromDate: '2025-07-01', toDate: '2026-06-30' },
    filter: '"ms" + Sell + 2025-07-01 to 2026-06-30',
  },
  { id: 'next-buy', kind: 'next', name: 'Next page of side Buy (1 to 2)', controls: { side: 'Buy' }, filter: 'Side Buy' },
  { id: 'clear', kind: 'clear', name: 'Clear (from "ms") to every trade', from: { symbol: 'ms' }, filter: 'Symbol search "ms"' },
  { id: 'typing', kind: 'typing', name: 'Typing "MSFT" in Symbol, a page shown', text: 'MSFT' },
]

/**
 * The scenarios named by --scenarios (ids, separated by commas), in the usual order; all when
 * none are named. The initial load always runs, because it opens the page the others use.
 */
export function selectScenarios(list: string | undefined): UiScenario[] {
  if (list === undefined) return [...UI_SCENARIOS]
  const ids = list.split(',').map((id) => id.trim()).filter((id) => id !== '')
  const unknown = ids.filter((id) => !UI_SCENARIOS.some((scenario) => scenario.id === id))
  if (ids.length === 0 || unknown.length > 0) {
    throw new BenchmarkError(`--scenarios takes ids separated by commas, from: ${UI_SCENARIOS.map((s) => s.id).join(', ')}` +
      `${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}.`)
  }
  return UI_SCENARIOS.filter((scenario) => scenario.kind === 'load' || ids.includes(scenario.id))
}

/** symbol|side|executedAt of each trade, in order, hashed as the page hashes what it shows. */
function signature(trades: readonly Trade[]): { rows: number; sha256: string } {
  const text = trades.map((t) => `${t.symbol}|${t.side}|${t.executedAt}`).join('\n')
  return { rows: trades.length, sha256: createHash('sha256').update(text).digest('hex') }
}

/** What the page must show for a view: the page's trades (hashed), both pagers' position, and how many trades match. */
export interface ExpectedPage {
  readonly rows: number
  readonly sha256: string
  readonly position: string
  readonly matched: number
}

export function expectedPage(snapshot: Snapshot, view: View): ExpectedPage {
  const matching = (view.filter === undefined ? [...snapshot.trades] : snapshot.trades.filter(apiScenario(view.filter).matches)).sort(compareTrades(view.sort))
  const shown = matching.slice((view.page - 1) * view.pageSize, view.page * view.pageSize)
  return { ...signature(shown), position: `Page ${grouped(view.page)} of ${grouped(Math.ceil(matching.length / view.pageSize))}`, matched: matching.length }
}

/** One measured action. Fields that could not be measured are absent, never estimated. */
export interface UiSample {
  /** From the click (or key press, or navigation start) until the frame after the result was shown. */
  readonly elapsedMs: number
  /** Click until the request for trades started: input handling and the application's own work before it. */
  readonly beforeRequestMs?: number
  /** Request start until its first byte arrived: the frontend's proxy and the API. */
  readonly waitingMs?: number
  /** First byte until the last byte of the response. */
  readonly transferMs?: number
  /** Last byte until the frame after the rows were shown: parsing, exact-decimal conversion, Vue, layout and paint together. */
  readonly afterResponseMs?: number
  readonly responseBytes?: number
  readonly longTasks: number
  readonly longTaskTotalMs: number
  readonly longestTaskMs: number
  /** Main-thread time in the window, from Chrome's Performance.getMetrics. */
  readonly scriptMs: number
  readonly styleMs: number
  readonly layoutMs: number
  readonly taskMs: number
  /** Typing: the longest event duration Event Timing reported (only events of 16 ms or more are reported). */
  readonly longestEventMs?: number
}

export interface UiScenarioResult {
  readonly id: string
  readonly name: string
  /** The run (UiBenchmarkResult.runId) these samples come from; samples of different runs are never pooled. */
  readonly runId: string
  readonly matchedRows: number | undefined
  readonly warmupIterations: number
  readonly measuredIterations: number
  readonly elapsedMs: Stats
  /** Medians of each measured part, over the measured runs. */
  readonly medians: Readonly<Partial<Record<keyof UiSample, number>>>
  readonly samples: readonly UiSample[]
  readonly notes: readonly string[]
}

export interface PageMemory {
  /** The page's JavaScript heap (Runtime.getHeapUsage): used and allocated, before and after a forced garbage collection. */
  readonly jsHeapUsedBytes: number
  readonly jsHeapTotalBytes: number
  readonly jsHeapUsedAfterGcBytes: number
  /** DOM nodes Chrome counts for the page (Performance.getMetrics Nodes), and elements in the document. */
  readonly domNodes: number
  readonly elements: number
  /** Every Chrome process's resident memory (working set on Windows), summed; shared pages count more than once. */
  readonly chromeProcesses: { readonly count: number; readonly residentBytes: number; readonly largestBytes: number; readonly source: string } | undefined
}

export interface UiBenchmarkResult {
  readonly tool: 'perf:ui'
  readonly version: 1
  /** Identifies this run; every scenario result carries it. */
  readonly runId: string
  /** False in a checkpoint written while the run was still going. */
  readonly complete: boolean
  /** The scenarios this run was asked to measure (--scenarios), by id. */
  readonly scenarioIds: readonly string[]
  readonly startedAt: string
  readonly finishedAt: string
  readonly environment: Readonly<Record<string, string | number>>
  readonly application: {
    readonly databasePath: string
    readonly webUrl: string
    readonly apiUrl: string
    readonly webPid: number
    readonly apiPid: number
    readonly frontend: string
  }
  readonly datasetTrades: number
  readonly openPositions: number
  readonly datasetFingerprint: string
  readonly datasetUnchanged: boolean
  readonly warmupIterations: number
  readonly measuredIterations: number
  readonly method: Readonly<Record<string, string>>
  readonly scenarios: readonly UiScenarioResult[]
  /** The frontend's exact-decimal parser and JSON.parse, in the page, on a page of 100 trades. */
  readonly parsing: { readonly responseBytes: number; readonly frontendParserMs: Stats; readonly jsonParseMs: Stats; readonly source: string }
  readonly memory: { readonly afterLoad: PageMemory; readonly afterScenarios: PageMemory }
  readonly consoleErrors: readonly string[]
  readonly observers: { readonly longTasks: boolean; readonly eventTiming: boolean }
}

export const UI_METHOD: Readonly<Record<string, string>> = {
  browser: `headless Chrome, its own temporary profile, ${String(VIEWPORT.width)}x${String(VIEWPORT.height)} at 1x, time zone ${TIME_ZONE}, no throttling`,
  input: 'the page\'s own controls: real mouse clicks on Apply, Clear, Previous, Next and the column headers, real key presses (DevTools Input); ' +
    'filter inputs and selects, the page-size select included, are set and their change/input events fired',
  done: 'a GET /trades/page request made after the action has finished, the table shows the expected page, both pagers show its position ' +
    '("Page 2 of 500"), and no update is in progress; then the next animation frame (resolution: one frame)',
  validation: 'after each run, the shown rows (symbol, side, executedAt, in order) are hashed and compared with the page computed from the database ' +
    'with the domain\'s order, and both pagers\' positions with the expected one; any difference stops the benchmark',
  view: 'before every run the list is put back as it opens (Clear, then 50 a page); that is not measured',
  clock: 'the page\'s performance.now() (monotonic); the request parts come from Resource Timing of the same request',
  breakdown: 'before request, waiting (proxy and API), transfer and after response are measured; parsing, exact-decimal conversion, Vue and rendering ' +
    'cannot be separated without changing the application, so after response is their sum; parsing alone is measured separately in the page',
  mainThread: 'script, style, layout and task time from Chrome\'s Performance.getMetrics, differences across the run (the page\'s renderer)',
  longTasks: 'Long Tasks API (tasks of 50 ms or more) overlapping the run',
  initialLoad: 'a new browser context for each run (empty cache), from navigation start until the first page and every position are shown',
  retired: 'scrolling and the End key were measured while the table showed every trade; with one page shown they measure nothing of interest, and are gone',
  typing: 'each key press until the second animation frame after it; Event Timing reports only events of 16 ms or more',
  statistics: 'minimum, median and maximum of the measured runs; with this few runs no tail percentile is meaningful, so none is reported',
}

// ---------------------------------------------------------------------------------------------
// Checking the application

/** The frontend started with app:start on the selected database, and the API it forwards to. */
export interface ManagedApplication {
  readonly api: ManagedApi
  readonly webUrl: URL
  readonly webPid: number
}

export function findManagedApplication(options: { readonly databasePath: string | undefined; readonly webUrl?: string; readonly protection?: Protection }): ManagedApplication {
  const protection = options.protection ?? DEFAULT_PROTECTION
  const api = findManagedApi({ databasePath: options.databasePath, protection })
  const state = readState(protection.runDir)
  const web = state?.apps.find((app) => app.name === 'web')
  if (state === undefined || web === undefined) throw new TargetError('The frontend started with app:start is not recorded. Run npm run app:stop, then app:start.')
  if (processStatus(web) !== 'running') {
    throw new TargetError(`The frontend started with app:start (process ${String(web.pid)}) is not running. Nothing was measured. Run npm run app:stop, then app:start.`)
  }
  const forwards = web.details?.['forwards API requests to']
  if (forwards === undefined || new URL(forwards).port !== api.url.port) {
    throw new TargetError(`The frontend forwards API requests to ${forwards ?? 'an unknown address'}, not to the API at ${api.url.origin}. Nothing was measured.`)
  }
  const webUrl = managedUrl(web, options.webUrl, '--web-url')
  const listeners = listenersOnPort(web.port, web.pid)
  if (listeners !== 'only') {
    throw new TargetError(listeners === 'others'
      ? `Another process also listens on port ${String(web.port)}, so the browser might not reach the frontend started with app:start. Nothing was measured.`
      : `Could not confirm that the frontend started with app:start listens on port ${String(web.port)}. Nothing was measured.`)
  }
  return { api, webUrl, webPid: web.pid }
}

async function text(url: URL): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  return { status: response.status, body: await response.text() }
}

/** The frontend is the production build, and through its proxy serves exactly the database's first page of trades. */
async function checkFrontend(app: ManagedApplication, snapshot: Snapshot): Promise<void> {
  const page = await text(app.webUrl)
  if (page.status !== 200 || !page.body.includes('<title>Trade Blotter</title>')) throw new TargetError(`${app.webUrl.origin} is not the Trade Blotter frontend.`)
  if (page.body.includes('/@vite/client') || !/<script[^>]+src="\/assets\/[^"]+\.js"/.test(page.body)) {
    throw new TargetError(`${app.webUrl.origin} serves the development frontend, not the production build. Use npm run build and app:start.`)
  }
  const expected = expectedResponse({ kind: 'page', name: 'first page', query: {}, matches: () => true, sort: DEFAULT_TRADE_SORT, pageSize: 100, at: 'first' }, snapshot)
  const trades = await text(new URL('/trades/page?page=1&pageSize=100', app.webUrl))
  const problem = trades.status === 200 ? expectedDifference(trades.body, expected) : `status ${String(trades.status)}`
  if (problem !== undefined) {
    throw new TargetError(`The frontend at ${app.webUrl.origin} does not serve the trades in ${app.api.databasePath} (${problem}). Nothing was measured.`)
  }
}

/** The frontend's exact-decimal parser, from its source, as an expression the page can evaluate. */
export function frontendParserSource(): string {
  const path = join(REPOSITORY_ROOT, 'client', 'src', 'api', 'json.ts')
  const code = stripTypeScriptTypes(readFileSync(path, 'utf8'))
  if (/^\s*import\s/m.test(code) || !code.includes('export function parseJsonKeepingNumberText')) {
    throw new Error(`${path} no longer holds a self-contained parseJsonKeepingNumberText; perf:ui cannot measure it.`)
  }
  return `(() => { ${code.replace('export function parseJsonKeepingNumberText', 'function parseJsonKeepingNumberText')}\nreturn parseJsonKeepingNumberText })()`
}

// ---------------------------------------------------------------------------------------------
// Measuring

/** What a run has measured so far: the finished result's fields that are known part-way. */
export type UiCheckpoint = Pick<UiBenchmarkResult, 'tool' | 'version' | 'runId' | 'complete' | 'scenarioIds' | 'startedAt' | 'environment' |
  'application' | 'datasetTrades' | 'openPositions' | 'datasetFingerprint' | 'warmupIterations' | 'measuredIterations' | 'method' | 'scenarios'> &
  { readonly memory: { readonly afterLoad: PageMemory } }

export interface UiOptions {
  readonly warmup?: number
  readonly iterations?: number
  readonly chrome?: string
  readonly timeoutSeconds?: number
  readonly maxHeapMb?: number
  readonly scenarios?: readonly UiScenario[]
  readonly onScenario?: (result: UiScenarioResult) => void
  /**
   * Told after each scenario with everything measured so far (complete: false), so a run that is
   * interrupted keeps the scenarios it finished.
   */
  readonly onCheckpoint?: (partial: UiCheckpoint) => void
  /** Told when a browser is running, so an interrupted run can close it. */
  readonly onBrowser?: (browser: Browser | undefined) => void
}

const median = (values: readonly number[]): number | undefined => values.length === 0 ? undefined : statistics(values).median

function summarise(scenario: Pick<UiScenario, 'id' | 'name'>, runId: string, matchedRows: number | undefined, warmup: number, samples: readonly UiSample[], notes: string[]): UiScenarioResult {
  const medians: Partial<Record<keyof UiSample, number>> = {}
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))] as (keyof UiSample)[]
  for (const key of keys) {
    const value = median(samples.map((sample) => sample[key]).filter((v): v is number => typeof v === 'number'))
    if (value !== undefined) medians[key] = value
  }
  return { id: scenario.id, name: scenario.name, runId, matchedRows, warmupIterations: warmup, measuredIterations: samples.length, elapsedMs: statistics(samples.map((s) => s.elapsedMs)), medians, samples, notes }
}

/**
 * Measures every UI scenario in headless Chrome against the managed application. Throws a
 * BenchmarkError on a wrong result, an error shown by the page, a crash, a timeout or too much
 * memory; Chrome is closed in every case.
 */
export async function runUiBenchmark(app: ManagedApplication, options: UiOptions = {}): Promise<UiBenchmarkResult> {
  const warmup = options.warmup ?? DEFAULT_UI_WARMUP
  const iterations = options.iterations ?? DEFAULT_UI_ITERATIONS
  if (!Number.isInteger(warmup) || warmup < 0 || !Number.isInteger(iterations) || iterations < 1) {
    throw new BenchmarkError(`--warmup must be 0 or more and --iterations 1 or more, got ${String(warmup)} and ${String(iterations)}.`)
  }
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  const maxHeapMb = options.maxHeapMb ?? DEFAULT_MAX_HEAP_MB
  const startedAt = new Date().toISOString()
  const runId = randomUUID()
  const scenarios = options.scenarios ?? UI_SCENARIOS
  const before = await readSnapshot(app.api.databasePath)
  await checkFrontend(app, before)
  const parser = frontendParserSource()
  const first = expectedPage(before, DEFAULT_VIEW)
  const openPositions = calculatePositions(before.trades).length

  const browser = await Browser.launch(findChrome(options.chrome), maxHeapMb)
  options.onBrowser?.(browser)
  const cpu = cpus()
  const header = {
    tool: 'perf:ui', version: 1, runId, scenarioIds: scenarios.map((scenario) => scenario.id), startedAt,
    environment: {
      platform: process.platform, release: release(), arch: arch(), node: process.version, cpu: cpu[0]?.model.trim() ?? 'unknown',
      logicalCores: cpu.length, totalMemoryBytes: totalmem(), chrome: browser.product, headless: 'yes (--headless=new)',
      viewport: `${String(VIEWPORT.width)}x${String(VIEWPORT.height)}`, timeZone: TIME_ZONE,
    },
    application: {
      databasePath: app.api.databasePath, webUrl: app.webUrl.origin, apiUrl: app.api.url.origin, webPid: app.webPid, apiPid: app.api.pid,
      frontend: 'production build (client/dist) served by vite preview, started with app:start',
    },
    datasetTrades: before.trades.length, openPositions, datasetFingerprint: before.fingerprint,
    warmupIterations: warmup, measuredIterations: iterations, method: UI_METHOD,
  } as const
  const errors: string[] = []
  let page: Page | undefined
  try {
    const guard = async (target: Page): Promise<void> => {
      if (target.crashed !== undefined) throw new BenchmarkError(target.crashed)
      const metrics = await target.metrics()
      const used = metrics['JSHeapUsedSize'] ?? 0
      if (used > maxHeapMb * 2 ** 20) throw new BenchmarkError(`The page's JavaScript heap reached ${mib(used)}, over --max-heap-mb ${String(maxHeapMb)}; stopped.`)
    }
    const verify = async (target: Page, expected: ExpectedPage, label: string): Promise<void> => {
      const shown = await target.evaluate<{ rows: number; sha256: string }>('window.__tradeBlotterPerf.signature()', timeoutMs)
      if (shown.rows !== expected.rows || shown.sha256 !== expected.sha256) {
        throw new BenchmarkError(`${label}: the page shows ${grouped(shown.rows)} trades${shown.rows === expected.rows ? ' in another order or with other values' : ''}; ` +
          `expected ${grouped(expected.rows)}. No result was recorded.`)
      }
      const positions = await target.evaluate<string[]>('window.__tradeBlotterPerf.pagerPositions()')
      if (positions.length !== 2 || positions.some((position) => position !== expected.position)) {
        throw new BenchmarkError(`${label}: the pagers show ${JSON.stringify(positions)}; expected "${expected.position}" in both. No result was recorded.`)
      }
    }
    const tasksIn = async (target: Page, from: number, to: number): Promise<{ count: number; total: number; longest: number }> => {
      const tasks = await target.evaluate<[number, number][]>('window.__tradeBlotterPerf.longTasks')
      const inside = tasks.filter(([start, duration]) => start + duration > from && start < to).map(([, duration]) => duration)
      return { count: inside.length, total: inside.reduce((sum, d) => sum + d, 0), longest: Math.max(0, ...inside) }
    }
    const mainThread = (a: Metrics, b: Metrics) => ({
      scriptMs: ((b['ScriptDuration'] ?? 0) - (a['ScriptDuration'] ?? 0)) * 1000,
      styleMs: ((b['RecalcStyleDuration'] ?? 0) - (a['RecalcStyleDuration'] ?? 0)) * 1000,
      layoutMs: ((b['LayoutDuration'] ?? 0) - (a['LayoutDuration'] ?? 0)) * 1000,
      taskMs: ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000,
    })
    const memory = async (target: Page): Promise<PageMemory> => {
      const heap = await target.send<{ usedSize: number; totalSize: number }>('Runtime.getHeapUsage')
      await target.send('HeapProfiler.collectGarbage', {}, timeoutMs)
      const afterGc = await target.send<{ usedSize: number }>('Runtime.getHeapUsage')
      const metrics = await target.metrics()
      const elements = await target.evaluate<number>('document.getElementsByTagName("*").length')
      const pids = await browser.processIds()
      const memories = [...processesMemory(pids).values()]
      return {
        jsHeapUsedBytes: heap.usedSize, jsHeapTotalBytes: heap.totalSize, jsHeapUsedAfterGcBytes: afterGc.usedSize,
        domNodes: metrics['Nodes'] ?? 0, elements,
        chromeProcesses: memories.length === 0 ? undefined : {
          count: memories.length, residentBytes: memories.reduce((sum, m) => sum + m.residentBytes, 0),
          largestBytes: Math.max(...memories.map((m) => m.residentBytes)), source: memories[0]?.source ?? '',
        },
      }
    }

    const results: UiScenarioResult[] = []
    const loaded: { memory?: PageMemory } = {}
    const record = (result: UiScenarioResult): void => {
      results.push(result)
      options.onScenario?.(result)
      if (loaded.memory !== undefined) options.onCheckpoint?.({ ...header, complete: false, scenarios: [...results], memory: { afterLoad: loaded.memory } })
    }

    // 1. Initial load, each run in a new browser context; the last page is kept for the rest.
    const loads: UiSample[] = []
    for (let run = 0; run < warmup + iterations; run++) {
      await page?.close()
      page = await Page.open(browser)
      const target = page
      await target.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__tradeBlotterPerf.loaded = window.__tradeBlotterPerf.when(() => window.__tradeBlotterPerf.tradesShown(${String(first.rows)}, 0) && ` +
          `window.__tradeBlotterPerf.pagerShows(${JSON.stringify(first.position)}) && ` +
          `window.__tradeBlotterPerf.positionsShown(${String(openPositions)}), ${String(timeoutMs)})`,
      })
      await target.send('Page.navigate', { url: app.webUrl.href })
      const deadline = Date.now() + timeoutMs
      // The evaluation must reach the new document, not the blank page before it.
      while (!(await target.evaluate<boolean>(`location.origin === ${JSON.stringify(app.webUrl.origin)} && !!window.__tradeBlotterPerf?.loaded`))) {
        if (Date.now() > deadline) throw new BenchmarkError('The page did not start loading.')
        await sleep(20)
      }
      const doneAt = await target.evaluate<number>('window.__tradeBlotterPerf.loaded', timeoutMs + 10_000)
      await verify(target, first, `Initial load, run ${String(run + 1)}`)
      const fetchTiming = await target.evaluate<FetchTiming | undefined>('window.__tradeBlotterPerf.lastFetch("/trades/page")')
      const tasks = await tasksIn(target, 0, doneAt)
      const metrics = await target.metrics()
      await guard(target)
      if (run >= warmup) {
        loads.push({
          elapsedMs: doneAt,
          ...(fetchTiming === undefined ? {} : {
            beforeRequestMs: fetchTiming.startTime, waitingMs: fetchTiming.responseStart - fetchTiming.startTime,
            transferMs: fetchTiming.responseEnd - fetchTiming.responseStart, afterResponseMs: doneAt - fetchTiming.responseEnd,
            responseBytes: fetchTiming.decodedBodySize,
          }),
          longTasks: tasks.count, longTaskTotalMs: tasks.total, longestTaskMs: tasks.longest,
          ...mainThread({}, metrics),
        })
      }
    }
    if (page === undefined) throw new BenchmarkError('No page was loaded.')
    const target: Page = page
    // The trade list is on the Trade History tab; open it as a user would before the list scenarios.
    await target.click('#tab-history')
    await target.evaluate(`window.__tradeBlotterPerf.when(() => document.getElementById('panel-history')?.checkVisibility() === true, ${String(timeoutMs)})`)
    const afterLoad = await memory(target)
    loaded.memory = afterLoad
    const loadScenario = scenarios.find((s) => s.kind === 'load')
    if (loadScenario !== undefined) {
      record(summarise(loadScenario, runId, first.matched, warmup, loads, ['before request: navigation start until the request for the first page started (HTML, scripts, Vue start-up)']))
    }

    // The page's controls. Setting a value fires the event its v-model listens to.
    const setControls = async (controls: Controls): Promise<void> => {
      const values: Record<string, string> = {
        'filter-symbol': controls.symbol ?? '', 'filter-side': controls.side ?? '', 'filter-from-date': controls.fromDate ?? '', 'filter-to-date': controls.toDate ?? '',
      }
      await target.evaluate(`(() => {
        const values = ${JSON.stringify(values)}
        for (const id of Object.keys(values)) {
          const element = document.getElementById(id)
          if (element.value === values[id]) continue
          element.value = values[id]
          element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
        }
      })()`)
      if (controls.symbol !== undefined && controls.symbol !== '') {
        // The symbol is typed, as a user would.
        await target.evaluate(`(() => { const e = document.getElementById('filter-symbol'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.focus() })()`)
        await target.send('Input.insertText', { text: controls.symbol })
      }
      await target.evaluate('window.__tradeBlotterPerf.nextFrame()')
    }
    let view: View = DEFAULT_VIEW
    /** Runs an action and waits until the page shows `next`, checked against the database. */
    const measure = async (action: () => Promise<void>, next: View, label: string): Promise<UiSample> => {
      const expected = expectedPage(before, next)
      if (expected.rows === 0 && next.page > 1) throw new BenchmarkError(`${label}: the data has no page ${String(next.page)}; this scenario needs more trades.`)
      await target.evaluate('performance.clearResourceTimings(); window.__tradeBlotterPerf.clicks.length = 0; window.scrollTo(0, 0); window.__tradeBlotterPerf.nextFrame()')
      const since = await target.evaluate<number>('performance.now()')
      const metricsBefore = await target.metrics()
      const done = target.evaluate<number>(
        `window.__tradeBlotterPerf.when(() => window.__tradeBlotterPerf.tradesShown(${String(expected.rows)}, ${String(since)}) && ` +
        `window.__tradeBlotterPerf.pagerShows(${JSON.stringify(expected.position)}), ${String(timeoutMs)})`, timeoutMs + 10_000)
      await action()
      let doneAt: number
      try {
        doneAt = await done
      } catch (error) {
        throw new BenchmarkError(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      const metricsAfter = await target.metrics()
      await verify(target, expected, label)
      view = next
      const clickAt = (await target.evaluate<number[]>('window.__tradeBlotterPerf.clicks')).at(-1) ?? since
      const fetchTiming = await target.evaluate<FetchTiming | undefined>('window.__tradeBlotterPerf.lastFetch("/trades/page")')
      const tasks = await tasksIn(target, clickAt, doneAt)
      await guard(target)
      return {
        elapsedMs: doneAt - clickAt,
        ...(fetchTiming === undefined ? {} : {
          beforeRequestMs: fetchTiming.startTime - clickAt, waitingMs: fetchTiming.responseStart - fetchTiming.startTime,
          transferMs: fetchTiming.responseEnd - fetchTiming.responseStart, afterResponseMs: doneAt - fetchTiming.responseEnd,
          responseBytes: fetchTiming.decodedBodySize,
        }),
        longTasks: tasks.count, longTaskTotalMs: tasks.total, longestTaskMs: tasks.longest, ...mainThread(metricsBefore, metricsAfter),
      }
    }
    const click = (selector: string) => async (): Promise<void> => { await target.click(selector) }
    const APPLY = '.trade-filters button[type="submit"]'
    const CLEAR = '.trade-filters button[type="button"]'
    // The upper pager; the lower one is the same component and stays in step (checked by verify).
    const PREVIOUS = 'nav.pager .pager-controls > button:nth-of-type(1)'
    const NEXT = 'nav.pager .pager-controls > button:nth-of-type(2)'
    const headerButton = (field: TradeSortField): string => `section[aria-labelledby="blotter-heading"] thead th:nth-child(${String(COLUMN[field])}) button`
    /** Chooses a page size in the upper pager's select; the time of the choice counts as the click. */
    const chooseSize = (size: number) => async (): Promise<void> => {
      await target.evaluate(`(() => { const select = document.querySelector('nav.pager select')
        window.__tradeBlotterPerf.clicks.push(performance.now()); select.value = '${String(size)}'
        select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    }
    /** Back to the list as it opens: Clear (filters, sort and page), then 50 a page. Not measured. */
    const reset = async (): Promise<void> => {
      const sorted = view.sort.field !== DEFAULT_TRADE_SORT.field || view.sort.direction !== DEFAULT_TRADE_SORT.direction
      if (view.filter !== undefined || sorted || view.page !== 1) {
        await setControls({})
        await measure(click(CLEAR), { ...DEFAULT_VIEW, pageSize: view.pageSize }, 'Clear (between runs)')
      }
      if (view.pageSize !== DEFAULT_VIEW.pageSize) await measure(chooseSize(DEFAULT_VIEW.pageSize), DEFAULT_VIEW, '50 a page (between runs)')
    }

    for (const scenario of scenarios) {
      if (scenario.kind === 'load') continue
      const samples: UiSample[] = []
      const notes: string[] = []
      for (let run = 0; run < warmup + iterations; run++) {
        const label = `${scenario.name}, run ${String(run + 1)}`
        let sample: UiSample | undefined
        await reset()
        if (scenario.kind === 'apply') {
          await setControls(scenario.controls)
          sample = await measure(click(APPLY), { ...DEFAULT_VIEW, filter: scenario.filter }, label)
        } else if (scenario.kind === 'clear') {
          await setControls(scenario.from)
          await measure(click(APPLY), { ...DEFAULT_VIEW, filter: scenario.filter }, `${label} (setup)`)
          sample = await measure(click(CLEAR), DEFAULT_VIEW, label)
        } else if (scenario.kind === 'sort') {
          if (scenario.clicks === 2) await measure(click(headerButton(scenario.field)), { ...view, sort: sortAfterClick(view.sort, scenario.field), page: 1 }, `${label} (setup)`)
          sample = await measure(click(headerButton(scenario.field)), { ...view, sort: sortAfterClick(view.sort, scenario.field), page: 1 }, label)
        } else if (scenario.kind === 'next') {
          if (scenario.controls !== undefined) {
            await setControls(scenario.controls)
            await measure(click(APPLY), { ...DEFAULT_VIEW, filter: scenario.filter }, `${label} (setup)`)
          }
          sample = await measure(click(NEXT), { ...view, page: 2 }, label)
        } else if (scenario.kind === 'previous') {
          await measure(click(NEXT), { ...view, page: 2 }, `${label} (setup)`)
          sample = await measure(click(PREVIOUS), { ...view, page: 1 }, label)
        } else if (scenario.kind === 'size') {
          sample = await measure(chooseSize(scenario.size), { ...view, page: 1, pageSize: scenario.size }, label)
        } else {
          await target.evaluate(`(() => { const e = document.getElementById('filter-symbol'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); window.scrollTo(0, 0); e.focus() })()`)
          await target.evaluate('window.__tradeBlotterPerf.events.length = 0; window.__tradeBlotterPerf.nextFrame()')
          const metricsBefore = await target.metrics()
          const latencies: [number, number][] = []
          const firstKey = await target.evaluate<number>('window.__tradeBlotterPerf.keys.length')
          for (let index = 0; index < scenario.text.length; index++) {
            const char = scenario.text.charAt(index)
            await target.key(char, `Key${char.toUpperCase()}`, char.toUpperCase().charCodeAt(0), char)
            // Each key press is measured to its next frame before the next one is sent.
            latencies.push(await target.evaluate<[number, number]>(`window.__tradeBlotterPerf.keyAt(${String(firstKey + index)})`, timeoutMs))
          }
          const metricsAfter = await target.metrics()
          const typed = await target.evaluate<string>('document.getElementById("filter-symbol").value')
          if (typed !== scenario.text) throw new BenchmarkError(`${label}: the Symbol field holds "${typed}", expected "${scenario.text}".`)
          const events = await target.evaluate<[string, number, number][]>('window.__tradeBlotterPerf.events')
          const from = latencies[0]?.[0] ?? 0
          const lastKey = latencies.at(-1) ?? [from, 0]
          const tasks = await tasksIn(target, from, lastKey[0] + lastKey[1])
          if (run === 0) notes.push(`${String(scenario.text.length)} key presses per run; the sample is each key press until the second frame after it`)
          for (const [, latency] of latencies) {
            if (run >= warmup) {
              samples.push({
                elapsedMs: latency, longestEventMs: Math.max(0, ...events.map(([, , duration]) => duration)),
                longTasks: tasks.count, longTaskTotalMs: tasks.total, longestTaskMs: tasks.longest, ...mainThread(metricsBefore, metricsAfter),
              })
            }
          }
          await setControls({})
          await verify(target, expectedPage(before, view), `${label} (typing never applies)`)
          await guard(target)
        }
        if (sample !== undefined && run >= warmup) samples.push(sample)
      }
      record(summarise(scenario, runId, expectedPage(before, view).matched, warmup, samples, notes))
    }
    await reset()

    // The frontend's own parser on a full page of 100 trades, in the page, apart from everything else.
    const parsed = await target.evaluate<{ bytes: number; frontend: number[]; native: number[] }>(`(async () => {
      const parse = ${parser}
      const body = await (await fetch('/trades/page?page=1&pageSize=100')).text()
      const frontend = [], native = []
      for (let run = 0; run < ${String(warmup + iterations)}; run++) {
        const start = performance.now(); parse(body); const middle = performance.now(); JSON.parse(body); const end = performance.now()
        if (run >= ${String(warmup)}) { frontend.push(middle - start); native.push(end - middle) }
      }
      return { bytes: new Blob([body]).size, frontend, native }
    })()`, timeoutMs * 2)
    const afterScenarios = await memory(target)
    errors.push(...target.consoleErrors)
    const observers = await target.evaluate<{ longTasks: boolean; eventTiming: boolean }>(
      '({ longTasks: window.__tradeBlotterPerf.longTasksObserved, eventTiming: window.__tradeBlotterPerf.eventsObserved })')

    const after = await readSnapshot(app.api.databasePath)
    if (after.fingerprint !== before.fingerprint) {
      throw new BenchmarkError(`The trades in ${app.api.databasePath} changed during the benchmark; the results were discarded. Something else wrote to the database.`)
    }
    return {
      ...header, complete: true, finishedAt: new Date().toISOString(), datasetUnchanged: true,
      scenarios: results,
      parsing: {
        responseBytes: parsed.bytes, frontendParserMs: statistics(parsed.frontend), jsonParseMs: statistics(parsed.native),
        source: 'parseJsonKeepingNumberText from client/src/api/json.ts, types stripped, run in the page on GET /trades/page?page=1&pageSize=100',
      },
      memory: { afterLoad, afterScenarios },
      consoleErrors: errors,
      observers,
    }
  } finally {
    await page?.close()
    await browser.close()
    options.onBrowser?.(undefined)
  }
}

// ---------------------------------------------------------------------------------------------
// Output

const msOrNa = (value: number | undefined): string => value === undefined ? 'n/a' : ms(value)

export function formatUiResult(result: UiBenchmarkResult): string {
  const env = result.environment
  const actions = result.scenarios.filter((s) => s.medians.longestEventMs === undefined)
  const memoryRow = (label: string, m: PageMemory): string[] => [
    label, mib(m.jsHeapUsedBytes), mib(m.jsHeapUsedAfterGcBytes), mib(m.jsHeapTotalBytes), grouped(m.domNodes), grouped(m.elements),
    m.chromeProcesses === undefined ? 'n/a' : `${mib(m.chromeProcesses.residentBytes)} (${String(m.chromeProcesses.count)} processes)`,
    m.chromeProcesses === undefined ? 'n/a' : mib(m.chromeProcesses.largestBytes),
  ]
  return [
    `UI benchmark: ${grouped(result.datasetTrades)} trades (${String(result.openPositions)} open positions) in ${result.application.databasePath}`,
    `Run ${result.runId}, ${result.startedAt}; scenarios: ${result.scenarioIds.join(', ')}.`,
    `Frontend ${result.application.webUrl} (process ${String(result.application.webPid)}, production build) -> API ${result.application.apiUrl} ` +
      `(process ${String(result.application.apiPid)}); ${String(result.warmupIterations)} warmup + ${String(result.measuredIterations)} measured runs per scenario.`,
    `${String(env['chrome'])} headless, ${String(env['viewport'])}, ${String(env['timeZone'])}; ${String(env['platform'])} ${String(env['release'])}, ` +
      `Node.js ${String(env['node'])}, ${String(env['cpu'])}.`,
    '',
    'Actions (ms; medians of the parts; "after response" = parsing + exact decimals + Vue + layout + paint, not separable):',
    table(
      ['Scenario', 'Matching', 'Min', 'Median', 'Max', 'Before request', 'Waiting', 'Transfer', 'After response', 'Long tasks', 'Longest task', 'Script', 'Layout', 'Style'],
      actions.map((s) => [
        s.name, s.matchedRows === undefined ? '-' : grouped(s.matchedRows), ms(s.elapsedMs.min), ms(s.elapsedMs.median), ms(s.elapsedMs.max),
        msOrNa(s.medians.beforeRequestMs), msOrNa(s.medians.waitingMs), msOrNa(s.medians.transferMs), msOrNa(s.medians.afterResponseMs),
        `${String(Math.round(s.medians.longTasks ?? 0))} / ${msOrNa(s.medians.longTaskTotalMs)}`, ms(Math.max(...s.samples.map((x) => x.longestTaskMs))),
        msOrNa(s.medians.scriptMs), msOrNa(s.medians.layoutMs), msOrNa(s.medians.styleMs),
      ]),
    ),
    '',
    'Typing (ms):',
    table(
      ['Scenario', 'Samples', 'Min', 'Median', 'Max', 'Longest event', 'Longest task'],
      result.scenarios.filter((s) => !actions.includes(s)).map((s) => [
        s.name, String(s.measuredIterations), ms(s.elapsedMs.min), ms(s.elapsedMs.median), ms(s.elapsedMs.max),
        Math.max(...s.samples.map((x) => x.longestEventMs ?? 0)) < 16 ? '< 16' : ms(Math.max(...s.samples.map((x) => x.longestEventMs ?? 0))),
        ms(Math.max(...s.samples.map((x) => x.longestTaskMs))),
      ]),
    ),
    ...result.scenarios.flatMap((s) => s.notes.map((note) => `  ${s.name}: ${note}`)),
    '',
    `Parsing a page of 100 trades (${grouped(result.parsing.responseBytes)} bytes) in the page, apart from rendering: frontend exact-decimal parser median ` +
      `${ms(result.parsing.frontendParserMs.median)} ms (min ${ms(result.parsing.frontendParserMs.min)}, max ${ms(result.parsing.frontendParserMs.max)}); ` +
      `JSON.parse median ${ms(result.parsing.jsonParseMs.median)} ms.`,
    '',
    'Memory:',
    table(['When', 'JS heap used', 'after GC', 'JS heap allocated', 'DOM nodes', 'Elements', 'Chrome processes', 'Largest process'],
      [memoryRow('After the initial load', result.memory.afterLoad), memoryRow('After every scenario', result.memory.afterScenarios)]),
    `  JS heap: the page's V8 heap only. Chrome processes: ${result.memory.afterLoad.chromeProcesses?.source ?? 'not available'}, every Chrome process summed (shared memory counted more than once).`,
    '',
    `Long tasks observed: ${result.observers.longTasks ? 'yes' : 'NOT AVAILABLE'}; Event Timing: ${result.observers.eventTiming ? 'yes' : 'NOT AVAILABLE'}.`,
    `Console errors: ${result.consoleErrors.length === 0 ? 'none' : result.consoleErrors.map((e) => `\n  ${e}`).join('')}`,
    `Trade records unchanged afterwards: ${result.datasetUnchanged ? 'yes' : 'NO'} (SHA-256 ${result.datasetFingerprint.slice(0, 16)}...).`,
    'Statistics: min, median and max of the measured runs; no tail percentile is given for this few runs.',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = 'Usage: npm run perf:ui -- --database <path> [--web-url <url>] [--warmup <n>] [--iterations <n>] [--json <file>] ' +
  `[--chrome <path>] [--timeout <seconds>] [--max-heap-mb <n>] [--scenarios <${UI_SCENARIOS.map((s) => s.id).join(',')}>]`

export const UI_OPTIONS = {
  database: { type: 'string' }, 'web-url': { type: 'string' }, warmup: { type: 'string' }, iterations: { type: 'string' }, json: { type: 'string' },
  chrome: { type: 'string' }, timeout: { type: 'string' }, 'max-heap-mb': { type: 'string' }, scenarios: { type: 'string' },
} as const

export function uiOptions(values: { warmup?: string; iterations?: string; chrome?: string; timeout?: string; 'max-heap-mb'?: string; scenarios?: string }): UiOptions {
  const iterations = count(values.iterations, '--iterations', DEFAULT_UI_ITERATIONS)
  const timeoutSeconds = count(values.timeout, '--timeout', DEFAULT_TIMEOUT_SECONDS)
  const maxHeapMb = count(values['max-heap-mb'], '--max-heap-mb', DEFAULT_MAX_HEAP_MB)
  if (iterations < 1 || timeoutSeconds < 1 || maxHeapMb < 64) throw new BenchmarkError('--iterations and --timeout must be 1 or more, --max-heap-mb 64 or more.')
  return {
    warmup: count(values.warmup, '--warmup', DEFAULT_UI_WARMUP), iterations, timeoutSeconds, maxHeapMb, scenarios: selectScenarios(values.scenarios),
    ...(values.chrome === undefined ? {} : { chrome: values.chrome }),
  }
}

async function main(): Promise<number> {
  let browser: Browser | undefined
  const interrupted = (): void => {
    void (browser?.close() ?? Promise.resolve()).finally(() => process.exit(130))
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: UI_OPTIONS })
    const cwd = process.env['INIT_CWD'] ?? process.cwd()
    const options = uiOptions(values)
    findChrome(options.chrome)
    const app = findManagedApplication({
      databasePath: values.database === undefined ? undefined : resolve(cwd, values.database),
      ...(values['web-url'] === undefined ? {} : { webUrl: values['web-url'] }),
      protection: { ...DEFAULT_PROTECTION, runDir: defaultRunDir() },
    })
    const json = values.json === undefined ? undefined : resolve(cwd, values.json)
    console.log(`Measuring ${app.webUrl.origin} (API ${app.api.url.origin}) on ${app.api.databasePath} in headless Chrome...`)
    const result = await runUiBenchmark(app, {
      ...options,
      onBrowser: (running) => { browser = running },
      onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${ms(scenario.elapsedMs.median)} ms`) },
      // Each finished scenario is on disk at once, so an interrupted run keeps it.
      ...(json === undefined ? {} : { onCheckpoint: (partial: UiCheckpoint) => { writeJson(json, partial) } }),
    })
    console.log(`\n${formatUiResult(result)}`)
    if (json !== undefined) {
      writeJson(json, result)
      console.log(`Results: ${json}`)
    }
    return 0
  } catch (error) {
    if (error instanceof TargetError || error instanceof BenchmarkError) {
      console.error(error.message)
      return 1
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(`${error.message}\n${USAGE}`)
      return 2
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main()
}
