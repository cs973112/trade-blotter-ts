import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { fakeApi, json, pagedTrades, pageJson, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

/**
 * The trade list on the whole page, against a scripted API: search and filters, sorting by column
 * header, pages, and booking. The list always comes from GET /trades/page; the API filters, sorts
 * and counts, so the fake API answers with the list a query should produce. Dates are entered as
 * the browser's local dates; the tests run in America/New_York, which local-dates.test.ts checks
 * is applied.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

const trade = (id: string, sequence: number, symbol: string, side: 'Buy' | 'Sell', quantity: string, price: string) =>
  tradeJson({
    id, bookingSequence: sequence, symbol, side, quantity, price, notional: '1', executedAt: `2026-01-0${String(sequence)}T15:00:00.000Z`,
  })

const AAPL = trade('a', 1, 'AAPL', 'Buy', '10', '100')
const MSFT = trade('m', 2, 'MSFT', 'Sell', '9', '301.25')
const XMSX = trade('x', 3, 'XMSX', 'Buy', '100', '2')
const POSITIONS = '[{"symbol":"AAPL","netQuantity":10,"averageCost":100},{"symbol":"MSFT","netQuantity":-9,"averageCost":301.25}]'

/** `count` trades named S001, S002, ..., newest first, as the API lists them by default. */
const many = (count: number): string[] => Array.from({ length: count }, (_, index) => tradeJson({
  id: `t${String(index + 1)}`, bookingSequence: index + 1, symbol: `S${String(index + 1).padStart(3, '0')}`, side: 'Buy',
  quantity: '1', price: '1', notional: '1', executedAt: '2026-01-01T15:00:00.000Z',
}))

async function openPage(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ 'GET /trades/page': pagedTrades([XMSX, MSFT, AAPL]), 'GET /positions': json(POSITIONS), ...routes })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  return { server, page: wrapper }
}

const blotter = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="blotter-heading"]')
const bookingForm = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="trade-form-heading"]')
const positionsPanel = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="positions-heading"]')
const listedSymbols = (page: VueWrapper): string[] => blotter(page).findAll('tbody th').map((cell) => cell.text())
const value = (page: VueWrapper, selector: string): string => (page.find(selector).element as HTMLInputElement | HTMLSelectElement).value
const filterValues = (page: VueWrapper): string[] =>
  ['#filter-symbol', '#filter-side', '#filter-from-date', '#filter-to-date'].map((selector) => value(page, selector))

/** Every request for the trade list, as its path and [name, value] pairs. */
const listRequests = (server: ReturnType<typeof fakeApi>): { path: string; query: string[][] }[] =>
  server.calls.filter((call) => call.method === 'GET' && call.url.startsWith('/trades')).map((call) => {
    const url = new URL(call.url, 'http://localhost')
    return { path: url.pathname, query: [...url.searchParams.entries()] }
  })

/** The query of the last trade-list request. */
const lastQuery = (server: ReturnType<typeof fakeApi>): string[][] => listRequests(server).at(-1)?.query ?? []

/** The query of a page request: filters and sort, then the page. */
const paged = (query: string[][], page = 1, pageSize = 50): string[][] => [...query, ['page', String(page)], ['pageSize', String(pageSize)]]

async function setFilters(page: VueWrapper, filters: { symbol?: string; side?: string; fromDate?: string; toDate?: string }): Promise<void> {
  if (filters.symbol !== undefined) await page.find('#filter-symbol').setValue(filters.symbol)
  if (filters.side !== undefined) await page.find('#filter-side').setValue(filters.side)
  if (filters.fromDate !== undefined) await page.find('#filter-from-date').setValue(filters.fromDate)
  if (filters.toDate !== undefined) await page.find('#filter-to-date').setValue(filters.toDate)
}

/** Presses Apply, as a click on the form's submit button. */
async function apply(page: VueWrapper): Promise<void> {
  await page.find('.trade-filters button[type="submit"]').trigger('click')
  await flushPromises()
}

async function clear(page: VueWrapper): Promise<void> {
  await page.findAll('.trade-filters button').find((button) => button.text() === 'Clear')?.trigger('click')
  await flushPromises()
}

/** The button in a column header, found by the header's label. */
function headerButton(page: VueWrapper, label: string): DOMWrapper<Element> {
  const header = blotter(page).findAll('thead th').find((cell) => cell.text().startsWith(label))
  if (header === undefined) throw new Error(`No header ${label}`)
  return header.find('button')
}

async function sortBy(page: VueWrapper, label: string, settle = true): Promise<void> {
  await headerButton(page, label).trigger('click')
  if (settle) await flushPromises()
}

/** Each column header's label and aria-sort, for the sortable ones. */
const sortState = (page: VueWrapper): (string | undefined)[][] => blotter(page).findAll('thead th.sortable')
  .map((cell) => [cell.find('button').text().split('↕')[0]?.split('↑')[0]?.split('↓')[0], cell.attributes('aria-sort')])

const pagers = (page: VueWrapper): DOMWrapper<Element>[] => blotter(page).findAll('nav.pager')

/** What each pager shows: its range, position, and which of Previous and Next can be used. */
const pagerState = (page: VueWrapper) => pagers(page).map((pager) => ({
  range: pager.find('.pager-range').text(),
  position: pager.find('.pager-position').text(),
  previous: pager.findAll('button')[0]?.attributes('disabled') === undefined,
  next: pager.findAll('button')[1]?.attributes('disabled') === undefined,
  size: (pager.find('select').element as HTMLSelectElement).value,
}))

