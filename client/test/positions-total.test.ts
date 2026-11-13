import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import PositionsPanel from '../src/components/PositionsPanel.vue'
import { useBlotterStore } from '../src/stores/blotter.ts'
import { fakeApi, json, pagedTrades, tradeJson } from './support/fake-api.ts'

/**
 * The total above both Positions grids: every open position GET /positions returned, however many
 * rows are in view, the same in both grids, and changed only when positions are loaded again (after
 * a booking or Refresh), never by changing tab.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

/** `count` open positions, P0001 onwards, alternately long and short. */
function positionsJson(count: number): string {
  const items = Array.from({ length: count }, (_, index) =>
    `{"symbol":"P${String(index + 1).padStart(4, '0')}","netQuantity":${index % 2 === 0 ? '' : '-'}${String(index + 1)},"averageCost":10.5}`)
  return `[${items.join(',')}]`
}

const totalIn = (scope: DOMWrapper<Element> | VueWrapper): string => scope.find('.positions-total').text()

async function showPanel(count: number) {
  fakeApi({ 'GET /positions': json(positionsJson(count)) })
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(PositionsPanel, { global: { plugins: [pinia] }, attachTo: document.body })
  await useBlotterStore().loadPositions()
  await flushPromises()
  return wrapper
}

describe('the positions total', () => {
  it('counts every position loaded, not the 25 rows in view: 167 positions read 167', async () => {
    const panel = await showPanel(167)
    expect(totalIn(panel)).toBe('Total: 167 positions')
    expect(panel.findAll('tbody tr')).toHaveLength(167)
    expect(panel.find('.positions-scroll').attributes('style')).toContain('--visible-rows: 25')
    expect(panel.find('#positions-resize-help').text()).toContain('Showing 25 positions at a time')
  })

  it('says "position" for one, and groups thousands', async () => {
    expect(totalIn(await showPanel(1))).toBe('Total: 1 position')
    wrapper?.unmount()
    expect(totalIn(await showPanel(1234))).toBe('Total: 1,234 positions')
  })

  it('reads 0 when there are none, beside the message that says so', async () => {
    const panel = await showPanel(0)
    expect(totalIn(panel)).toBe('Total: 0 positions')
    expect(panel.find('.state').text()).toBe('No open positions.')
    expect(panel.find('table').exists()).toBe(false)
  })

  it('is not shown until positions have loaded', async () => {
    fakeApi({ 'GET /positions': () => new Promise(() => undefined) })
    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(PositionsPanel, { global: { plugins: [pinia] } })
    void useBlotterStore().loadPositions()
    await flushPromises()
    expect(wrapper.find('.positions-total').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').text()).toBe('Loading positions…')
  })

  it('changes when Refresh loads a different number of positions', async () => {
    const panel = await showPanel(3)
    expect(totalIn(panel)).toBe('Total: 3 positions')
    fakeApi({ 'GET /positions': json(positionsJson(2)) })
    await panel.find('button.refresh-positions').trigger('click')
    await flushPromises()
    expect(totalIn(panel)).toBe('Total: 2 positions')
  })
})

describe('the positions total in both grids', () => {
  const AAPL = '{"symbol":"AAPL","netQuantity":10,"averageCost":100}'
  const MSFT = '{"symbol":"MSFT","netQuantity":-5,"averageCost":301.25}'
  const TRADE = tradeJson({
    id: 't1', bookingSequence: 1, symbol: 'AAPL', side: 'Buy', quantity: '10', price: '100', notional: '1000',
    executedAt: '2026-03-01T15:00:00.000Z',
  })

  async function openPage(positions: string) {
    const server = fakeApi({ 'GET /trades/page': pagedTrades([TRADE]), 'GET /positions': json(positions) })
    const page = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
    wrapper = page
    await flushPromises()
    const trading = page.find('section[aria-labelledby="positions-heading"]')
    const master = page.find('section[aria-labelledby="master-heading"]')
    return { server, page, totals: (): string[] => [totalIn(trading), totalIn(master)] }
  }

  async function book(page: VueWrapper, symbol: string, side: 'buy' | 'sell', quantity: string): Promise<void> {
    await page.find('#trade-symbol').setValue(symbol)
    await page.find(`#trade-side-${side}`).setValue(true)
    await page.find('#trade-quantity').setValue(quantity)
    await page.find('#trade-price').setValue('100')
    await page.find('form').trigger('submit')
    await flushPromises()
  }

  it('shows the same total in the Trading grid and the Open positions grid, from one request', async () => {
    const { server, totals } = await openPage(`[${AAPL},${MSFT}]`)
    expect(totals()).toEqual(['Total: 2 positions', 'Total: 2 positions'])
    expect(server.sequence().filter((call) => call === 'GET /positions')).toHaveLength(1)
  })

  it('goes up after a booking that opens a position, in both grids', async () => {
    const { server, page, totals } = await openPage(`[${AAPL}]`)
    expect(totals()).toEqual(['Total: 1 position', 'Total: 1 position'])
    server.set('POST /trades', json(TRADE, 201))
    server.set('GET /positions', json(`[${AAPL},${MSFT}]`))
    await book(page, 'MSFT', 'sell', '5')
    expect(totals()).toEqual(['Total: 2 positions', 'Total: 2 positions'])
  })

  it('goes down after a booking that closes a position, which the API no longer lists', async () => {
    const { server, page, totals } = await openPage(`[${AAPL},${MSFT}]`)
    server.set('POST /trades', json(TRADE, 201))
    server.set('GET /positions', json(`[${MSFT}]`))
    await book(page, 'AAPL', 'sell', '10')
    expect(totals()).toEqual(['Total: 1 position', 'Total: 1 position'])

    server.set('GET /positions', json('[]'))
    await book(page, 'MSFT', 'buy', '5')
    expect(totals()).toEqual(['Total: 0 positions', 'Total: 0 positions'])
  })

  it('stays right when changing tabs, which loads nothing', async () => {
    const { server, page, totals } = await openPage(`[${AAPL},${MSFT}]`)
    const before = server.sequence()
    for (const id of ['#tab-details', '#tab-history', '#tab-trading', '#tab-details']) {
      await page.find(id).trigger('click')
      await flushPromises()
      expect(totals(), id).toEqual(['Total: 2 positions', 'Total: 2 positions'])
    }
    expect(server.sequence()).toEqual(before)
  })
})
