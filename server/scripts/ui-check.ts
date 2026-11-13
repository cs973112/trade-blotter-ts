import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { loadConfig } from '../src/config.ts'
import { Dec } from '../src/domain/decimal.ts'
import { calculatePositions } from '../src/domain/position.ts'
import { notional } from '../src/domain/trade.ts'
import { createServer } from '../src/server.ts'
import { defaultRunDir, REPOSITORY_ROOT } from './lifecycle.ts'
import { Browser, findChrome, Page } from './perf-ui.ts'
import {
  UI_DETAIL_COUNTS, UI_OPEN_POSITIONS, uiBenchmarkPositionCount, uiCheckPositions, uiDetailPositions, uiDetailTrades, writeBenchmarkDatabase,
  writeUiCheckDatabase, writeUiDetailDatabase,
} from './ui-check-data.ts'
import { BENCHMARK_COUNT, BENCHMARK_SEED } from './review-context.ts'
import { generateTrades } from './seed-data.ts'

/**
 * npm run check:ui [-- --chrome <path>] [--out <folder>]
 *
 * The page's behaviour in a real browser: the three tabs (pointer, keyboard, focus, what each keeps
 * when another is shown, and that changing tab loads nothing), the Positions grid (25 positions in
 * view under a header that stays put, every position reachable, resizing columns by pointer and
 * keyboard within their least widths, headers aligned with their cells), the layout at 1280, 768
 * and 390 pixels wide, booking a trade with exact decimals, and no console errors.
 *
 * Then Positions & Trade Details on a second dataset of overlapping symbols (MS, MSFT, MSTR, AMS),
 * and finally both Positions grids at the benchmark's scale: the seed generator's 25,000 trades
 * (dataset version 2, 167 open positions), generated afresh into a database of the checks' own.
 *
 * It needs the built frontend (npm run build). Each part runs on a database of its own, made from
 * fixed trades (ui-check-data.ts); the first has 40 open positions. The API runs in this process, with a small
 * server for the built frontend that forwards the API's paths, both on free ports chosen by the
 * system. Nothing else is read or changed; the database is removed at the end. The browser comes
 * from --chrome, else CHROME_PATH, else the usual places (browser.ts); it is never installed.
 * Screenshots of each layout are kept in the output folder.
 */

export interface UiCheckResult {
  readonly name: string
  /** Why it failed; undefined when it passed. */
  readonly problem?: string
}

export interface UiCheckRun {
  readonly browser: string
  readonly product: string
  readonly results: readonly UiCheckResult[]
  readonly screenshots: readonly string[]
  readonly consoleErrors: readonly string[]
}

const VIEWPORT_HEIGHT = 900
export const UI_CHECK_WIDTHS = [1280, 768, 390] as const
const TIMEOUT_MS = 20_000
const VISIBLE_POSITIONS = 25

// ---------------------------------------------------------------------------------------------
// The built frontend, and the API's paths forwarded to the API

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/** The API's own paths, which the frontend calls with relative URLs (as vite preview forwards them). */
const API_PATH = /^\/(?:trades|positions)(?:\/|$)/

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface FrontendServerOptions {
  /** Milliseconds to hold an API request before forwarding it: how a check makes one answer arrive late. */
  readonly delayFor?: (url: URL) => number
}

/** Serves `dist` (index.html for any other path) and forwards the API's paths to `api`. */
export async function frontendServer(dist: string, api: string, options: FrontendServerOptions = {}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const root = resolve(dist)
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (API_PATH.test(url.pathname)) {
      const delay = options.delayFor?.(url) ?? 0
      if (delay > 0) await sleep(delay)
      const sent = request.method === 'GET' || request.method === 'HEAD' ? undefined : await body(request)
      const answer = await fetch(`${api}${url.pathname}${url.search}`, {
        method: request.method ?? 'GET',
        headers: request.headers['content-type'] === undefined ? {} : { 'content-type': request.headers['content-type'] },
        ...(sent === undefined ? {} : { body: sent }),
      })
      response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' })
      response.end(Buffer.from(await answer.arrayBuffer()))
      return
    }
    let file = resolve(root, `.${normalize(decodeURIComponent(url.pathname))}`)
    if (file !== root && !file.startsWith(`${root}${sep}`)) file = join(root, 'index.html')
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  }
  const server: Server = createHttpServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections()
      server.close(() => { resolveClose() })
    }),
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and driving the page

/** Read in the page: geometry and state of the tabs, the grid and the trade list. */
const PAGE_READERS = String.raw`(() => {
  if (window.__ui) return
  const ui = window.__ui = {}
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
  ui.visible = (element) => !!element && element.checkVisibility()
  ui.grid = () => document.querySelector('#panel-trading .positions-scroll')
  ui.gridTable = () => document.querySelector('#panel-trading .positions-table')
  ui.columnWidths = (table = ui.gridTable()) => [...table.tHead.rows[0].cells].map((cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10)
  /** A cell's text as seen: without the text kept for screen readers only. */
  ui.seen = (cell) => { const copy = cell.cloneNode(true); copy.querySelectorAll('.visually-hidden').forEach((e) => e.remove()); return copy.textContent.trim() }
  /** A cell's text as a screen reader gets it, hidden text included. */
  ui.heard = (cell) => cell.textContent.replace(/\s+/g, ' ').trim()
  ui.master = () => document.querySelector('section[aria-labelledby="master-heading"]')
  ui.masterTable = () => ui.master().querySelector('table')
  ui.masterRows = () => [...ui.masterTable().tBodies[0].rows]
  ui.details = () => document.querySelector('section[aria-labelledby="details-heading"]')
  ui.detailsTable = () => ui.details().querySelector('table.details-table')
  ui.detailRows = () => { const t = ui.detailsTable(); return t ? [...t.tBodies[0].rows] : [] }
  ui.detailHeaders = () => { const t = ui.detailsTable(); return t ? [...t.tHead.rows[0].cells].map((c) => (c.querySelector('.column-label, .sort-button')?.childNodes[0]?.textContent ?? '').trim()) : [] }
  ui.detailsIdle = () => !ui.details().querySelector('[aria-busy="true"]') && !/Loading trades|Updating trades/.test(ui.details().querySelector('.list-status')?.textContent ?? '')
  ui.detailState = () => ({
    heading: ui.details().querySelector('h2').textContent.trim(), count: ui.details().querySelector('.trade-count')?.textContent.trim() ?? '',
    position: ui.details().querySelector('nav.pager .pager-position')?.textContent.trim() ?? '', rows: ui.detailRows().length,
    size: ui.details().querySelector('nav.pager select')?.value ?? '',
    selected: ui.masterRows().filter((row) => row.getAttribute('aria-selected') === 'true').map((row) => row.cells[0].textContent.trim()),
  })
  /** The API requests the page made whose path and query match: the details' requests carry symbolMatch=exact. */
  ui.requests = (pattern) => performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'fetch').map((e) => { const u = new URL(e.name); return u.pathname + u.search }).filter((path) => new RegExp(pattern).test(path))
  /** The rows wholly visible in the grid's box, below its header. */
  ui.fullyVisibleRows = () => {
    const scroller = ui.grid()
    const top = scroller.getBoundingClientRect().top + scroller.clientTop
    const bottom = top + scroller.clientHeight
    // The header cells stay in view (sticky); the header row group itself scrolls with the rows.
    const headerBottom = ui.gridTable().tHead.rows[0].cells[0].getBoundingClientRect().bottom
    return [...ui.gridTable().tBodies[0].rows].filter((row) => {
      const r = row.getBoundingClientRect()
      return r.top >= headerBottom - 0.5 && r.bottom <= bottom + 0.5 && r.top >= top - 0.5
    }).map((row) => row.cells[0].textContent.trim())
  }
  /** Each header cell against the cell below it in the first row wholly in view: the largest gap in pixels. */
  ui.misalignment = (table) => {
    const header = [...table.tHead.rows[0].cells]
    const scroller = table.closest('.table-scroll')
    const limit = scroller.getBoundingClientRect().bottom
    const row = [...table.tBodies[0].rows].find((candidate) => candidate.getBoundingClientRect().top >= header[0].getBoundingClientRect().bottom - 0.5 &&
      candidate.getBoundingClientRect().bottom <= limit + 0.5) ?? table.tBodies[0].rows[0]
    return Math.max(...header.map((cell, index) => {
      const a = cell.getBoundingClientRect(), b = row.cells[index].getBoundingClientRect()
      return Math.max(Math.abs(a.left - b.left), Math.abs(a.right - b.right))
    }))
  }
  /** Numeric cells whose text takes more than one line. */
  ui.wrappedNumbers = () => [...document.querySelectorAll('.data-table td.numeric')].filter(ui.visible).filter((cell) => {
    const range = document.createRange()
    range.selectNodeContents(cell)
    return range.getBoundingClientRect().height > parseFloat(getComputedStyle(cell).fontSize) * 2
  }).map((cell) => cell.textContent.trim())
  ui.pageOverflow = () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  /** Each visible table's box: whether it scrolls sideways itself, and by how much its table is wider. */
  ui.tableBoxes = () => [...document.querySelectorAll('.table-scroll')].filter(ui.visible).map((scroller) => ({
    overflowX: getComputedStyle(scroller).overflowX, wider: scroller.scrollWidth - scroller.clientWidth,
    outside: Math.max(0, scroller.getBoundingClientRect().right - document.documentElement.clientWidth),
  }))
  ui.rowHeights = () => [...new Set([...ui.gridTable().tBodies[0].rows].map((row) => Math.round(row.getBoundingClientRect().height * 10) / 10))]
  ui.focusShown = () => {
    const element = document.activeElement
    if (!element || element === document.body) return 'nothing has focus'
    const style = getComputedStyle(element)
    if (!element.matches(':focus-visible')) return 'the focused element does not match :focus-visible'
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1 ? undefined : 'no outline is drawn: ' + style.outlineStyle + ' ' + style.outlineWidth
  }
  ui.selectedTab = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()
  ui.shownPanels = () => [...document.querySelectorAll('[role="tabpanel"]')].filter(ui.visible).map((panel) => panel.id)
  ui.fetches = (path) => performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'fetch' && new URL(e.name).pathname === path).length
  ui.historyState = () => {
    const section = document.querySelector('section[aria-labelledby="blotter-heading"]')
    return {
      symbol: document.getElementById('filter-symbol').value,
      sorted: section.querySelector('th[aria-sort]')?.textContent.split(',')[0].replace(/[↑↓↕]/g, '').trim() ?? '',
      direction: section.querySelector('th[aria-sort]')?.getAttribute('aria-sort') ?? '',
      position: section.querySelector('nav.pager .pager-position')?.textContent.trim() ?? '',
      size: section.querySelector('nav.pager select')?.value ?? '',
      rows: [...section.querySelectorAll('tbody tr')].map((row) => row.cells[0].textContent.trim() + ' ' + row.cells[3].textContent.trim()).join('|'),
    }
  }
})()`

const KEYS: Readonly<Record<string, readonly [code: string, keyCode: number]>> = {
  ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37], Home: ['Home', 36], End: ['End', 35], Tab: ['Tab', 9],
  PageDown: ['PageDown', 34], Enter: ['Enter', 13], Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38],
  ' ': ['Space', 32],
}

const TYPED: Readonly<Record<string, string>> = { Enter: '\r', ' ': ' ' }

class Driver {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  value<T>(expression: string): Promise<T> {
    return this.page.evaluate<T>(`(() => { ${PAGE_READERS}; return (${expression}) })()`)
  }