async function pagerButton(page: VueWrapper, which: 'Previous' | 'Next', placement: 0 | 1 = 0, settle = true): Promise<void> {
  const button = pagers(page)[placement]?.findAll('button').find((candidate) => candidate.text().startsWith(which))
  await button?.trigger('click')
  if (settle) await flushPromises()
}

async function choosePageSize(page: VueWrapper, size: string, placement: 0 | 1 = 0): Promise<void> {
  await pagers(page)[placement]?.find('select').setValue(size)
  await flushPromises()
}

/** A route that answers only when released, so tests control the order responses arrive in. */
function held() {
  const waiting: { url: string; release: (response: FakeResponse) => void }[] = []
  const route = (_body: string | undefined, url: string) => new Promise<FakeResponse>((resolve) => {
    waiting.push({ url, release: resolve })
  })
  return { route, waiting }
}

describe('trade list: as the page opens', () => {
  it('loads page 1 of 50 trades from GET /trades/page, newest execution first, and never the whole history', async () => {
    const { server, page } = await openPage()

    expect(server.sequence()).toEqual(['GET /trades/page?page=1&pageSize=50', 'GET /positions'])
    expect(server.calls.some((call) => call.method === 'GET' && (call.url === '/trades' || call.url.startsWith('/trades?')))).toBe(false)
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
    expect(filterValues(page)).toEqual(['', '', '', ''])
    expect(blotter(page).find('caption').text()).toContain('Every trade, newest execution first.')
  })

  it('shows the same pager above and below the table: the range, page 1 of 1, no way back or on, 50 per page', async () => {
    const { page } = await openPage()

    const [top, bottom] = pagers(page)
    expect(blotter(page).findAll('nav.pager, .table-scroll').map((element) => element.classes()[0])).toEqual(['pager', 'table-scroll', 'pager'])
    expect(top?.attributes('aria-label')).toBe('Trade pages, above the table')
    expect(bottom?.attributes('aria-label')).toBe('Trade pages, below the table')
    expect(pagerState(page)).toEqual([
      { range: '1–3 of 3 trades', position: 'Page 1 of 1', previous: false, next: false, size: '50' },
      { range: '1–3 of 3 trades', position: 'Page 1 of 1', previous: false, next: false, size: '50' },
    ])
  })
})

describe('trade list: accessibility', () => {
  it('labels every filter and groups them as a search form, without sort controls', async () => {
    const { page } = await openPage()
    const form = page.find('form.trade-filters')

    expect(form.attributes('role')).toBe('search')
    expect(form.attributes('aria-label')).toBe('Search and filter trades')
    const labels = form.findAll('label').map((label) => [label.attributes('for'), label.text()])
    expect(labels).toEqual([['filter-symbol', 'Symbol'], ['filter-side', 'Side'], ['filter-from-date', 'From'], ['filter-to-date', 'To']])
    for (const [id] of labels) expect(form.find(`#${id ?? ''}`).exists()).toBe(true)
    expect(page.find('#filter-sort-by').exists()).toBe(false)
    expect(page.find('#filter-sort-direction').exists()).toBe(false)
    expect(form.find('#filter-from-date').attributes('aria-describedby')).toBe('filter-dates-hint')
    expect(form.find('#filter-dates-hint').text()).toContain('calendar dates in your time zone (America/New_York), and both are included')
    expect(form.findAll('button').map((button) => [button.text(), button.attributes('type')])).toEqual([['Apply', 'submit'], ['Clear', 'button']])
    expect(form.findAll('#filter-side option').map((option) => [option.attributes('value'), option.text()]))
      .toEqual([['', 'All'], ['Buy', 'Buy'], ['Sell', 'Sell']])
  })

  it('makes only Symbol, Quantity, Price and Executed at sortable, each with a button that says what it does', async () => {
    const { page } = await openPage()
    const headers = blotter(page).findAll('thead th')

    expect(headers.map((cell) => cell.find('button').exists())).toEqual([true, false, true, true, false, true, false, false])
    expect(headers.filter((cell) => cell.find('button').exists()).map((cell) => cell.find('button').attributes('type')))
      .toEqual(['button', 'button', 'button', 'button'])
    expect(headers.map((cell) => cell.find('.visually-hidden').exists() ? cell.find('.visually-hidden').text() : ''))
      .toEqual([', sort ascending', '', ', sort ascending', ', sort ascending', '', ', sort oldest first', '', ''])
    expect(headers.map((cell) => cell.find('.sort-indicator').exists() ? cell.find('.sort-indicator').attributes('aria-hidden') : null))
      .toEqual(['true', null, 'true', 'true', null, 'true', null, null])
  })

  it('marks only the sorted column with aria-sort, as the order on screen', async () => {
    const { page } = await openPage()

    expect(sortState(page)).toEqual([['Symbol', undefined], ['Quantity', undefined], ['Price', undefined], ['Executed at', 'descending']])
    expect(blotter(page).findAll('thead th[aria-sort]')).toHaveLength(1)
  })

  it('labels both page-size choosers and names Previous and Next as pages', async () => {
    const { page } = await openPage()

    for (const [index, pager] of pagers(page).entries()) {
      const id = index === 0 ? 'pager-top-size' : 'pager-bottom-size'
      expect(pager.find('label').attributes('for')).toBe(id)
      expect(pager.find('label').text()).toBe('Trades per page')
      expect(pager.find(`select#${id}`).findAll('option').map((option) => option.text())).toEqual(['25', '50', '100'])
      expect(pager.findAll('button').map((button) => [button.text(), button.attributes('type')]))
        .toEqual([['Previous page', 'button'], ['Next page', 'button']])
    }
  })

  it('applies with Enter in the symbol field, since the filters are one form', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms' })
    await page.find('form.trade-filters').trigger('submit')
    await flushPromises()

    expect(lastQuery(server)).toEqual(paged([['symbol', 'ms']]))
  })

  it('announces the page shown once it has loaded', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })

    expect(blotter(page).find('[role="status"]').text()).toBe('Showing 1–50 of 120 trades, page 1 of 3.')
    expect(blotter(page).find('[role="status"]').classes()).toContain('visually-hidden')

    server.set('GET /trades/page', pagedTrades(many(120).slice(0, 7)))
    await setFilters(page, { symbol: 's00' })
    await apply(page)
    expect(blotter(page).find('[role="status"]').text()).toBe('Showing 1–7 of 7 matching trades, page 1 of 1.')
  })
})

