import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { fakeApi, json, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

/**
 * The trade list's search, filter and sort controls on the whole page, against a scripted API.
 * Dates are entered as the browser's local dates; the tests run in America/New_York, which
 * local-dates.test.ts checks is applied.
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

async function openPage(routes: Parameters<typeof fakeApi>[0] = {}) {
  const server = fakeApi({ 'GET /trades': json(`[${XMSX},${MSFT},${AAPL}]`), 'GET /positions': json(POSITIONS), ...routes })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  return { server, page: wrapper }
}

const blotter = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="blotter-heading"]')
const bookingForm = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="trade-form-heading"]')
const positionsPanel = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="positions-heading"]')
const listedSymbols = (page: VueWrapper): string[] => blotter(page).findAll('tbody th').map((cell) => cell.text())
const value = (page: VueWrapper, selector: string): string => (page.find(selector).element as HTMLInputElement | HTMLSelectElement).value

/** The query of every GET /trades request, as [name, value] pairs. */
const tradeQueries = (server: ReturnType<typeof fakeApi>): string[][][] =>
  server.calls.filter((call) => call.method === 'GET' && call.url.startsWith('/trades'))
    .map((call) => [...new URL(call.url, 'http://localhost').searchParams.entries()])

const lastTradeQuery = (server: ReturnType<typeof fakeApi>): string[][] => tradeQueries(server).at(-1) ?? []

async function setFilters(page: VueWrapper, filters: {
  symbol?: string; side?: string; fromDate?: string; toDate?: string; sortBy?: string; sortDirection?: string
}): Promise<void> {
  if (filters.symbol !== undefined) await page.find('#filter-symbol').setValue(filters.symbol)
  if (filters.side !== undefined) await page.find('#filter-side').setValue(filters.side)
  if (filters.fromDate !== undefined) await page.find('#filter-from-date').setValue(filters.fromDate)
  if (filters.toDate !== undefined) await page.find('#filter-to-date').setValue(filters.toDate)
  if (filters.sortBy !== undefined) await page.find('#filter-sort-by').setValue(filters.sortBy)
  if (filters.sortDirection !== undefined) await page.find('#filter-sort-direction').setValue(filters.sortDirection)
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

/** A route that answers only when released, so tests control the order responses arrive in. */
function held() {
  const waiting: { url: string; release: (response: FakeResponse) => void }[] = []
  const route = (_body: string | undefined, url: string) => new Promise<FakeResponse>((resolve) => {
    waiting.push({ url, release: resolve })
  })
  return { route, waiting }
}

describe('trade history controls: without any filter', () => {
  it('loads every trade with plain GET /trades, as before, and shows the defaults', async () => {
    const { server, page } = await openPage()

    expect(server.sequence()).toEqual(['GET /trades', 'GET /positions'])
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
    expect([value(page, '#filter-symbol'), value(page, '#filter-side'), value(page, '#filter-from-date'), value(page, '#filter-to-date'),
      value(page, '#filter-sort-by'), value(page, '#filter-sort-direction')]).toEqual(['', '', '', '', 'executedAt', 'desc'])
    expect(blotter(page).text()).not.toContain('matching')
    expect(blotter(page).find('caption').text()).toContain('Every trade, newest execution first.')
  })

  it('sends plain GET /trades again when Apply is pressed with the defaults', async () => {
    const { server, page } = await openPage()

    await apply(page)

    expect(server.calls.at(-1)?.url).toBe('/trades')
  })
})

describe('trade history controls: accessibility', () => {
  it('labels every control and groups them as a search form', async () => {
    const { page } = await openPage()
    const form = page.find('form.trade-filters')

    expect(form.attributes('role')).toBe('search')
    expect(form.attributes('aria-label')).toBe('Search, filter and sort trades')
    const labels = form.findAll('label').map((label) => [label.attributes('for'), label.text()])
    expect(labels).toEqual([
      ['filter-symbol', 'Symbol'], ['filter-side', 'Side'], ['filter-from-date', 'From'], ['filter-to-date', 'To'],
      ['filter-sort-by', 'Sort by'], ['filter-sort-direction', 'Order'],
    ])
    for (const [id] of labels) expect(form.find(`#${id ?? ''}`).exists()).toBe(true)
    expect(form.find('#filter-from-date').attributes('type')).toBe('date')
    expect(form.find('#filter-from-date').attributes('aria-describedby')).toBe('filter-dates-hint')
    expect(form.find('#filter-dates-hint').text()).toContain('calendar dates in your time zone (America/New_York), and both are included')
    expect(form.findAll('button').map((button) => [button.text(), button.attributes('type')])).toEqual([['Apply', 'submit'], ['Clear', 'button']])
  })

  it('offers All, Buy and Sell, the four sort fields, and directions named for the field', async () => {
    const { page } = await openPage()
    const options = (id: string) => page.findAll(`#${id} option`).map((option) => [option.attributes('value'), option.text()])

    expect(options('filter-side')).toEqual([['', 'All'], ['Buy', 'Buy'], ['Sell', 'Sell']])
    expect(options('filter-sort-by')).toEqual([
      ['executedAt', 'Execution date'], ['symbol', 'Symbol'], ['quantity', 'Quantity'], ['price', 'Price'],
    ])
    expect(options('filter-sort-direction')).toEqual([['desc', 'Newest first'], ['asc', 'Oldest first']])

    await setFilters(page, { sortBy: 'price' })

    expect(options('filter-sort-direction')).toEqual([['asc', 'Ascending'], ['desc', 'Descending']])
  })

  it('applies with Enter in the symbol field, since the controls are one form', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms' })
    await page.find('form.trade-filters').trigger('submit')
    await flushPromises()

    expect(lastTradeQuery(server)).toEqual([['symbol', 'ms']])
  })
})

describe('trade history controls: apply and clear', () => {
  it('changes nothing until Apply, then requests exactly what was chosen', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms', side: 'Sell' })
    await flushPromises()

    expect(server.sequence()).toEqual(['GET /trades', 'GET /positions'])
    expect(blotter(page).find('.filter-pending').text()).toBe('Changes not applied yet.')

    server.set('GET /trades', json(`[${MSFT}]`))
    await apply(page)

    expect(lastTradeQuery(server)).toEqual([['symbol', 'ms'], ['side', 'Sell']])
    expect(listedSymbols(page)).toEqual(['MSFT'])
    expect(blotter(page).find('.filter-pending').exists()).toBe(false)
    expect(blotter(page).text()).toContain('1 matching trade.')
    expect(blotter(page).find('caption').text()).toContain('Trades matching the filters, newest execution first.')
  })

  it.each([['Buy'], ['Sell']])('filters by side %s', async (side) => {
    const { server, page } = await openPage()

    await setFilters(page, { side })
    await apply(page)

    expect(lastTradeQuery(server)).toEqual([['side', side]])
  })

  it.each([['MSFT'], ['ms'], ['sf'], ['  xMs  ']])('sends the symbol search %j trimmed, for the API to match anywhere', async (symbol) => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol })
    await apply(page)

    expect(lastTradeQuery(server)).toEqual([['symbol', symbol.trim()]])
  })

  it('combines symbol, side, local dates and sort in one request, with the dates as UTC day boundaries', async () => {
    const { server, page } = await openPage()

    await setFilters(page, { symbol: 'ms', side: 'Buy', fromDate: '2026-03-08', toDate: '2026-11-01', sortBy: 'quantity', sortDirection: 'asc' })
    await apply(page)

    expect(lastTradeQuery(server)).toEqual([
      ['symbol', 'ms'], ['side', 'Buy'],
      // 2026-03-08 begins at 00:00 EST; 2026-11-01 ends at 23:59:59.999 EST, after the clocks went back.
      ['executedFrom', '2026-03-08T05:00:00.000Z'], ['executedTo', '2026-11-02T04:59:59.999Z'],
      ['sortBy', 'quantity'], ['sortDirection', 'asc'],
    ])
  })

  it.each([
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'], // 23 hours: the clocks go forward
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'], // 25 hours: the clocks go back
    ['2026-06-15', '2026-06-15T04:00:00.000Z', '2026-06-16T03:59:59.999Z'],
  ])('sends the local day %s as %s to %s', async (date, from, to) => {
    const { server, page } = await openPage()

    await setFilters(page, { fromDate: date, toDate: date })
    await apply(page)

    expect(lastTradeQuery(server)).toEqual([['executedFrom', from], ['executedTo', to]])
  })

  it.each([
    ['executedAt', 'asc', [['sortBy', 'executedAt'], ['sortDirection', 'asc']]],
    ['executedAt', 'desc', []],
    ['symbol', 'asc', [['sortBy', 'symbol'], ['sortDirection', 'asc']]],
    ['symbol', 'desc', [['sortBy', 'symbol'], ['sortDirection', 'desc']]],
    ['quantity', 'asc', [['sortBy', 'quantity'], ['sortDirection', 'asc']]],
    ['quantity', 'desc', [['sortBy', 'quantity'], ['sortDirection', 'desc']]],
    ['price', 'asc', [['sortBy', 'price'], ['sortDirection', 'asc']]],
    ['price', 'desc', [['sortBy', 'price'], ['sortDirection', 'desc']]],
  ])('sorts by %s %s, and lists the trades in the order the API returns', async (sortBy, sortDirection, expected) => {
    const { server, page } = await openPage()
    server.set('GET /trades', json(`[${AAPL},${XMSX},${MSFT}]`))

    await setFilters(page, { sortBy, sortDirection })
    await apply(page)

    expect(lastTradeQuery(server)).toEqual(expected)
    expect(listedSymbols(page)).toEqual(['AAPL', 'XMSX', 'MSFT'])
  })

  it('names the sort in the table caption', async () => {
    const { page } = await openPage()

    await setFilters(page, { sortBy: 'price', sortDirection: 'asc' })
    await apply(page)

    expect(blotter(page).find('caption').text()).toContain('Every trade, sorted by price, ascending.')
  })

  it('Clear resets every control and reloads the full history with plain GET /trades', async () => {
    const { server, page } = await openPage()
    await setFilters(page, { symbol: 'ms', side: 'Sell', fromDate: '2026-01-01', toDate: '2026-01-31', sortBy: 'price', sortDirection: 'asc' })
    server.set('GET /trades', json(`[${MSFT}]`))
    await apply(page)
    server.set('GET /trades', json(`[${XMSX},${MSFT},${AAPL}]`))

    await clear(page)

    expect(server.calls.at(-1)?.url).toBe('/trades')
    expect([value(page, '#filter-symbol'), value(page, '#filter-side'), value(page, '#filter-from-date'), value(page, '#filter-to-date'),
      value(page, '#filter-sort-by'), value(page, '#filter-sort-direction')]).toEqual(['', '', '', '', 'executedAt', 'desc'])
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
    expect(blotter(page).text()).not.toContain('matching')
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
})

