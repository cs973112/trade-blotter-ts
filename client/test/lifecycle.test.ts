import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { checkReason, isCancellable, isExecutable, REASON_MAX_LENGTH } from '../src/lib/cancellation.ts'
import { positionDirection } from '../src/lib/positions.ts'
import { fakeApi, json, pageJson, positionJson, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

/**
 * The trade lifecycle on the page, against a scripted API: Pending-only booking, the Status column
 * and filter, executing a Pending trade and cancelling one (from Trade History and from Trade
 * Details, with a choice among several for cancelling), the actual position in the Positions grids,
 * and the read-only audit history. Nothing but the id is sent for an execution, and only the reason
 * for a cancellation; the times and the actors come from the server.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const T = '2026-03-01T15:00:00.000Z'
const EXECUTED = tradeJson({ id: 'e1', bookingSequence: 1, symbol: 'MSFT', side: 'Buy', quantity: '10', price: '301.255', notional: '3012.55', executedAt: T })
const PENDING = tradeJson({ id: 'p1', bookingSequence: 2, symbol: 'MSFT', side: 'Sell', quantity: '4', price: '300.125', notional: '1200.5', executedAt: T, status: 'Pending', createdAt: '2026-03-02T10:00:00.000Z' })
const PENDING_2 = tradeJson({ id: 'p2', bookingSequence: 3, symbol: 'MSFT', side: 'Buy', quantity: '2', price: '299.5', notional: '599', executedAt: T, status: 'Pending', createdAt: '2026-03-02T11:00:00.000Z' })
const CANCELLED = tradeJson({
  id: 'c1', bookingSequence: 4, symbol: 'MSFT', side: 'Buy', quantity: '1', price: '1', notional: '1', executedAt: T, status: 'Cancelled',
  cancellationReason: 'Booked in error', cancellationTradeId: 'r1', updatedAt: '2026-03-03T09:00:00.000Z',
})
const ONLY_PENDING = tradeJson({ id: 'n1', bookingSequence: 5, symbol: 'NEWCO', side: 'Buy', quantity: '7', price: '12', notional: '84', executedAt: T, status: 'Pending' })

const POSITIONS = `[${positionJson('MSFT', '10', '301.255', '-2')},${positionJson('NEWCO', '0', '0', '7')}]`
const ALL = [PENDING_2, PENDING, ONLY_PENDING, CANCELLED, EXECUTED]

/** GET /trades/page over ALL: filters by status and by exact symbol as the API does, in the order given. */
function tradesRoute(list: () => readonly string[] = () => ALL): (body: string | undefined, url: string) => FakeResponse {
  return (_body, url) => {
    const parameters = new URL(url, 'http://localhost').searchParams
    const status = parameters.get('status')
    const symbol = parameters.get('symbol')
    const exact = parameters.get('symbolMatch') === 'exact'
    const items = list().filter((text) => {
      const trade = JSON.parse(text) as { status: string; symbol: string }
      return (status === null || trade.status === status) && (symbol === null || (exact ? trade.symbol === symbol : trade.symbol.includes(symbol)))
    })
    const page = Number(parameters.get('page') ?? '1')
    const pageSize = Number(parameters.get('pageSize') ?? '50')
    return pageJson(items.slice((page - 1) * pageSize, page * pageSize), { page, pageSize, totalCount: items.length })
  }
}

/** The answer to cancelling `id`: the trade, now Cancelled, and its cancellation record, as the API writes them. */
function cancellationOf(original: string, reason: string): FakeResponse {
  const trade = JSON.parse(original) as { id: string; symbol: string; side: 'Buy' | 'Sell'; quantity: number; price: number; notional: number; bookingSequence: number }
  const cancelled = tradeJson({
    id: trade.id, bookingSequence: trade.bookingSequence, symbol: trade.symbol, side: trade.side, quantity: String(trade.quantity), price: String(trade.price),
    notional: String(trade.notional), executedAt: T, status: 'Cancelled', cancellationReason: reason, cancellationTradeId: `record-${trade.id}`,
    updatedAt: '2026-03-04T12:00:00.000Z',
  })
  const record = tradeJson({
    id: `record-${trade.id}`, bookingSequence: 99, symbol: trade.symbol, side: trade.side, quantity: String(trade.quantity), price: String(trade.price),
    notional: String(trade.notional), executedAt: T, status: 'Cancelled', cancellationReason: reason, originalTradeId: trade.id,
    createdAt: '2026-03-04T12:00:00.000Z',
  })
  return { status: 201, body: `{"trade":${cancelled},"cancellationRecord":${record}}` }
}

async function openPage(routes: Parameters<typeof fakeApi>[0] = {}, tab: 'trading' | 'details' | 'history' = 'history') {
  const server = fakeApi({ 'GET /trades/page': tradesRoute(), 'GET /positions': json(POSITIONS), ...routes })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  await wrapper.find(`#tab-${tab}`).trigger('click')
  return { server, page: wrapper }
}

const history = (page: VueWrapper): DOMWrapper<Element> => page.find('section[aria-labelledby="blotter-heading"]')
const dialog = (page: VueWrapper): DOMWrapper<Element> => page.find('[role="dialog"]')
const historyRow = (page: VueWrapper, id: string): DOMWrapper<HTMLTableRowElement> => {
  const rows = history(page).findAll<HTMLTableRowElement>('tbody tr')
  const index = ALL.findIndex((text) => (JSON.parse(text) as { id: string }).id === id)
  const found = rows[index]
  if (found === undefined) throw new Error(`no row for ${id}`)
  return found
}
const posts = (server: ReturnType<typeof fakeApi>) => server.calls.filter((call) => call.method === 'POST')
const count = (server: ReturnType<typeof fakeApi>, path: string) => server.calls.filter((call) => call.url.split('?')[0] === path).length

async function book(page: VueWrapper, fields: { symbol: string; side: 'Buy' | 'Sell'; quantity: string; price: string }) {
  await page.find('#trade-symbol').setValue(fields.symbol)
  await page.find(`#trade-side-${fields.side.toLowerCase()}`).setValue(true)
  await page.find('#trade-quantity').setValue(fields.quantity)
  await page.find('#trade-price').setValue(fields.price)
  await page.find('section[aria-labelledby="trade-form-heading"] form').trigger('submit')
  await flushPromises()
}

/** The answer to executing `original`: the same trade, now Executed at the server's time, by User. */
function executionOf(original: string): FakeResponse {
  const trade = JSON.parse(original) as { id: string; symbol: string; side: 'Buy' | 'Sell'; quantity: number; price: number; notional: number; bookingSequence: number; createdAt: string }
  return json(tradeJson({
    id: trade.id, bookingSequence: trade.bookingSequence, symbol: trade.symbol, side: trade.side, quantity: String(trade.quantity), price: String(trade.price),
    notional: String(trade.notional), executedAt: '2026-03-04T12:00:00.000Z', createdAt: trade.createdAt, updatedAt: '2026-03-04T12:00:00.000Z',
  }))
}

const created = (fields: Record<string, string>): FakeResponse => ({ status: 201, body: tradeJson({ id: 'new', bookingSequence: 50, symbol: 'AAPL', side: 'Buy', quantity: '5', price: '10', notional: '50', executedAt: T, ...fields }) })

describe('M7: booking is Pending only', () => {
  it('books Pending, sending no status and no execution time: the form offers neither', async () => {
    const { server, page } = await openPage({ 'POST /trades': created({ status: 'Pending' }) }, 'trading')
    expect(page.find('input[name="status"]').exists()).toBe(false)
    expect(page.find('#trade-executed-at').exists()).toBe(false)

    await book(page, { symbol: 'aapl', side: 'Buy', quantity: '5', price: '10.125' })

    expect(JSON.parse(posts(server)[0]?.body ?? '{}')).toEqual({ symbol: 'aapl', side: 'Buy', quantity: '5', price: '10.125' })
    expect(page.find('section[aria-labelledby="trade-form-heading"] [role="status"]').text()).toContain('Booked as Pending: Buy 5 AAPL at 10.')
    // Both lists are loaded again after the booking.
    expect(count(server, '/positions')).toBe(2)
  })

  it('explains a booking refused at the position limit, keeping what was typed', async () => {
    const limit = problem(400, { type: 'urn:trade-blotter:problem:position-limit', detail: 'The net quantity of AAPL reached the position limit of 1000000000000000.', symbol: 'AAPL' })
    const { page } = await openPage({ 'POST /trades': limit }, 'trading')

    await book(page, { symbol: 'AAPL', side: 'Buy', quantity: '5', price: '10' })

    const alert = page.find('section[aria-labelledby="trade-form-heading"] [role="alert"]').text()
    expect(alert).toContain('The trade was not booked. The net quantity of AAPL reached the position limit')
    expect(alert).toContain('checked against the Executed and Pending trades together')
    expect((page.find('#trade-symbol').element as HTMLInputElement).value).toBe('AAPL')
  })

  it('shows invalid fields before sending, and the API\'s field errors by their fields', async () => {
    const invalid = problem(400, { type: 'urn:trade-blotter:problem:invalid-trade', detail: 'x', errors: { price: ['Price must be greater than zero.'] } })
    const { server, page } = await openPage({ 'POST /trades': invalid }, 'trading')
    await page.find('section[aria-labelledby="trade-form-heading"] form').trigger('submit')
    await flushPromises()
    expect(posts(server)).toHaveLength(0)
    expect(page.find('#trade-symbol-error').text()).toBe('Enter a symbol.')

    await book(page, { symbol: 'AAPL', side: 'Buy', quantity: '5', price: '10' })
    expect(page.find('#trade-price-error').text()).toBe('Price must be greater than zero.')
    expect(document.activeElement?.id).toBe('trade-price')
  })
})

describe('M6 Phase 2: positions show the actual position only', () => {
  /** Every cell of every row of a positions grid, money to its rounded part. */
  const cells = (grid: DOMWrapper<Element>) => grid.findAll('tbody tr').map((row) => row.findAll('th, td').map((cell) => cell.find('.money').exists() ? cell.find('.money').text().split(',')[0] ?? '' : cell.text()))

  it('shows the Executed net and the average cost from Executed trades, and no Pending or Projected net anywhere, nor a way to show them', async () => {
    const { page } = await openPage({}, 'trading')
    const grid = page.find('section[aria-labelledby="positions-heading"]')
    expect(grid.findAll('thead th').map((cell) => cell.find('.column-label').text())).toEqual(['Symbol', 'Direction', 'Executed net', 'Average cost'])
    // MSFT: Executed 10 (Pending -2, Projected 8 in the API's answer); NEWCO: only Pending trades, so Flat.
    expect(cells(grid)).toEqual([['MSFT', 'Long', '10', '301.26'], ['NEWCO', 'Flat', '0', '0.00']])
    expect(grid.find('#positions-resize-help').text()).toContain('Executed net is the actual position: Executed trades only.')
    expect(grid.find('caption').text()).toContain('Executed net is the actual position')

    await grid.find('.column-chooser > button').trigger('click')
    await flushPromises()
    expect(grid.findAll('.column-chooser input[type="checkbox"]').map((box) => box.attributes('data-column'))).toEqual(['symbol', 'direction', 'netQuantity', 'averageCost'])
    expect(grid.find('.column-chooser-panel button.show-all-columns').attributes('aria-disabled')).toBe('true')
    await grid.find('.column-chooser-panel button.show-all-columns').trigger('click')
    await grid.find('.column-chooser-panel button.restore-columns').trigger('click')
    expect(grid.findAll('thead th')).toHaveLength(4)

    // Nowhere on any tab: no label, caption, tooltip or hint names them.
    for (const tab of ['trading', 'details', 'history'] as const) {
      await page.find(`#tab-${tab}`).trigger('click')
      expect(page.html(), tab).not.toMatch(/Pending net|Projected net|pending-net|projected-net/i)
    }
    expect(positionDirection({ executedNetQuantity: '-0.5' })).toBe('Short')
    expect(positionDirection({ executedNetQuantity: '0.000' })).toBe('Flat')
  })

  it('shows the actual position after booking a Pending trade (unchanged), executing it (changed) and cancelling another (unchanged), in both grids and the Trade Details summary', async () => {
    // The API as the server answers: the Executed net and average cost change only on execution;
    // the Pending and Projected net (which the page must not show) change on booking and cancelling.
    let executed = { net: '10', cost: '301.255' }
    let pending = '0'
    const positions = () => json(`[${positionJson('MSFT', executed.net, executed.cost, pending)}]`)
    const booked = (id: string, sequence: number, quantity: string, price: string) => tradeJson({ id, bookingSequence: sequence, symbol: 'MSFT', side: 'Buy', quantity, price, notional: '1', executedAt: T, status: 'Pending', createdAt: '2026-03-05T10:00:00.000Z' })
    let list = [EXECUTED]
    const { server, page } = await openPage({
      'GET /trades/page': tradesRoute(() => list),
      'GET /positions': () => positions(),
      'POST /trades': (body) => {
        const sent = JSON.parse(body ?? '{}') as { quantity: string; price: string }
        const trade = booked(list.length === 1 ? 'b1' : 'b2', 10 + list.length, sent.quantity, sent.price)
        pending = String(Number(pending) + Number(sent.quantity))
        list = [trade, ...list]
        return { status: 201, body: trade }
      },
      'POST /trades/:id/execution': () => {
        // b1: Buy 30 at 299.255 on 10 at 301.255 gives 40 at 299.755.
        executed = { net: '40', cost: '299.755' }
        pending = String(Number(pending) - 30)
        const trade = tradeJson({ id: 'b1', bookingSequence: 11, symbol: 'MSFT', side: 'Buy', quantity: '30', price: '299.255', notional: '1', executedAt: '2026-03-05T11:00:00.000Z', createdAt: '2026-03-05T10:00:00.000Z', updatedAt: '2026-03-05T11:00:00.000Z' })
        list = list.map((text) => text.includes('"id":"b1"') ? trade : text)
        return json(trade)
      },
      'POST /trades/:id/cancellation': (_body, url) => {
        const id = url.split('/')[2] ?? ''
        const original = list.find((text) => text.includes(`"id":"${id}"`)) ?? ''
        pending = String(Number(pending) - 5)
        const answer = cancellationOf(original, 'Withdrawn')
        const cancelled = JSON.stringify((JSON.parse(answer.body) as { trade: unknown }).trade)
        list = list.map((text) => text === original ? cancelled : text)
        return answer
      },
    }, 'trading')
    const trading = () => page.find('section[aria-labelledby="positions-heading"]')
    const master = () => page.find('section[aria-labelledby="master-heading"]')
    const actual = async () => {
      await page.find('#tab-details').trigger('click')
      await master().findAll('tbody tr')[0]?.trigger('click')
      await flushPromises()
      const summary = page.find('section[aria-labelledby="details-heading"] .position-summary').text()
      await page.find('#tab-trading').trigger('click')
      return { trading: cells(trading()), master: cells(master()), summary }
    }
    const shows = (net: string, cost: string) => ({
      trading: [['MSFT', 'Long', net, cost]], master: [['MSFT', 'Long', net, cost]], summary: expect.stringMatching(new RegExp(`Executed net${net}.*Average cost${cost.replace('.', '\\.')}`)) as unknown,
    })
    expect(await actual()).toEqual(shows('10', '301.26'))

    // Booking a Pending Buy of 30: the API's Projected net is 40, but the actual position stays 10.
    await book(page, { symbol: 'MSFT', side: 'Buy', quantity: '30', price: '299.255' })
    expect(server.calls.filter((call) => call.url === '/positions').length).toBeGreaterThanOrEqual(2)
    expect(await actual()).toEqual(shows('10', '301.26'))
    expect(page.html()).not.toMatch(/Projected|Pending net/)

    // Executing it: the actual position becomes 40 at 299.76 (299.755, half to even), everywhere at once.
    await page.find('#tab-history').trigger('click')
    await history(page).find('tbody tr button.execute-trade').trigger('click')
    await flushPromises()
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(await actual()).toEqual(shows('40', '299.76'))

    // Booking a Pending Buy of 5 and cancelling it: the actual position stays 40 at 299.76.
    await book(page, { symbol: 'MSFT', side: 'Buy', quantity: '5', price: '1' })
    expect(await actual()).toEqual(shows('40', '299.76'))
    await page.find('#tab-history').trigger('click')
    await history(page).find('tbody tr button.cancel-trade').trigger('click')
    await flushPromises()
    await page.find('#cancel-reason').setValue('Withdrawn')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(await actual()).toEqual(shows('40', '299.76'))
    expect(page.html()).not.toMatch(/Projected|Pending net/)
  })
})

describe('M5: Trade History statuses', () => {
  it('lists each logical trade once with its status, a dash for no execution time, and Execute and Cancel only on Pending trades', async () => {
    const { page } = await openPage()
    const headers = history(page).findAll('thead th').map((cell) => cell.text().replace(/[↑↓↕].*$/, '').trim())
    expect(headers).toEqual(['Symbol', 'Side', 'Status', 'Actions', 'Quantity', 'Price', 'Notional', 'Executed at', 'Created at', 'Updated at'])
    const statuses = history(page).findAll('tbody .status-badge').map((badge) => badge.text())
    expect(statuses).toEqual(['Pending', 'Pending', 'Pending', 'Cancelled, reason: Booked in error', 'Executed'])
    expect(historyRow(page, 'c1').find('.status-badge').attributes('title')).toBe('Reason: Booked in error')
    expect(historyRow(page, 'p1').find('td.executed .none').attributes('aria-label')).toBe('Not executed')
    for (const id of ['p1', 'p2', 'n1']) {
      expect(historyRow(page, id).find('button.cancel-trade').exists()).toBe(true)
      expect(historyRow(page, id).find('button.execute-trade').exists()).toBe(true)
    }
    for (const id of ['e1', 'c1']) {
      expect(historyRow(page, id).find('button.cancel-trade').exists()).toBe(false)
      expect(historyRow(page, id).find('button.execute-trade').exists()).toBe(false)
    }
    expect(historyRow(page, 'p1').find('button.execute-trade').attributes('aria-label')).toBe('Execute the Pending trade: Sell 4 MSFT at 300.12')
    expect(history(page).find('[role="status"].visually-hidden').text()).toBe('Showing 1–5 of 5 trades, page 1 of 1.')
    expect(isCancellable({ status: 'Executed', originalTradeId: null })).toBe(false)
    expect(isCancellable({ status: 'Cancelled', originalTradeId: null })).toBe(false)
    expect(isExecutable({ status: 'Pending', originalTradeId: null })).toBe(true)
    expect(isExecutable({ status: 'Executed', originalTradeId: null })).toBe(false)
    expect(isExecutable({ status: 'Cancelled', originalTradeId: null })).toBe(false)
    expect(isExecutable({ status: 'Pending', originalTradeId: 'x' })).toBe(false)
  })

  it('filters by status through the API, and says when no trade matches', async () => {
    const { server, page } = await openPage()
    await page.find('#filter-status').setValue('Cancelled')
    await page.find('.trade-filters button[type="submit"]').trigger('click')
    await flushPromises()
    expect(server.calls.at(-1)?.url).toBe('/trades/page?status=Cancelled&page=1&pageSize=50')
    expect(history(page).findAll('tbody tr')).toHaveLength(1)

    server.set('GET /trades/page', pageJson([], { page: 1, pageSize: 50, totalCount: 0 }))
    await page.find('#filter-status').setValue('Pending')
    await page.find('.trade-filters button[type="submit"]').trigger('click')
    await flushPromises()
    expect(history(page).text()).toContain('No trades match these filters.')

    await page.find('.trade-filters button[type="button"]').trigger('click')
    await flushPromises()
    expect((page.find('#filter-status').element as HTMLSelectElement).value).toBe('')
  })
})

describe('M7: executing from Trade History', () => {
  it('asks for confirmation in an accessible dialog, sends only the id, then refreshes the trades and positions and reports the outcome', async () => {
    const { server, page } = await openPage({ 'POST /trades/:id/execution': executionOf(PENDING) })
    const button = historyRow(page, 'p1').find<HTMLButtonElement>('button.execute-trade')
    button.element.focus()
    await button.trigger('click')
    await flushPromises()

    expect(dialog(page).attributes()).toMatchObject({ 'aria-modal': 'true', 'aria-labelledby': 'execute-dialog-heading', 'aria-describedby': 'execute-dialog-intro' })
    expect(page.find('#execute-dialog-heading').text()).toBe('Execute a Pending trade')
    expect(page.find('#execute-dialog-intro').text()).toContain('recorded by User')
    expect(dialog(page).find('.cancel-trade-summary').attributes('aria-label')).toBe('Trade to execute')
    expect(dialog(page).find('.cancel-trade-summary .trade-id').text()).toBe('p1')
    expect(dialog(page).text()).toContain('Sell 4 MSFT at 300.12')
    // Focus starts on the safe choice, and the page behind is inert.
    expect(document.activeElement?.classList.contains('keep-pending')).toBe(true)
    expect(page.find('main').attributes('inert')).toBeDefined()

    const before = { trades: count(server, '/trades/page'), positions: count(server, '/positions') }
    await dialog(page).find('form').trigger('submit')
    await flushPromises()

    expect(posts(server).map((call) => [call.url, call.body, call.headers['content-type']])).toEqual([['/trades/p1/execution', undefined, undefined]])
    expect(dialog(page).exists()).toBe(false)
    expect(page.find('main').attributes('inert')).toBeUndefined()
    expect(count(server, '/trades/page')).toBe(before.trades + 1)
    expect(count(server, '/positions')).toBe(before.positions + 1)
    const outcome = page.find('#history-execution-outcome')
    expect(outcome.text()).toBe('Executed: Sell 4 MSFT at 300.12, recorded by User. It now counts in the Executed net and average cost.')
    // The list still shows p1 as Pending here (the scripted list does not change), so its button takes focus back.
    expect(document.activeElement).toBe(historyRow(page, 'p1').find('button.execute-trade').element)
  })

  it('sends one execution however often Confirm is pressed while it is on its way, and cannot be closed meanwhile', async () => {
    let release: (() => void) | undefined
    const slow = () => new Promise<FakeResponse>((resolve) => { release = () => { resolve(executionOf(PENDING)) } })
    const { server, page } = await openPage({ 'POST /trades/:id/execution': slow })
    await historyRow(page, 'p1').find('button.execute-trade').trigger('click')
    await flushPromises()
    await dialog(page).find('form').trigger('submit')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    const confirm = dialog(page).find<HTMLButtonElement>('button.confirm-execution')
    expect(confirm.element.disabled).toBe(true)
    expect(confirm.text()).toBe('Executing…')
    expect(confirm.attributes('aria-busy')).toBe('true')
    expect(dialog(page).find<HTMLButtonElement>('button.keep-pending').element.disabled).toBe(true)
    await dialog(page).trigger('keydown', { key: 'Escape' })
    expect(dialog(page).exists()).toBe(true)
    release?.()
    await flushPromises()
    expect(posts(server)).toHaveLength(1)
    expect(dialog(page).exists()).toBe(false)
  })

  it.each([
    ['a trade already executed (409)', problem(409, { type: 'urn:trade-blotter:problem:invalid-transition', detail: 'Trade p1 is already executed.', tradeId: 'p1' }),
      'The trade was not executed. Trade p1 is already executed. The lists have been refreshed.', true],
    ['a trade cancelled meanwhile (409)', problem(409, { type: 'urn:trade-blotter:problem:invalid-transition', detail: 'Trade p1 is cancelled; only a Pending trade can be executed.', tradeId: 'p1' }),
      'The trade was not executed. Trade p1 is cancelled; only a Pending trade can be executed. The lists have been refreshed.', true],
    ['a trade that no longer exists (404)', problem(404, { type: 'urn:trade-blotter:problem:trade-not-found', detail: 'No trade has the id p1.', tradeId: 'p1' }),
      'The trade was not executed. The trade no longer exists. The lists have been refreshed.', true],
    ['the position limit (409)', problem(409, { type: 'urn:trade-blotter:problem:position-limit', detail: 'Trade p1 was not executed: The net quantity of MSFT reached the position limit of 1e30. It stays Pending.', symbol: 'MSFT' }),
      'Trade p1 was not executed: The net quantity of MSFT reached the position limit of 1e30. It stays Pending. Executing other trades of MSFT first may make room for it. The lists have been refreshed.', true],
    ['a request the API did not accept (400)', problem(400, { type: 'urn:trade-blotter:problem:invalid-execution', detail: 'Unexpected member x' }),
      'The trade was not executed. The execution request was not accepted. Reload the page and try again.', false],
    ['a server failure (500)', problem(500, { detail: 'SQLITE_BUSY' }), 'The trade was not executed. The server could not complete the request. Try again in a moment.', false],
  ])('reports %s in the dialog, refreshing the lists when the trade is no longer Pending', async (_name, response, message, final) => {
    const { server, page } = await openPage({ 'POST /trades/:id/execution': response })
    await historyRow(page, 'p1').find('button.execute-trade').trigger('click')
    await flushPromises()
    const before = count(server, '/trades/page')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()

    expect(dialog(page).find('[role="alert"]').text()).toBe(message)
    expect(dialog(page).text()).not.toContain('SQLITE')
    expect(document.activeElement?.classList.contains('dialog-error')).toBe(true)
    expect(count(server, '/trades/page')).toBe(final ? before + 1 : before)
    expect(dialog(page).find('button.confirm-execution').exists()).toBe(!final)
    expect(dialog(page).find('button.keep-pending').text()).toBe(final ? 'Close' : 'Keep Pending')
  })

  it('closes with Escape or Keep Pending, sends nothing, and gives focus back to the button that opened it; Tab stays in the dialog', async () => {
    const { server, page } = await openPage()
    const button = historyRow(page, 'p2').find<HTMLButtonElement>('button.execute-trade')
    button.element.focus()
    await button.trigger('click')
    await flushPromises()
    await dialog(page).trigger('keydown', { key: 'Tab' })
    await dialog(page).trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
    expect(document.activeElement).toBe(historyRow(page, 'p2').find('button.execute-trade').element)

    await historyRow(page, 'p2').find('button.execute-trade').trigger('click')
    await flushPromises()
    await dialog(page).find('button.keep-pending').trigger('click')
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
    expect(posts(server)).toHaveLength(0)
  })

  it('opens nothing for a trade that is not Pending', async () => {
    const { page } = await openPage()
    const { useExecutionStore } = await import('../src/stores/execution.ts')
    useExecutionStore().openFor(JSON.parse(EXECUTED) as never, 'history')
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
  })
})

describe('M5: cancelling from Trade History', () => {
  it('asks for a reason and confirmation, sends only the reason, then refreshes the trades and positions and reports the outcome', async () => {
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': cancellationOf(PENDING, 'Client withdrew') })
    const button = historyRow(page, 'p1').find<HTMLButtonElement>('button.cancel-trade')
    expect(button.attributes('aria-label')).toBe('Cancel the Pending trade: Sell 4 MSFT at 300.12')
    button.element.focus()
    await button.trigger('click')
    await flushPromises()

    expect(dialog(page).attributes('aria-modal')).toBe('true')
    expect(dialog(page).text()).toContain('Sell 4 MSFT at 300.12')
    expect(dialog(page).find('.cancel-trade-summary .trade-id').text()).toBe('p1')
    expect(document.activeElement?.id).toBe('cancel-reason')
    // The page behind is inert while the dialog is open.
    expect(page.find('main').attributes('inert')).toBeDefined()

    // Confirming without a reason sends nothing.
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server)).toHaveLength(0)
    expect(page.find('#cancel-reason-error').text()).toBe('Enter a reason for the cancellation.')

    const before = { trades: count(server, '/trades/page'), positions: count(server, '/positions') }
    await page.find('#cancel-reason').setValue('  Client withdrew  ')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()

    expect(posts(server).map((call) => [call.url, call.body])).toEqual([['/trades/p1/cancellation', '{"reason":"Client withdrew"}']])
    expect(dialog(page).exists()).toBe(false)
    expect(page.find('main').attributes('inert')).toBeUndefined()
    expect(count(server, '/trades/page')).toBe(before.trades + 1)
    expect(count(server, '/positions')).toBe(before.positions + 1)
    const outcome = page.find('#history-cancellation-outcome')
    expect(outcome.text()).toBe('Cancelled: Sell 4 MSFT at 300.12. Reason: Client withdrew. Cancellation record record-p1, recorded by Admin.')
  })

  it('sends one cancellation however often Confirm is pressed while it is on its way', async () => {
    let release: (() => void) | undefined
    const slow = () => new Promise<FakeResponse>((resolve) => { release = () => { resolve(cancellationOf(PENDING, 'Twice')) } })
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': slow })
    await historyRow(page, 'p1').find('button.cancel-trade').trigger('click')
    await page.find('#cancel-reason').setValue('Twice')
    await dialog(page).find('form').trigger('submit')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    const confirm = dialog(page).find<HTMLButtonElement>('button[type="submit"]')
    expect(confirm.element.disabled).toBe(true)
    expect(confirm.text()).toBe('Cancelling…')
    // Escape does not close it while sending.
    await dialog(page).trigger('keydown', { key: 'Escape' })
    expect(dialog(page).exists()).toBe(true)
    release?.()
    await flushPromises()
    expect(posts(server)).toHaveLength(1)
    expect(dialog(page).exists()).toBe(false)
  })

  it('shows the API\'s reason message by the reason, and checks control characters and the length before sending', async () => {
    const refused = problem(400, { type: 'urn:trade-blotter:problem:invalid-cancellation', detail: 'Reason is required.', errors: { reason: ['Reason must not contain control or invisible characters.'] } })
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': refused })
    await historyRow(page, 'p1').find('button.cancel-trade').trigger('click')
    await page.find('#cancel-reason').setValue('tab\there')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server)).toHaveLength(0)
    expect(page.find('#cancel-reason-error').text()).toContain('control or invisible characters')

    await page.find('#cancel-reason').setValue('x'.repeat(REASON_MAX_LENGTH + 1))
    await dialog(page).find('form').trigger('submit')
    expect(page.find('#cancel-reason-error').text()).toBe('The reason can be at most 500 characters.')

    await page.find('#cancel-reason').setValue('Fine by the page')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server)).toHaveLength(1)
    expect(page.find('#cancel-reason-error').text()).toBe('Reason must not contain control or invisible characters.')
    expect(document.activeElement?.id).toBe('cancel-reason')
    expect(checkReason('  ok ')).toEqual({ ok: true, value: 'ok' })
    expect(checkReason('é'.normalize('NFD').repeat(500)).ok).toBe(true)
  })

  it('reports a trade already cancelled (409), refreshes the lists, and offers only Close', async () => {
    const conflict = problem(409, { type: 'urn:trade-blotter:problem:invalid-transition', detail: 'Trade p1 is already cancelled.', tradeId: 'p1' })
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': conflict })
    await historyRow(page, 'p1').find('button.cancel-trade').trigger('click')
    await page.find('#cancel-reason').setValue('Again')
    const before = count(server, '/trades/page')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(dialog(page).find('[role="alert"]').text()).toBe('The trade was not cancelled. Trade p1 is already cancelled. The lists have been refreshed.')
    expect(count(server, '/trades/page')).toBe(before + 1)
    expect(dialog(page).find('button[type="submit"]').exists()).toBe(false)
    expect(dialog(page).find('.dialog-actions button').text()).toBe('Close')
  })

  it('reports a trade that no longer exists (404)', async () => {
    const missing = problem(404, { type: 'urn:trade-blotter:problem:trade-not-found', detail: 'No trade has the id p1.', tradeId: 'p1' })
    const { page } = await openPage({ 'POST /trades/:id/cancellation': missing })
    await historyRow(page, 'p1').find('button.cancel-trade').trigger('click')
    await page.find('#cancel-reason').setValue('Gone')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(dialog(page).find('[role="alert"]').text()).toBe('The trade was not cancelled. The trade no longer exists. The lists have been refreshed.')
  })

  it('closes with Escape or Keep trade, sends nothing, and gives focus back to the button that opened it; Tab stays in the dialog', async () => {
    const { server, page } = await openPage()
    const button = historyRow(page, 'p2').find<HTMLButtonElement>('button.cancel-trade')
    button.element.focus()
    await button.trigger('click')
    await flushPromises()
    const controls = dialog(page).findAll<HTMLElement>('input, button')
    controls.at(-1)?.element.focus()
    await dialog(page).trigger('keydown', { key: 'Tab' })
    // jsdom has no layout, so only the wrap from the last control is checked when controls have boxes; Escape always closes.
    await dialog(page).trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
    expect(document.activeElement).toBe(historyRow(page, 'p2').find('button.cancel-trade').element)

    await historyRow(page, 'p2').find('button.cancel-trade').trigger('click')
    await flushPromises()
    await dialog(page).findAll('.dialog-actions button').at(-1)?.trigger('click')
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
    expect(posts(server)).toHaveLength(0)
  })
})

