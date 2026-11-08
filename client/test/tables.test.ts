import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Component } from 'vue'

import PositionsPanel from '../src/components/PositionsPanel.vue'
import TradeBlotter from '../src/components/TradeBlotter.vue'
import { useBlotterStore } from '../src/stores/blotter.ts'
import { fakeApi, json, pagedTrades, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

/** Mounts a table and loads its data through the store, as the app does. */
async function show(component: Component, load: 'loadTrades' | 'loadPositions', settle = true): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(component, { global: { plugins: [pinia] } })
  void useBlotterStore()[load]()
  if (settle) await flushPromises()
  return wrapper
}

const pending = (): (() => Promise<FakeResponse>) => () => new Promise<FakeResponse>(() => undefined)

const rows = (table: VueWrapper): string[][] =>
  table.findAll('tbody tr').map((row) => row.findAll('th, td').map((cell) => cell.text()))

describe('trade blotter', () => {
  const newest = tradeJson({
    id: 'b', bookingSequence: 2, symbol: 'MSFT', side: 'Sell',
    quantity: '123456789012345.1234567891', price: '0.0000000001', notional: '12345.67890123451234567891',
    executedAt: '2026-07-01T13:30:15.250Z', createdAt: '2026-07-02T08:00:00.000Z',
  })
  const older = tradeJson({
    id: 'a', bookingSequence: 1, symbol: 'AAPL', side: 'Buy', quantity: '1000', price: '187.5', notional: '187500',
    executedAt: '2026-01-02T14:30:00.123Z', createdAt: '2026-01-02T14:30:01.000Z',
  })

  it('shows every column, in the order the API sends, with exact decimals and local times', async () => {
    fakeApi({ 'GET /trades/page': pagedTrades([newest, older]) })
    const table = await show(TradeBlotter, 'loadTrades')

    // Four headers sort: each shows its state with an arrow, and says what choosing it does.
    expect(table.findAll('thead th').map((cell) => cell.text())).toEqual([
      'Symbol↕, sort ascending', 'Side', 'Quantity↕, sort ascending', 'Price↕, sort ascending', 'Notional',
      'Executed at↓, sort oldest first', 'Created at', 'Updated at',
    ])
    expect(rows(table)).toEqual([
      ['MSFT', 'Sell', '123,456,789,012,345.1234567891', '0.0000000001', '12,345.67890123451234567891',
        '2026-07-01 09:30:15.250 UTC−04:00', '2026-07-02 04:00:00.000 UTC−04:00', '2026-07-02 04:00:00.000 UTC−04:00'],
      ['AAPL', 'Buy', '1,000', '187.5', '187,500',
        '2026-01-02 09:30:00.123 UTC−05:00', '2026-01-02 09:30:01.000 UTC−05:00', '2026-01-02 09:30:01.000 UTC−05:00'],
    ])
  })

  it('keeps the exact UTC value on each time, and separates execution from recording', async () => {
    fakeApi({ 'GET /trades/page': pagedTrades([older]) })
    const table = await show(TradeBlotter, 'loadTrades')

    const [executed, created] = table.findAll('tbody time')
    expect(executed?.attributes('datetime')).toBe('2026-01-02T14:30:00.123Z')
    expect(executed?.attributes('title')).toBe('2026-01-02T14:30:00.123Z (UTC)')
    expect(created?.attributes('datetime')).toBe('2026-01-02T14:30:01.000Z')
    expect(table.find('td.executed').exists()).toBe(true)
    expect(table.findAll('td.recorded')).toHaveLength(2)
    expect(table.text()).toContain('Executed at is when the trade happened')
  })

  it('marks Buy and Sell in words, not only colour', async () => {
    fakeApi({ 'GET /trades/page': pagedTrades([newest, older]) })
    const table = await show(TradeBlotter, 'loadTrades')

    expect(table.findAll('.side-badge').map((badge) => [badge.text(), badge.classes()])).toEqual([
      ['Sell', ['side-badge', 'side-badge-sell']],
      ['Buy', ['side-badge', 'side-badge-buy']],
    ])
  })

  it('says it is loading until the first response', async () => {
    fakeApi({ 'GET /trades/page': pending() })
    const table = await show(TradeBlotter, 'loadTrades', false)
    await flushPromises()

    expect(table.find('[role="status"]').text()).toBe('Loading trades…')
    expect(table.find('table').exists()).toBe(false)
  })

  it('says when there are no trades', async () => {
    fakeApi({ 'GET /trades/page': pagedTrades([]) })
    const table = await show(TradeBlotter, 'loadTrades')

    expect(table.text()).toContain('No trades yet.')
    expect(table.find('table').exists()).toBe(false)
  })

  it('explains a failure without server details, and recovers on refresh', async () => {
    const server = fakeApi({ 'GET /trades/page': problem(500, { detail: 'disk I/O error' }) })
    const table = await show(TradeBlotter, 'loadTrades')

    expect(table.find('[role="alert"]').text()).toBe(
      'Trades could not be loaded. The server could not complete the request. Try again in a moment.',
    )
    expect(table.text()).not.toContain('disk')

    server.set('GET /trades/page', pagedTrades([older]))
    await table.find('button').trigger('click')
    await flushPromises()
    expect(table.find('[role="alert"]').exists()).toBe(false)
    expect(rows(table)).toHaveLength(1)
  })

  it('keeps showing the last trades if a later refresh fails', async () => {
    const server = fakeApi({ 'GET /trades/page': pagedTrades([older]) })
    const table = await show(TradeBlotter, 'loadTrades')

    server.set('GET /trades/page', new TypeError('Failed to fetch'))
    await table.find('button').trigger('click')
    await flushPromises()

    expect(table.find('[role="alert"]').text()).toContain('could not be reached')
    expect(rows(table)).toHaveLength(1)
  })

  it('says the API is not available when the frontend server cannot reach it', async () => {
    const server = fakeApi({ 'GET /trades/page': pagedTrades([older]) })
    const table = await show(TradeBlotter, 'loadTrades')

    server.set('GET /trades/page', { status: 502, body: '', contentType: 'text/plain' })
    await table.find('button').trigger('click')
    await flushPromises()

    expect(table.find('[role="alert"]').text()).toBe(
      'Trades could not be loaded. The API is not available. Check that it is running, and try again in a moment.',
    )
    expect(rows(table)).toHaveLength(1)
  })
})

