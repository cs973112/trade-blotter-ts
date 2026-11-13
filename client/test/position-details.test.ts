import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { DEFAULT_TRADE_SORT } from '../src/lib/trade-filters.ts'
import { DETAIL_PAGE_SIZE, detailQuery } from '../src/stores/details.ts'
import { fakeApi, json, pageJson, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

/**
 * Positions & Trade Details: choosing a position in the master grid (pointer and keyboard), and its
 * trades, loaded a page at a time from GET /trades/page with symbolMatch=exact. Covers the query,
 * paging, sorting, a new choice starting again at page 1, answers that arrive late, loading, empty
 * and failed states, money to 2 places with the exact value kept, and that changing tab or choosing
 * the same position again loads nothing.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

const POSITIONS = '[{"symbol":"MS","netQuantity":60,"averageCost":90.125},' +
  '{"symbol":"MSFT","netQuantity":-3,"averageCost":1.6666666666666666666666666666666666666666666666667},' +
  '{"symbol":"MSTR","netQuantity":2,"averageCost":5}]'

/** `count` trades in a symbol, newest first, with exact prices; the first one's price is a half to round to even. */
function tradesIn(symbol: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => tradeJson({
    id: `${symbol}-${String(index + 1)}`, bookingSequence: 1000 - index, symbol, side: index % 2 === 0 ? 'Buy' : 'Sell',
    quantity: index === 0 ? '0.0000000001' : '1', price: index === 0 ? '90.125' : '90.135',
    notional: index === 0 ? '0.0000000090125' : '90.135',
    executedAt: new Date(Date.UTC(2026, 2, 1, 15, 0) - index * 60_000).toISOString(),
  }))
}

const BY_SYMBOL: Readonly<Record<string, string[]>> = { MS: tradesIn('MS', 60), MSFT: tradesIn('MSFT', 3), MSTR: tradesIn('MSTR', 1) }

/**
 * GET /trades/page as the API answers it for these symbols: symbolMatch=exact matches the whole
 * symbol, and without it the symbol matches anywhere (MS then lists MS, MSFT and MSTR).
 */
function tradesRoute(_body: string | undefined, url: string): FakeResponse {
  const parameters = new URL(url, 'http://localhost').searchParams
  const symbol = parameters.get('symbol') ?? ''
  const exact = parameters.get('symbolMatch') === 'exact'
  const items = Object.entries(BY_SYMBOL).filter(([name]) => exact ? name === symbol : name.includes(symbol)).flatMap(([, list]) => list)
  const page = Number(parameters.get('page') ?? '1')
  const pageSize = Number(parameters.get('pageSize') ?? '50')
  return pageJson(items.slice((page - 1) * pageSize, page * pageSize), { page, pageSize, totalCount: items.length })
}

async function openDetails() {
  const server = fakeApi({ 'GET /trades/page': tradesRoute, 'GET /positions': json(POSITIONS) })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  await wrapper.find('#tab-details').trigger('click')
  return { server, page: wrapper }
}

const master = (page: VueWrapper) => page.find('section[aria-labelledby="master-heading"]')
const details = (page: VueWrapper) => page.find('section[aria-labelledby="details-heading"]')
const row = (page: VueWrapper, symbol: string): DOMWrapper<HTMLTableRowElement> => {
  const found = master(page).findAll<HTMLTableRowElement>('tbody tr').find((candidate) => candidate.find('th').text() === symbol)
  if (found === undefined) throw new Error(`no row for ${symbol}`)
  return found
}
const symbolCell = (page: VueWrapper, symbol: string) => row(page, symbol).find<HTMLElement>('th')
/** The detail requests, as sent: the trade list's own requests on the Trade History tab never ask for symbolMatch. */
const detailRequests = (server: ReturnType<typeof fakeApi>): string[] =>
  server.calls.map((call) => call.url).filter((url) => url.includes('symbolMatch='))
const detailRows = (page: VueWrapper): string[][] =>
  details(page).findAll('tbody tr').map((tableRow) => tableRow.findAll('th, td').map((cell) => cell.text()))

async function choose(page: VueWrapper, symbol: string): Promise<void> {
  await row(page, symbol).trigger('click')
  await flushPromises()
}

describe('the detail query', () => {
  it('asks for the whole symbol, never a search within symbols, and leaves out the default sort', () => {
    expect(detailQuery('MS', DEFAULT_TRADE_SORT, 1, 25)).toEqual({ symbol: 'MS', symbolMatch: 'exact', page: 1, pageSize: 25 })
    expect(detailQuery('MS', { sortBy: 'price', sortDirection: 'asc' }, 3, 50))
      .toEqual({ symbol: 'MS', symbolMatch: 'exact', sortBy: 'price', sortDirection: 'asc', page: 3, pageSize: 50 })
    expect(DETAIL_PAGE_SIZE).toBe(25)
  })
})