describe('trade list: pages', () => {
  it('moves to the next and previous page, and keeps both pagers the same', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })

    await pagerButton(page, 'Next', 1)

    expect(lastQuery(server)).toEqual(paged([], 2))
    expect(listedSymbols(page)[0]).toBe('S051')
    expect(listedSymbols(page)).toHaveLength(50)
    expect(pagerState(page)).toEqual(Array(2).fill({ range: '51–100 of 120 trades', position: 'Page 2 of 3', previous: true, next: true, size: '50' }))

    await pagerButton(page, 'Previous', 0)

    expect(lastQuery(server)).toEqual(paged([], 1))
    expect(listedSymbols(page)[0]).toBe('S001')
    expect(pagerState(page)[1]).toMatchObject({ range: '1–50 of 120 trades', position: 'Page 1 of 3', previous: false, next: true })
  })

  it('shows a partly full last page, and offers no Next there', async () => {
    const { page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })

    await pagerButton(page, 'Next')
    await pagerButton(page, 'Next')

    expect(listedSymbols(page)).toEqual(many(120).slice(100).map((_, index) => `S${String(101 + index)}`))
    expect(pagerState(page)[0]).toEqual({ range: '101–120 of 120 trades', position: 'Page 3 of 3', previous: true, next: false, size: '50' })
  })

  it('moves focus to Previous when Next reaches the last page, so the keyboard is not stranded on a disabled button', async () => {
    const { page } = await openPage({ 'GET /trades/page': pagedTrades(many(60)) })
    const next = pagers(page)[1]?.findAll('button')[1]
    ;(next?.element as HTMLButtonElement).focus()

    await next?.trigger('click')
    await flushPromises()

    expect(next?.attributes('disabled')).toBeDefined()
    expect(document.activeElement).toBe(pagers(page)[1]?.findAll('button')[0]?.element)
  })

  it('moves focus to Next when Previous reaches the first page', async () => {
    const { page } = await openPage({ 'GET /trades/page': pagedTrades(many(60)) })
    await pagerButton(page, 'Next')
    const previous = pagers(page)[0]?.findAll('button')[0]
    ;(previous?.element as HTMLButtonElement).focus()

    await previous?.trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(pagers(page)[0]?.findAll('button')[1]?.element)
  })

  it.each([['25', 5, '1–25 of 120 trades'], ['100', 2, '1–100 of 120 trades']])(
    'shows %s trades a page from page 1, from either pager', async (size, pages, range) => {
      const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
      await pagerButton(page, 'Next')
      const before = server.calls.length

      await choosePageSize(page, size, 1)

      expect(lastQuery(server)).toEqual(paged([], 1, Number(size)))
      expect(server.calls).toHaveLength(before + 1)
      expect(listedSymbols(page)).toHaveLength(Number(size))
      expect(pagerState(page)).toEqual(Array(2).fill({ range, position: `Page 1 of ${String(pages)}`, previous: false, next: true, size }))
    },
  )

  it('sends nothing when the page size chosen is the one shown', async () => {
    const { server, page } = await openPage()
    const before = server.calls.length

    await choosePageSize(page, '50')

    expect(server.calls).toHaveLength(before)
  })

  it('shows a page from the middle of a large history with grouped numbers', async () => {
    const route = (_body: string | undefined, url: string): FakeResponse => {
      const number = Number(new URL(url, 'http://localhost').searchParams.get('page'))
      return pageJson(many(50), { page: number, pageSize: 50, totalCount: 25_000 })
    }
    const { page } = await openPage({ 'GET /trades/page': route })

    await pagerButton(page, 'Next')

    expect(pagerState(page)[0]).toMatchObject({ range: '51–100 of 25,000 trades', position: 'Page 2 of 500', previous: true, next: true })
  })

  it('shows no pager and says so when there are no trades at all', async () => {
    const { page } = await openPage({ 'GET /trades/page': pagedTrades([]) })

    expect(pagers(page)).toHaveLength(0)
    expect(blotter(page).find('table').exists()).toBe(false)
    expect(blotter(page).text()).toContain('No trades yet. Book one to see it here.')
  })

  it('asks for the last page when the page asked for is past it', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await pagerButton(page, 'Next')
    await pagerButton(page, 'Next')
    // The history is now shorter than the page shown: the API answers page 3 with no trades.
    server.set('GET /trades/page', pagedTrades(many(80)))

    await blotter(page).find('.panel-heading button').trigger('click')
    await flushPromises()

    expect(listRequests(server).slice(-2).map((request) => request.query)).toEqual([paged([], 3), paged([], 2)])
    expect(pagerState(page)[0]).toMatchObject({ range: '51–80 of 80 trades', position: 'Page 2 of 2', next: false })
  })
})