  async until(expression: string, what: string): Promise<void> {
    try {
      await this.page.evaluate(`(() => { ${PAGE_READERS}; return window.__tradeBlotterPerf.when(() => !!(${expression}), ${String(TIMEOUT_MS)}) })()`, TIMEOUT_MS + 5_000)
    } catch (error) {
      throw new Error(`waited for ${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  async frame(): Promise<void> {
    await this.page.evaluate('window.__tradeBlotterPerf.nextFrame()')
  }

  async press(key: string, shift = false): Promise<void> {
    const [code, keyCode] = KEYS[key] ?? [key, 0]
    const modifiers = shift ? 8 : 0
    // Enter and Space type a character, as a keyboard does: that is what activates a button or check box.
    const text = TYPED[key]
    await this.page.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text === undefined ? {} : { text }) })
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
    await this.frame()
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector)
    await this.frame()
  }

  async type(selector: string, text: string): Promise<void> {
    await this.value(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return true })()`)
    await this.page.send('Input.insertText', { text })
    await this.frame()
  }

  /** Presses the left button at the middle of an element, moves by dx in steps, and releases. */
  async drag(selector: string, dx: number): Promise<void> {
    const [x, y] = await this.value<[number, number]>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    const steps = 6
    for (let step = 1; step <= steps; step++) {
      await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * step) / steps, y, button: 'left', buttons: 1 })
    }
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', buttons: 0, clickCount: 1 })
    await this.frame()
  }

  /** Turns the mouse wheel over the middle of an element: dx and dy in pixels, as a wheel or touchpad sends them. */
  async wheel(selector: string, dx: number, dy: number): Promise<void> {
    const [x, y] = await this.value<[number, number]>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + Math.min(r.height / 2, 120)] })()`)
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy })
    await this.frame()
  }

  async viewport(width: number): Promise<void> {
    await this.page.send('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false })
    await this.frame()
    await this.frame()
  }

  /** The whole page at this width: the viewport is made as tall as the page for the picture, then put back. */
  async screenshot(path: string, width: number): Promise<void> {
    const height = await this.value<number>('document.documentElement.scrollHeight')
    await this.page.send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(Math.max(height, VIEWPORT_HEIGHT), 4000), deviceScaleFactor: 1, mobile: false })
    await this.frame()
    const shot = await this.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    await this.viewport(width)
  }
}

const near = (a: number, b: number, tolerance = 1): boolean => Math.abs(a - b) <= tolerance

type Decimal = InstanceType<typeof Dec>

/** Decimal text with its integer digits grouped in threes, every fractional digit kept. */
function group(text: string): string {
  const [integer = '', fraction] = text.replace('-', '').split('.')
  return `${text.startsWith('-') ? '-' : ''}${integer.replace(/\B(?=(\d{3})+$)/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`
}

/**
 * What the page should show for money: 2 places, half to even, grouped. Worked out here with the
 * server's decimal library, not the page's own code, so the two are checked against each other.
 */
function money(value: Decimal): string {
  const text = value.toFixed(2, Dec.ROUND_HALF_EVEN)
  return group(text === '-0.00' ? '0.00' : text)
}

/** A money cell with Exact values on: the two-place value, and the exact one beside it where digits are hidden. */
function withExact(value: Decimal): string {
  return value.equals(value.toDecimalPlaces(2)) ? money(value) : `${money(value)} exactly ${group(value.toFixed())}`
}

/**
 * Reaches a grid's Exact values checkbox from its Columns button with Shift+Tab, as a keyboard user
 * would, and presses Space. Undefined when the checkbox took focus, showed it, and is now checked.
 */
async function pressExactValues(ui: Driver, section: string): Promise<string | undefined> {
  await ui.value(`document.querySelector('${section} .column-chooser > button').focus()`)
  await ui.press('Tab', true)
  const reached = await ui.value<{ toggle: boolean; focus: string | undefined }>(`({ toggle: document.activeElement.classList.contains('exact-toggle'), focus: __ui.focusShown() })`)
  if (!reached.toggle) return 'Shift+Tab from Columns did not reach the Exact values checkbox'
  if (reached.focus !== undefined) return `the checkbox's focus: ${reached.focus}`
  const kind = await ui.value<{ type: string; checked: boolean }>(`({ type: document.activeElement.type, checked: document.activeElement.checked })`)
  if (kind.type !== 'checkbox' || kind.checked) return `Exact values is a ${kind.type}, ${kind.checked ? 'checked' : 'unchecked'}, before Space`
  await ui.press(' ')
  const checked = await ui.value<boolean>(`document.activeElement.checked`)
  return checked ? undefined : 'after Space, Exact values is not checked'
}

/**
 * Where 2 places hide digits, the exact value must be the tooltip and follow the rounded one for
 * screen readers; where they hide none, neither is added. Undefined when that holds.
 */
function exactKept(value: Decimal, title: string | null, heard: string): string | undefined {
  const exact = group(value.toFixed())
  const rounded = !value.equals(value.toDecimalPlaces(2))
  const wantTitle = rounded ? `Exactly ${exact}` : null
  if (title !== wantTitle) return `tooltip ${String(title)}, expected ${String(wantTitle)}`
  const wantHeard = rounded ? `${money(value)}, exactly ${exact}` : money(value)
  return heard === wantHeard ? undefined : `screen readers get "${heard}", expected "${wantHeard}"`
}
const HANDLE = (label: string): string => `[role="separator"][aria-label="Resize the ${label} column"]`

// ---------------------------------------------------------------------------------------------
// The checks

type Check = readonly [name: string, run: (ui: Driver) => Promise<string | undefined>]

function checks(screenshots: string[], outDir: string): Check[] {
  const expected = uiCheckPositions()
  return [
    ['Opens on the Trading tab, with the booking form and the Positions grid; each tab names the panel it controls', async (ui) => {
      const state = await ui.value<{ selected: string; panels: string[]; tabs: string[]; links: boolean; form: boolean; grid: boolean }>(`({
        selected: __ui.selectedTab(), panels: __ui.shownPanels(), tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
        links: [...document.querySelectorAll('[role="tab"]')].every((t) => document.getElementById(t.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === t.id),
        form: __ui.visible(document.querySelector('section[aria-labelledby="trade-form-heading"]')), grid: __ui.visible(__ui.grid()),
      })`)
      if (state.tabs.join('|') !== 'Trading|Positions & Trade Details|Trade History') return `tabs ${state.tabs.join(', ')}`
      if (state.selected !== 'Trading' || state.panels.join() !== 'panel-trading') return `selected ${state.selected}, panels shown ${state.panels.join(', ')}`
      if (!state.links) return 'a tab and its panel do not name each other'
      return state.form && state.grid ? undefined : 'the booking form or the Positions grid is not visible'
    }],
    ['Loads the trade list and positions once as it opens', async (ui) => {
      const counts = await ui.value<number[]>('[__ui.fetches("/trades/page"), __ui.fetches("/positions")]')
      return counts.join() === '1,1' ? undefined : `GET /trades/page ${String(counts[0])} times, GET /positions ${String(counts[1])} times`
    }],
    [`Positions grid: all ${String(UI_OPEN_POSITIONS)} open positions, exactly ${String(VISIBLE_POSITIONS)} wholly in view before scrolling, rows of one height`, async (ui) => {
      const state = await ui.value<{ symbols: string[]; visible: string[]; heights: number[]; scrolls: boolean }>(`({
        symbols: [...__ui.gridTable().tBodies[0].rows].map((row) => row.cells[0].textContent.trim()), visible: __ui.fullyVisibleRows(),
        heights: __ui.rowHeights(), scrolls: __ui.grid().scrollHeight > __ui.grid().clientHeight,
      })`)
      if (state.symbols.join() !== expected.map((position) => position.symbol).join()) return `rows ${state.symbols.join(', ')}`
      if (state.visible.length !== VISIBLE_POSITIONS) return `${String(state.visible.length)} rows wholly in view: ${state.visible.join(', ')}`
      if (state.visible[0] !== 'POS01' || state.visible.at(-1) !== 'POS25') return `rows in view ${String(state.visible[0])} to ${String(state.visible.at(-1))}`
      if (state.heights.length !== 1) return `row heights ${state.heights.join(', ')}`
      return state.scrolls ? undefined : 'the grid does not scroll'
    }],
    ['Positions grid: exact net quantities and directions as the API calculates them; average costs to 2 places, half to even, the exact cost as tooltip and for screen readers', async (ui) => {
      const rows = await ui.value<{ seen: string[]; title: string | null; heard: string }[]>(`[...__ui.gridTable().tBodies[0].rows].map((row) => ({
        seen: [...row.cells].map((cell) => __ui.seen(cell)), title: row.cells[3].querySelector('.money').getAttribute('title'), heard: __ui.heard(row.cells[3]),
      }))`)
      for (const [index, position] of expected.entries()) {
        const net = position.netQuantity.toFixed()
        const want = [position.symbol, net.startsWith('-') ? 'Short' : 'Long', group(net), money(position.averageCost)]
        const row = rows[index]
        if (row?.seen.join('|') !== want.join('|')) return `row ${String(index + 1)}: ${row?.seen.join(' | ') ?? 'missing'}, expected ${want.join(' | ')}`
        const problem = exactKept(position.averageCost, row.title, row.heard)
        if (problem !== undefined) return `${position.symbol}: ${problem}`
      }
      return undefined
    }],
    ['Positions grid: the header stays in view while the rows scroll, and the keyboard reaches the last position', async (ui) => {
      await ui.value('__ui.grid().focus()')
      await ui.press('End')
      await ui.until('__ui.grid().scrollTop + __ui.grid().clientHeight >= __ui.grid().scrollHeight - 1', 'the grid to scroll to the end')
      await ui.frame()
      const end = await ui.value<{ headerTop: number; boxTop: number; visible: string[] }>(`({
        headerTop: __ui.gridTable().tHead.rows[0].cells[0].getBoundingClientRect().top, boxTop: __ui.grid().getBoundingClientRect().top + __ui.grid().clientTop, visible: __ui.fullyVisibleRows(),
      })`)
      if (!near(end.headerTop, end.boxTop)) return `the header moved with the rows: ${String(end.headerTop)} against ${String(end.boxTop)}`
      if (end.visible.at(-1) !== 'POS40' || end.visible.length !== VISIBLE_POSITIONS) return `after End: ${end.visible.join(', ')}`
      const misalignment = await ui.value<number>('__ui.misalignment(__ui.gridTable())')
      if (misalignment > 1) return `scrolled, headers and cells differ by ${String(misalignment)} px`
      await ui.press('Home')
      await ui.until('__ui.grid().scrollTop < 1', 'the grid to scroll back to the start')
      const focus = await ui.value<string | undefined>('__ui.focusShown()')
      return focus === undefined ? undefined : `the grid's focus: ${focus}`
    }],
    ['Resizing by pointer: dragging the Symbol column\'s edge widens only that column, aligned, without sorting, loading or selecting anything', async (ui) => {
      const before = await ui.value<number[]>('__ui.columnWidths()')
      const fetches = await ui.value<number>('__ui.fetches("/positions") + __ui.fetches("/trades/page")')
      await ui.drag(HANDLE('Symbol'), 60)
      const after = await ui.value<number[]>('__ui.columnWidths()')
      if (!near(after[0] ?? 0, (before[0] ?? 0) + 60)) return `Symbol ${String(before[0])} px to ${String(after[0])} px, expected ${String((before[0] ?? 0) + 60)}`
      if (after.slice(1).some((width, index) => !near(width, before[index + 1] ?? 0))) return `other columns changed: ${before.join(', ')} to ${after.join(', ')}`
      const misalignment = await ui.value<number>('__ui.misalignment(__ui.gridTable())')
      if (misalignment > 1) return `headers and cells differ by ${String(misalignment)} px`
      const side = await ui.value<{ fetches: number; selected: string; resizing: boolean }>(`({
        fetches: __ui.fetches("/positions") + __ui.fetches("/trades/page"), selected: getSelection().toString(), resizing: __ui.gridTable().classList.contains('is-resizing'),
      })`)
      if (side.fetches !== fetches) return 'the drag loaded data'
      if (side.selected !== '') return `the drag selected text: ${side.selected}`
      return side.resizing ? 'the grid still shows a resize in progress' : undefined
    }],
    ['Resizing by pointer: a column cannot be dragged narrower than its least width', async (ui) => {
      await ui.drag(HANDLE('Symbol'), -600)
      const widths = await ui.value<number[]>('__ui.columnWidths()')
      const least = await ui.value<number>(`Number(document.querySelector('${HANDLE('Symbol')}').getAttribute('aria-valuemin'))`)
      if (!near(widths[0] ?? 0, least)) return `Symbol is ${String(widths[0])} px; its least width is ${String(least)} px`
      const label = await ui.value<{ shown: number; needed: number }>(`(() => { const l = __ui.gridTable().tHead.rows[0].cells[0].querySelector('.column-label'); return { shown: l.clientWidth, needed: l.scrollWidth } })()`)
      return label.needed <= label.shown + 1 ? undefined : `at its least width the Symbol header is cut off (${String(label.needed)} px needed, ${String(label.shown)} shown)`
    }],
    ['Resizing by keyboard: Tab reaches each column\'s edge, with a visible focus; arrows, Shift and Home resize it within its limits', async (ui) => {
      await ui.value('__ui.grid().focus()')
      await ui.press('Tab')
      await ui.press('Tab')
      await ui.press('Tab')
      const focused = await ui.value<string>('document.activeElement.getAttribute("aria-label") ?? document.activeElement.tagName')
      if (focused !== 'Resize the Net quantity column') return `Tab reached ${focused}`
      const focus = await ui.value<string | undefined>('__ui.focusShown()')
      if (focus !== undefined) return `the handle's focus: ${focus}`
      const start = (await ui.value<number[]>('__ui.columnWidths()'))[2] ?? 0
      await ui.press('ArrowRight')
      await ui.press('ArrowRight')
      await ui.press('ArrowRight', true)
      const wider = (await ui.value<number[]>('__ui.columnWidths()'))[2] ?? 0
      if (!near(wider, start + 70)) return `Net quantity ${String(start)} px to ${String(wider)} px after two arrows and Shift+arrow, expected ${String(start + 70)}`
      await ui.press('ArrowLeft')
      if (!near((await ui.value<number[]>('__ui.columnWidths()'))[2] ?? 0, start + 60)) return 'Left arrow did not narrow the column by 10 px'
      await ui.press('Home')
      const least = await ui.value<number>('Number(document.activeElement.getAttribute("aria-valuemin"))')
      const narrowest = (await ui.value<number[]>('__ui.columnWidths()'))[2] ?? 0
      if (!near(narrowest, least)) return `Home made it ${String(narrowest)} px, its least width is ${String(least)} px`
      await ui.press('ArrowLeft', true)
      if (!near((await ui.value<number[]>('__ui.columnWidths()'))[2] ?? 0, least)) return 'it went below its least width'
      const now = await ui.value<string>('document.activeElement.getAttribute("aria-valuenow")')
      if (Number(now) !== least) return `aria-valuenow ${now}`
      await ui.press('Enter')
      const fitted = await ui.value<{ width: number; clipped: number }>(`(() => {
        const cells = [...__ui.gridTable().rows].map((row) => row.cells[2])
        return { width: __ui.columnWidths()[2], clipped: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length }
      })()`)
      return fitted.clipped === 0 ? undefined : `Enter (fit the contents) left ${String(fitted.clipped)} cells cut off at ${String(fitted.width)} px`
    }],
    ['Column widths stay as set while other tabs are shown, and when positions are loaded again', async (ui) => {
      const before = await ui.value<number[]>('__ui.columnWidths()')
      await ui.click('#tab-history')
      await ui.click('#tab-details')
      await ui.click('#tab-trading')
      await ui.click('#panel-trading .refresh-positions')
      await ui.until(`__ui.fetches("/positions") === 2 && !document.querySelector('#panel-trading .refresh-positions').disabled`, 'positions to load again')
      const after = await ui.value<number[]>('__ui.columnWidths()')
      return after.every((width, index) => near(width, before[index] ?? 0)) ? undefined : `${before.join(', ')} became ${after.join(', ')}`
    }],
    ['Exact values by keyboard in the Positions grid (widths fixed by resizing): Shift+Tab reaches the checkbox with a visible focus; Space shows each rounded average cost\'s exact value beside its two-place value, whole; Space again hides them', async (ui) => {
      const problem = await pressExactValues(ui, '#panel-trading')
      if (problem !== undefined) return problem
      await ui.frame()
      const cells = await ui.value<{ seen: string; clipped: boolean }[]>(`[...__ui.gridTable().tBodies[0].rows].map((row) => ({ seen: __ui.seen(row.cells[3]), clipped: row.cells[3].scrollWidth > row.cells[3].clientWidth + 1 }))`)
      for (const [index, position] of expected.entries()) {
        if (cells[index]?.seen !== withExact(position.averageCost)) return `${position.symbol}: shows "${String(cells[index]?.seen)}", expected "${withExact(position.averageCost)}"`
        if (cells[index].clipped) return `${position.symbol}: the exact average cost is cut off`
      }
      if (await ui.value<number>('__ui.pageOverflow()') > 0) return 'the page scrolls sideways'
      if (await ui.value<number>('__ui.misalignment(__ui.gridTable())') > 1) return 'headers and cells are not aligned'
      await ui.press(' ')
      const off = await ui.value<string[]>(`[...__ui.gridTable().tBodies[0].rows].map((row) => __ui.seen(row.cells[3]))`)
      return off.join('|') === expected.map((position) => money(position.averageCost)).join('|') ? undefined : 'Space again did not hide the exact values'
    }],
    ['Tabs by pointer: each shows its own panel only', async (ui) => {
      for (const [id, label] of [['history', 'Trade History'], ['details', 'Positions & Trade Details'], ['trading', 'Trading']] as const) {
        await ui.click(`#tab-${id}`)
        const state = await ui.value<{ selected: string; panels: string[] }>('({ selected: __ui.selectedTab(), panels: __ui.shownPanels() })')
        if (state.selected !== label || state.panels.join() !== `panel-${id}`) return `after choosing ${label}: ${state.selected}, ${state.panels.join(', ')}`
      }
      return undefined
    }],
    ['Tabs by keyboard: Right and Left arrows (wrapping), Home and End move focus and show the tab, with a visible focus', async (ui) => {
      await ui.value('document.getElementById("tab-trading").focus()')
      const expectations = [['ArrowRight', 'Positions & Trade Details'], ['ArrowRight', 'Trade History'], ['ArrowRight', 'Trading'],
        ['ArrowLeft', 'Trade History'], ['Home', 'Trading'], ['End', 'Trade History'], ['Home', 'Trading']] as const
      for (const [key, label] of expectations) {
        await ui.press(key)
        const state = await ui.value<{ selected: string; focused: string; focus: string | undefined }>(
          '({ selected: __ui.selectedTab(), focused: document.activeElement.textContent.trim(), focus: __ui.focusShown() })')
        if (state.selected !== label || state.focused !== label) return `after ${key}: ${state.selected} shown, ${state.focused} focused, expected ${label}`
        if (state.focus !== undefined) return `the tab's focus: ${state.focus}`
      }
      await ui.press('Tab')
      const next = await ui.value<string>('document.activeElement.id')
      return next === 'panel-trading' ? undefined : `Tab from the tabs went to ${next}, not the Trading panel`
    }],
    ['What was typed in the booking form is kept while other tabs are shown', async (ui) => {
      await ui.type('#trade-symbol', 'zzexact')
      await ui.type('#trade-quantity', '0.0000000001')
      await ui.type('#trade-price', '999999999999999.9999999999')
      await ui.click('label[for="trade-side-buy"], #trade-side-buy')
      await ui.click('#tab-history')
      await ui.click('#tab-details')
      await ui.click('#tab-trading')
      const values = await ui.value<string[]>(`['#trade-symbol', '#trade-quantity', '#trade-price'].map((s) => document.querySelector(s).value).concat(String(document.getElementById('trade-side-buy').checked))`)
      return values.join('|') === 'zzexact|0.0000000001|999999999999999.9999999999|true' ? undefined : `the form shows ${values.join(', ')}`
    }],
    ['The trade list keeps its filters, sort, page and page size while other tabs are shown, and changing tab loads nothing', async (ui) => {
      await ui.click('#tab-history')
      await ui.type('#filter-symbol', 'pos0')
      await ui.click('.trade-filters button[type="submit"]')
      await ui.until('__ui.historyState().position === "Page 1 of 1" || /Page 1 of/.test(__ui.historyState().position)', 'the filtered list')
      await ui.click('section[aria-labelledby="blotter-heading"] thead th:nth-child(4) button')
      await ui.until('__ui.historyState().sorted === "Price"', 'the list sorted by price')
      await ui.value(`(() => { const s = document.querySelector('nav.pager select'); s.value = '25'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
      await ui.until('__ui.historyState().size === "25" && /^Page 1 of/.test(__ui.historyState().position) && !document.querySelector(".table-scroll[aria-busy=true]")', '25 trades a page')
      await ui.click('nav.pager .pager-controls > button:nth-of-type(2)')
      await ui.until('/^Page 2 of/.test(__ui.historyState().position) && !document.querySelector(".table-scroll[aria-busy=true]")', 'page 2')
      const state = await ui.value<Record<string, string>>('__ui.historyState()')
      const requests = await ui.value<number>('__ui.fetches("/trades/page") + __ui.fetches("/positions")')
      for (const id of ['trading', 'details', 'history', 'trading', 'history']) await ui.click(`#tab-${id}`)
      const after = await ui.value<Record<string, string>>('__ui.historyState()')
      if (JSON.stringify(after) !== JSON.stringify(state)) return `before: ${JSON.stringify(state)}\nafter: ${JSON.stringify(after)}`
      if (state['symbol'] !== 'pos0' || state['sorted'] !== 'Price' || state['size'] !== '25' || !/^Page 2 of/.test(state['position'] ?? '')) return `the list shows ${JSON.stringify(state)}`
      const now = await ui.value<number>('__ui.fetches("/trades/page") + __ui.fetches("/positions")')
      return now === requests ? undefined : `${String(now - requests)} requests were made by changing tab`
    }],
    ...UI_CHECK_WIDTHS.map((width): Check => [`Layout at ${String(width)} px: no sideways page scrolling, tables scroll in their own boxes, numbers on one line, headers aligned, focus visible`, async (ui) => {
      await ui.viewport(width)
      const problems: string[] = []
      for (const id of ['trading', 'details', 'history'] as const) {
        await ui.click(`#tab-${id}`)
        await ui.value('window.scrollTo(0, 0)')
        const state = await ui.value<{ overflow: number; boxes: { overflowX: string; wider: number; outside: number }[]; wrapped: string[]; tables: number[] }>(`({
          overflow: __ui.pageOverflow(), boxes: __ui.tableBoxes(), wrapped: __ui.wrappedNumbers(),
          tables: [...document.querySelectorAll('.data-table')].filter(__ui.visible).map((table) => __ui.misalignment(table)),
        })`)
        if (state.overflow > 0) problems.push(`${id}: the page scrolls sideways by ${String(state.overflow)} px`)
        for (const box of state.boxes) {
          if (box.overflowX !== 'auto') problems.push(`${id}: a table box has overflow-x ${box.overflowX}`)
          if (box.outside > 0.5) problems.push(`${id}: a table box reaches ${String(box.outside)} px past the page`)
        }
        if (state.wrapped.length > 0) problems.push(`${id}: numbers on more than one line: ${state.wrapped.slice(0, 3).join(', ')}`)
        if (state.tables.some((gap) => gap > 1)) problems.push(`${id}: headers and cells differ by ${state.tables.join(', ')} px`)
        const file = join(outDir, `ui-${String(width)}-${id}.png`)
        await ui.screenshot(file, width)
        screenshots.push(file)
      }
      await ui.click('#tab-trading')
      // Resizing at this width keeps the page in place: only the grid's box scrolls.
      await ui.value(`document.querySelector('${HANDLE('Average cost')}').focus()`)
      await ui.press('ArrowRight', true)
      await ui.press('ArrowRight', true)
      if (await ui.value<number>('__ui.pageOverflow()') > 0) problems.push('a wider column made the page scroll sideways')
      if (await ui.value<number>('__ui.misalignment(__ui.gridTable())') > 1) problems.push('after resizing, headers and cells are not aligned')
      await ui.press('ArrowLeft', true)
      await ui.press('ArrowLeft', true)
      // Back to the column before, as a keyboard user would.
      await ui.press('Tab', true)
      const focus = await ui.value<string | undefined>('__ui.focusShown()')
      if (focus !== undefined) problems.push(`keyboard focus: ${focus}`)
      return problems.length === 0 ? undefined : problems.join('\n')
    }]),
    ['Booking a trade with exact decimals: the new position and the trade list keep every digit of the quantity, and show money to 2 places with the exact value as tooltip', async (ui) => {
      await ui.viewport(1280)
      await ui.click('#tab-trading')
      await ui.click('section[aria-labelledby="trade-form-heading"] button[type="submit"]')
      await ui.until('document.querySelector(\'section[aria-labelledby="trade-form-heading"] .alert-success\')', 'the booking to be confirmed')
      await ui.until(`[...__ui.gridTable().tBodies[0].rows].length === ${String(UI_OPEN_POSITIONS + 1)}`, 'the new position')
      const row = await ui.value<string[] | undefined>(`(() => { const row = [...__ui.gridTable().tBodies[0].rows].find((r) => r.cells[0].textContent.trim() === 'ZZEXACT'); return row && [...row.cells].map((c) => __ui.seen(c)).concat(row.cells[3].querySelector('.money').title) })()`)
      if (row?.join('|') !== 'ZZEXACT|Long|0.0000000001|1,000,000,000,000,000.00|Exactly 999,999,999,999,999.9999999999') return `the position shows ${row?.join(' | ') ?? 'nothing'}`
      await ui.click('#tab-history')
      await ui.click('.trade-filters button[type="button"]')
      await ui.until('__ui.historyState().symbol === "" && /^Page 1 of/.test(__ui.historyState().position) && !document.querySelector(".table-scroll[aria-busy=true]") && document.querySelector(\'section[aria-labelledby="blotter-heading"] tbody th\')?.textContent.trim() === "ZZEXACT"', 'the trade at the top of the list')
      const trade = await ui.value<string[]>(`(() => { const cells = [...document.querySelector('section[aria-labelledby="blotter-heading"] tbody tr').cells]; return cells.slice(0, 5).map((c) => __ui.seen(c)).concat(cells.slice(3, 5).map((c) => c.querySelector('.money').title)) })()`)
      return trade.join('|') === 'ZZEXACT|Buy|0.0000000001|1,000,000,000,000,000.00|100,000.00|Exactly 999,999,999,999,999.9999999999|Exactly 99,999.99999999999999999999'
        ? undefined : `the list shows ${trade.join(' | ')}`
    }],
  ]
}

// ---------------------------------------------------------------------------------------------
// Positions & Trade Details

/** Lets a check hold back chosen API answers, to make one arrive after a later one. */
export interface DetailControl {
  delayFor: (url: URL) => number
}

const MASTER = 'section[aria-labelledby="master-heading"]'
const DETAILS = 'section[aria-labelledby="details-heading"]'
const DETAIL_NEXT = `${DETAILS} nav.pager .pager-controls > button:nth-of-type(2)`
const SLOW_MS = 1500

/** The request the details make for a page of a symbol's trades, as the page should send it. */
function detailRequest(symbol: string, page: number, pageSize: number, sort = ''): string {
  return `/trades/page?symbol=${encodeURIComponent(symbol)}&symbolMatch=exact${sort}&page=${String(page)}&pageSize=${String(pageSize)}`
}

function detailChecks(screenshots: string[], outDir: string, control: DetailControl): Check[] {
  const positions = uiDetailPositions()
  const symbols = positions.map((position) => position.symbol)
  const trades = uiDetailTrades()
  const rowOf = (symbol: string): string => `${MASTER} tbody tr:nth-child(${String(symbols.indexOf(symbol) + 1)}) th`
  const plural = (count: number): string => `${String(count)} ${count === 1 ? 'trade' : 'trades'}`

  /** Chooses a position by clicking its row, and waits for its first page. */
  const choose = async (ui: Driver, symbol: string): Promise<void> => {
    await ui.click(rowOf(symbol))
    await ui.until(`__ui.detailsIdle() && __ui.detailState().heading === ${JSON.stringify(`Trade Details: ${symbol}`)} && __ui.detailState().count === ${JSON.stringify(plural(UI_DETAIL_COUNTS[symbol] ?? 0))}`, `${symbol}'s trades`)
  }
  const setPageSize = async (ui: Driver, size: number): Promise<void> => {
    await ui.value(`(() => { const s = __ui.details().querySelector('nav.pager select'); s.value = '${String(size)}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await ui.until(`__ui.detailsIdle() && __ui.detailState().size === '${String(size)}' && /^Page 1 of/.test(__ui.detailState().position)`, `${String(size)} trades a page`)
  }
  const openColumns = async (ui: Driver): Promise<void> => {
    await ui.click(`${DETAILS} .column-chooser > button`)
    await ui.until(`__ui.details().querySelector('.column-chooser > button').getAttribute('aria-expanded') === 'true'`, 'the column list to open')
  }
  const closeColumns = async (ui: Driver): Promise<void> => {
    await ui.value(`__ui.details().querySelector('.column-chooser-panel input:not(:disabled)').focus()`)
    await ui.press('Escape')
  }
  const detailWidths = (ui: Driver): Promise<Record<string, number>> =>
    ui.value<Record<string, number>>('Object.fromEntries(__ui.detailHeaders().map((label, index) => [label, __ui.columnWidths(__ui.detailsTable())[index]]))')

  return [
    ['Positions & Trade Details: the master grid lists every open position (symbols that contain one another included), none chosen, and no trades are asked for until one is', async (ui) => {
      await ui.click('#tab-details')
      const state = await ui.value<{ symbols: string[]; selected: string[]; role: string | null; requests: string[]; prompt: string; cells: { seen: string; title: string | null; heard: string }[] }>(`({
        symbols: __ui.masterRows().map((row) => row.cells[0].textContent.trim()), selected: __ui.masterRows().map((row) => row.getAttribute('aria-selected')),
        role: __ui.masterTable().getAttribute('role'), requests: __ui.requests('symbolMatch'), prompt: __ui.details().textContent,
        cells: __ui.masterRows().map((row) => ({ seen: __ui.seen(row.cells[3]), title: row.cells[3].querySelector('.money').getAttribute('title'), heard: __ui.heard(row.cells[3]) })),
      })`)
      if (state.symbols.join() !== symbols.join()) return `rows ${state.symbols.join(', ')}, expected ${symbols.join(', ')}`
      if (state.role !== 'grid' || state.selected.some((value) => value !== 'false')) return `role ${String(state.role)}, aria-selected ${state.selected.join(', ')}`
      if (state.requests.length > 0) return `trades were asked for before a position was chosen: ${state.requests.join(', ')}`
      if (!state.prompt.includes('Choose a position to see the trades that make it up.')) return 'the details do not ask for a position to be chosen'
      for (const [index, position] of positions.entries()) {
        const cell = state.cells[index]
        if (cell?.seen !== money(position.averageCost)) return `${position.symbol}: average cost ${String(cell?.seen)}, expected ${money(position.averageCost)}`
        const problem = exactKept(position.averageCost, cell.title, cell.heard)
        if (problem !== undefined) return `${position.symbol} average cost: ${problem}`
      }
      return undefined
    }],
    ['Choosing MS with the pointer marks its row and loads page 1 of exactly MS\'s trades from the server (symbolMatch=exact): 25 rows of 60, newest first', async (ui) => {
      await choose(ui, 'MS')
      const state = await ui.value<{ detail: Record<string, unknown>; requests: string[]; marked: boolean; times: string[]; range: string }>(`({
        detail: __ui.detailState(), requests: __ui.requests('symbolMatch'),
        marked: (() => { const rows = __ui.masterRows(); const chosen = rows.find((r) => r.getAttribute('aria-selected') === 'true'); const other = rows.find((r) => r.getAttribute('aria-selected') === 'false');
          return getComputedStyle(chosen.cells[1]).backgroundColor !== getComputedStyle(other.cells[1]).backgroundColor && getComputedStyle(chosen.cells[0]).boxShadow !== 'none' })(),
        times: __ui.detailRows().map((row) => row.querySelector('time').getAttribute('datetime')),
        range: __ui.details().querySelector('nav.pager .pager-range').textContent.trim(),
      })`)
      if (JSON.stringify(state.requests) !== JSON.stringify([detailRequest('MS', 1, 25)])) return `requests ${state.requests.join(', ')}`
      const detail = state.detail
      if (detail['rows'] !== 25 || detail['position'] !== 'Page 1 of 3' || state.range !== '1–25 of 60 trades') return `${JSON.stringify(detail)} ${state.range}`
      if (JSON.stringify(detail['selected']) !== '["MS"]') return `rows marked chosen: ${JSON.stringify(detail['selected'])}`
      if (!state.marked) return 'the chosen row does not look different from the others'
      const newest = trades.filter((trade) => trade.symbol === 'MS').map((trade) => trade.executedAt).sort().reverse().slice(0, 25)
      return state.times.join() === newest.join() ? undefined : `the first page is not MS's 25 newest trades: ${state.times.slice(0, 3).join(', ')}…`
    }],
    ['Exact matching: shown with the Symbol column, MS lists only its own 60 trades (never MSFT, MSTR, AMS or MSXLONG…), and every other position lists exactly its own', async (ui) => {
      await openColumns(ui)
      await ui.click(`${DETAILS} input[data-column="symbol"]`)
      await closeColumns(ui)
      await setPageSize(ui, 100)
      for (const symbol of ['MS', ...symbols.filter((candidate) => candidate !== 'MS'), 'MS']) {
        if (symbol !== 'MS' || (await ui.value<string>('__ui.detailState().heading')) !== 'Trade Details: MS') await choose(ui, symbol)
        const shown = await ui.value<string[]>(`__ui.detailRows().map((row) => row.querySelector('td.cell-symbol').textContent.trim())`)
        const want = UI_DETAIL_COUNTS[symbol] ?? 0
        if (shown.length !== want || shown.some((text) => text !== symbol)) return `${symbol}: ${String(shown.length)} rows, symbols ${[...new Set(shown)].join(', ')}; expected ${String(want)} of ${symbol}`
      }
      const requests = await ui.value<string[]>('__ui.requests("symbolMatch")')
      const bad = requests.filter((request) => !/^\/trades\/page\?symbol=[^&]+&symbolMatch=exact&/.test(request))
      if (bad.length > 0) return `requests without an exact symbol: ${bad.join(', ')}`
      const contains = await ui.value<string[]>('__ui.requests("^/trades/page\\\\?symbol=").filter((r) => !r.includes("symbolMatch=exact"))')
      return contains.length === 0 ? undefined : `details asked for a search within symbols: ${contains.join(', ')}`
    }],
    ['Paging on the server: Next shows pages 2 and 3 of MS\'s trades, 60 different trades in all, newest first; page size 50; another position starts at page 1, keeping the size', async (ui) => {
      await setPageSize(ui, 25)
      const seen: string[] = []
      for (const [page, rows] of [[1, 25], [2, 25], [3, 10]] as const) {
        if (page > 1) {
          await ui.click(DETAIL_NEXT)
          await ui.until(`__ui.detailsIdle() && __ui.detailState().position === 'Page ${String(page)} of 3'`, `page ${String(page)}`)
        }
        const times = await ui.value<string[]>(`__ui.detailRows().map((row) => row.querySelector('time').getAttribute('datetime'))`)
        if (times.length !== rows) return `page ${String(page)} has ${String(times.length)} rows, expected ${String(rows)}`
        seen.push(...times)
      }
      const all = trades.filter((trade) => trade.symbol === 'MS').map((trade) => trade.executedAt).sort().reverse()
      if (seen.join() !== all.join()) return `the three pages together are not MS's 60 trades, newest first (${String(new Set(seen).size)} different)`
      const range = await ui.value<string>(`__ui.details().querySelector('nav.pager .pager-range').textContent.trim()`)
      if (range !== '51–60 of 60 trades') return `page 3 says ${range}`
      await setPageSize(ui, 50)
      if ((await ui.value<string>('__ui.detailState().position')) !== 'Page 1 of 2') return 'size 50 does not give 2 pages'
      await ui.click(DETAIL_NEXT)
      await ui.until(`__ui.detailsIdle() && __ui.detailState().position === 'Page 2 of 2'`, 'page 2 of 2')
      await choose(ui, 'MSFT')
      const after = await ui.value<{ position: string; size: string }>('__ui.detailState()')
      if (after.position !== 'Page 1 of 1' || after.size !== '50') return `MSFT shows ${after.position} at ${after.size} a page`
      await choose(ui, 'MS')
      const requests = await ui.value<string[]>('__ui.requests("symbolMatch")')
      const want = [detailRequest('MS', 1, 25), detailRequest('MS', 2, 25), detailRequest('MS', 3, 25), detailRequest('MS', 1, 50), detailRequest('MS', 2, 50), detailRequest('MSFT', 1, 50), detailRequest('MS', 1, 50)]
      const last = requests.slice(-want.length)
      return last.join() === want.join() ? undefined : `requests ${last.join(', ')}`
    }],
    ['Sorting on the server: Price ascending, then descending, from page 1, by the exact prices; Executed at puts it back to newest first', async (ui) => {
      const price = `${DETAILS} thead th.column-price .sort-button`
      for (const [direction, sort] of [['ascending', 'asc'], ['descending', 'desc']] as const) {
        await ui.click(price)
        await ui.until(`__ui.detailsIdle() && __ui.details().querySelector('th.column-price')?.getAttribute('aria-sort') === '${direction}' && /^Page 1 of/.test(__ui.detailState().position)`, `prices ${direction}`)
        const shown = await ui.value<string[]>(`__ui.detailRows().map((row) => row.querySelector('td.price .money').dataset.exact.replace(/,/g, ''))`)
        const values = shown.map((text) => new Dec(text))
        const ordered = values.every((value, index) => index === 0 || (sort === 'asc' ? value.gte(values[index - 1] ?? value) : value.lte(values[index - 1] ?? value)))
        if (!ordered || values.length !== 50) return `${direction}: ${shown.slice(0, 5).join(', ')}…`
        const request = (await ui.value<string[]>('__ui.requests("symbolMatch")')).at(-1)
        if (request !== detailRequest('MS', 1, 50, `&sortBy=price&sortDirection=${sort}`)) return `request ${String(request)}`
      }
      await ui.click(`${DETAILS} thead th.column-executedAt .sort-button`)
      await ui.until(`__ui.detailsIdle() && __ui.details().querySelector('th.column-executedAt')?.getAttribute('aria-sort') === 'descending'`, 'newest first again')
      return undefined
    }],
    ['Two decimals in the details: every price and notional of MS to 2 places, half to even (90.125 as 90.12, 90.135 as 90.14, 270.405 as 270.40), the exact value as tooltip and for screen readers; quantities exact; the summary gives the exact average cost', async (ui) => {
      await setPageSize(ui, 100)
      const rows = await ui.value<{ time: string; quantity: string; price: { seen: string; title: string | null; heard: string }; notional: { seen: string; title: string | null; heard: string } }[]>(`__ui.detailRows().map((row) => {
        const read = (cell) => ({ seen: __ui.seen(cell), title: cell.querySelector('.money').getAttribute('title'), heard: __ui.heard(cell) })
        return { time: row.querySelector('time').getAttribute('datetime'), quantity: __ui.seen(row.querySelector('td.cell-quantity')), price: read(row.querySelector('td.price')), notional: read(row.querySelector('td.notional')) }
      })`)
      const byTime = new Map(trades.filter((trade) => trade.symbol === 'MS').map((trade) => [String(trade.executedAt), trade]))
      if (rows.length !== 60) return `${String(rows.length)} rows`
      const checked = new Set<string>()
      for (const row of rows) {
        const trade = byTime.get(row.time)
        if (trade === undefined) return `a row for no MS trade: ${row.time}`
        if (row.quantity !== group(trade.quantity.toFixed())) return `${row.time}: quantity ${row.quantity}, expected ${group(trade.quantity.toFixed())}`
        for (const [label, value, cell] of [['price', trade.price, row.price], ['notional', notional(trade), row.notional]] as const) {
          if (cell.seen !== money(value)) return `${row.time}: ${label} ${cell.seen}, expected ${money(value)}`
          const problem = exactKept(value, cell.title, cell.heard)
          if (problem !== undefined) return `${row.time} ${label}: ${problem}`
          checked.add(`${label} ${value.toFixed()} ${cell.seen}`)
        }
      }
      for (const wanted of ['price 90.125 90.12', 'price 90.135 90.14', 'notional 270.405 270.40']) {
        if (!checked.has(wanted)) return `the case ${wanted} was not among the rows`
      }
      const position = positions.find((candidate) => candidate.symbol === 'MS')
      if (position === undefined) return 'MS is not an open position'
      // Exact values unchecked: the summary's average cost is two places; the exact value only its tooltip and for screen readers.
      const cost = await ui.value<{ seen: string; title: string | null; heard: string }>(`(() => { const cell = __ui.details().querySelector('.position-summary dd.average-cost')
        return { seen: __ui.seen(cell), title: cell.querySelector('.money').getAttribute('title'), heard: __ui.heard(cell) } })()`)
      if (cost.seen !== money(position.averageCost)) return `the summary's average cost shows "${cost.seen}", expected "${money(position.averageCost)}" with Exact values unchecked`
      const kept = exactKept(position.averageCost, cost.title, cost.heard)
      return kept === undefined ? undefined : `the summary's average cost: ${kept}`
    }],
    ['Exact values by keyboard in the Trade Details: Space on the checkbox shows every rounded price and notional of MS, and the position\'s average cost above them, with its exact value beside the two-place one, whole; Space again hides them', async (ui) => {
      const problem = await pressExactValues(ui, DETAILS)
      if (problem !== undefined) return problem
      await ui.frame()
      const rows = await ui.value<{ time: string; price: string; notional: string; clipped: number }[]>(`__ui.detailRows().map((row) => {
        const price = row.querySelector('td.price'), total = row.querySelector('td.notional')
        return { time: row.querySelector('time').getAttribute('datetime'), price: __ui.seen(price), notional: __ui.seen(total),
          clipped: [price, total].filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length }
      })`)
      const byTime = new Map(trades.filter((trade) => trade.symbol === 'MS').map((trade) => [String(trade.executedAt), trade]))
      if (rows.length !== 60) return `${String(rows.length)} rows`
      for (const row of rows) {
        const trade = byTime.get(row.time)
        if (trade === undefined) return `a row for no MS trade: ${row.time}`
        if (row.price !== withExact(trade.price)) return `${row.time}: price "${row.price}", expected "${withExact(trade.price)}"`
        if (row.notional !== withExact(notional(trade))) return `${row.time}: notional "${row.notional}", expected "${withExact(notional(trade))}"`
        if (row.clipped > 0) return `${row.time}: an exact value is cut off`
      }
      if (await ui.value<number>('__ui.pageOverflow()') > 0) return 'the page scrolls sideways'
      const position = positions.find((candidate) => candidate.symbol === 'MS')
      if (position === undefined) return 'MS is not an open position'
      const summaryCost = (): Promise<string> => ui.value<string>(`__ui.seen(__ui.details().querySelector('.position-summary dd.average-cost'))`)
      const costOn = await summaryCost()
      if (costOn !== withExact(position.averageCost)) return `the summary's average cost shows "${costOn}", expected "${withExact(position.averageCost)}"`
      await ui.press(' ')
      const off = await ui.value<string[]>(`__ui.detailRows().map((row) => __ui.seen(row.querySelector('td.price')))`)
      if (!off.every((text) => !text.includes('exactly'))) return 'Space again did not hide the exact values'
      const costOff = await summaryCost()
      return costOff === money(position.averageCost) ? undefined : `Space again left the summary's average cost as "${costOff}"`
    }],
    ['Keyboard in the master grid: Tab reaches the chosen position with a visible focus; arrows, Home and End move between rows without loading; Enter and Space choose; choosing it again loads nothing', async (ui) => {
      await setPageSize(ui, 25)
      await ui.value(`__ui.master().querySelector('[role="separator"][aria-label="Resize the Average cost column"]').focus()`)
      await ui.press('Tab')
      const start = await ui.value<{ symbol: string | undefined; focus: string | undefined }>(`({ symbol: document.activeElement.dataset.symbol, focus: __ui.focusShown() })`)
      if (start.symbol !== 'MS') return `Tab reached ${String(start.symbol)}, not the chosen position MS`
      if (start.focus !== undefined) return `the row's focus: ${start.focus}`
      const before = (await ui.value<string[]>('__ui.requests("symbolMatch")')).length
      const steps: [string, string][] = [['ArrowDown', 'MSFT'], ['ArrowDown', 'MSTR'], ['ArrowUp', 'MSFT'], ['End', symbols.at(-1) ?? ''], ['Home', symbols[0] ?? ''], ['ArrowDown', 'MS'], ['ArrowDown', 'MSFT']]
      for (const [key, symbol] of steps) {
        await ui.press(key)
        const focused = await ui.value<{ symbol: string | undefined; focus: string | undefined; inView: boolean }>(`({ symbol: document.activeElement.dataset.symbol, focus: __ui.focusShown(),
          inView: (() => { const r = document.activeElement.getBoundingClientRect(); const box = __ui.master().querySelector('.grid-scroll').getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 })() })`)
        if (focused.symbol !== symbol) return `after ${key}: ${String(focused.symbol)} focused, expected ${symbol}`
        if (focused.focus !== undefined) return `after ${key}: ${focused.focus}`
        if (!focused.inView) return `after ${key}: the focused row is out of view`
      }
      if ((await ui.value<string[]>('__ui.requests("symbolMatch")')).length !== before) return 'moving between rows loaded trades'
      await ui.press('Enter')
      await ui.until(`__ui.detailsIdle() && __ui.detailState().count === '${plural(UI_DETAIL_COUNTS['MSFT'] ?? 0)}'`, 'MSFT chosen with Enter')
      await ui.press('Enter')
      await ui.press('ArrowDown')
      await ui.press(' ')
      await ui.until(`__ui.detailsIdle() && __ui.detailState().count === '${plural(UI_DETAIL_COUNTS['MSTR'] ?? 0)}'`, 'MSTR chosen with Space')
      await ui.press(' ')
      await ui.frame()
      const requests = await ui.value<string[]>('__ui.requests("symbolMatch")')
      const added = requests.slice(before)
      if (added.join() !== [detailRequest('MSFT', 1, 25), detailRequest('MSTR', 1, 25)].join()) return `requests ${added.join(', ')} (choosing a position again must load nothing)`
      const state = await ui.value<{ selected: string[] }>('__ui.detailState()')
      if (state.selected.join() !== 'MSTR') return `chosen ${state.selected.join()}`
      await ui.press('ArrowUp')
      await ui.press('ArrowUp')
      await ui.press('Enter')
      await ui.until(`__ui.detailsIdle() && __ui.detailState().heading === 'Trade Details: MS'`, 'MS chosen again')
      return undefined
    }],
    ['Columns chooser by keyboard: Enter opens it, Space hides and shows a column, Escape closes it; columns keep their order and widths, the table narrows with no gap, and Restore brings back the defaults', async (ui) => {
      await ui.value(`__ui.details().querySelector('.column-chooser > button').focus()`)
      await ui.press('Enter')
      const opened = await ui.value<{ expanded: string | null; focused: string | undefined; focus: string | undefined }>(`({
        expanded: __ui.details().querySelector('.column-chooser > button').getAttribute('aria-expanded'), focused: document.activeElement.dataset.column, focus: __ui.focusShown() })`)
      if (opened.expanded !== 'true' || opened.focused !== 'side') return `after Enter: expanded ${String(opened.expanded)}, focus on ${String(opened.focused)}`
      if (opened.focus !== undefined) return `the check box's focus: ${opened.focus}`
      const before = await detailWidths(ui)
      const tableBefore = await ui.value<number>('__ui.detailsTable().getBoundingClientRect().width')
      await ui.press(' ')
      const hidden = await ui.value<string[]>('__ui.detailHeaders()')
      if (hidden.join('|') !== 'Executed at|Quantity|Price|Notional|Symbol') return `after hiding Side: ${hidden.join(', ')}`
      const gap = await ui.value<{ table: number; columns: number }>(`({ table: __ui.detailsTable().getBoundingClientRect().width, columns: __ui.columnWidths(__ui.detailsTable()).reduce((a, b) => a + b, 0) })`)
      if (!near(gap.table, gap.columns, 2) || gap.table >= tableBefore - 10) return `the table is ${String(gap.table)} px for ${String(gap.columns)} px of columns (before: ${String(tableBefore)} px)`
      await ui.press('Escape')
      const closed = await ui.value<{ expanded: string | null; focusedButton: boolean }>(`({ expanded: __ui.details().querySelector('.column-chooser > button').getAttribute('aria-expanded'), focusedButton: document.activeElement === __ui.details().querySelector('.column-chooser > button') })`)
      if (closed.expanded !== 'false' || !closed.focusedButton) return 'Escape did not close the list and return to the Columns button'
      // A resized column keeps its width while another is hidden and shown, and while it is hidden itself.
      await ui.value(`__ui.details().querySelector('[role="separator"][aria-label="Resize the Price column"]').focus()`)
      await ui.press('ArrowRight', true)
      await ui.press('ArrowRight', true)
      const resized = await detailWidths(ui)
      if (!near(resized['Price'] ?? 0, (before['Price'] ?? 0) + 100)) return `Price ${String(before['Price'])} px to ${String(resized['Price'])} px, expected 100 px wider`
      await openColumns(ui)
      await ui.click(`${DETAILS} input[data-column="side"]`)
      await ui.click(`${DETAILS} input[data-column="price"]`)
      if ((await ui.value<string[]>('__ui.detailHeaders()')).join('|') !== 'Executed at|Side|Quantity|Notional|Symbol') return 'Side did not come back in its place, or Price did not hide'
      await ui.click(`${DETAILS} input[data-column="price"]`)
      const back = await detailWidths(ui)
      if ((await ui.value<string[]>('__ui.detailHeaders()')).join('|') !== 'Executed at|Side|Quantity|Price|Notional|Symbol') return 'columns came back out of order'
      for (const label of ['Executed at', 'Quantity', 'Price', 'Notional']) {
        if (!near(back[label] ?? 0, resized[label] ?? 0)) return `${label} was ${String(resized[label])} px and is ${String(back[label])} px after hiding and showing`
      }
      // Side was hidden when the widths were fixed: shown again, it is as wide as its contents, as it was at first.
      if (!near(back['Side'] ?? 0, before['Side'] ?? 0, 2)) return `Side was ${String(before['Side'])} px and came back ${String(back['Side'])} px`
      if (await ui.value<number>('__ui.misalignment(__ui.detailsTable())') > 1) return 'headers and cells are not aligned after hiding and showing'
      await ui.click(`${DETAILS} .column-chooser-panel .restore-columns`)
      const restored = await ui.value<{ headers: string[]; disabled: boolean }>(`({ headers: __ui.detailHeaders(), disabled: __ui.details().querySelector('.column-chooser-panel .restore-columns').getAttribute('aria-disabled') === 'true' })`)
      if (restored.headers.join('|') !== 'Executed at|Side|Quantity|Price|Notional' || !restored.disabled) return `after Restore: ${restored.headers.join(', ')}`
      await closeColumns(ui)
      return undefined
    }],
    ['Resizing by pointer after columns are hidden and restored: only the dragged column changes, headers stay aligned, it stops at its least width; Reset column widths sizes by contents again', async (ui) => {
      const before = await ui.value<number[]>('__ui.columnWidths(__ui.detailsTable())')
      await ui.drag(`${DETAILS} [role="separator"][aria-label="Resize the Notional column"]`, 60)
      const after = await ui.value<number[]>('__ui.columnWidths(__ui.detailsTable())')
      const index = 4
      if (!near(after[index] ?? 0, (before[index] ?? 0) + 60)) return `Notional ${String(before[index])} px to ${String(after[index])} px`
      if (after.some((width, at) => at !== index && !near(width, before[at] ?? 0))) return `other columns changed: ${before.join(', ')} to ${after.join(', ')}`
      if (await ui.value<number>('__ui.misalignment(__ui.detailsTable())') > 1) return 'headers and cells are not aligned'
      await ui.drag(`${DETAILS} [role="separator"][aria-label="Resize the Notional column"]`, -900)
      const least = await ui.value<number>(`Number(__ui.details().querySelector('[role="separator"][aria-label="Resize the Notional column"]').getAttribute('aria-valuemin'))`)
      if (!near((await ui.value<number[]>('__ui.columnWidths(__ui.detailsTable())'))[index] ?? 0, least)) return 'Notional went below its least width'
      const masterBefore = await ui.value<number[]>('__ui.columnWidths(__ui.masterTable())')
      await ui.drag(`${MASTER} [role="separator"][aria-label="Resize the Symbol column"]`, 40)
      const masterAfter = await ui.value<number[]>('__ui.columnWidths(__ui.masterTable())')
      if (!near(masterAfter[0] ?? 0, (masterBefore[0] ?? 0) + 40)) return `master Symbol ${String(masterBefore[0])} px to ${String(masterAfter[0])} px`
      if (await ui.value<number>('__ui.misalignment(__ui.masterTable())') > 1) return 'the master grid\'s headers and cells are not aligned'
      if ((await ui.value<string[]>('__ui.detailState().selected')).join() !== 'MS') return 'resizing changed the chosen position'
      const resetButton = await ui.value<boolean>(`[...__ui.details().querySelectorAll('.panel-actions > button')].some((b) => b.textContent.trim() === 'Reset column widths')`)
      if (!resetButton) return 'no Reset column widths button after resizing'
      await ui.value(`[...__ui.details().querySelectorAll('.panel-actions > button')].find((b) => b.textContent.trim() === 'Reset column widths').click()`)
      await ui.frame()
      const style = await ui.value<string>(`__ui.detailsTable().style.tableLayout`)
      return style === '' ? undefined : `after Reset the table layout is ${style}`
    }],
    [`A late answer for an earlier choice is dropped: MSFT's trades held back ${String(SLOW_MS)} ms, MS chosen meanwhile; MS's trades are shown, and stay when MSFT's arrive`, async (ui) => {
      control.delayFor = (url) => url.searchParams.get('symbol') === 'MSFT' ? SLOW_MS : 0
      try {
        const before = (await ui.value<string[]>('__ui.requests("symbol=MSFT&")')).length
        await ui.click(rowOf('MSFT'))
        await ui.click(rowOf('MS'))
        await ui.until(`__ui.detailsIdle() && __ui.detailState().heading === 'Trade Details: MS' && __ui.detailState().count === '60 trades'`, 'MS\'s trades')
        await ui.until(`__ui.requests('symbol=MSFT&').length > ${String(before)}`, 'MSFT\'s late answer')
        await ui.frame()
        await ui.frame()
        const state = await ui.value<{ heading: string; count: string; selected: string[]; rows: number }>('__ui.detailState()')
        const times = await ui.value<string[]>(`__ui.detailRows().map((row) => row.querySelector('time').getAttribute('datetime'))`)
        const ms = new Set(trades.filter((trade) => trade.symbol === 'MS').map((trade) => String(trade.executedAt)))
        if (state.heading !== 'Trade Details: MS' || state.count !== '60 trades' || state.selected.join() !== 'MS') return `after MSFT's answer: ${JSON.stringify(state)}`
        return times.length === 25 && times.every((time) => ms.has(time)) ? undefined : 'rows other than MS\'s are shown'
      } finally {
        control.delayFor = () => 0
      }
    }],
    ['Changing tab keeps the chosen position, its page, sort, page size and columns, and loads nothing', async (ui) => {
      await ui.click(DETAIL_NEXT)
      await ui.until(`__ui.detailsIdle() && __ui.detailState().position === 'Page 2 of 3'`, 'page 2')
      await openColumns(ui)
      await ui.click(`${DETAILS} input[data-column="createdAt"]`)
      await closeColumns(ui)
      const state = await ui.value<string>(`JSON.stringify({ detail: __ui.detailState(), headers: __ui.detailHeaders(), times: __ui.detailRows().map((r) => r.querySelector('time').getAttribute('datetime')) })`)
      const requests = await ui.value<number>('__ui.requests("^/(trades|positions)").length')
      for (const id of ['trading', 'history', 'details', 'trading', 'details']) await ui.click(`#tab-${id}`)
      const after = await ui.value<string>(`JSON.stringify({ detail: __ui.detailState(), headers: __ui.detailHeaders(), times: __ui.detailRows().map((r) => r.querySelector('time').getAttribute('datetime')) })`)
      if (after !== state) return `before: ${state}\nafter: ${after}`
      const now = await ui.value<number>('__ui.requests("^/(trades|positions)").length')
      return now === requests ? undefined : `${String(now - requests)} requests were made by changing tab`
    }],
    ...UI_CHECK_WIDTHS.map((width): Check => [`Positions & Trade Details at ${String(width)} px: ${width >= 1100 ? 'master and details side by side' : 'master above details, with a button that moves to the trades'}; no sideways page scrolling, grids scroll in their own boxes, numbers on one line, headers aligned`, async (ui) => {
      await ui.viewport(width)
      await ui.click('#tab-details')
      await ui.value('window.scrollTo(0, 0)')
      const problems: string[] = []
      const state = await ui.value<{ overflow: number; boxes: { overflowX: string; outside: number }[]; wrapped: string[]; tables: number[]; master: { left: number; right: number; top: number; bottom: number }; details: { left: number; right: number; top: number }; button: boolean }>(`({
        overflow: __ui.pageOverflow(), boxes: __ui.tableBoxes(), wrapped: __ui.wrappedNumbers(),
        tables: [...document.querySelectorAll('#panel-details .data-table')].filter(__ui.visible).map((table) => __ui.misalignment(table)),
        master: __ui.master().getBoundingClientRect().toJSON(), details: __ui.details().getBoundingClientRect().toJSON(),
        button: __ui.visible(document.querySelector('.to-details')),
      })`)
      if (state.overflow > 0) problems.push(`the page scrolls sideways by ${String(state.overflow)} px`)
      for (const box of state.boxes) {
        if (box.overflowX !== 'auto') problems.push(`a table box has overflow-x ${box.overflowX}`)
        if (box.outside > 0.5) problems.push(`a table box reaches ${String(box.outside)} px past the page`)
      }
      if (state.wrapped.length > 0) problems.push(`numbers on more than one line: ${state.wrapped.slice(0, 3).join(', ')}`)
      if (state.tables.length !== 2 || state.tables.some((gap) => gap > 1)) problems.push(`headers and cells differ by ${state.tables.join(', ')} px`)
      if (width >= 1100) {
        if (!(state.details.left >= state.master.right && near(state.details.top, state.master.top, 2))) problems.push('master and details are not side by side')
        if (state.master.right - state.master.left < 360) problems.push(`the master panel is only ${String(state.master.right - state.master.left)} px wide`)
        if (state.button) problems.push('the button to the trades shows beside them')
      } else {
        if (state.details.top < state.master.bottom) problems.push('the details are not below the master grid')
        if (!state.button) problems.push('no button leads to the trades')
      }
      const file = join(outDir, `ui-${String(width)}-details-chosen.png`)
      await ui.screenshot(file, width)
      screenshots.push(file)
      if (width < 1100) {
        await ui.click('.to-details')
        await ui.frame()
        const moved = await ui.value<{ focused: boolean; top: number; height: number }>(`({ focused: document.activeElement === document.getElementById('details-heading'), top: document.getElementById('details-heading').getBoundingClientRect().top, height: innerHeight })`)
        if (!moved.focused || moved.top < -1 || moved.top > moved.height / 2) problems.push(`the button did not move to the trades (focus ${String(moved.focused)}, heading at ${String(moved.top)} px)`)
      }
      return problems.length === 0 ? undefined : problems.join('\n')
    }]),
  ]
}

/** One grid's headers, their widths, and its Columns list: for the Show all columns checks. */
interface ChooserState {
  readonly headers: string[]
  readonly widths: Record<string, number>
  readonly count: string
  readonly disabled: string | null
  readonly open: boolean
  readonly onShowAll: boolean
  readonly onColumns: boolean
  readonly unchecked: string[]
  readonly misaligned: number
}

const chooserState = (ui: Driver, scope: string): Promise<ChooserState> => ui.value<ChooserState>(`(() => {
  const root = document.querySelector(${JSON.stringify(scope)}), table = root.querySelector('.grid-table')
  const cells = [...table.tHead.rows[0].cells]
  const name = (cell) => (cell.querySelector('.column-label') ?? cell.querySelector('.sort-button').firstChild).textContent.trim()
  const showAll = root.querySelector('.show-all-columns')
  return {
    headers: cells.map(name), widths: Object.fromEntries(cells.map((cell) => [name(cell), Math.round(cell.getBoundingClientRect().width)])),
    count: root.querySelector('.column-count').textContent.trim(), disabled: showAll.getAttribute('aria-disabled'),
    open: __ui.visible(root.querySelector('.column-chooser-panel')), onShowAll: document.activeElement === showAll,
    onColumns: document.activeElement === root.querySelector('.column-chooser > button'),
    unchecked: [...root.querySelectorAll('.column-chooser-panel input')].filter((box) => !box.checked).map((box) => box.dataset.column),
    misaligned: __ui.misalignment(table),
  }
})()`)

/**
 * Show all columns in one grid, by keyboard: a column is widened (fixing every width), some are
 * hidden, then Enter on Show all columns. Every column must come back in the grid's order with the
 * widths it had, every box checked, the count right, the list open, focus kept, and the action
 * marked unavailable; Enter again changes nothing; Escape closes and returns to Columns. With
 * `restoreHides`, Restore default columns then hides the columns hidden by default again. Leaves the
 * grid at its default columns and widths. Undefined when all of that holds.
 */
async function showAllIn(ui: Driver, scope: string, options: {
  readonly widen: string; readonly hide: readonly string[]; readonly all: readonly string[]; readonly defaults: readonly string[]; readonly picture?: string
}): Promise<string | undefined> {
  const at = (selector: string): string => `${scope} ${selector}`
  // From the grid's defaults, its list closed, whatever earlier checks left.
  await ui.value(`(() => { const root = document.querySelector(${JSON.stringify(scope)}), button = root.querySelector('.column-chooser > button')
    if (button.getAttribute('aria-expanded') === 'true') button.click()
    root.querySelector('.restore-columns').click(); return true })()`)
  await ui.frame()
  await ui.value(`document.querySelector(${JSON.stringify(at(HANDLE(options.widen)))}).focus()`)
  await ui.press('ArrowRight', true)
  const widened = await chooserState(ui, scope)
  await ui.click(at('.column-chooser > button'))
  for (const key of options.hide) await ui.click(at(`input[data-column="${key}"]`))
  const hidden = await chooserState(ui, scope)
  const total = options.all.length
  if (hidden.headers.length !== total - options.hide.length - (options.all.length - options.defaults.length)) return `after hiding ${options.hide.join(', ')}: ${hidden.headers.join(', ')}`
  if (hidden.count !== `${String(hidden.headers.length)} of ${String(total)} columns shown` || hidden.disabled !== 'false') return `before Show all: "${hidden.count}", aria-disabled ${String(hidden.disabled)}`
  await ui.value(`document.querySelector(${JSON.stringify(at('.show-all-columns'))}).focus()`)
  await ui.press('Enter')
  const shown = await chooserState(ui, scope)
  const problems: string[] = []
  if (shown.headers.join('|') !== options.all.join('|')) problems.push(`headers after Show all: ${shown.headers.join(', ')}`)
  for (const [label, width] of Object.entries(widened.widths)) {
    if (!near(shown.widths[label] ?? 0, width, 1)) problems.push(`${label} was ${String(width)} px and is ${String(shown.widths[label])} px after Show all`)
  }
  if (shown.unchecked.length > 0) problems.push(`boxes still unchecked: ${shown.unchecked.join(', ')}`)
  if (shown.count !== `${String(total)} of ${String(total)} columns shown`) problems.push(`count "${shown.count}"`)
  if (!shown.open) problems.push('the list closed')
  if (!shown.onShowAll) problems.push('focus left Show all columns')
  if (shown.disabled !== 'true') problems.push(`aria-disabled ${String(shown.disabled)} with every column shown`)
  if (shown.misaligned > 1) problems.push(`headers and cells differ by ${String(shown.misaligned)} px`)
  if (await ui.value<string | undefined>('__ui.focusShown()') !== undefined) problems.push('Show all columns does not show its focus')
  if (options.picture !== undefined) await ui.screenshot(options.picture, 1280)
  await ui.press('Enter')
  const again = await chooserState(ui, scope)
  if (again.headers.join('|') !== shown.headers.join('|') || JSON.stringify(again.widths) !== JSON.stringify(shown.widths) || !again.onShowAll || !again.open) {
    problems.push('Enter on the unavailable Show all columns changed something')
  }
  if (options.defaults.length < total) {
    await ui.click(at('.column-chooser-panel .restore-columns'))
    const restored = await chooserState(ui, scope)
    if (restored.headers.join('|') !== options.defaults.join('|') || restored.disabled !== 'false') problems.push(`after Restore default columns: ${restored.headers.join(', ')}, Show all aria-disabled ${String(restored.disabled)}`)
  }
  await ui.value(`document.querySelector(${JSON.stringify(at('.show-all-columns'))}).focus()`)
  await ui.press('Escape')
  const closed = await chooserState(ui, scope)
  if (closed.open || !closed.onColumns) problems.push('Escape did not close the list and return to the Columns button')
  // Back to the defaults for the checks that follow.
  await ui.value(`(() => { const root = document.querySelector(${JSON.stringify(scope)}); root.querySelector('.restore-columns').click(); [...root.querySelectorAll('.panel-actions > button')].find((b) => b.textContent.trim() === 'Reset column widths')?.click(); return true })()`)
  await ui.frame()
  const after = await chooserState(ui, scope)
  if (after.headers.join('|') !== options.defaults.join('|')) problems.push(`left with ${after.headers.join(', ')}`)
  return problems.length === 0 ? undefined : problems.join('\n')
}

/** One grid's Restore default columns button and what it governs: for the keyboard-focus check. */
interface RestoreState {
  readonly headers: string[]
  readonly disabled: string | null
  readonly nativeDisabled: boolean
  readonly showAllDisabled: string | null
  readonly open: boolean
  readonly onRestore: boolean
  readonly onColumns: boolean
  readonly count: string
}

const restoreState = (ui: Driver, scope: string): Promise<RestoreState> => ui.value<RestoreState>(`(() => {
  const root = document.querySelector(${JSON.stringify(scope)}), restore = root.querySelector('.restore-columns')
  const name = (cell) => (cell.querySelector('.column-label') ?? cell.querySelector('.sort-button').firstChild).textContent.trim()
  return {
    headers: [...root.querySelector('.grid-table').tHead.rows[0].cells].map(name),
    disabled: restore.getAttribute('aria-disabled'), nativeDisabled: restore.disabled,
    showAllDisabled: root.querySelector('.show-all-columns').getAttribute('aria-disabled'),
    open: __ui.visible(root.querySelector('.column-chooser-panel')), onRestore: document.activeElement === restore,
    onColumns: document.activeElement === root.querySelector('.column-chooser > button'),
    count: root.querySelector('.column-count').textContent.trim(),
  }
})()`)

/**
 * Restore default columns in one grid, by keyboard. At the defaults it is aria-disabled (never
 * natively disabled, so it keeps focus) and Enter and Space do nothing. After columns are changed
 * (`change`: the boxes to click, and Show all columns when `showAll`), Space on it restores the
 * defaults, focus stays on it and it becomes aria-disabled; Enter and Space then change nothing,
 * and Escape closes the list and returns to the Columns button. Undefined when all of that holds.
 */
async function restoreIn(ui: Driver, scope: string, options: { readonly change: readonly string[]; readonly showAll?: boolean; readonly defaults: readonly string[] }): Promise<string | undefined> {
  const at = (selector: string): string => `${scope} ${selector}`
  const same = (a: RestoreState, b: RestoreState): boolean => a.headers.join('|') === b.headers.join('|') && a.count === b.count
  await ui.value(`(() => { const root = document.querySelector(${JSON.stringify(scope)}), button = root.querySelector('.column-chooser > button')
    if (button.getAttribute('aria-expanded') === 'true') button.click()
    root.querySelector('.restore-columns').click(); return true })()`)
  await ui.frame()
  await ui.click(at('.column-chooser > button'))
  const focusRestore = (): Promise<unknown> => ui.value(`document.querySelector(${JSON.stringify(at('.restore-columns'))}).focus()`)
  const problems: string[] = []

  await focusRestore()
  const atDefaults = await restoreState(ui, scope)
  if (atDefaults.headers.join('|') !== options.defaults.join('|')) return `not at the defaults to start: ${atDefaults.headers.join(', ')}`
  if (atDefaults.disabled !== 'true' || atDefaults.nativeDisabled) problems.push(`at the defaults: aria-disabled ${String(atDefaults.disabled)}, disabled ${String(atDefaults.nativeDisabled)}`)
  if (!atDefaults.onRestore) problems.push('Restore default columns cannot take focus at the defaults')
  for (const key of ['Enter', ' ']) {
    await ui.press(key)
    const after = await restoreState(ui, scope)
    if (!same(after, atDefaults) || !after.onRestore || !after.open) problems.push(`${key === ' ' ? 'Space' : key} on the unavailable Restore default columns changed something`)
  }

  for (const key of options.change) await ui.click(at(`input[data-column="${key}"]`))
  if (options.showAll === true) await ui.click(at('.show-all-columns'))
  const changed = await restoreState(ui, scope)
  if (changed.disabled !== 'false') problems.push(`after changing the columns: aria-disabled ${String(changed.disabled)}`)

  await focusRestore()
  await ui.press(' ')
  const restored = await restoreState(ui, scope)
  if (restored.headers.join('|') !== options.defaults.join('|')) problems.push(`after Space on Restore default columns: ${restored.headers.join(', ')}`)
  if (!restored.onRestore) problems.push('focus left Restore default columns when it became unavailable')
  if (restored.disabled !== 'true' || restored.nativeDisabled) problems.push(`after restoring: aria-disabled ${String(restored.disabled)}, disabled ${String(restored.nativeDisabled)}`)
  if (!restored.open) problems.push('the list closed')
  if (restored.showAllDisabled !== (options.showAll === true ? 'false' : 'true')) problems.push(`Show all columns aria-disabled ${String(restored.showAllDisabled)} after restoring`)
  if (await ui.value<string | undefined>('__ui.focusShown()') !== undefined) problems.push('Restore default columns does not show its focus')
  for (const key of ['Enter', ' ']) {
    await ui.press(key)
    const after = await restoreState(ui, scope)
    if (!same(after, restored) || !after.onRestore || !after.open) problems.push(`${key === ' ' ? 'Space' : key} again on Restore default columns changed something`)
  }

  await ui.press('Escape')
  const closed = await restoreState(ui, scope)
  if (closed.open || !closed.onColumns) problems.push('Escape did not close the list and return to the Columns button')
  return problems.length === 0 ? undefined : problems.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The grids on the benchmark dataset

const TRADING_GRID = '#panel-trading .positions-scroll'
const MASTER_GRID = `${MASTER} .grid-scroll`

/**
 * The Positions grids at the benchmark's scale: its 25,000 trades, as the seed generator makes them
 * (a copy of their own, never the reviewer's database), with 167 open positions. Every expectation
 * comes from the generator and the domain's position rules, not from the page.
 */
function benchmarkChecks(screenshots: string[], outDir: string): Check[] {
  const trades = generateTrades(BENCHMARK_COUNT, BENCHMARK_SEED)
  const positions = calculatePositions(trades.map((trade, index) => ({ ...trade, bookingSequence: index + 1 })))
  const symbols = positions.map((position) => position.symbol)
  const perSymbol = new Map<string, number>()
  for (const trade of trades) perSymbol.set(trade.symbol, (perSymbol.get(trade.symbol) ?? 0) + 1)
  const middle = Math.floor(symbols.length / 2)
  const plural = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'trade' : 'trades'}`
  /** The rows wholly in view in a grid's box, under its header: their symbols. */
  const inView = (grid: string): string => `(() => {
    const box = document.querySelector(${JSON.stringify(grid)}), table = box.querySelector('table')
    const top = table.tHead.rows[0].cells[0].getBoundingClientRect().bottom, bottom = box.getBoundingClientRect().top + box.clientTop + box.clientHeight
    return [...table.tBodies[0].rows].filter((row) => { const r = row.getBoundingClientRect(); return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 }).map((row) => row.cells[0].textContent.trim())
  })()`
  const inViewCount = `(grid) => { const box = document.querySelector(grid), table = box.querySelector('table')
    const top = table.tHead.rows[0].cells[0].getBoundingClientRect().bottom, bottom = box.getBoundingClientRect().top + box.clientTop + box.clientHeight
    return [...table.tBodies[0].rows].filter((row) => { const r = row.getBoundingClientRect(); return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 }).length }`
  const headerPinned = (grid: string): string => `(() => { const box = document.querySelector(${JSON.stringify(grid)}); return Math.abs(box.querySelector('thead th').getBoundingClientRect().top - (box.getBoundingClientRect().top + box.clientTop)) <= 1 })()`
  const settle = async (ui: Driver, grid: string): Promise<void> => {
    // Smooth scrolling ends when scrollTop stops changing for two frames.
    await ui.until(`(() => { const box = document.querySelector(${JSON.stringify(grid)}); const now = box.scrollTop + ',' + box.scrollLeft; const same = window.__lastScroll === now; window.__lastScroll = now; return same })()`, 'scrolling to stop')
    await ui.frame()
  }
  const chooseDetails = async (ui: Driver, symbol: string): Promise<void> => {
    await ui.until(`__ui.detailsIdle() && __ui.detailState().heading === ${JSON.stringify(`Trade Details: ${symbol}`)} && __ui.detailState().count === ${JSON.stringify(plural(perSymbol.get(symbol) ?? 0))}`, `${symbol}'s trades`)
  }

  return [
    [`Benchmark data: the Trading Positions grid lists all ${String(symbols.length)} open positions, by symbol, as calculated from the 25,000 trades; exactly 25 wholly in view; the rest scroll inside the box`, async (ui) => {
      await ui.viewport(1280)
      await ui.click('#tab-trading')
      const state = await ui.value<{ rows: string[]; visible: string[]; scrolls: boolean; pageScrolls: boolean }>(`({
        rows: [...document.querySelectorAll('#panel-trading .positions-table tbody tr')].map((row) => row.cells[0].textContent.trim()),
        visible: ${inView(TRADING_GRID)}, scrolls: document.querySelector('${TRADING_GRID}').scrollHeight > document.querySelector('${TRADING_GRID}').clientHeight,
        pageScrolls: __ui.pageOverflow() > 0,
      })`)
      if (symbols.length < 120) return `the benchmark has only ${String(symbols.length)} open positions`
      if (state.rows.join() !== symbols.join()) return `rows ${String(state.rows.length)}, expected ${String(symbols.length)} in the API's order`
      if (state.visible.length !== 25 || state.visible[0] !== symbols[0]) return `${String(state.visible.length)} rows wholly in view, from ${String(state.visible[0])}`
      const cells = await ui.value<string[][]>(`[...document.querySelectorAll('#panel-trading .positions-table tbody tr')].map((row) => [...row.cells].map((cell) => __ui.seen(cell)))`)
      for (const [index, position] of positions.entries()) {
        const net = position.netQuantity.toFixed()
        const want = [position.symbol, net.startsWith('-') ? 'Short' : 'Long', group(net), money(position.averageCost)]
        if (cells[index]?.join('|') !== want.join('|')) return `${position.symbol}: ${String(cells[index]?.join(' | '))}, expected ${want.join(' | ')}`
      }
      return state.scrolls && !state.pageScrolls ? undefined : 'the grid does not scroll in its own box'
    }],
    ['Benchmark data, keyboard: the focused grid moves from the first positions to the middle (Page Down) and the last (End) and back (Home), with the header pinned at the top', async (ui) => {
      await ui.value(`document.querySelector('${TRADING_GRID}').focus()`)
      const pages: string[][] = []
      for (let press = 0; press < 3; press++) {
        await ui.press('PageDown')
        await settle(ui, TRADING_GRID)
        pages.push(await ui.value<string[]>(inView(TRADING_GRID)))
      }
      const reached = pages.flat()
      if (!reached.includes(symbols[middle] ?? '')) return `Page Down three times did not reach the middle position ${String(symbols[middle])} (in view: ${String(pages.at(-1)?.[0])} to ${String(pages.at(-1)?.at(-1))})`
      if (!(await ui.value<boolean>(headerPinned(TRADING_GRID)))) return 'the header moved with the rows'
      await ui.press('End')
      await settle(ui, TRADING_GRID)
      const end = await ui.value<string[]>(inView(TRADING_GRID))
      if (end.at(-1) !== symbols.at(-1) || end.length !== 25) return `after End: ${String(end[0])} to ${String(end.at(-1))}`
      if (!(await ui.value<boolean>(headerPinned(TRADING_GRID)))) return 'the header moved with the rows at the end'
      await ui.press('Home')
      await settle(ui, TRADING_GRID)
      const start = await ui.value<string[]>(inView(TRADING_GRID))
      if (start[0] !== symbols[0]) return `after Home: ${String(start[0])}`
      const focus = await ui.value<string | undefined>('__ui.focusShown()')
      return focus === undefined ? undefined : `the grid's focus: ${focus}`
    }],
    ['Benchmark data, mouse: the wheel over the grid scrolls it to the middle and to the last position; the page itself stays where it is', async (ui) => {
      await ui.value(`document.querySelector('${TRADING_GRID}').scrollIntoView({ block: 'nearest' })`)
      const pageTop = await ui.value<number>('window.scrollY')
      await ui.wheel(TRADING_GRID, 0, 34 * (middle - 12))
      await settle(ui, TRADING_GRID)
      const centre = await ui.value<string[]>(inView(TRADING_GRID))
      if (!centre.includes(symbols[middle] ?? '')) return `after scrolling to the middle: ${String(centre[0])} to ${String(centre.at(-1))}, without ${String(symbols[middle])}`
      await ui.wheel(TRADING_GRID, 0, 34 * symbols.length)
      await settle(ui, TRADING_GRID)
      const end = await ui.value<string[]>(inView(TRADING_GRID))
      if (end.at(-1) !== symbols.at(-1)) return `after scrolling to the end: the last row in view is ${String(end.at(-1))}`
      if (!(await ui.value<boolean>(headerPinned(TRADING_GRID)))) return 'the header moved with the rows'
      if (await ui.value<number>('window.scrollY') !== pageTop) return 'the page scrolled with the grid'
      await ui.wheel(TRADING_GRID, 0, -34 * symbols.length)
      await settle(ui, TRADING_GRID)
      return undefined
    }],
    [`Benchmark data at 768 px: the Trading grid, given the page's width below the form, fits it with every column, so it scrolls only up and down; nothing is widened to make it scroll sideways`, async (ui) => {
      await ui.viewport(768)
      await ui.click('#tab-trading')
      const box = await ui.value<{ wider: number; taller: number; overflow: number; columns: number }>(`(() => { const b = document.querySelector('${TRADING_GRID}'); return { wider: b.scrollWidth - b.clientWidth, taller: b.scrollHeight - b.clientHeight, overflow: __ui.pageOverflow(), columns: b.querySelector('thead tr').cells.length } })()`)
      if (box.columns !== 4) return `${String(box.columns)} columns shown`
      if (box.wider > 0) return `the grid is ${String(box.wider)} px wider than its box at 768 px`
      if (box.taller <= 0) return 'the grid does not scroll up and down'
      return box.overflow > 0 ? `the page scrolls sideways by ${String(box.overflow)} px` : undefined
    }],
    ...([390] as const).map((width): Check => [`Benchmark data at ${String(width)} px: the grid is wider than its box with real values, so it scrolls sideways and up and down, each without moving the other; the header stays pinned and aligned`, async (ui) => {
      await ui.viewport(width)
      await ui.click('#tab-trading')
      await ui.value(`document.querySelector('${TRADING_GRID}').scrollIntoView({ block: 'start' })`)
      const box = await ui.value<{ wider: number; taller: number; overflow: number }>(`(() => { const b = document.querySelector('${TRADING_GRID}'); return { wider: b.scrollWidth - b.clientWidth, taller: b.scrollHeight - b.clientHeight, overflow: __ui.pageOverflow() } })()`)
      if (box.wider <= 0) return `the grid fits its box at ${String(width)} px; nothing to scroll sideways`
      if (box.taller <= 0) return 'the grid does not scroll up and down'
      if (box.overflow > 0) return `the page scrolls sideways by ${String(box.overflow)} px`
      await ui.wheel(TRADING_GRID, 0, 34 * 60)
      await settle(ui, TRADING_GRID)
      const down = await ui.value<{ top: number; left: number }>(`(() => { const b = document.querySelector('${TRADING_GRID}'); return { top: b.scrollTop, left: b.scrollLeft } })()`)
      if (down.top <= 0 || down.left !== 0) return `scrolling down moved it to ${String(down.left)}, ${String(down.top)}`
      await ui.wheel(TRADING_GRID, box.wider, 0)
      await settle(ui, TRADING_GRID)
      const across = await ui.value<{ top: number; left: number }>(`(() => { const b = document.querySelector('${TRADING_GRID}'); return { top: b.scrollTop, left: b.scrollLeft } })()`)
      if (across.left <= 0 || across.top !== down.top) return `scrolling sideways moved it from ${String(down.left)}, ${String(down.top)} to ${String(across.left)}, ${String(across.top)}`
      if (!(await ui.value<boolean>(headerPinned(TRADING_GRID)))) return 'the header moved with the rows'
      const misalignment = await ui.value<number>(`__ui.misalignment(document.querySelector('${TRADING_GRID} table'))`)
      if (misalignment > 1) return `scrolled both ways, headers and cells differ by ${String(misalignment)} px`
      if (await ui.value<number>('__ui.pageOverflow()') > 0) return 'the page scrolls sideways'
      const file = join(outDir, `ui-${String(width)}-benchmark-trading.png`)
      await ui.screenshot(file, width)
      screenshots.push(file)
      await ui.value(`(() => { const b = document.querySelector('${TRADING_GRID}'); b.scrollTop = 0; b.scrollLeft = 0; return true })()`)
      return undefined
    }]),
    ['Benchmark data: hiding columns narrows the grid with no blank space, showing them puts them back in order; resizing keeps its least width and the header aligned while scrolled', async (ui) => {
      await ui.viewport(1280)
      await ui.click('#tab-trading')
      const widthOf = `(() => { const t = document.querySelector('${TRADING_GRID} table'); return { table: t.getBoundingClientRect().width, columns: __ui.columnWidths(t).reduce((a, b) => a + b, 0), headers: [...t.tHead.rows[0].cells].map((c) => c.querySelector('.column-label').textContent.trim()) } })()`
      const before = await ui.value<{ table: number; columns: number; headers: string[] }>(widthOf)
      await ui.click('#panel-trading .column-chooser > button')
      await ui.click('#panel-trading input[data-column="direction"]')
      await ui.click('#panel-trading input[data-column="netQuantity"]')
      const hidden = await ui.value<{ table: number; columns: number; headers: string[] }>(widthOf)
      if (hidden.headers.join('|') !== 'Symbol|Average cost') return `headers ${hidden.headers.join(', ')}`
      if (!near(hidden.table, hidden.columns, 2) || hidden.table >= before.table - 100) return `the table is ${String(hidden.table)} px for ${String(hidden.columns)} px of columns (was ${String(before.table)} px)`
      await ui.click('#panel-trading .column-chooser-panel .restore-columns')
      await ui.press('Escape')
      const back = await ui.value<{ table: number; headers: string[] }>(widthOf)
      if (back.headers.join('|') !== before.headers.join('|') || !near(back.table, before.table, 2)) return `after Restore: ${back.headers.join(', ')}, ${String(back.table)} px`
      await ui.wheel(TRADING_GRID, 0, 34 * middle)
      await settle(ui, TRADING_GRID)
      await ui.drag(`#panel-trading ${HANDLE('Net quantity')}`, -900)
      const least = await ui.value<number>(`Number(document.querySelector('#panel-trading ${HANDLE('Net quantity')}').getAttribute('aria-valuemin'))`)
      const widths = await ui.value<number[]>(`__ui.columnWidths(document.querySelector('${TRADING_GRID} table'))`)
      if (!near(widths[2] ?? 0, least)) return `Net quantity is ${String(widths[2])} px; its least width is ${String(least)} px`
      if (await ui.value<number>(`__ui.misalignment(document.querySelector('${TRADING_GRID} table'))`) > 1) return 'headers and cells are not aligned after resizing'
      await ui.click('#panel-trading .panel-actions > button')
      await ui.value(`document.querySelector('${TRADING_GRID}').scrollTop = 0`)
      return (await ui.value<string>(`document.querySelector('${TRADING_GRID} table').style.tableLayout`)) === '' ? undefined : 'Reset column widths did not size the columns by their contents again'
    }],
    [`Benchmark data, master-detail: scrolled to the last position (End) and the middle one (Page Down) with the keyboard, and one chosen with the mouse after scrolling, each shows exactly its own trades, counted as the generator made them`, async (ui) => {
      await ui.click('#tab-details')
      await ui.value(`__ui.master().querySelector('tbody th[tabindex="0"]').focus()`)
      await ui.press('End')
      await settle(ui, MASTER_GRID)
      const last = symbols.at(-1) ?? ''
      if ((await ui.value<string | undefined>('document.activeElement.dataset.symbol')) !== last) return `End did not reach ${last}`
      if (!(await ui.value<string[]>(inView(MASTER_GRID))).includes(last)) return `${last} is focused but out of view`
      await ui.press('Enter')
      await chooseDetails(ui, last)
      await ui.press('Home')
      for (let press = 0; press < Math.floor(middle / 25); press++) await ui.press('PageDown')
      await settle(ui, MASTER_GRID)
      const focused = await ui.value<string | undefined>('document.activeElement.dataset.symbol')
      if (focused === undefined || focused !== symbols[Math.floor(middle / 25) * 25]) return `Page Down reached ${String(focused)}, expected ${String(symbols[Math.floor(middle / 25) * 25])}`
      await ui.press(' ')
      await chooseDetails(ui, focused)
      // The mouse: scroll the master with the wheel, then click a row that was out of view.
      await ui.wheel(MASTER_GRID, 0, -34 * symbols.length)
      await settle(ui, MASTER_GRID)
      const target = symbols[middle + 7] ?? ''
      await ui.wheel(MASTER_GRID, 0, 34 * (middle + 2))
      await settle(ui, MASTER_GRID)
      if (!(await ui.value<string[]>(inView(MASTER_GRID))).includes(target)) return `${target} is not in view after scrolling`
      await ui.value(`window.__clickTarget = [...__ui.masterRows()].find((row) => row.cells[0].textContent.trim() === ${JSON.stringify(target)})`)
      const [x, y] = await ui.value<[number, number]>('(() => { const r = window.__clickTarget.cells[0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()')
      await ui.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await ui.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await chooseDetails(ui, target)
      const requests = (await ui.value<string[]>('__ui.requests("symbolMatch")')).slice(-3)
      const want = [last, focused, target].map((symbol) => detailRequest(symbol, 1, 25))
      return requests.join() === want.join() ? undefined : `requests ${requests.join(', ')}`
    }],
    ['Benchmark data, master-detail: MSFT\'s trades on the server, never MS\'s or MSTR\'s: every page through Next, sorted by price on the server, totals as generated', async (ui) => {
      await ui.value(`[...__ui.masterRows()].find((row) => row.cells[0].textContent.trim() === 'MSFT').scrollIntoView({ block: 'center' })`)
      await settle(ui, MASTER_GRID)
      await ui.click(`${MASTER} tbody tr:nth-child(${String(symbols.indexOf('MSFT') + 1)}) th`)
      await chooseDetails(ui, 'MSFT')
      const count = perSymbol.get('MSFT') ?? 0
      const pages = Math.ceil(count / 25)
      if (count <= 100) return `MSFT has only ${String(count)} trades in the benchmark`
      await openDetailsColumn(ui, 'symbol')
      const seen = new Set<string>()
      for (let page = 1; page <= pages; page++) {
        if (page > 1) {
          await ui.click(DETAIL_NEXT)
          await ui.until(`__ui.detailsIdle() && __ui.detailState().position === 'Page ${String(page)} of ${String(pages)}'`, `page ${String(page)}`)
        }
        const rows = await ui.value<{ symbol: string; time: string }[]>(`__ui.detailRows().map((row) => ({ symbol: row.querySelector('td.cell-symbol').textContent.trim(), time: row.querySelector('time').getAttribute('datetime') }))`)
        if (rows.some((row) => row.symbol !== 'MSFT')) return `page ${String(page)} lists ${[...new Set(rows.map((row) => row.symbol))].join(', ')}`
        for (const row of rows) seen.add(`${row.time} ${String(seen.size)}`)
        if (rows.length !== Math.min(25, count - (page - 1) * 25)) return `page ${String(page)} has ${String(rows.length)} rows`
      }
      if (seen.size !== count) return `${String(seen.size)} rows on ${String(pages)} pages, expected ${String(count)}`
      await ui.click(`${DETAILS} thead th.column-price .sort-button`)
      await ui.until(`__ui.detailsIdle() && __ui.details().querySelector('th.column-price')?.getAttribute('aria-sort') === 'ascending' && /^Page 1 of/.test(__ui.detailState().position)`, 'MSFT by price')
      const prices = (await ui.value<string[]>(`__ui.detailRows().map((row) => row.querySelector('td.price .money').dataset.exact.replace(/,/g, ''))`)).map((text) => new Dec(text))
      const lowest = trades.filter((trade) => trade.symbol === 'MSFT').map((trade) => trade.price).sort((a, b) => a.comparedTo(b)).slice(0, 25)
      if (prices.map((price) => price.toFixed()).join() !== lowest.map((price) => price.toFixed()).join()) return `the first page by price is not MSFT's 25 lowest prices: ${prices.slice(0, 3).map((price) => price.toFixed()).join(', ')}…`
      const request = (await ui.value<string[]>('__ui.requests("symbolMatch")')).at(-1)
      return request === detailRequest('MSFT', 1, 25, '&sortBy=price&sortDirection=asc') ? undefined : `request ${String(request)}`
    }],
    ...([1280, 768, 390] as const).map((width): Check => [`Benchmark data at ${String(width)} px: both Positions grids read "Total: ${String(symbols.length)} positions", every open position however many rows are in view, readable just above the grid`, async (ui) => {
      await ui.viewport(width)
      const want = `Total: ${symbols.length.toLocaleString('en-US')} positions`
      const problems: string[] = []
      for (const [tab, grid] of [['trading', TRADING_GRID], ['details', MASTER_GRID]] as const) {
        await ui.click(`#tab-${tab}`)
        const seen = await ui.value<{ text: string; shown: boolean; cut: boolean; inside: boolean; gap: number; rows: number }>(`(() => {
          const box = document.querySelector(${JSON.stringify(grid)}), total = box.closest('section').querySelector('.positions-total')
          const r = total.getBoundingClientRect(), b = box.getBoundingClientRect()
          return { text: total.textContent.trim(), shown: __ui.visible(total) && r.width > 0, cut: total.scrollWidth > total.clientWidth + 0.5,
            inside: r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5, gap: b.top - r.bottom, rows: box.querySelectorAll('tbody tr').length }
        })()`)
        if (seen.text !== want) problems.push(`${tab}: "${seen.text}", expected "${want}"`)
        if (!seen.shown || seen.cut || !seen.inside) problems.push(`${tab}: the total is not wholly readable`)
        if (seen.gap < 0 || seen.gap > 24) problems.push(`${tab}: the total is ${String(Math.round(seen.gap))} px above the grid`)
        if (seen.rows !== symbols.length) problems.push(`${tab}: ${String(seen.rows)} rows`)
        if (width === 1280) {
          const inView = await ui.value<number>(`(${inViewCount})(${JSON.stringify(grid)})`)
          if (inView !== VISIBLE_POSITIONS) problems.push(`${tab}: ${String(inView)} rows in view, so the total is not the rows shown`)
        }
      }
      return problems.length === 0 ? undefined : problems.join('\n')
    }]),
    ['Benchmark data: Show all columns, by keyboard, in the Trading Positions grid, the Open positions grid and Trade Details: every column back in its place with its width, boxes and count updated, the list open with focus kept, then unavailable; Restore default columns hides Trade Details\' default-hidden columns again', async (ui) => {
      await ui.viewport(1280)
      await ui.click('#tab-trading')
      const all = ['Symbol', 'Direction', 'Net quantity', 'Average cost']
      const trading = await showAllIn(ui, '#panel-trading section.positions-panel', { widen: 'Direction', hide: ['direction', 'netQuantity'], all, defaults: all })
      if (trading !== undefined) return `Trading: ${trading}`
      await ui.click('#tab-details')
      const master = await showAllIn(ui, MASTER, { widen: 'Average cost', hide: ['averageCost', 'direction'], all, defaults: all })
      if (master !== undefined) return `Open positions: ${master}`
      if (await ui.value<string>('__ui.detailState().heading') !== 'Trade Details: MSFT') return 'MSFT is no longer chosen'
      const details = await showAllIn(ui, DETAILS, {
        widen: 'Price', hide: ['side'],
        all: ['Executed at', 'Side', 'Quantity', 'Price', 'Notional', 'Symbol', 'Created at', 'Updated at', 'Booking sequence', 'Trade ID'],
        defaults: ['Executed at', 'Side', 'Quantity', 'Price', 'Notional'],
        picture: join(outDir, 'ui-1280-benchmark-show-all-columns.png'),
      })
      if (details !== undefined) return `Trade Details: ${details}`
      screenshots.push(join(outDir, 'ui-1280-benchmark-show-all-columns.png'))
      const requests = await ui.value<string[]>('__ui.requests("symbolMatch")')
      return requests.at(-1) === detailRequest('MSFT', 1, 25, '&sortBy=price&sortDirection=asc') ? undefined : `showing columns sent ${String(requests.at(-1))}`
    }],
    ['Benchmark data: Restore default columns, by keyboard, in the Trading Positions grid, the Open positions grid and Trade Details: aria-disabled at the defaults and still focusable, Enter and Space then do nothing; Space restores the defaults (Trade Details\' hidden ones hidden again) and focus stays on it; Escape then closes the list and returns to Columns', async (ui) => {
      await ui.viewport(1280)
      await ui.click('#tab-trading')
      const positions = ['Symbol', 'Direction', 'Net quantity', 'Average cost']
      const trading = await restoreIn(ui, '#panel-trading section.positions-panel', { change: ['direction', 'averageCost'], defaults: positions })
      if (trading !== undefined) return `Trading: ${trading}`
      await ui.click('#tab-details')
      const master = await restoreIn(ui, MASTER, { change: ['netQuantity'], defaults: positions })
      if (master !== undefined) return `Open positions: ${master}`
      const details = await restoreIn(ui, DETAILS, { change: ['side'], showAll: true, defaults: ['Executed at', 'Side', 'Quantity', 'Price', 'Notional'] })
      if (details !== undefined) return `Trade Details: ${details}`
      return (await ui.value<string>('__ui.detailState().heading')) === 'Trade Details: MSFT' ? undefined : 'MSFT is no longer chosen'
    }],
    ...UI_CHECK_WIDTHS.map((width): Check => [`Benchmark data at ${String(width)} px: Positions & Trade Details with no sideways page scrolling, both grids scrolling in their own boxes, headers aligned; Trading and Trade History without sideways page scrolling either (a picture of each tab)`, async (ui) => {
      await ui.viewport(width)
      await ui.click('#tab-details')
      await ui.value('window.scrollTo(0, 0)')
      const state = await ui.value<{ overflow: number; boxes: { overflowX: string; outside: number }[]; tables: number[]; masterTaller: boolean }>(`({
        overflow: __ui.pageOverflow(), boxes: __ui.tableBoxes(),
        tables: [...document.querySelectorAll('#panel-details .data-table')].filter(__ui.visible).map((table) => __ui.misalignment(table)),
        masterTaller: document.querySelector('${MASTER_GRID}').scrollHeight > document.querySelector('${MASTER_GRID}').clientHeight,
      })`)
      const problems: string[] = []
      if (state.overflow > 0) problems.push(`the page scrolls sideways by ${String(state.overflow)} px`)
      if (state.boxes.some((box) => box.overflowX !== 'auto' || box.outside > 0.5)) problems.push('a grid box does not scroll on its own, or reaches past the page')
      if (state.tables.length !== 2 || state.tables.some((gap) => gap > 1)) problems.push(`headers and cells differ by ${state.tables.join(', ')} px`)
      if (!state.masterTaller) problems.push('the master grid does not scroll up and down')
      if (width === 1280) {
        // Side by side, the master takes the width its grid needs (its help text does not widen it),
        // and the details take all the rest of the row.
        await ui.click(`${DETAILS} .column-chooser > button`)
        if (!(await ui.value<boolean>(`__ui.details().querySelector('.column-chooser-panel .restore-columns').getAttribute('aria-disabled') === 'true'`))) await ui.click(`${DETAILS} .column-chooser-panel .restore-columns`)
        await ui.click(`${DETAILS} .column-chooser > button`)
        const fit = await ui.value<{ master: number; masterGrid: number; detailsLeft: number; detailsRight: number; row: number; open: boolean; headers: string[] }>(`({
          master: __ui.master().getBoundingClientRect().width,
          // The table itself and the box's vertical scroll bar: the box stretches to the panel, the table does not.
          masterGrid: (() => { const box = document.querySelector('${MASTER_GRID}'); return box.querySelector('table').getBoundingClientRect().width + (box.offsetWidth - box.clientWidth) })(),
          detailsLeft: __ui.details().getBoundingClientRect().left, detailsRight: __ui.details().getBoundingClientRect().right,
          row: document.querySelector('.master-detail').getBoundingClientRect().right, open: __ui.visible(__ui.details().querySelector('.column-chooser-panel')),
          headers: __ui.detailHeaders(),
        })`)
        if (fit.open) problems.push('the Columns list did not close')
        if (fit.headers.join('|') !== 'Executed at|Side|Quantity|Price|Notional') problems.push(`details columns ${fit.headers.join(', ')}`)
        // The panel's padding (2 × 18 px) and border, around the grid's box.
        if (fit.master > fit.masterGrid + 40) problems.push(`the master panel is ${String(Math.round(fit.master))} px wide for a ${String(Math.round(fit.masterGrid))} px grid`)
        if (!near(fit.detailsRight, fit.row, 1)) problems.push('the details do not reach the end of the row')
      }
      // Earlier clicks scrolled the grids sideways to reach a header; the picture shows them from their first column.
      await ui.value(`[...document.querySelectorAll('#panel-details .grid-scroll')].forEach((box) => { box.scrollLeft = 0 })`)
      const file = join(outDir, `ui-${String(width)}-benchmark-details.png`)
      await ui.screenshot(file, width)
      screenshots.push(file)
      // The other two tabs on the same data, for a full set of pictures at this width.
      for (const tab of ['trading', 'history'] as const) {
        await ui.click(`#tab-${tab}`)
        await ui.value('window.scrollTo(0, 0)')
        if (await ui.value<number>('__ui.pageOverflow()') > 0) problems.push(`${tab}: the page scrolls sideways`)
        const shot = join(outDir, `ui-${String(width)}-benchmark-${tab}.png`)
        await ui.screenshot(shot, width)
        if (!screenshots.includes(shot)) screenshots.push(shot)
      }
      await ui.click('#tab-details')
      return problems.length === 0 ? undefined : problems.join('\n')
    }]),
  ]
}

