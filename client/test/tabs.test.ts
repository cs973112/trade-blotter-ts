import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { tabAfterKey, TABS } from '../src/lib/tabs.ts'
import { fakeApi, json, pagedTrades, tradeJson } from './support/fake-api.ts'

/**
 * The three tabs: their order and roles, choosing one by pointer or keyboard, and that changing tab
 * keeps what the user had (typed entries, the trade list's filters, sort, page and page size)
 * without loading anything again.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

/** `count` trades named S001, S002, ..., newest first. */
const many = (count: number): string[] => Array.from({ length: count }, (_, index) => tradeJson({
  id: `t${String(index + 1)}`, bookingSequence: index + 1, symbol: `S${String(index + 1).padStart(3, '0')}`, side: 'Buy',
  quantity: '1', price: '1', notional: '1', executedAt: '2026-01-01T15:00:00.000Z',
}))

async function openPage() {
  const server = fakeApi({ 'GET /trades/page': pagedTrades(many(120)), 'GET /positions': json('[{"symbol":"AAPL","netQuantity":10,"averageCost":100}]') })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  return { server, page: wrapper }
}

const tabs = (page: VueWrapper) => page.findAll('[role="tab"]')
const selectedTab = (page: VueWrapper): string => page.find('[role="tab"][aria-selected="true"]').text()
const visiblePanels = (page: VueWrapper): string[] =>
  page.findAll('[role="tabpanel"]').filter((panel) => (panel.element as HTMLElement).style.display !== 'none').map((panel) => panel.attributes('id') ?? '')
const press = async (page: VueWrapper, key: string): Promise<void> => {
  await page.find('[role="tab"]:focus').trigger('keydown', { key })
}

describe('tabs: which key moves where', () => {
  it('moves right and left round the three tabs, and to the first and last with Home and End', () => {
    expect(TABS.map((tab) => tab.label)).toEqual(['Trading', 'Positions & Trade Details', 'Trade History'])
    expect(tabAfterKey('trading', 'ArrowRight')).toBe('details')
    expect(tabAfterKey('details', 'ArrowRight')).toBe('history')
    expect(tabAfterKey('history', 'ArrowRight')).toBe('trading')
    expect(tabAfterKey('trading', 'ArrowLeft')).toBe('history')
    expect(tabAfterKey('history', 'ArrowLeft')).toBe('details')
    expect(tabAfterKey('details', 'Home')).toBe('trading')
    expect(tabAfterKey('trading', 'End')).toBe('history')
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(tabAfterKey('details', key)).toBeUndefined()
  })
})