describe('trade list: sorting by column', () => {
  it.each([
    ['Symbol', [['sortBy', 'symbol'], ['sortDirection', 'asc']], 'ascending'],
    ['Quantity', [['sortBy', 'quantity'], ['sortDirection', 'asc']], 'ascending'],
    ['Price', [['sortBy', 'price'], ['sortDirection', 'asc']], 'ascending'],
    ['Executed at', [['sortBy', 'executedAt'], ['sortDirection', 'asc']], 'ascending'],
  ])('sorts by %s from page 1 (Executed at, already active, reverses), and lists the trades as the API returns them', async (label, query, ariaSort) => {
    const { server, page } = await openPage()
    server.set('GET /trades/page', pagedTrades([AAPL, XMSX, MSFT]))

    await sortBy(page, label)

    expect(lastQuery(server)).toEqual(paged(query))
    expect(listedSymbols(page)).toEqual(['AAPL', 'XMSX', 'MSFT'])
    expect(sortState(page).find(([name]) => name === label)?.[1]).toBe(ariaSort)
    expect(blotter(page).findAll('thead th[aria-sort]')).toHaveLength(1)
  })

  it.each([['Symbol', 'symbol'], ['Quantity', 'quantity'], ['Price', 'price']])(
    'reverses %s when chosen again, and again', async (label, field) => {
      const { server, page } = await openPage()

      await sortBy(page, label)
      await sortBy(page, label)
      expect(lastQuery(server)).toEqual(paged([['sortBy', field], ['sortDirection', 'desc']]))
      expect(blotter(page).find('thead th[aria-sort]').attributes('aria-sort')).toBe('descending')
      expect(headerButton(page, label).find('.sort-indicator').text()).toBe('↓')
      expect(headerButton(page, label).find('.visually-hidden').text()).toBe(', sort ascending')

      await sortBy(page, label)
      expect(lastQuery(server)).toEqual(paged([['sortBy', field], ['sortDirection', 'asc']]))
      expect(headerButton(page, label).find('.sort-indicator').text()).toBe('↑')
    },
  )

  it('starts the execution date newest first, and reverses it to oldest first', async () => {
    const { server, page } = await openPage()

    await sortBy(page, 'Executed at')
    expect(lastQuery(server)).toEqual(paged([['sortBy', 'executedAt'], ['sortDirection', 'asc']]))
    expect(blotter(page).find('caption').text()).toContain('Every trade, sorted by execution date, oldest first.')

    await sortBy(page, 'Price')
    await sortBy(page, 'Executed at')
    // Back to the default order, which is sent as no sort at all.
    expect(lastQuery(server)).toEqual(paged([]))
    expect(blotter(page).find('caption').text()).toContain('newest execution first')
  })

  it('names the sort in the table caption', async () => {
    const { page } = await openPage()

    await sortBy(page, 'Price')

    expect(blotter(page).find('caption').text()).toContain('Every trade, sorted by price, ascending.')
  })

  it('goes back to page 1, keeping the page size and the applied filters', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await setFilters(page, { side: 'Buy' })
    await apply(page)
    await choosePageSize(page, '25')
    await pagerButton(page, 'Next')
    expect(lastQuery(server)).toEqual(paged([['side', 'Buy']], 2, 25))

    await sortBy(page, 'Quantity')

    expect(lastQuery(server)).toEqual(paged([['side', 'Buy'], ['sortBy', 'quantity'], ['sortDirection', 'asc']], 1, 25))
    expect(pagerState(page)[0]).toMatchObject({ position: 'Page 1 of 5', size: '25' })
  })

  it('sorts with the applied filters, never filters typed but not applied', async () => {
    const { server, page } = await openPage()
    await setFilters(page, { symbol: 'ms' })
    await apply(page)
    await setFilters(page, { symbol: 'zzz', side: 'Sell' })

    await sortBy(page, 'Price')

    expect(lastQuery(server)).toEqual(paged([['symbol', 'ms'], ['sortBy', 'price'], ['sortDirection', 'asc']]))
    expect(filterValues(page).slice(0, 2)).toEqual(['zzz', 'Sell'])
    expect(blotter(page).find('.filter-pending').text()).toBe('Changes not applied yet.')
  })
})