describe('Positions & Trade Details: the master grid', () => {
  it('lists every open position as a grid of rows to choose, none chosen, and asks for no trades until one is', async () => {
    const { server, page } = await openDetails()

    const table = master(page).find('table')
    expect(table.attributes('role')).toBe('grid')
    expect(master(page).findAll('tbody tr').map((tableRow) => tableRow.attributes('aria-selected'))).toEqual(['false', 'false', 'false'])
    expect(master(page).findAll('tbody th').map((cell) => cell.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(master(page).findAll('tbody tr').map((tableRow) => tableRow.findAll('th, td').map((cell) => cell.text())[3])).toEqual([
      '90.12, exactly 90.125', '1.67, exactly 1.6666666666666666666666666666666666666666666666667', '5.00',
    ])
    expect(details(page).text()).toContain('Choose a position to see the trades that make it up.')
    expect(detailRequests(server)).toEqual([])
    // The positions are the Trading tab's: loaded once for both.
    expect(server.calls.filter((call) => call.url === '/positions')).toHaveLength(1)
  })

  it('chooses a position with the pointer: marks the row, and loads page 1 of exactly that symbol\'s trades', async () => {
    const { server, page } = await openDetails()

    await choose(page, 'MS')

    expect(detailRequests(server)).toEqual(['/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25'])
    expect(row(page, 'MS').attributes('aria-selected')).toBe('true')
    expect(row(page, 'MS').classes()).toContain('is-selected')
    expect(row(page, 'MSFT').attributes('aria-selected')).toBe('false')
    expect(details(page).find('h2').text()).toBe('Trade Details: MS')
    expect(details(page).find('.trade-count').text()).toBe('60 trades')
    expect(details(page).findAll('tbody tr')).toHaveLength(25)
    expect(details(page).find('nav.pager .pager-range').text()).toBe('1–25 of 60 trades')
    expect(details(page).find('nav.pager .pager-position').text()).toBe('Page 1 of 3')
    expect(document.activeElement).toBe(symbolCell(page, 'MS').element)
  })

  it('never shows another symbol\'s trades: MS lists none of MSFT\'s or MSTR\'s', async () => {
    const { page } = await openDetails()

    await choose(page, 'MS')
    await details(page).find('select').setValue('100')
    await flushPromises()

    expect(details(page).findAll('tbody tr')).toHaveLength(60)
    expect(details(page).find('.trade-count').text()).toBe('60 trades')
    // Symbol is hidden by default (every row would repeat it); shown, it is MS on every row.
    await openColumns(page)
    await details(page).find('input[data-column="symbol"]').setValue(true)
    expect(new Set(details(page).findAll('tbody td.cell-symbol').map((cell) => cell.text()))).toEqual(new Set(['MS']))
  })

  it('chooses with the keyboard: arrows, Home and End move between rows, Enter and Space choose', async () => {
    const { server, page } = await openDetails()

    symbolCell(page, 'MS').element.focus()
    await symbolCell(page, 'MS').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(symbolCell(page, 'MSFT').element)
    expect(symbolCell(page, 'MSFT').attributes('tabindex')).toBe('0')
    expect(symbolCell(page, 'MS').attributes('tabindex')).toBe('-1')
    expect(detailRequests(server)).toEqual([])

    await symbolCell(page, 'MSFT').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(row(page, 'MSFT').attributes('aria-selected')).toBe('true')

    await symbolCell(page, 'MSFT').trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(symbolCell(page, 'MSTR').element)
    await symbolCell(page, 'MSTR').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(symbolCell(page, 'MSTR').element)
    await symbolCell(page, 'MSTR').trigger('keydown', { key: ' ' })
    await flushPromises()
    await symbolCell(page, 'MSTR').trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(symbolCell(page, 'MS').element)
    await symbolCell(page, 'MS').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(symbolCell(page, 'MS').element)

    expect(detailRequests(server)).toEqual([
      '/trades/page?symbol=MSFT&symbolMatch=exact&page=1&pageSize=25',
      '/trades/page?symbol=MSTR&symbolMatch=exact&page=1&pageSize=25',
    ])
    expect(master(page).findAll('tbody tr[aria-selected="true"]').map((tableRow) => tableRow.find('th').text())).toEqual(['MSTR'])
  })

  it('loads nothing when the position already chosen is chosen again, by pointer or keyboard', async () => {
    const { server, page } = await openDetails()

    await choose(page, 'MS')
    await choose(page, 'MS')
    await symbolCell(page, 'MS').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(detailRequests(server)).toHaveLength(1)
  })
})

describe('Positions & Trade Details: the trades', () => {
  it('pages, sorts and changes the page size on the server, for the chosen symbol only', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')

    await details(page).findAll('nav.pager')[0]?.findAll('button')[1]?.trigger('click')
    await flushPromises()
    expect(details(page).find('nav.pager .pager-position').text()).toBe('Page 2 of 3')
    expect(details(page).findAll('tbody tr')).toHaveLength(25)

    await details(page).findAll('thead th button.sort-button').find((button) => button.text().startsWith('Price'))?.trigger('click')
    await flushPromises()
    expect(details(page).find('th[aria-sort]').text()).toContain('Price')
    expect(details(page).find('th[aria-sort]').attributes('aria-sort')).toBe('ascending')

    await details(page).find('select').setValue('50')
    await flushPromises()

    expect(detailRequests(server)).toEqual([
      '/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25',
      '/trades/page?symbol=MS&symbolMatch=exact&page=2&pageSize=25',
      '/trades/page?symbol=MS&symbolMatch=exact&sortBy=price&sortDirection=asc&page=1&pageSize=25',
      '/trades/page?symbol=MS&symbolMatch=exact&sortBy=price&sortDirection=asc&page=1&pageSize=50',
    ])
    expect(details(page).find('nav.pager .pager-range').text()).toBe('1–50 of 60 trades')
  })

  it('starts again at page 1 for another position, keeping the sort and page size', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')
    await details(page).find('select').setValue('50')
    await flushPromises()
    await details(page).findAll('nav.pager')[0]?.findAll('button')[1]?.trigger('click')
    await flushPromises()

    await choose(page, 'MSFT')

    expect(detailRequests(server).at(-1)).toBe('/trades/page?symbol=MSFT&symbolMatch=exact&page=1&pageSize=50')
    expect(details(page).find('.trade-count').text()).toBe('3 trades')
    expect(details(page).find('nav.pager .pager-position').text()).toBe('Page 1 of 1')
  })

  it('shows prices and notionals to 2 places, half to even, the exact value kept; quantities exact; the summary\'s average cost too, its exact value shown only with Exact values', async () => {
    const { page } = await openDetails()
    await choose(page, 'MS')

    expect(details(page).findAll('thead th').map((cell) => cell.find('.column-label, .sort-button').text().split(/[↑↓↕]/)[0])).toEqual([
      'Executed at', 'Side', 'Quantity', 'Price', 'Notional',
    ])
    const [first, second] = detailRows(page)
    expect(first?.slice(1)).toEqual(['Buy', '0.0000000001', '90.12, exactly 90.125', '0.00, exactly 0.0000000090125'])
    expect(second?.slice(1)).toEqual(['Sell', '1', '90.14, exactly 90.135', '90.14, exactly 90.135'])
    expect(details(page).find('td.price .money').attributes('title')).toBe('Exactly 90.125')
    const cost = () => details(page).find('.position-summary dd.average-cost')
    // What a sighted user reads: the text without what only screen readers get.
    const seenCost = () => {
      const copy = cost().element.cloneNode(true) as Element
      copy.querySelectorAll('.visually-hidden').forEach((hidden) => { hidden.remove() })
      return copy.textContent.replace(/\s+/g, ' ').trim()
    }
    // Off by default: two places, the exact value only as the tooltip and for screen readers.
    expect(seenCost()).toBe('90.12')
    expect(cost().find('.money').attributes('title')).toBe('Exactly 90.125')
    expect(cost().find('.visually-hidden').text()).toBe(', exactly 90.125')
    expect(details(page).find('.position-summary').text()).not.toContain('(exactly')
    expect(details(page).find('.position-summary').text()).toContain('60')

    const exact = details(page).find<HTMLInputElement>('input.exact-toggle')
    await exact.setValue(true)
    expect(seenCost()).toBe('90.12 exactly 90.125')
    expect(cost().find('.exact-inline').exists()).toBe(true)
    await exact.setValue(false)
    expect(seenCost()).toBe('90.12')
  })

  it('drops an answer for an earlier choice that arrives late: the newest choice\'s trades are shown', async () => {
    const { server, page } = await openDetails()
    let releaseMs: (response: FakeResponse) => void = () => undefined
    server.set('GET /trades/page', (body, url) => url.includes('symbol=MS&')
      ? new Promise<FakeResponse>((resolve) => { releaseMs = resolve })
      : tradesRoute(body, url))

    await choose(page, 'MS')
    expect(details(page).text()).toContain('Loading trades for MS…')
    await choose(page, 'MSTR')
    releaseMs(tradesRoute(undefined, '/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25'))
    await flushPromises()

    expect(details(page).find('h2').text()).toBe('Trade Details: MSTR')
    expect(details(page).find('.trade-count').text()).toBe('1 trade')
    expect(detailRows(page)).toHaveLength(1)
    expect(details(page).find('tbody tr td.price').text()).toBe('90.12, exactly 90.125')
  })

  it('never shows the previous position\'s trades under the new one\'s name while they load', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')
    server.set('GET /trades/page', () => new Promise<FakeResponse>(() => undefined))

    await choose(page, 'MSFT')

    expect(details(page).find('h2').text()).toBe('Trade Details: MSFT')
    expect(details(page).find('table').exists()).toBe(false)
    expect(details(page).find('[role="status"]').text()).toBe('Loading trades for MSFT…')
  })

  it('drops a late answer for an earlier page: the page asked for last is shown', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')
    let releasePage2: (response: FakeResponse) => void = () => undefined
    server.set('GET /trades/page', (body, url) => url.includes('page=2&')
      ? new Promise<FakeResponse>((resolve) => { releasePage2 = resolve })
      : tradesRoute(body, url))

    const next = details(page).findAll('nav.pager')[0]?.findAll('button')[1]
    await next?.trigger('click')
    await details(page).find('select').setValue('100')
    await flushPromises()
    releasePage2(tradesRoute(undefined, '/trades/page?symbol=MS&symbolMatch=exact&page=2&pageSize=25'))
    await flushPromises()

    expect(details(page).find('nav.pager .pager-range').text()).toBe('1–60 of 60 trades')
    expect(detailRows(page)).toHaveLength(60)
  })

  it('says when a position has no trades, and when they could not be loaded, with a way to try again', async () => {
    const { server, page } = await openDetails()
    server.set('GET /trades/page', pageJson([], { page: 1, pageSize: 25, totalCount: 0 }))
    await choose(page, 'MSTR')
    expect(details(page).find('[role="status"]').text()).toBe('No trades for MSTR.')
    expect(details(page).find('table').exists()).toBe(false)

    server.set('GET /trades/page', problem(503, {}))
    await choose(page, 'MSFT')
    expect(details(page).find('[role="alert"]').text()).toContain('Trades for MSFT could not be loaded. The API is not available.')

    server.set('GET /trades/page', tradesRoute)
    await details(page).find('button.retry-details').trigger('click')
    await flushPromises()
    expect(details(page).find('[role="alert"]').exists()).toBe(false)
    expect(detailRows(page)).toHaveLength(3)
  })

  it('refuses an answer holding another symbol\'s trades rather than show them', async () => {
    const { server, page } = await openDetails()
    server.set('GET /trades/page', pageJson(tradesIn('MSFT', 1), { page: 1, pageSize: 25, totalCount: 1 }))

    await choose(page, 'MS')

    expect(details(page).find('[role="alert"]').text()).toContain('The server returned trades for another symbol.')
    expect(details(page).find('table').exists()).toBe(false)
  })

  it('keeps the choice, page, sort and columns while other tabs are shown, loading nothing again', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')
    await details(page).findAll('nav.pager')[0]?.findAll('button')[1]?.trigger('click')
    await flushPromises()
    await openColumns(page)
    await details(page).find('input[data-column="side"]').setValue(false)
    const requests = server.calls.length
    const before = details(page).html()

    for (const id of ['trading', 'history', 'details', 'trading', 'details']) await page.find(`#tab-${id}`).trigger('click')
    await flushPromises()

    expect(server.calls.length).toBe(requests)
    expect(details(page).html()).toBe(before)
    expect(row(page, 'MS').attributes('aria-selected')).toBe('true')
  })

  it('loads the details again after booking a trade in the chosen symbol, and only then', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MS')
    server.set('POST /trades', json(tradesIn('MSTR', 1)[0] ?? '', 201))
    await page.find('#tab-trading').trigger('click')
    const book = async (symbol: string): Promise<void> => {
      await page.find('#trade-symbol').setValue(symbol)
      await page.find('#trade-side-buy').setValue(true)
      await page.find('#trade-quantity').setValue('1')
      await page.find('#trade-price').setValue('1')
      await page.find('form').trigger('submit')
      await flushPromises()
    }

    await book('MSTR')
    expect(detailRequests(server)).toHaveLength(1)

    server.set('POST /trades', json(tradesIn('MS', 1)[0] ?? '', 201))
    await book('MS')
    expect(detailRequests(server)).toEqual([
      '/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25',
      '/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25',
    ])
  })

  it('says when the chosen position is no longer open, and still lists its trades', async () => {
    const { server, page } = await openDetails()
    await choose(page, 'MSFT')
    server.set('GET /positions', json('[{"symbol":"MS","netQuantity":60,"averageCost":90.125}]'))

    await master(page).find('button.refresh-positions').trigger('click')
    await flushPromises()

    expect(details(page).text()).toContain('MSFT is no longer an open position; its trades are still listed.')
    expect(detailRows(page)).toHaveLength(3)
  })
})

async function openColumns(page: VueWrapper): Promise<void> {
  await details(page).find('.column-chooser > button').trigger('click')
  await flushPromises()
}