describe('trade history controls: invalid dates', () => {
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

    expect(lastTradeQuery(server)).toEqual([['executedFrom', '2026-03-09T04:00:00.000Z'], ['executedTo', '2026-03-10T03:59:59.999Z']])
  })
})

describe('trade history controls: loading, empty results and errors', () => {
  it('says the list is updating while a filtered request is in flight, keeping the current rows', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades', slow.route)

    await setFilters(page, { side: 'Buy' })
    await apply(page)

    expect(blotter(page).find('[role="status"]').text()).toBe('Updating trades…')
    expect(blotter(page).find('.table-scroll').attributes('aria-busy')).toBe('true')
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])

    slow.waiting[0]?.release(json(`[${XMSX},${AAPL}]`))
    await flushPromises()

    expect(listedSymbols(page)).toEqual(['XMSX', 'AAPL'])
    expect(blotter(page).find('.table-scroll').attributes('aria-busy')).toBe('false')
  })

  it('says when no trade matches the filters, which is not the same as having no trades', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades', json('[]'))

    await setFilters(page, { symbol: 'zzz' })
    await apply(page)

    expect(blotter(page).find('table').exists()).toBe(false)
    expect(blotter(page).text()).toContain('No trades match these filters. Change them, or choose Clear to see every trade.')
    expect(blotter(page).text()).not.toContain('No trades yet')
  })

  it('still says there are no trades yet when the unfiltered list is empty', async () => {
    const { page } = await openPage({ 'GET /trades': json('[]') })

    expect(blotter(page).text()).toContain('No trades yet. Book one to see it here.')
  })

  it('shows a query the API refused with the trade list, not with the booking form', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades', problem(400, {
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

  it('explains a server failure without its details, and recovers on the next Apply', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades', problem(500, { detail: 'SQLITE_BUSY' }))

    await setFilters(page, { side: 'Sell' })
    await apply(page)

    expect(blotter(page).find('[role="alert"]').text())
      .toBe('Trades could not be loaded. The server could not complete the request. Try again in a moment.')
    expect(page.text()).not.toContain('SQLITE')

    server.set('GET /trades', json(`[${MSFT}]`))
    await apply(page)

    expect(blotter(page).find('[role="alert"]').exists()).toBe(false)
    expect(listedSymbols(page)).toEqual(['MSFT'])
  })
})