describe('trade list: apply and clear', () => {
  it('changes nothing until Apply, then requests page 1 of exactly what was chosen', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms', side: 'Sell' })
    await flushPromises()

    expect(server.sequence()).toEqual(['GET /trades/page?page=1&pageSize=50', 'GET /positions'])
    expect(blotter(page).find('.filter-pending').text()).toBe('Changes not applied yet.')

    server.set('GET /trades/page', pagedTrades([MSFT]))
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['symbol', 'ms'], ['side', 'Sell']]))
    expect(listedSymbols(page)).toEqual(['MSFT'])
    expect(blotter(page).find('.filter-pending').exists()).toBe(false)
    expect(pagerState(page)[0]).toMatchObject({ range: '1–1 of 1 matching trade', position: 'Page 1 of 1' })
    expect(blotter(page).find('caption').text()).toContain('Trades matching the filters, newest execution first.')
  })

  it('goes back to page 1 when filters are applied, keeping the sort and page size', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await sortBy(page, 'Symbol')
    await choosePageSize(page, '25')
    await pagerButton(page, 'Next')
    await pagerButton(page, 'Next')

    await setFilters(page, { side: 'Buy' })
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['side', 'Buy'], ['sortBy', 'symbol'], ['sortDirection', 'asc']], 1, 25))
    expect(pagerState(page)[0]).toMatchObject({ range: '1–25 of 120 matching trades', position: 'Page 1 of 5' })
  })

  it.each([['Buy'], ['Sell']])('filters by side %s', async (side) => {
    const { server, page } = await openPage()

    await setFilters(page, { side })
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['side', side]]))
  })

  it.each([['MSFT'], ['ms'], ['sf'], ['  xMs  ']])('sends the symbol search %j trimmed, for the API to match anywhere', async (symbol) => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol })
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['symbol', symbol.trim()]]))
  })

  it('combines symbol, side and local dates in one request, with the dates as UTC day boundaries', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms', side: 'Buy', fromDate: '2026-03-08', toDate: '2026-11-01' })
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([
      ['symbol', 'ms'], ['side', 'Buy'],
      // 2026-03-08 begins at 00:00 EST; 2026-11-01 ends at 23:59:59.999 EST, after the clocks went back.
      ['executedFrom', '2026-03-08T05:00:00.000Z'], ['executedTo', '2026-11-02T04:59:59.999Z'],
    ]))
  })

  it.each([
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'], // 23 hours: the clocks go forward
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'], // 25 hours: the clocks go back
    ['2026-06-15', '2026-06-15T04:00:00.000Z', '2026-06-16T03:59:59.999Z'],
  ])('sends the local day %s as %s to %s', async (date, from, to) => {
    const { server, page } = await openPage()

    await setFilters(page, { fromDate: date, toDate: date })
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['executedFrom', from], ['executedTo', to]]))
  })

  it('Clear resets the filters, the sort and the page, keeps the page size, and shows every trade newest first', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await setFilters(page, { symbol: 's', side: 'Buy', fromDate: '2026-01-01', toDate: '2026-01-31' })
    await apply(page)
    await sortBy(page, 'Price')
    await choosePageSize(page, '25')
    await pagerButton(page, 'Next')

    await clear(page)

    expect(lastQuery(server)).toEqual(paged([], 1, 25))
    expect(filterValues(page)).toEqual(['', '', '', ''])
    expect(sortState(page).find(([name]) => name === 'Executed at')?.[1]).toBe('descending')
    expect(pagerState(page)[0]).toMatchObject({ range: '1–25 of 120 trades', position: 'Page 1 of 5', size: '25' })
    expect(blotter(page).find('caption').text()).toContain('Every trade, newest execution first.')
  })

  it('Clear also discards changes that were never applied, and clears date messages', async () => {
    const { page } = await openPage()
    await setFilters(page, { fromDate: '2026-02-01', toDate: '2026-01-01' })
    await apply(page)
    expect(page.find('#filter-to-date-error').exists()).toBe(true)

    await clear(page)

    expect(page.find('#filter-to-date-error').exists()).toBe(false)
    expect(value(page, '#filter-from-date')).toBe('')
    expect(blotter(page).find('.filter-pending').exists()).toBe(false)
  })

  it('pages with the applied filters, never filters typed but not applied', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await setFilters(page, { side: 'Buy' })
    await apply(page)
    await setFilters(page, { side: 'Sell', symbol: 'q' })

    await pagerButton(page, 'Next')
    await choosePageSize(page, '100')

    expect(listRequests(server).slice(-2).map((request) => request.query)).toEqual([paged([['side', 'Buy']], 2), paged([['side', 'Buy']], 1, 100)])
    expect(blotter(page).find('.filter-pending').exists()).toBe(true)
  })
})