/** Shows a Trade Details column with the Columns control, and closes it again. */
async function openDetailsColumn(ui: Driver, key: string): Promise<void> {
  await ui.click(`${DETAILS} .column-chooser > button`)
  const checked = await ui.value<boolean>(`__ui.details().querySelector('input[data-column="${key}"]').checked`)
  if (!checked) await ui.click(`${DETAILS} input[data-column="${key}"]`)
  await ui.value(`__ui.details().querySelector('.column-chooser-panel input:not(:disabled)').focus()`)
  await ui.press('Escape')
}

/** Runs every check in one page; a check that fails is reported and the next one runs. */
export async function runUiChecks(options: { readonly chrome: string; readonly outDir: string; readonly clientDist?: string; readonly onCheck?: (result: UiCheckResult) => void }): Promise<UiCheckRun> {
  const dist = options.clientDist ?? join(REPOSITORY_ROOT, 'client', 'dist')
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`The built frontend is missing (${join(dist, 'index.html')}); run npm run build first.`)
  mkdirSync(options.outDir, { recursive: true })
  const work = mkdtempSync(join(options.outDir, 'db-'))
  const apps: { close(): Promise<void> }[] = []
  let browser: Browser | undefined
  /** The API on a database of its own, and the built frontend in front of it; both closed at the end. */
  const serve = async (write: (path: string) => void, name: string, delayFor?: (url: URL) => number): Promise<string> => {
    const databasePath = join(work, `${name}.db`)
    write(databasePath)
    const api = await createServer(loadConfig({ DATABASE_PATH: databasePath, LOG_LEVEL: 'fatal' }), { logger: false })
    apps.push({ close: () => api.close() })
    await api.listen({ host: '127.0.0.1', port: 0 })
    const { port } = api.server.address() as AddressInfo
    const frontend = await frontendServer(dist, `http://127.0.0.1:${String(port)}`, delayFor === undefined ? {} : { delayFor })
    apps.push(frontend)
    return frontend.url
  }
  try {
    browser = await Browser.launch(options.chrome, 2048, { hideScrollbars: false })
    const page = await Page.open(browser)
    const ui = new Driver(page)
    const screenshots: string[] = []
    const results: UiCheckResult[] = []
    const run = async (list: readonly Check[]): Promise<void> => {
      for (const [name, check] of list) {
        let problem: string | undefined
        try {
          problem = await check(ui)
        } catch (error) {
          problem = error instanceof Error ? error.message : String(error)
        }
        const result = problem === undefined ? { name } : { name, problem }
        results.push(result)
        options.onCheck?.(result)
      }
    }

    // The tabs, the Trading grid, layout and booking: on the 40-position dataset.
    await open(page, ui, await serve(writeUiCheckDatabase, 'ui-check'), `#panel-trading .positions-table tbody tr`, UI_OPEN_POSITIONS)
    await run(checks(screenshots, options.outDir))

    // Positions & Trade Details: on its own dataset, with a server that can hold back chosen answers.
    const slow: DetailControl = { delayFor: () => 0 }
    await ui.viewport(1280)
    await open(page, ui, await serve(writeUiDetailDatabase, 'ui-detail', (url) => slow.delayFor(url)), `section[aria-labelledby="master-heading"] tbody tr`, uiDetailPositions().length)
    await run(detailChecks(screenshots, options.outDir, slow))

    // The grids at the benchmark's scale: the seed generator's 25,000 trades, in a database of their own.
    await ui.viewport(1280)
    await open(page, ui, await serve(writeBenchmarkDatabase, 'ui-benchmark'), '#panel-trading .positions-table tbody tr', uiBenchmarkPositionCount())
    await run(benchmarkChecks(screenshots, options.outDir))

    return { browser: options.chrome, product: browser.product, results, screenshots, consoleErrors: [...page.consoleErrors] }
  } finally {
    await browser?.close()
    for (const app of apps.reverse()) await app.close()
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/** Opens the page at `url` and waits until it has loaded its positions and the trade list. */
async function open(page: Page, ui: Driver, url: string, positionRows: string, positions: number): Promise<void> {
  await page.send('Page.navigate', { url })
  const deadline = Date.now() + TIMEOUT_MS
  while (!(await page.evaluate<boolean>(`location.origin === ${JSON.stringify(new URL(url).origin)} && !!window.__tradeBlotterPerf`))) {
    if (Date.now() > deadline) throw new Error('The page did not open.')
    await sleep(50)
  }
  await ui.until(`document.querySelectorAll(${JSON.stringify(positionRows)}).length === ${String(positions)} && document.querySelectorAll('section[aria-labelledby="blotter-heading"] tbody tr').length > 0`, 'the page to load')
  await ui.frame()
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { chrome: { type: 'string' }, out: { type: 'string' } } })
  let chrome: string
  try {
    chrome = findChrome(values.chrome)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('The UI checks did not run.')
    return 3
  }
  const outDir = resolve(values.out ?? join(defaultRunDir(), 'ui-check'))
  console.log(`UI checks in headless ${chrome}; screenshots in ${outDir}`)
  const run = await runUiChecks({
    chrome, outDir,
    onCheck: (result) => { console.log(`${result.problem === undefined ? 'PASS' : 'FAIL'}  ${result.name}${result.problem === undefined ? '' : `\n      ${result.problem.split('\n').join('\n      ')}`}`) },
  })
  console.log(`Browser: ${run.product}`)
  if (run.consoleErrors.length > 0) console.log(`FAIL  The page logged errors:\n      ${run.consoleErrors.join('\n      ')}`)
  const failed = run.results.filter((result) => result.problem !== undefined).length + (run.consoleErrors.length > 0 ? 1 : 0)
  console.log(`${String(run.results.length - run.results.filter((r) => r.problem !== undefined).length)} of ${String(run.results.length)} checks passed` +
    `${run.consoleErrors.length === 0 ? '; no console errors' : ''}. Screenshots:\n  ${run.screenshots.join('\n  ')}`)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main()
}