describe('M5: Positions & Trade Details', () => {
  async function chooseMsft(page: VueWrapper): Promise<void> {
    const row = page.find('section[aria-labelledby="master-heading"]').findAll('tbody tr').find((candidate) => candidate.find('th').text() === 'MSFT')
    await row?.trigger('click')
    await flushPromises()
  }
  const detailsPanel = (page: VueWrapper) => page.find('section[aria-labelledby="details-heading"]')

  it('shows the actual position of the chosen symbol and a Status column, with Execute and Cancel only on its Pending trades', async () => {
    const { page } = await openPage({}, 'details')
    await chooseMsft(page)
    const summary = detailsPanel(page).find('.position-summary').text()
    expect(summary).toContain('Executed net10')
    expect(summary).not.toContain('Pending net')
    expect(summary).not.toContain('Projected net')
    expect(summary).toMatch(/Average cost301\.26/)
    const statuses = detailsPanel(page).findAll('tbody .status-badge').map((badge) => badge.text().split(',')[0])
    expect(statuses).toEqual(['Pending', 'Pending', 'Cancelled', 'Executed'])
    expect(detailsPanel(page).findAll('tbody button.cancel-trade')).toHaveLength(2)
    expect(detailsPanel(page).findAll('tbody button.execute-trade')).toHaveLength(2)
  })

  it('executes from a row of the details grid, then reloads the details and the positions, and reports it there', async () => {
    const { server, page } = await openPage({ 'POST /trades/:id/execution': executionOf(PENDING) }, 'details')
    await chooseMsft(page)
    const before = { details: server.calls.filter((call) => call.url.includes('symbolMatch=exact')).length, positions: count(server, '/positions') }
    await detailsPanel(page).findAll('tbody button.execute-trade').at(1)?.trigger('click')
    await flushPromises()
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server).map((call) => call.url)).toEqual(['/trades/p1/execution'])
    expect(server.calls.filter((call) => call.url.includes('symbolMatch=exact')).length).toBeGreaterThan(before.details)
    expect(count(server, '/positions')).toBe(before.positions + 1)
    expect(page.find('#details-execution-outcome').text()).toContain('Executed: Sell 4 MSFT at 300.12')
  })

  it('cancels one of several Pending trades of the symbol, chosen by its details, from the summary\'s button', async () => {
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': cancellationOf(PENDING_2, 'Duplicate') }, 'details')
    await chooseMsft(page)
    await detailsPanel(page).find('button.cancel-pending').trigger('click')
    await flushPromises()
    expect(server.calls.at(-1)?.url).toBe('/trades/page?symbol=MSFT&symbolMatch=exact&status=Pending&page=1&pageSize=100')
    const choices = dialog(page).findAll('.cancel-choice')
    expect(choices.map((choice) => choice.text().replace(/\s+/g, ' '))).toEqual([
      expect.stringMatching(/^Buy 2 at 299\.50, booked .*, ID p2$/),
      expect.stringMatching(/^Sell 4 at 300\.12.*, booked .*, ID p1$/),
    ])
    await page.find('#cancel-reason').setValue('Duplicate')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server)).toHaveLength(0)
    expect(page.find('#cancel-choice-error').text()).toBe('Choose the trade to cancel.')

    await choices[0]?.find('input').setValue(true)
    const detailLoads = server.calls.filter((call) => call.url.includes('symbolMatch=exact')).length
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server).map((call) => call.url)).toEqual(['/trades/p2/cancellation'])
    expect(page.find('#details-cancellation-outcome').text()).toContain('Cancelled: Buy 2 MSFT at 299.50. Reason: Duplicate.')
    // The details' own page is loaded again, besides the trade list and positions.
    expect(server.calls.filter((call) => call.url.includes('symbolMatch=exact')).length).toBeGreaterThan(detailLoads)
  })

  it('cancels from a row of the details grid', async () => {
    const { server, page } = await openPage({ 'POST /trades/:id/cancellation': cancellationOf(PENDING, 'Row') }, 'details')
    await chooseMsft(page)
    await detailsPanel(page).findAll('tbody button.cancel-trade').at(1)?.trigger('click')
    await flushPromises()
    await page.find('#cancel-reason').setValue('Row')
    await dialog(page).find('form').trigger('submit')
    await flushPromises()
    expect(posts(server).map((call) => call.url)).toEqual(['/trades/p1/cancellation'])
  })

  it('drops the Pending trades of a symbol that arrive after the dialog was closed', async () => {
    let release: (() => void) | undefined
    const { server, page } = await openPage({}, 'details')
    await chooseMsft(page)
    server.set('GET /trades/page', (body, url) => url.includes('status=Pending')
      ? new Promise<FakeResponse>((resolve) => { release = () => { resolve(tradesRoute()(body, url)) } })
      : tradesRoute()(body, url))
    await detailsPanel(page).find('button.cancel-pending').trigger('click')
    expect(dialog(page).text()).toContain('Loading the Pending trades in MSFT')
    await dialog(page).trigger('keydown', { key: 'Escape' })
    await flushPromises()
    release?.()
    await flushPromises()
    expect(dialog(page).exists()).toBe(false)
  })

  it('shows the audit history read only: the original\'s entries and its cancellation record\'s, by User, Admin and System', async () => {
    const snapshot = (fields: Record<string, unknown>) => JSON.stringify({
      bookingSequence: 4, id: 'c1', symbol: 'MSFT', side: 'Buy', quantity: 1, price: 1.005, executedAt: null, createdAt: '2026-03-02T10:00:00.000Z',
      updatedAt: '2026-03-02T10:00:00.000Z', quantityKey: 'k', priceKey: 'k', status: 'Pending', createdBy: 'User', updatedBy: 'User', originalTradeId: null,
      cancellationReason: null, ...fields,
    })
    const entries = [
      `{"auditId":10,"auditAction":"Inserted","auditOn":"2026-03-02T10:00:00.000Z","auditBy":"System","trade":${snapshot({})}}`,
      `{"auditId":11,"auditAction":"Updated","auditOn":"2026-03-03T09:00:00.000Z","auditBy":"System","trade":${snapshot({ status: 'Cancelled', updatedBy: 'Admin', updatedAt: '2026-03-03T09:00:00.000Z' })}}`,
      `{"auditId":12,"auditAction":"Inserted","auditOn":"2026-03-03T09:00:00.000Z","auditBy":"System","trade":${snapshot({ id: 'r1', bookingSequence: 9, status: 'Cancelled', createdBy: 'Admin', updatedBy: 'Admin', originalTradeId: 'c1', cancellationReason: 'Booked in error' })}}`,
    ]
    const audit = json(`{"tradeId":"c1","scope":"logical","tradeIds":["c1","r1"],"items":[${entries.join(',')}],"page":1,"pageSize":25,"totalCount":3,"totalPages":1}`)
    const { server, page } = await openPage({ 'GET /trades/:id/audit': audit }, 'details')
    await chooseMsft(page)
    await detailsPanel(page).findAll('tbody button.show-history').at(2)?.trigger('click')
    await flushPromises()
    expect(server.calls.at(-1)?.url).toBe('/trades/c1/audit?scope=logical&page=1&pageSize=25')
    const rows = page.findAll('.audit-table tbody tr').map((row) => row.findAll('th, td').map((cell) => cell.text().split(',')[0]?.trim()))
    expect(rows.map((row) => row[0])).toEqual(['Trade booked by User as Pending', 'Trade cancelled by Admin', 'Cancellation record created by Admin'])
    expect(rows.map((row) => [row[1], row[3], row[4], row[5], row[6], row[7], row[8]])).toEqual([
      ['Inserted', 'System', 'c1', '—', 'Pending', 'User', 'User'],
      ['Updated', 'System', 'c1', '—', 'Cancelled', 'User', 'Admin'],
      ['Inserted', 'System', 'r1', 'c1', 'Cancelled', 'Admin', 'Admin'],
    ])
    // The price to 2 places, half to even, the exact value kept.
    expect(page.find('.audit-table td.price .money').text()).toMatch(/^1\.00/)
    expect(page.find('.audit-table td.price .money').attributes('title')).toBe('Exactly 1.005')
    expect(page.find('.audit-summary').text()).toBe('3 entries for trade c1 and its cancellation record, oldest first.')
    expect(document.activeElement?.id).toBe('audit-heading')
    // Read only: no control writes an entry.
    expect(page.find('.audit-history').findAll('button').map((button) => button.text())).toEqual(['Refresh', 'Close'])
  })

  it('describes an execution in the audit history as executed by User', async () => {
    const snapshot = (fields: Record<string, unknown>) => JSON.stringify({
      bookingSequence: 2, id: 'p1', symbol: 'MSFT', side: 'Sell', quantity: 4, price: 300.125, executedAt: null, createdAt: '2026-03-02T10:00:00.000Z',
      updatedAt: '2026-03-02T10:00:00.000Z', quantityKey: 'k', priceKey: 'k', status: 'Pending', createdBy: 'User', updatedBy: 'User', originalTradeId: null,
      cancellationReason: null, ...fields,
    })
    const entries = [
      `{"auditId":20,"auditAction":"Inserted","auditOn":"2026-03-02T10:00:00.000Z","auditBy":"System","trade":${snapshot({})}}`,
      `{"auditId":21,"auditAction":"Updated","auditOn":"2026-03-04T12:00:00.000Z","auditBy":"System","trade":${snapshot({ status: 'Executed', executedAt: '2026-03-04T12:00:00.000Z', updatedAt: '2026-03-04T12:00:00.000Z' })}}`,
    ]
    const audit = json(`{"tradeId":"p1","scope":"logical","tradeIds":["p1"],"items":[${entries.join(',')}],"page":1,"pageSize":25,"totalCount":2,"totalPages":1}`)
    const { page } = await openPage({ 'GET /trades/:id/audit': audit }, 'details')
    await chooseMsft(page)
    await detailsPanel(page).findAll('tbody button.show-history').at(1)?.trigger('click')
    await flushPromises()
    expect(page.findAll('.audit-table tbody tr').map((row) => row.find('th, td').text().split(',')[0]?.trim())).toEqual(['Trade booked by User as Pending', 'Trade executed by User'])
  })

  it('keeps only the newest audit history asked for: a late answer for another trade is dropped', async () => {
    let releaseFirst: (() => void) | undefined
    const answer = (id: string) => json(`{"tradeId":"${id}","scope":"logical","tradeIds":["${id}"],"items":[],"page":1,"pageSize":25,"totalCount":0,"totalPages":0}`)
    const { page } = await openPage({
      'GET /trades/:id/audit': (_body, url) => url.startsWith('/trades/p2/')
        ? new Promise<FakeResponse>((resolve) => { releaseFirst = () => { resolve(answer('p2')) } })
        : answer('p1'),
    }, 'details')
    await chooseMsft(page)
    const buttons = detailsPanel(page).findAll('tbody button.show-history')
    await buttons.at(0)?.trigger('click')
    await buttons.at(1)?.trigger('click')
    await flushPromises()
    releaseFirst?.()
    await flushPromises()
    expect(page.find('#audit-heading').text()).toBe('Audit history: trade p1')
    expect(page.find('.audit-history').text()).toContain('No audit entries for this trade.')
  })
})