describe('trade history controls: requests that finish out of order', () => {
  it('shows the newest query\'s results even when an older request answers last', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades', slow.route)

    await setFilters(page, { side: 'Buy' })
    await apply(page)
    await setFilters(page, { side: 'Sell' })
    await apply(page)
    expect(slow.waiting.map((request) => request.url)).toEqual(['/trades?side=Buy', '/trades?side=Sell'])

    slow.waiting[1]?.release(json(`[${MSFT}]`))
    await flushPromises()
    slow.waiting[0]?.release(json(`[${XMSX},${AAPL}]`))
    await flushPromises()

    expect(listedSymbols(page)).toEqual(['MSFT'])
    expect(value(page, '#filter-side')).toBe('Sell')
    expect(blotter(page).find('[role="status"]').text()).toBe('1 matching trade.')
  })

  it('ignores an older request that fails after a newer one succeeded', async () => {
    const { server, page } = await openPage()
    const slow = held()
    server.set('GET /trades', slow.route)

    await setFilters(page, { symbol: 'aa' })
    await apply(page)
    await clear(page)

    slow.waiting[1]?.release(json(`[${XMSX},${MSFT},${AAPL}]`))
    await flushPromises()
    slow.waiting[0]?.release(problem(500, {}))
    await flushPromises()

    expect(blotter(page).find('[role="alert"]').exists()).toBe(false)
    expect(listedSymbols(page)).toEqual(['XMSX', 'MSFT', 'AAPL'])
  })
})

