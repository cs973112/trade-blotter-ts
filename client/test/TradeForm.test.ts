import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TradeForm from '../src/components/TradeForm.vue'
import { useBlotterStore } from '../src/stores/blotter.ts'
import { fakeApi, json, pageJson, problem, tradeJson, type FakeResponse } from './support/fake-api.ts'

/** The trade list's reload after a booking: page 1 of 50, with no filters. */
const RELOAD = 'GET /trades/page?page=1&pageSize=50'
const EMPTY_PAGE = pageJson([], { page: 1, pageSize: 50, totalCount: 0 })

const CREATED = tradeJson({
  id: 't1', bookingSequence: 1, symbol: 'MSFT', side: 'Buy', quantity: '10.50', price: '301.25', notional: '3163.125',
  executedAt: '2026-01-02T14:30:00.000Z',
})

let wrapper: VueWrapper | undefined

function mountForm(): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(TradeForm, { global: { plugins: [pinia] }, attachTo: document.body })
  return wrapper
}

beforeEach(() => {
  fakeApi({ 'POST /trades': json(CREATED, 201), 'GET /trades/page': pageJson([CREATED], { page: 1, pageSize: 50, totalCount: 1 }), 'GET /positions': json('[]') })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

async function fill(form: VueWrapper, values: { symbol?: string; side?: 'Buy' | 'Sell'; quantity?: string; price?: string; executedAt?: string }) {
  if (values.symbol !== undefined) await form.find('#trade-symbol').setValue(values.symbol)
  if (values.side !== undefined) await form.find(values.side === 'Buy' ? '#trade-side-buy' : '#trade-side-sell').setValue(true)
  if (values.quantity !== undefined) await form.find('#trade-quantity').setValue(values.quantity)
  if (values.price !== undefined) await form.find('#trade-price').setValue(values.price)
  if (values.executedAt !== undefined) await form.find('#trade-executed-at').setValue(values.executedAt)
}

async function submit(form: VueWrapper): Promise<void> {
  await form.find('form').trigger('submit')
  await flushPromises()
}

const posted = (): unknown[] => {
  const fetchMock = vi.mocked(fetch)
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => (typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined))
}

const errorText = (form: VueWrapper, id: string): string | undefined => {
  const element = form.find(`#${id}-error`)
  return element.exists() ? element.text() : undefined
}

describe('trade form: accessibility', () => {
  it('labels every control and groups the side choice', () => {
    const form = mountForm()

    for (const [id, label] of [['trade-symbol', 'Symbol'], ['trade-quantity', 'Quantity'], ['trade-price', 'Price'],
      ['trade-executed-at', 'Execution time (optional)']] as const) {
      expect(form.find(`label[for="${id}"]`).text()).toBe(label)
      expect(form.find(`#${id}`).exists()).toBe(true)
    }
    const side = form.find('fieldset.side')
    expect(side.find('legend').text()).toBe('Side')
    expect(side.findAll('input[type="radio"][name="side"]').map((radio) => radio.attributes('value'))).toEqual(['Buy', 'Sell'])
    expect(side.findAll('label').map((label) => label.text())).toEqual(['Buy', 'Sell'])
    expect(form.find('#trade-executed-at').attributes('aria-describedby')).toBe('trade-executed-at-hint')
    expect(form.find('#trade-executed-at-hint').text()).toContain('America/New_York')
    expect(form.find('button[type="submit"]').text()).toBe('Book trade')
  })

  it('marks invalid fields, links each to its message, and moves focus to the first', async () => {
    const form = mountForm()

    await submit(form)

    const symbol = form.find('#trade-symbol')
    expect(symbol.attributes('aria-invalid')).toBe('true')
    expect(symbol.attributes('aria-describedby')).toBe('trade-symbol-error')
    expect(form.find('fieldset.side').attributes('aria-invalid')).toBe('true')
    expect(form.find('fieldset.side').attributes('aria-describedby')).toBe('trade-side-buy-error')
    expect(document.activeElement).toBe(symbol.element)
  })
})

describe('trade form: validation before sending', () => {
  it('names every missing required field and sends nothing', async () => {
    const form = mountForm()

    await submit(form)

    expect(errorText(form, 'trade-symbol')).toBe('Enter a symbol.')
    expect(errorText(form, 'trade-side-buy')).toBe('Choose Buy or Sell.')
    expect(errorText(form, 'trade-quantity')).toBe('Enter a quantity.')
    expect(errorText(form, 'trade-price')).toBe('Enter a price.')
    expect(errorText(form, 'trade-executed-at')).toBeUndefined()
    expect(posted()).toEqual([])
  })

  it('shows no errors before the first attempt to submit', async () => {
    const form = mountForm()

    await fill(form, { quantity: 'abc' })

    expect(form.find('.field-error').exists()).toBe(false)
  })

  it.each([
    ['1,000', 'Enter the quantity as a number such as 100 or 101.25, without spaces or separators.'],
    ['-5', 'Enter the quantity as a number such as 100 or 101.25, without spaces or separators.'],
    ['1e3', 'Enter the quantity as a number such as 100 or 101.25, without spaces or separators.'],
    ['0', 'Quantity must be greater than zero.'],
  ])('refuses quantity %j', async (quantity, message) => {
    const form = mountForm()

    await fill(form, { symbol: 'MSFT', side: 'Buy', quantity, price: '1' })
    await submit(form)

    expect(errorText(form, 'trade-quantity')).toBe(message)
    expect(posted()).toEqual([])
  })

  it('updates messages as the user corrects a field after submitting', async () => {
    const form = mountForm()
    await submit(form)

    await fill(form, { symbol: 'MSFT' })

    expect(errorText(form, 'trade-symbol')).toBeUndefined()
    expect(errorText(form, 'trade-quantity')).toBe('Enter a quantity.')
  })
})

describe('trade form: what it sends', () => {
  it('sends the side the user chose', async () => {
    const form = mountForm()

    await fill(form, { symbol: 'MSFT', side: 'Buy', quantity: '1', price: '1' })
    await fill(form, { side: 'Sell' })
    await submit(form)

    expect(posted()).toEqual([{ symbol: 'MSFT', side: 'Sell', quantity: '1', price: '1' }])
  })

  it('sends decimals exactly as typed (trimmed), as strings, with no rounding', async () => {
    const form = mountForm()

    await fill(form, { symbol: ' msft ', side: 'Buy', quantity: ' 123456789012345.1234567891 ', price: '10.50' })
    await submit(form)

    const body = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body
    expect(body).toBe('{"symbol":"msft","side":"Buy","quantity":"123456789012345.1234567891","price":"10.50"}')
  })

  it('sends no execution time when the field is blank, so the server assigns it', async () => {
    const form = mountForm()

    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1' })
    await submit(form)

    expect(posted()).toEqual([{ symbol: 'A', side: 'Buy', quantity: '1', price: '1' }])
  })

  it('sends a chosen execution time as RFC 3339 with the local offset', async () => {
    const form = mountForm()

    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-07-01T09:30:15' })
    await submit(form)

    expect(posted()).toEqual([{ symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-07-01T09:30:15-04:00' }])
  })

  it('never sends server-managed fields', async () => {
    const form = mountForm()

    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-01-02T09:30' })
    await submit(form)

    expect(Object.keys(posted()[0] as object)).toEqual(['symbol', 'side', 'quantity', 'price', 'executedAt'])
  })
})

describe('trade form: daylight-saving changes', () => {
  it('refuses a local time the clocks skip', async () => {
    const form = mountForm()

    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-03-08T02:30' })
    await submit(form)

    expect(errorText(form, 'trade-executed-at')).toContain('does not exist in your time zone')
    expect(posted()).toEqual([])
  })

  it('asks which occurrence of a repeated local time was meant, and sends that one', async () => {
    const form = mountForm()
    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-11-01T01:30' })

    const choice = form.find('fieldset.occurrence')
    expect(choice.find('legend').text()).toBe('This time happens twice. Which one?')
    expect(choice.findAll('label').map((label) => label.text())).toEqual(['First, UTC−04:00', 'Second, UTC−05:00'])

    await submit(form)
    expect(errorText(form, 'trade-executed-at')).toContain('happens twice')
    expect(posted()).toEqual([])

    await choice.findAll('input[type="radio"]')[1]?.setValue(true)
    await submit(form)
    expect(posted()).toEqual([{ symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-11-01T01:30:00-05:00' }])
  })

  it('forgets the chosen occurrence when the time changes', async () => {
    const form = mountForm()
    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1', executedAt: '2026-11-01T01:30' })
    await form.find('fieldset.occurrence').findAll('input[type="radio"]')[0]?.setValue(true)

    await fill(form, { executedAt: '2026-11-01T01:45' })
    await submit(form)

    expect(errorText(form, 'trade-executed-at')).toContain('happens twice')
  })
})

describe('trade form: after sending', () => {
  it('confirms the booking, clears the form, refreshes trades and positions, and returns focus to the symbol', async () => {
    const form = mountForm()
    const server = vi.mocked(fetch)

    await fill(form, { symbol: 'MSFT', side: 'Buy', quantity: '10.50', price: '301.25' })
    await submit(form)

    expect(form.find('[role="status"]').text()).toBe('Booked: Buy 10.50 MSFT at 301.25. It is on this page of the trade list.')
    expect((form.find('#trade-symbol').element as HTMLInputElement).value).toBe('')
    expect((form.find('#trade-quantity').element as HTMLInputElement).value).toBe('')
    expect((form.find('#trade-side-buy').element as HTMLInputElement).checked).toBe(false)
    expect(server.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url as string}`))
      .toEqual(['POST /trades', RELOAD, 'GET /positions'])
    expect(document.activeElement).toBe(form.find('#trade-symbol').element)
    expect(form.find('.field-error').exists()).toBe(false)
  })

  it('shows field errors from the server next to their fields, and clears one when its field changes', async () => {
    const server = fakeApi({
      'POST /trades': problem(400, {
        type: 'urn:trade-blotter:problem:invalid-trade',
        errors: {
          quantity: ['Quantity must be less than 10^15 with at most 10 decimal places.'],
          price: ['Price must be less than 10^15 with at most 10 decimal places.'],
        },
      }),
    })
    const form = mountForm()

    await fill(form, { symbol: 'A', side: 'Buy', quantity: '0.00000000001', price: '1000000000000000' })
    await submit(form)

    expect(form.find('[role="alert"]').text()).toBe('Some fields need attention.')
    expect(errorText(form, 'trade-quantity')).toBe('Quantity must be less than 10^15 with at most 10 decimal places.')
    expect(errorText(form, 'trade-price')).toBe('Price must be less than 10^15 with at most 10 decimal places.')
    expect(form.find('#trade-quantity').attributes('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(form.find('#trade-quantity').element)
    expect(server.sequence()).toEqual(['POST /trades'])

    await fill(form, { quantity: '0.5' })
    expect(errorText(form, 'trade-quantity')).toBeUndefined()
    expect(errorText(form, 'trade-price')).toBe('Price must be less than 10^15 with at most 10 decimal places.')
  })

  it.each<[string, FakeResponse | Error, string]>([
    ['the server cannot be reached', new TypeError('Failed to fetch'), 'The server could not be reached.'],
    ['the API is not running behind the frontend server', { status: 502, body: '', contentType: 'text/plain' },
      'The API is not available.'],
    ['the server fails', problem(500, { detail: 'SQLITE_CORRUPT C:/data/trades.db' }), 'The server could not complete the request.'],
    ['the position limit would be breached', problem(400, {
      type: 'urn:trade-blotter:problem:position-limit', detail: 'The net quantity of BIG reached the position limit of 1e30.',
    }), 'The trade was not booked. The net quantity of BIG reached the position limit of 1e30.'],
  ])('keeps what was typed and explains when %s', async (_name, response, message) => {
    fakeApi({ 'POST /trades': response })
    const form = mountForm()

    await fill(form, { symbol: 'BIG', side: 'Buy', quantity: '1', price: '1' })
    await submit(form)

    expect(form.find('[role="alert"]').text()).toContain(message)
    expect(form.text()).not.toContain('SQLITE')
    expect((form.find('#trade-symbol').element as HTMLInputElement).value).toBe('BIG')
  })

  it('disables the button while booking', async () => {
    let release: (response: FakeResponse) => void = () => undefined
    fakeApi({ 'POST /trades': () => new Promise<FakeResponse>((resolve) => { release = resolve }), 'GET /trades/page': EMPTY_PAGE,
      'GET /positions': json('[]') })
    const form = mountForm()
    await fill(form, { symbol: 'A', side: 'Buy', quantity: '1', price: '1' })

    await form.find('form').trigger('submit')
    await flushPromises()
    const button = form.find('button[type="submit"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.text()).toBe('Booking…')

    release(json(CREATED, 201))
    await flushPromises()
    expect(form.find('button[type="submit"]').attributes('disabled')).toBeUndefined()
  })
})

describe('trade form: after the API comes back', () => {
  const OUTAGE = 'The API is not available. Check that it is running, and try again in a moment.'
  const BARE_502: FakeResponse = { status: 502, body: '', contentType: 'text/plain' }

  async function failBooking(response: FakeResponse | Error, extra: Parameters<typeof fakeApi>[0] = {}) {
    const server = fakeApi({ 'POST /trades': response, 'GET /trades/page': BARE_502, 'GET /positions': BARE_502, ...extra })
    const form = mountForm()
    await fill(form, { symbol: 'ACME', side: 'Buy', quantity: '100', price: '10' })
    await submit(form)
    return { server, form, store: useBlotterStore() }
  }

  const alert = (form: VueWrapper): string | undefined => {
    const element = form.find('[role="alert"]')
    return element.exists() ? element.text() : undefined
  }

  it.each<[string, FakeResponse | Error]>([
    ['the API was unavailable', BARE_502],
    ['the server could not be reached', new TypeError('Failed to fetch')],
  ])('removes the alert once the API answers again when %s, and keeps what was typed', async (_name, response) => {
    const { server, form, store } = await failBooking(response)
    expect(alert(form)).toBeDefined()

    await store.refresh()
    await flushPromises()
    expect(alert(form)).toBeDefined()

    server.set('GET /trades/page', EMPTY_PAGE)
    await store.loadTrades()
    await flushPromises()

    expect(alert(form)).toBeUndefined()
    expect((form.find('#trade-symbol').element as HTMLInputElement).value).toBe('ACME')
    expect((form.find('#trade-quantity').element as HTMLInputElement).value).toBe('100')
    expect(form.find('[role="status"]').exists()).toBe(false)
  })

  it('keeps the alert when a load that started before the failure succeeds after it', async () => {
    let release: (response: FakeResponse) => void = () => undefined
    const server = fakeApi({
      'GET /positions': () => new Promise<FakeResponse>((resolve) => { release = resolve }),
      'POST /trades': BARE_502,
    })
    const form = mountForm()
    const store = useBlotterStore()
    const earlier = store.loadPositions()
    await fill(form, { symbol: 'ACME', side: 'Buy', quantity: '100', price: '10' })
    await submit(form)
    expect(alert(form)).toBe(OUTAGE)

    release(json('[]'))
    await earlier
    await flushPromises()

    expect(alert(form)).toBe(OUTAGE)
    expect(server.sequence()).toEqual(['GET /positions', 'POST /trades'])
  })

  it.each<[string, FakeResponse, string]>([
    ['the server failed', problem(500, { detail: 'disk I/O error' }), 'The server could not complete the request.'],
    ['the position limit would be breached', problem(400, {
      type: 'urn:trade-blotter:problem:position-limit', detail: 'The net quantity of ACME reached the position limit of 1e30.',
    }), 'The trade was not booked. The net quantity of ACME reached the position limit of 1e30.'],
    ['fields were rejected', problem(400, {
      type: 'urn:trade-blotter:problem:invalid-trade', errors: { price: ['Price must be less than 10^15 with at most 10 decimal places.'] },
    }), 'Some fields need attention.'],
  ])('keeps the alert after a successful refresh when %s, because it still applies', async (_name, response, message) => {
    const { server, form, store } = await failBooking(response, { 'GET /trades/page': EMPTY_PAGE, 'GET /positions': json('[]') })

    await store.refresh()
    await flushPromises()

    expect(alert(form)).toContain(message)
    expect(server.sequence()).toEqual(['POST /trades', RELOAD, 'GET /positions'])
  })

  it('shows a new outage alert if the next attempt fails too', async () => {
    const { server, form, store } = await failBooking(BARE_502)
    server.set('GET /trades/page', EMPTY_PAGE)
    await store.loadTrades()
    await flushPromises()
    expect(alert(form)).toBeUndefined()

    await submit(form)

    expect(alert(form)).toBe(OUTAGE)
  })
})