describe('trade list: invalid dates', () => {
  it('refuses a From date later than the To date before sending anything, and moves focus to To', async () => {
    const { server, page } = await openPage()
    const before = server.calls.length

    await setFilters(page, { fromDate: '2026-03-09', toDate: '2026-03-08' })
    await apply(page)

    expect(server.calls).toHaveLength(before)
    const to = page.find('#filter-to-date')
    expect(to.attributes('aria-invalid')).toBe('true')
    expect(to.attributes('aria-describedby')).toBe('filter-dates-hint filter-to-date-error')
    expect(page.find('#filter-to-date-error').text()).toBe('The From date is later than the To date. Choose a To date on or after the From date.')
    expect(document.activeElement).toBe(to.element)
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
  })

  it('removes the message when a date changes, and applies once the range is valid', async () => {
    const { server, page } = await openPage()
    await setFilters(page, { fromDate: '2026-03-09', toDate: '2026-03-08' })
    await apply(page)

    await setFilters(page, { toDate: '2026-03-09' })
    expect(page.find('#filter-to-date-error').exists()).toBe(false)
    await apply(page)

    expect(lastQuery(server)).toEqual(paged([['executedFrom', '2026-03-09T04:00:00.000Z'], ['executedTo', '2026-03-10T03:59:59.999Z']]))
  })

  /** jsdom cannot type into part of a date input; this sets what a browser reports for one: value '' and bad input. */
  function partlyTyped(page: VueWrapper, id: string): void {
    Object.defineProperty(page.find(`#${id}`).element, 'validity', { configurable: true, get: () => ({ badInput: true }) })
  }

  it('refuses a partly typed From date instead of applying no bound, and moves focus to it', async () => {
    const { server, page } = await openPage()
    const before = server.calls.length
    await setFilters(page, { toDate: '2026-03-08' })
    partlyTyped(page, 'filter-from-date')

    await apply(page)

    expect(server.calls).toHaveLength(before)
    expect(page.find('#filter-from-date-error').text()).toBe('Enter a complete From date between the years 0001 and 9999, or clear it.')
    expect(page.find('#filter-from-date').attributes('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(page.find('#filter-from-date').element)
  })

  it('refuses a partly typed To date as well', async () => {
    const { server, page } = await openPage()
    const before = server.calls.length
    partlyTyped(page, 'filter-to-date')

    await apply(page)

    expect(server.calls).toHaveLength(before)
    expect(page.find('#filter-to-date-error').text()).toBe('Enter a complete To date between the years 0001 and 9999, or clear it.')
  })
})

describe('trade list: loading, empty results and errors', () => {
  it('says the list is updating while a page is on its way, keeping the current rows and pagers', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await pagerButton(page, 'Next')

    expect(blotter(page).find('[role="status"]').text()).toBe('Updating trades…')
    expect(blotter(page).find('.table-scroll').attributes('aria-busy')).toBe('true')
    expect(listedSymbols(page)[0]).toBe('S001')
    expect(pagerState(page)[0]).toMatchObject({ position: 'Page 1 of 3' })

    // The status line sits in a box that is always there, so it never pushes the pager down.
    const box = blotter(page).find('.list-status').element
    expect(box.nextElementSibling?.matches('nav.pager')).toBe(true)

    slow.waiting[0]?.release(pagedTrades(many(120))(undefined, slow.waiting[0].url))
    await flushPromises()

    expect(blotter(page).find('.list-status').element).toBe(box)
    expect(listedSymbols(page)[0]).toBe('S051')
    expect(pagerState(page)[0]).toMatchObject({ position: 'Page 2 of 3' })
    expect(blotter(page).find('.table-scroll').attributes('aria-busy')).toBe('false')
  })

  it('says when no trade matches the filters, which is not the same as having no trades, and shows no pager', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades/page', pagedTrades([]))

    await setFilters(page, { symbol: 'zzz' })
    await apply(page)

    expect(blotter(page).find('table').exists()).toBe(false)
    expect(pagers(page)).toHaveLength(0)
    expect(blotter(page).text()).toContain('No trades match these filters. Change them, or choose Clear to see every trade.')
    expect(blotter(page).text()).not.toContain('No trades yet')
  })

  it('shows a query the API refused with the trade list, not with the booking form', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades/page', problem(400, {
      type: 'urn:trade-blotter:problem:invalid-query', title: 'Invalid query', detail: 'symbol must be at most 64 characters.',
      errors: { symbol: ['symbol must be at most 64 characters.'] },
    }))

    await setFilters(page, { symbol: 'A'.repeat(65) })
    await apply(page)

    expect(blotter(page).find('[role="alert"]').text())
      .toBe('Trades could not be loaded. The filters were not accepted. symbol must be at most 64 characters.')
    expect(bookingForm(page).find('[role="alert"]').exists()).toBe(false)
    expect(positionsPanel(page).find('[role="alert"]').exists()).toBe(false)
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
  })

  it('explains a failed page without its details, keeps the last page, and recovers on the next attempt', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    server.set('GET /trades/page', problem(500, { detail: 'SQLITE_BUSY' }))

    await pagerButton(page, 'Next')

    expect(blotter(page).find('[role="alert"]').text())
      .toBe('Trades could not be loaded. The server could not complete the request. Try again in a moment.')
    expect(page.text()).not.toContain('SQLITE')
    expect(listedSymbols(page)[0]).toBe('S001')
    expect(pagerState(page)[0]).toMatchObject({ position: 'Page 1 of 3' })

    server.set('GET /trades/page', pagedTrades(many(120)))
    await blotter(page).find('.panel-heading button').trigger('click')
    await flushPromises()

    expect(blotter(page).find('[role="alert"]').exists()).toBe(false)
    expect(listedSymbols(page)[0]).toBe('S051')
    expect(lastQuery(server)).toEqual(paged([], 2))
  })

  it('shows no pager when the first page could not be loaded at all', async () => {
    const { page } = await openPage({ 'GET /trades/page': problem(500, {}) })

    expect(blotter(page).find('[role="alert"]').exists()).toBe(true)
    expect(pagers(page)).toHaveLength(0)
  })

  it('refuses a page whose numbers do not add up, as a response the page does not understand', async () => {
    const { page } = await openPage({ 'GET /trades/page': json(`{"items":[${AAPL}],"page":1,"pageSize":50,"totalCount":3,"totalPages":1}`) })

    expect(blotter(page).find('[role="alert"]').text()).toContain('does not understand')
  })
})