describe('tabs on the page', () => {
  it('opens on Trading, with the booking form and positions, and each tab naming the panel it controls', async () => {
    const { page } = await openPage()

    const list = page.find('[role="tablist"]')
    expect(list.attributes('aria-label')).toBe('Trade Blotter sections')
    expect(tabs(page).map((tab) => tab.text())).toEqual(['Trading', 'Positions & Trade Details', 'Trade History'])
    expect(selectedTab(page)).toBe('Trading')
    expect(tabs(page).map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(visiblePanels(page)).toEqual(['panel-trading'])
    for (const tab of tabs(page)) {
      const panel = page.find(`#${tab.attributes('aria-controls') ?? ''}`)
      expect(panel.attributes('role')).toBe('tabpanel')
      expect(panel.attributes('aria-labelledby')).toBe(tab.attributes('id'))
    }
    const trading = page.find('#panel-trading')
    expect(trading.find('section[aria-labelledby="trade-form-heading"]').exists()).toBe(true)
    expect(trading.find('section[aria-labelledby="positions-heading"]').exists()).toBe(true)
    expect(page.find('#panel-history section[aria-labelledby="blotter-heading"]').exists()).toBe(true)
    expect(page.find('#panel-details section[aria-labelledby="master-heading"]').exists()).toBe(true)
    expect(page.find('#panel-details section[aria-labelledby="details-heading"]').text()).toContain('Choose a position to see the trades that make it up.')
  })

  it('shows the tab chosen with the pointer', async () => {
    const { page } = await openPage()

    await page.find('#tab-history').trigger('click')
    expect(selectedTab(page)).toBe('Trade History')
    expect(visiblePanels(page)).toEqual(['panel-history'])
    expect(tabs(page).map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '-1', '0'])

    await page.find('#tab-details').trigger('click')
    expect(visiblePanels(page)).toEqual(['panel-details'])
  })

  it('moves with the arrow keys, Home and End, focusing and showing each tab', async () => {
    const { page } = await openPage()
    ;(page.find('#tab-trading').element as HTMLElement).focus()

    const steps: [string, string][] = [['ArrowRight', 'Positions & Trade Details'], ['ArrowRight', 'Trade History'], ['ArrowRight', 'Trading'],
      ['ArrowLeft', 'Trade History'], ['Home', 'Trading'], ['End', 'Trade History']]
    for (const [key, expected] of steps) {
      await press(page, key)
      expect(selectedTab(page), key).toBe(expected)
      expect(document.activeElement?.textContent.trim(), key).toBe(expected)
    }
    expect(visiblePanels(page)).toEqual(['panel-history'])
  })

  it('keeps what was typed in the booking form while another tab is shown', async () => {
    const { page } = await openPage()
    await page.find('#trade-symbol').setValue('msft')
    await page.find('#trade-side-sell').setValue(true)
    await page.find('#trade-quantity').setValue('12.5')
    await page.find('#trade-price').setValue('0.0000000001')

    await page.find('#tab-history').trigger('click')
    await page.find('#tab-details').trigger('click')
    await page.find('#tab-trading').trigger('click')

    const value = (selector: string): string => (page.find(selector).element as HTMLInputElement).value
    expect([value('#trade-symbol'), value('#trade-quantity'), value('#trade-price')]).toEqual(['msft', '12.5', '0.0000000001'])
    expect((page.find('#trade-side-sell').element as HTMLInputElement).checked).toBe(true)
  })

  it('keeps the trade list\'s filters, sort, page and page size, and loads nothing again, when changing tabs', async () => {
    const { server, page } = await openPage()
    await page.find('#tab-history').trigger('click')
    await page.find('#filter-symbol').setValue('s0')
    await page.find('form.trade-filters').trigger('submit')
    await flushPromises()
    await page.find('section[aria-labelledby="blotter-heading"] thead th:nth-child(1) button').trigger('click')
    await flushPromises()
    await page.find('nav.pager select').setValue('25')
    await flushPromises()
    await page.find('nav.pager .pager-controls > button:nth-of-type(2)').trigger('click')
    await flushPromises()
    const before = server.sequence()
    const shown = (): string[] => [
      (page.find('#filter-symbol').element as HTMLInputElement).value,
      page.find('section[aria-labelledby="blotter-heading"] th[aria-sort]').text(),
      page.find('nav.pager .pager-position').text(),
      (page.find('nav.pager select').element as HTMLSelectElement).value,
      page.findAll('section[aria-labelledby="blotter-heading"] tbody th').map((cell) => cell.text()).join(','),
    ]
    const state = shown()
    expect(state.slice(0, 4)).toEqual(['s0', expect.stringContaining('Symbol'), 'Page 2 of 5', '25'])
    expect(before.at(-1)).toBe('GET /trades/page?symbol=s0&sortBy=symbol&sortDirection=asc&page=2&pageSize=25')

    for (const id of ['#tab-trading', '#tab-details', '#tab-history', '#tab-trading', '#tab-history']) {
      await page.find(id).trigger('click')
      await flushPromises()
    }

    expect(shown()).toEqual(state)
    expect(server.sequence()).toEqual(before)
  })

  it('loads the trade list and positions once when the page opens, whichever tab is shown', async () => {
    const { server, page } = await openPage()
    for (const id of ['#tab-history', '#tab-details', '#tab-trading']) await page.find(id).trigger('click')
    await flushPromises()

    expect(server.sequence()).toEqual(['GET /trades/page?page=1&pageSize=50', 'GET /positions'])
  })
})