describe('positions', () => {
  it('shows long and short positions apart, with exact net quantity and average cost', async () => {
    fakeApi({
      'GET /positions': json('[{"symbol":"AAPL","netQuantity":-1500.25,"averageCost":187.5},' +
        '{"symbol":"MSFT","netQuantity":3,"averageCost":1.6666666666666666666666666666666666666666666666667}]'),
    })
    const panel = await show(PositionsPanel, 'loadPositions')

    expect(panel.findAll('thead th').map((cell) => cell.text())).toEqual(['Symbol', 'Direction', 'Net quantity', 'Average cost'])
    expect(rows(panel)).toEqual([
      ['AAPL', 'Short', '-1,500.25', '187.5'],
      ['MSFT', 'Long', '3', '1.6666666666666666666666666666666666666666666666667'],
    ])
    expect(panel.findAll('tbody tr').map((row) => row.classes())).toEqual([['position-short'], ['position-long']])
    // Narrow screens show each figure on its own line under these labels; the text is the header's.
    expect(panel.findAll('tbody tr').map((row) => row.findAll('td[data-label]').map((cell) => cell.attributes('data-label'))))
      .toEqual([['Net quantity', 'Average cost'], ['Net quantity', 'Average cost']])
    expect(panel.findAll('.direction-badge').map((badge) => badge.classes())).toEqual([
      ['direction-badge', 'direction-short'],
      ['direction-badge', 'direction-long'],
    ])
  })

  it('says it is loading, then that there are no open positions', async () => {
    let release: (response: FakeResponse) => void = () => undefined
    fakeApi({ 'GET /positions': () => new Promise<FakeResponse>((resolve) => { release = resolve }) })
    const panel = await show(PositionsPanel, 'loadPositions', false)
    await flushPromises()
    expect(panel.find('[role="status"]').text()).toBe('Loading positions…')

    release(json('[]'))
    await flushPromises()
    expect(panel.text()).toContain('No open positions.')
    expect(panel.find('[role="status"]').exists()).toBe(false)
  })

  it('explains a failure', async () => {
    fakeApi({ 'GET /positions': new TypeError('Failed to fetch') })
    const panel = await show(PositionsPanel, 'loadPositions')

    expect(panel.find('[role="alert"]').text()).toContain('Positions could not be loaded.')
  })
})