describe('trade list: requests that finish out of order', () => {
  it('shows the newest page when pages are changed quickly and older requests answer last', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(160)) })
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await pagerButton(page, 'Next', 0, false)
    await pagerButton(page, 'Next', 1, false)
    await pagerButton(page, 'Next', 0, false)
    await flushPromises()
    expect(slow.waiting.map((request) => new URL(request.url, 'http://localhost').searchParams.get('page'))).toEqual(['2', '3', '4'])

    for (const index of [2, 0, 1]) {
      const request = slow.waiting[index]
      request?.release(pagedTrades(many(160))(undefined, request.url))
      await flushPromises()
    }

    expect(listedSymbols(page)[0]).toBe('S151')
    expect(pagerState(page)[0]).toMatchObject({ range: '151–160 of 160 trades', position: 'Page 4 of 4', next: false })
  })

  it('shows the newest sort when a header is chosen while another sort loads', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await sortBy(page, 'Price', false)
    await sortBy(page, 'Symbol', false)
    await flushPromises()
    slow.waiting[1]?.release(pagedTrades([AAPL, MSFT, XMSX])(undefined, slow.waiting[1].url))
    await flushPromises()
    slow.waiting[0]?.release(pagedTrades([XMSX, MSFT, AAPL])(undefined, slow.waiting[0].url))
    await flushPromises()

    expect(listedSymbols(page)).toEqual(['AAPL', 'MSFT', 'XMSX'])
    expect(sortState(page).find(([name]) => name === 'Symbol')?.[1]).toBe('ascending')
    expect(blotter(page).findAll('thead th[aria-sort]')).toHaveLength(1)
  })

  it('shows the newest filters\' results even when an older request answers last', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await setFilters(page, { side: 'Buy' })
    await apply(page)
    await setFilters(page, { side: 'Sell' })
    await apply(page)
    expect(slow.waiting.map((request) => request.url))
      .toEqual(['/trades/page?side=Buy&page=1&pageSize=50', '/trades/page?side=Sell&page=1&pageSize=50'])

    slow.waiting[1]?.release(pagedTrades([MSFT])(undefined, slow.waiting[1].url))
    await flushPromises()
    slow.waiting[0]?.release(pagedTrades([XMSX, AAPL])(undefined, slow.waiting[0].url))
    await flushPromises()

    expect(listedSymbols(page)).toEqual(['MSFT'])
    expect(value(page, '#filter-side')).toBe('Sell')
    expect(pagerState(page)[0]).toMatchObject({ range: '1–1 of 1 matching trade' })
  })

  it('ignores an older request that fails after a newer one succeeded', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await setFilters(page, { symbol: 'aa' })
    await apply(page)
    await clear(page)

    slow.waiting[1]?.release(pagedTrades([XMSX, MSFT, AAPL])(undefined, slow.waiting[1].url))
    await flushPromises()
    slow.waiting[0]?.release(problem(500, {}))
    await flushPromises()

    expect(blotter(page).find('[role="alert"]').exists()).toBe(false)
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
  })
})

