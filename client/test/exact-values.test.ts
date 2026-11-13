import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import MoneyValue from '../src/components/MoneyValue.vue'
import { fakeApi, json, pagedTrades, tradeJson } from './support/fake-api.ts'

/**
 * Exact values without a pointer or a screen reader: each grid's Exact values checkbox shows the
 * exact value of every rounded price, notional and average cost beside its two-place value. The
 * two-place value stays as it is; values that lose no digits are left alone.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

/** What a sighted user reads in an element: its text without what only screen readers get. */
function seen(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.visually-hidden').forEach((hidden) => { hidden.remove() })
  return copy.textContent.replace(/\s+/g, ' ').trim()
}

describe('a money value', () => {
  it('shows two places, with the exact value only for screen readers and as its tooltip, until asked to show it', async () => {
    wrapper = mount(MoneyValue, { props: { value: '1.6666666666666666666666666666666666666666666666667' } })
    expect(seen(wrapper.find('.money').element)).toBe('1.67')
    expect(wrapper.find('.visually-hidden').text()).toBe(', exactly 1.6666666666666666666666666666666666666666666666667')

    await wrapper.setProps({ showExact: true })
    expect(seen(wrapper.find('.money').element)).toBe('1.67 exactly 1.6666666666666666666666666666666666666666666666667')
    expect(wrapper.find('.visually-hidden').exists()).toBe(false)
    // Read once by screen readers, not twice.
    expect(wrapper.text().match(/exactly/g)).toHaveLength(1)
    expect(wrapper.find('.money').attributes('title')).toBe('Exactly 1.6666666666666666666666666666666666666666666666667')
  })

  it('adds nothing to a value that loses no digits, and keeps large and negative values exact', async () => {
    wrapper = mount(MoneyValue, { props: { value: '187.5', showExact: true } })
    expect(wrapper.text()).toBe('187.50')
    await wrapper.setProps({ value: '-999999999999999.9999999999' })
    expect(seen(wrapper.find('.money').element)).toBe('-1,000,000,000,000,000.00 exactly -999,999,999,999,999.9999999999')
    await wrapper.setProps({ value: '-0.004' })
    expect(seen(wrapper.find('.money').element)).toBe('0.00 exactly -0.004')
  })
})

const POSITIONS = '[{"symbol":"MS","netQuantity":3,"averageCost":90.125},{"symbol":"MSFT","netQuantity":-2,"averageCost":187.5}]'
const TRADE = tradeJson({
  id: 't1', bookingSequence: 1, symbol: 'MS', side: 'Buy', quantity: '3', price: '90.125', notional: '270.375',
  executedAt: '2026-03-01T15:00:00.000Z',
})

async function openPage() {
  const server = fakeApi({ 'GET /trades/page': pagedTrades([TRADE]), 'GET /positions': json(POSITIONS) })
  wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  return { server, page: wrapper }
}

const toggleIn = (page: VueWrapper, section: string) => page.find<HTMLInputElement>(`section[aria-labelledby="${section}"] input.exact-toggle`)
const checkedIn = (page: VueWrapper, section: string): boolean => toggleIn(page, section).element.checked

describe('the Exact values checkbox', () => {
  it('is one ordinary checkbox per grid, in the tab order, labelled for its grid, unchecked at first; no Exact values buttons remain', async () => {
    const { page } = await openPage()

    const toggles = page.findAll<HTMLInputElement>('input.exact-toggle')
    expect(toggles).toHaveLength(4)
    expect(toggles.map((toggle) => toggle.element.labels?.[0]?.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      'Exact values in the positions grid', 'Exact values in the open positions grid', 'Exact values in the trade details grid', 'Exact values in the trade list',
    ])
    for (const toggle of toggles) {
      expect(toggle.attributes('type')).toBe('checkbox')
      expect(toggle.element.checked).toBe(false)
      expect(toggle.attributes('aria-pressed')).toBeUndefined()
      expect(toggle.element.tabIndex).toBe(0)
    }
    expect(page.findAll('button').filter((button) => button.text().includes('Exact values'))).toHaveLength(0)
  })

  it('is checked and unchecked by clicking its label, like any checkbox', async () => {
    const { page } = await openPage()
    const trading = page.find('section[aria-labelledby="positions-heading"]')
    const label = trading.find('label.exact-values-option')
    await label.trigger('click')
    expect(checkedIn(page, 'positions-heading')).toBe(true)
    expect(trading.find('td.average-cost .exact-inline').exists()).toBe(true)
    await label.trigger('click')
    expect(checkedIn(page, 'positions-heading')).toBe(false)
    expect(trading.find('td.average-cost .exact-inline').exists()).toBe(false)
  })

  it('shows the exact average costs in its own grid only, keeps the two-place values, and hides them again', async () => {
    const { page } = await openPage()
    const trading = page.find('section[aria-labelledby="positions-heading"]')
    const costs = () => trading.findAll('td.average-cost').map((cell) => seen(cell.element))
    expect(costs()).toEqual(['90.12', '187.50'])

    await toggleIn(page, 'positions-heading').trigger('click')

    expect(checkedIn(page, 'positions-heading')).toBe(true)
    expect(costs()).toEqual(['90.12 exactly 90.125', '187.50'])
    // The other grids are as they were.
    expect(page.findAll('section[aria-labelledby="master-heading"] td.average-cost').map((cell) => seen(cell.element))).toEqual(['90.12', '187.50'])
    expect(seen(page.find('section[aria-labelledby="blotter-heading"] td.price').element)).toBe('90.12')

    await toggleIn(page, 'positions-heading').trigger('click')
    expect(costs()).toEqual(['90.12', '187.50'])
  })

  it('shows exact prices and notionals in the trade list and the trade details, and stays on while other tabs are shown', async () => {
    const { server, page } = await openPage()
    await toggleIn(page, 'blotter-heading').trigger('click')
    const row = page.find('section[aria-labelledby="blotter-heading"] tbody tr')
    expect([seen(row.find('td.price').element), seen(row.find('td.notional').element)]).toEqual(['90.12 exactly 90.125', '270.38 exactly 270.375'])

    await page.find('#tab-details').trigger('click')
    await page.find('section[aria-labelledby="master-heading"] tbody tr').trigger('click')
    await flushPromises()
    // Unchecked, the chosen position's average cost above the grid shows two places only; the exact value is its tooltip.
    const summaryCost = page.find('section[aria-labelledby="details-heading"] .position-summary dd.average-cost')
    expect(seen(summaryCost.element)).toBe('90.12')
    expect(summaryCost.find('.money').attributes('title')).toBe('Exactly 90.125')
    await toggleIn(page, 'details-heading').trigger('click')
    const detail = page.find('section[aria-labelledby="details-heading"] tbody tr')
    expect([seen(detail.find('td.price').element), seen(detail.find('td.notional').element)]).toEqual(['90.12 exactly 90.125', '270.38 exactly 270.375'])
    // The chosen position's average cost above the grid follows the same checkbox.
    expect(seen(page.find('section[aria-labelledby="details-heading"] .position-summary dd.average-cost').element)).toBe('90.12 exactly 90.125')

    const requests = server.calls.length
    for (const id of ['history', 'trading', 'details']) await page.find(`#tab-${id}`).trigger('click')
    expect(checkedIn(page, 'details-heading')).toBe(true)
    expect(checkedIn(page, 'blotter-heading')).toBe(true)
    expect(server.calls.length).toBe(requests)
  })
})
