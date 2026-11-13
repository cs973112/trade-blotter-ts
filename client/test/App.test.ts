import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App.vue'
import { fakeApi, json, pagedTrades, tradeJson } from './support/fake-api.ts'

const FIRST_PAGE = 'GET /trades/page?page=1&pageSize=50'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

const first = tradeJson({ id: 'a', bookingSequence: 1, symbol: 'AAPL', side: 'Buy', quantity: '10', price: '100', notional: '1000',
  executedAt: '2026-01-02T14:30:00.000Z' })
const second = tradeJson({ id: 'b', bookingSequence: 2, symbol: 'MSFT', side: 'Sell', quantity: '5', price: '301.25',
  notional: '1506.25', executedAt: '2026-01-03T14:30:00.000Z' })

describe('app', () => {
  it('loads the first page of trades, and positions, when it opens: never the whole history', async () => {
    const server = fakeApi({ 'GET /trades/page': pagedTrades([first]), 'GET /positions': json('[{"symbol":"AAPL","netQuantity":10,"averageCost":100}]') })

    wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()

    expect(server.sequence()).toEqual([FIRST_PAGE, 'GET /positions'])
    expect(wrapper.find('h1').text()).toBe('Trade Blotter')
    expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['Book a trade', 'Positions', 'Open positions', 'Trade Details', 'Trades'])
    expect(wrapper.find('section[aria-labelledby="blotter-heading"] tbody').text()).toContain('AAPL')
  })

  it('shows the new trade and the updated position after booking, as the API returns them', async () => {
    const server = fakeApi({
      'GET /trades/page': pagedTrades([first]),
      'GET /positions': json('[{"symbol":"AAPL","netQuantity":10,"averageCost":100}]'),
      'POST /trades': json(second, 201),
    })
    wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()
    server.set('GET /trades/page', pagedTrades([second, first]))
    server.set('GET /positions', json('[{"symbol":"AAPL","netQuantity":10,"averageCost":100},' +
      '{"symbol":"MSFT","netQuantity":-5,"averageCost":301.25}]'))

    await wrapper.find('#trade-symbol').setValue('MSFT')
    await wrapper.find('#trade-side-sell').setValue(true)
    await wrapper.find('#trade-quantity').setValue('5')
    await wrapper.find('#trade-price').setValue('301.25')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(server.sequence()).toEqual([FIRST_PAGE, 'GET /positions', 'POST /trades', FIRST_PAGE, 'GET /positions'])
    const tradeSymbols = wrapper.findAll('section[aria-labelledby="blotter-heading"] tbody th').map((cell) => cell.text())
    expect(tradeSymbols).toEqual(['MSFT', 'AAPL'])
    const positions = wrapper.findAll('section[aria-labelledby="positions-heading"] tbody tr').map((row) => row.text())
    expect(positions).toEqual(['AAPLLong10100.00', 'MSFTShort-5301.25'])
  })
})