describe('trade list: booking a trade', () => {
  const BOOKED = trade('n', 4, 'AAPL', 'Buy', '5', '110')

  async function book(page: VueWrapper): Promise<void> {
    await page.find('#trade-symbol').setValue('AAPL')
    await page.find('#trade-side-buy').setValue(true)
    await page.find('#trade-quantity').setValue('5')
    await page.find('#trade-price').setValue('110')
    await bookingForm(page).find('form').trigger('submit')
    await flushPromises()
  }

  const confirmation = (page: VueWrapper): string => bookingForm(page).find('[role="status"]').text()

  it('reloads the same page with the applied filters and sort, never the whole history, and positions without them', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)), 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { symbol: 's' })
    await apply(page)
    await sortBy(page, 'Price')
    await pagerButton(page, 'Next')
    // A change typed but not applied must not be used by the reload.
    await setFilters(page, { side: 'Sell' })

    await book(page)

    expect(server.sequence().slice(-3)).toEqual([
      'POST /trades', 'GET /trades/page?symbol=s&sortBy=price&sortDirection=asc&page=2&pageSize=50', 'GET /positions',
    ])
    expect(server.calls.some((call) => call.method === 'GET' && (call.url === '/trades' || call.url.startsWith('/trades?')))).toBe(false)
    expect(filterValues(page).slice(0, 2)).toEqual(['s', 'Sell'])
    expect(blotter(page).find('.filter-pending').exists()).toBe(true)
    expect(pagerState(page)[0]).toMatchObject({ position: 'Page 2 of 3' })
  })

  it('says the trade is on this page when the reloaded page shows it', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { symbol: 'aa' })
    server.set('GET /trades/page', pagedTrades([AAPL]))
    await apply(page)
    server.set('GET /trades/page', pagedTrades([BOOKED, AAPL]))

    await book(page)

    expect(lastQuery(server)).toEqual(paged([['symbol', 'aa']]))
    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110. It is on this page of the trade list.')
    expect(listedSymbols(page)).toEqual(['AAPL', 'AAPL'])
    expect(pagerState(page)[0]).toMatchObject({ range: '1–2 of 2 matching trades' })
  })

  it('says the trade matches the filters but is on another page, without guessing which', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)), 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { symbol: 'a', side: 'Buy' })
    await apply(page)
    // Sorted by price, the new trade falls on a later page: the reloaded page 1 does not show it.
    server.set('GET /trades/page', pagedTrades([...many(120), BOOKED]))

    await book(page)

    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110. It matches the filters but is on another page of the trade list.')
    expect(pagerState(page)[0]).toMatchObject({ range: '1–50 of 121 matching trades', position: 'Page 1 of 3' })
  })

  it('says the trade is on another page of the list when no filters are applied', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)), 'POST /trades': json(BOOKED, 201) })
    server.set('GET /trades/page', pagedTrades([...many(120), BOOKED]))

    await book(page)

    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110. It is on another page of the trade list.')
  })

  it('says the trade is not in the list when it does not match the applied filters', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { side: 'Sell' })
    server.set('GET /trades/page', pagedTrades([MSFT]))
    await apply(page)

    await book(page)

    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110. It is not in the trade list because it does not match the current filters.')
    expect(listedSymbols(page)).toEqual(['MSFT'])
  })

  it('judges the filters by the API\'s rules: the search is matched in any case, and dates include both ends', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    // BOOKED executed at 2026-01-04 15:00 UTC: 10:00 in New York that day.
    await setFilters(page, { symbol: 'apl', fromDate: '2026-01-04', toDate: '2026-01-04' })
    await apply(page)
    server.set('GET /trades/page', pagedTrades(many(60)))
    await book(page)
    expect(confirmation(page)).toContain('It matches the filters but is on another page')

    await setFilters(page, { fromDate: '2026-01-05', toDate: '2026-01-05' })
    await apply(page)
    await book(page)
    expect(confirmation(page)).toContain('does not match the current filters')
  })

  it('says nothing about where the trade is when other filters were applied while the booking was refreshing', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { side: 'Sell' })
    server.set('GET /trades/page', pagedTrades([MSFT]))
    await apply(page)
    const slow = held()
    server.set('GET /trades/page', slow.route)

    await book(page)
    // While the booking's reload is on its way, the user applies other filters.
    await setFilters(page, { side: 'Buy' })
    await apply(page)
    expect(slow.waiting.map((request) => request.url))
      .toEqual(['/trades/page?side=Sell&page=1&pageSize=50', '/trades/page?side=Buy&page=1&pageSize=50'])
    // The booking's reload answers first, and is stale: the confirmation cannot judge the list from it.
    slow.waiting[0]?.release(pagedTrades([MSFT])(undefined, slow.waiting[0].url))
    await flushPromises()

    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110.')

    slow.waiting[1]?.release(pagedTrades([BOOKED, XMSX, AAPL])(undefined, slow.waiting[1].url))
    await flushPromises()
    expect(listedSymbols(page)).toEqual(['AAPL', 'XMSX', 'AAPL'])
  })

  it('says nothing about where the trade is when the reload failed', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    server.set('GET /trades/page', problem(500, {}))

    await book(page)

    expect(confirmation(page)).toBe('Booked: Buy 5 AAPL at 110.')
    expect(blotter(page).find('[role="alert"]').exists()).toBe(true)
  })
})

describe('trade list: positions', () => {
  it('never sends the filters, sort or page to GET /positions, and keeps positions when the filtered list is empty', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades/page', pagedTrades([]))

    await setFilters(page, { symbol: 'zzz', side: 'Sell', fromDate: '2026-01-01' })
    await apply(page)
    await positionsPanel(page).find('button').trigger('click')
    await flushPromises()

    expect(server.calls.filter((call) => call.url.startsWith('/positions')).map((call) => call.url)).toEqual(['/positions', '/positions'])
    expect(positionsPanel(page).findAll('tbody tr').map((row) => row.find('th').text())).toEqual(['AAPL', 'MSFT'])
    expect(listRequests(server)).toHaveLength(2)
  })

  it('leaves positions alone while paging and sorting: they cover every trade, not the page', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })

    await pagerButton(page, 'Next')
    await sortBy(page, 'Quantity')
    await choosePageSize(page, '25')

    expect(server.calls.filter((call) => call.url.startsWith('/positions'))).toHaveLength(1)
    expect(positionsPanel(page).findAll('tbody tr').map((row) => row.text())).toEqual(['AAPLLong10100', 'MSFTShort-9301.25'])
  })

  it('keeps the positions panel working when the trade list fails', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades/page', problem(500, {}))

    await setFilters(page, { side: 'Buy' })
    await apply(page)

    expect(blotter(page).find('[role="alert"]').exists()).toBe(true)
    expect(positionsPanel(page).find('[role="alert"]').exists()).toBe(false)
    expect(positionsPanel(page).findAll('tbody tr')).toHaveLength(2)
  })

  it('reloads the same page with the applied filters from the Refresh button too', async () => {
    const { server, page } = await openPage({ 'GET /trades/page': pagedTrades(many(120)) })
    await setFilters(page, { side: 'Buy' })
    await apply(page)
    await pagerButton(page, 'Next')

    await blotter(page).find('.panel-heading button').trigger('click')
    await flushPromises()

    expect(listRequests(server).slice(-2).map((request) => request.query)).toEqual([paged([['side', 'Buy']], 2), paged([['side', 'Buy']], 2)])
  })
})