describe('trade history controls: booking and positions', () => {
  const BOOKED = trade('n', 4, 'AAPL', 'Buy', '5', '110')

  async function book(page: VueWrapper): Promise<void> {
    await page.find('#trade-symbol').setValue('AAPL')
    await page.find('#trade-side-buy').setValue(true)
    await page.find('#trade-quantity').setValue('5')
    await page.find('#trade-price').setValue('110')
    await bookingForm(page).find('form').trigger('submit')
    await flushPromises()
  }

  it('reloads the list with the applied filters after a booking, keeping them, and positions without them', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { symbol: 'ms', sortBy: 'price', sortDirection: 'asc' })
    server.set('GET /trades', json(`[${XMSX},${MSFT}]`))
    await apply(page)
    // A change typed but not applied must not be used by the reload.
    await setFilters(page, { side: 'Sell' })

    await book(page)

    expect(server.sequence().slice(-3)).toEqual([
      'POST /trades', 'GET /trades?symbol=ms&sortBy=price&sortDirection=asc', 'GET /positions',
    ])
    expect([value(page, '#filter-symbol'), value(page, '#filter-side'), value(page, '#filter-sort-by')]).toEqual(['ms', 'Sell', 'price'])
    expect(blotter(page).find('.filter-pending').exists()).toBe(true)
    expect(bookingForm(page).find('[role="status"]').text())
      .toBe('Booked: Buy 5 AAPL at 110. It is not in the trade list because it does not match the current filters.')
  })

  it('does not mention the filters when the booked trade is in the filtered list', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { symbol: 'aa' })
    server.set('GET /trades', json(`[${AAPL}]`))
    await apply(page)
    server.set('GET /trades', json(`[${BOOKED},${AAPL}]`))

    await book(page)

    expect(lastTradeQuery(server)).toEqual([['symbol', 'aa']])
    expect(bookingForm(page).find('[role="status"]').text()).toBe('Booked: Buy 5 AAPL at 110.')
    expect(listedSymbols(page)).toEqual(['AAPL', 'AAPL'])
  })

  it('never sends the trade filters to GET /positions, and keeps positions when the filtered list is empty', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades', json('[]'))

    await setFilters(page, { symbol: 'zzz', side: 'Sell', fromDate: '2026-01-01' })
    await apply(page)
    await positionsPanel(page).find('button').trigger('click')
    await flushPromises()

    expect(server.calls.filter((call) => call.url.startsWith('/positions')).map((call) => call.url)).toEqual(['/positions', '/positions'])
    expect(positionsPanel(page).findAll('tbody tr').map((row) => row.find('th').text())).toEqual(['AAPL', 'MSFT'])
    expect(tradeQueries(server)).toHaveLength(2)
  })

  it('keeps the positions panel working when the trade list fails', async () => {
    const { server, page } = await openPage()
    server.set('GET /trades', problem(500, {}))

    await setFilters(page, { side: 'Buy' })
    await apply(page)

    expect(blotter(page).find('[role="alert"]').exists()).toBe(true)
    expect(positionsPanel(page).find('[role="alert"]').exists()).toBe(false)
    expect(positionsPanel(page).findAll('tbody tr')).toHaveLength(2)
  })

  it('reloads with the applied filters from the Refresh button too', async () => {
    const { server, page } = await openPage()
    await setFilters(page, { side: 'Buy' })
    await apply(page)

    await blotter(page).find('.panel-heading button').trigger('click')
    await flushPromises()

    expect(tradeQueries(server).slice(-2)).toEqual([[['side', 'Buy']], [['side', 'Buy']]])
  })

  it('says nothing about the filters when other filters were applied while the booking was refreshing', async () => {
    const { server, page } = await openPage({ 'POST /trades': json(BOOKED, 201) })
    await setFilters(page, { side: 'Sell' })
    server.set('GET /trades', json(`[${MSFT}]`))
    await apply(page)
    const slow = held()
    server.set('GET /trades', slow.route)

    await book(page)
    // While the booking's reload is on its way, the user applies other filters.
    await setFilters(page, { side: 'Buy' })
    await apply(page)
    expect(slow.waiting.map((request) => request.url)).toEqual(['/trades?side=Sell', '/trades?side=Buy'])
    // The booking's reload answers first, and is stale: the confirmation cannot judge the list from it.
    slow.waiting[0]?.release(json(`[${MSFT}]`))
    await flushPromises()

    expect(bookingForm(page).find('[role="status"]').text()).toBe('Booked: Buy 5 AAPL at 110.')

    slow.waiting[1]?.release(json(`[${BOOKED},${XMSX},${AAPL}]`))
    await flushPromises()
    expect(listedSymbols(page)).toEqual(['AAPL', 'XMSX', 'AAPL'])
  })
})

describe('trade history controls: partly typed dates', () => {
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
