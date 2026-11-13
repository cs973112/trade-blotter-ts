import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'

import App from '../src/App.vue'
import PositionsPanel from '../src/components/PositionsPanel.vue'
import { allShown, defaultShown, shownColumns, useColumnVisibility, withColumn } from '../src/lib/column-visibility.ts'
import { useColumnWidths } from '../src/lib/column-widths.ts'
import { useBlotterStore } from '../src/stores/blotter.ts'
import { fakeApi, json, pageJson, tradeJson } from './support/fake-api.ts'

/**
 * Showing and hiding columns: which are shown by default, that essential columns stay, that order
 * is kept, Show all and Restore (and that they differ), the Columns control by keyboard and
 * pointer, and column widths across hiding and showing again.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

const COLUMNS = [
  { key: 'a', label: 'A', essential: true },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C', hiddenByDefault: true },
  { key: 'd', label: 'D' },
] as const

describe('column visibility', () => {
  it('shows by default every column not hidden by default, and essential ones always', () => {
    expect([...defaultShown(COLUMNS)].sort()).toEqual(['a', 'b', 'd'])
    expect(defaultShown([{ key: 'x', label: 'X', essential: true, hiddenByDefault: true }]).has('x')).toBe(true)
  })

  it('hides and shows one column at a time, never an essential or unknown one, keeping the grid\'s order', () => {
    let shown = defaultShown(COLUMNS)
    shown = withColumn(shown, COLUMNS, 'b', false)
    shown = withColumn(shown, COLUMNS, 'c', true)
    expect(shownColumns(COLUMNS, shown).map((column) => column.key)).toEqual(['a', 'c', 'd'])
    expect(withColumn(shown, COLUMNS, 'a', false)).toBe(shown)
    expect(withColumn(shown, COLUMNS, 'zz', true)).toBe(shown)
    shown = withColumn(shown, COLUMNS, 'b', true)
    expect(shownColumns(COLUMNS, shown).map((column) => column.key)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('restores the defaults, and knows when it is at them', () => {
    const visibility = useColumnVisibility(COLUMNS)
    expect(visibility.atDefaults.value).toBe(true)
    visibility.setShown('d', false)
    visibility.setShown('c', true)
    expect(visibility.atDefaults.value).toBe(false)
    expect(visibility.visibleColumns.value.map((column) => column.key)).toEqual(['a', 'b', 'c'])
    visibility.restoreDefaults()
    expect(visibility.atDefaults.value).toBe(true)
    expect(visibility.visibleColumns.value.map((column) => column.key)).toEqual(['a', 'b', 'd'])
  })
})

describe('showing all columns', () => {
  it('shows every column, those hidden by default included, in the grid\'s order', () => {
    expect([...allShown(COLUMNS)]).toEqual(['a', 'b', 'c', 'd'])
    const visibility = useColumnVisibility(COLUMNS)
    visibility.setShown('b', false)
    expect(visibility.allVisible.value).toBe(false)
    visibility.showAll()
    expect(visibility.visibleColumns.value.map((column) => column.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(visibility.allVisible.value).toBe(true)
  })

  it('changes nothing when every column is already shown', () => {
    const visibility = useColumnVisibility(COLUMNS)
    visibility.showAll()
    const before = visibility.shown.value
    visibility.showAll()
    expect(visibility.shown.value).toBe(before)
  })

  it('differs from Restore, which hides again the columns hidden by default', () => {
    const visibility = useColumnVisibility(COLUMNS)
    visibility.showAll()
    expect(visibility.atDefaults.value).toBe(false)
    visibility.restoreDefaults()
    expect(visibility.visibleColumns.value.map((column) => column.key)).toEqual(['a', 'b', 'd'])
    expect(visibility.allVisible.value).toBe(false)
  })

  it('never hides an essential column', () => {
    const visibility = useColumnVisibility(COLUMNS)
    visibility.setShown('a', false)
    expect(visibility.isShown('a')).toBe(true)
    visibility.showAll()
    visibility.setShown('a', false)
    expect(visibility.visibleColumns.value.map((column) => column.key)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('column widths when columns are hidden and shown', () => {
  const RESIZABLE = [
    { key: 'a', label: 'A', minWidth: 100, maxWidth: 500 },
    { key: 'b', label: 'B', minWidth: 80, maxWidth: 500 },
    { key: 'c', label: 'C', minWidth: 60, maxWidth: 500 },
  ]

  /** The composable inside a component, as a grid uses it, with the visible columns chosen by the test. */
  function mountWidths() {
    const visible = ref(RESIZABLE)
    let api: ReturnType<typeof useColumnWidths> | undefined
    const Host = defineComponent(() => {
      const table = ref<HTMLTableElement | null>(null)
      api = useColumnWidths(() => visible.value, table)
      return () => h('table', { ref: table }, [h('thead', [h('tr', visible.value.map((column) => h('th', { key: column.key }, column.label)))])])
    })
    wrapper = mount(Host)
    if (api === undefined) throw new Error('not mounted')
    return { visible, widths: api }
  }

  it('keeps a hidden column\'s width for when it comes back, and narrows the table by it meanwhile, leaving no gap', async () => {
    const { visible, widths } = mountWidths()
    widths.setWidth('a', 200)
    widths.setWidth('b', 150)
    expect(widths.tableStyle.value).toEqual({ tableLayout: 'fixed', width: '410px' })

    visible.value = RESIZABLE.filter((column) => column.key !== 'b')
    await flushPromises()
    expect(widths.tableStyle.value).toEqual({ tableLayout: 'fixed', width: '260px' })
    expect(widths.widthOf('a')).toBe(200)

    visible.value = RESIZABLE
    await flushPromises()
    expect(widths.widthOf('b')).toBe(150)
    expect(widths.tableStyle.value).toEqual({ tableLayout: 'fixed', width: '410px' })
  })

  it('sizes a column never sized before, shown while widths are fixed, to its contents and at least its least width', async () => {
    const { visible, widths } = mountWidths()
    visible.value = RESIZABLE.filter((column) => column.key !== 'c')
    await nextTick()
    widths.setWidth('a', 220)
    visible.value = RESIZABLE
    await flushPromises()
    // jsdom measures nothing, so the contents need 0 pixels: the column gets its least width.
    expect(widths.widths.value).toEqual({ a: 220, b: 80, c: 60 })
    await widths.reset()
    expect(widths.tableStyle.value).toEqual({})
  })
})

describe('the Columns control', () => {
  async function showPositions() {
    fakeApi({ 'GET /positions': json('[{"symbol":"AAPL","netQuantity":-10,"averageCost":187.125}]') })
    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(PositionsPanel, { global: { plugins: [pinia] }, attachTo: document.body })
    await useBlotterStore().loadPositions()
    await flushPromises()
    return wrapper
  }

  const headers = (panel: VueWrapper): string[] => panel.findAll('thead th .column-label').map((cell) => cell.text())

  it('opens a labelled list of the grid\'s columns, the essential one checked and fixed, and moves focus into it', async () => {
    const panel = await showPositions()
    const button = panel.find('.column-chooser > button')
    expect(button.text()).toBe('Columns of the positions grid')
    expect(button.attributes('aria-expanded')).toBe('false')
    const list = panel.find(`#${button.attributes('aria-controls') ?? ''}`)
    expect(list.isVisible()).toBe(false)

    await button.trigger('click')
    await flushPromises()

    expect(button.attributes('aria-expanded')).toBe('true')
    expect(list.isVisible()).toBe(true)
    expect(list.find('legend').text()).toBe('Columns shown in the positions grid')
    const boxes = list.findAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes.map((box) => [box.element.parentElement?.textContent.trim(), box.element.checked, box.element.disabled])).toEqual([
      ['Symbol (always shown)', true, true], ['Direction', true, false], ['Net quantity', true, false], ['Average cost', true, false],
    ])
    expect(document.activeElement).toBe(boxes[1]?.element)
  })

  it('hides and shows columns independently, keeping their order, and restores the defaults', async () => {
    const panel = await showPositions()
    await panel.find('.column-chooser > button').trigger('click')

    await panel.find('input[data-column="direction"]').setValue(false)
    await panel.find('input[data-column="netQuantity"]').setValue(false)
    expect(headers(panel)).toEqual(['Symbol', 'Average cost'])
    expect(panel.find('tbody tr').findAll('th, td').map((cell) => cell.text())).toEqual(['AAPL', '187.12, exactly 187.125'])

    await panel.find('input[data-column="direction"]').setValue(true)
    expect(headers(panel)).toEqual(['Symbol', 'Direction', 'Average cost'])

    const restore = panel.findAll('.column-chooser-panel button').find((button) => button.text() === 'Restore default columns')
    expect(restore?.attributes('aria-disabled')).toBe('false')
    await restore?.trigger('click')
    expect(headers(panel)).toEqual(['Symbol', 'Direction', 'Net quantity', 'Average cost'])
    expect(restore?.attributes('aria-disabled')).toBe('true')
    expect(restore?.attributes('disabled')).toBeUndefined()
  })

  it('closes with Escape, returning focus to the button, and when the pointer goes down elsewhere', async () => {
    const panel = await showPositions()
    const button = panel.find('.column-chooser > button')
    await button.trigger('click')
    await flushPromises()

    await panel.find('input[data-column="direction"]').trigger('keydown', { key: 'Escape' })
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button.element)

    await button.trigger('click')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('click')
    panel.find('input[data-column="direction"]').element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(button.attributes('aria-expanded')).toBe('true')
  })

  it('keeps the columns chosen when positions are loaded again', async () => {
    const panel = await showPositions()
    await panel.find('.column-chooser > button').trigger('click')
    await panel.find('input[data-column="direction"]').setValue(false)

    await panel.find('button.refresh-positions').trigger('click')
    await flushPromises()

    expect(headers(panel)).toEqual(['Symbol', 'Net quantity', 'Average cost'])
  })
})

// -------------------------------------------------------------------------------------------------
// Show all columns in each of the three grids that have a Columns control

type Scope = DOMWrapper<Element> | VueWrapper

const showAllButton = (scope: Scope) => scope.find('.column-chooser-panel button.show-all-columns')
const countText = (scope: Scope): string => scope.find('.column-chooser-panel .column-count').text()
const boxStates = (scope: Scope): [string, boolean, boolean][] =>
  scope.findAll<HTMLInputElement>('.column-chooser-panel input[type="checkbox"]')
    .map((box) => [box.attributes('data-column') ?? '', box.element.checked, box.element.disabled])
const gridHeaders = (scope: Scope): string[] =>
  scope.findAll('thead th').map((cell) => cell.find('.column-label').exists()
    ? cell.find('.column-label').text()
    : (cell.find('.sort-button').element.firstChild?.textContent ?? '').trim())

/** Activates a focused button, as Enter or Space on it would: focus stays unless the page moves it. */
async function press(button: DOMWrapper<Element>): Promise<void> {
  ;(button.element as HTMLElement).focus()
  await button.trigger('click')
  await flushPromises()
}

describe('Show all columns: the Trading Positions grid', () => {
  async function showPositions() {
    fakeApi({ 'GET /positions': json('[{"symbol":"AAPL","netQuantity":-10,"averageCost":187.125}]') })
    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(PositionsPanel, { global: { plugins: [pinia] }, attachTo: document.body })
    await useBlotterStore().loadPositions()
    await flushPromises()
    await wrapper.find('.column-chooser > button').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('is marked unavailable while every column is shown, and then does nothing', async () => {
    const panel = await showPositions()
    const button = showAllButton(panel)
    expect(button.text()).toBe('Show all columns')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(countText(panel)).toBe('4 of 4 columns shown')

    await press(button)
    expect(gridHeaders(panel)).toEqual(['Symbol', 'Direction', 'Net quantity', 'Average cost'])
    expect(countText(panel)).toBe('4 of 4 columns shown')
    expect(panel.find('.column-chooser > button').attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(button.element)
  })

  it('shows hidden columns again in their places, keeping resized widths, checks their boxes and counts them, staying open with focus on it', async () => {
    const panel = await showPositions()
    await panel.find('[role="separator"][aria-label="Resize the Direction column"]').trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    const widthOf = (key: string): string => (panel.find(`thead th.column-${key}`).element as HTMLElement).style.width
    const widths = (): string[] => ['symbol', 'direction', 'netQuantity', 'averageCost'].map(widthOf)
    const resized = widths()
    // jsdom measures nothing, so every column starts at its least width; Direction is 50 px wider.
    expect(resized).toEqual(['88px', '162px', '136px', '136px'])

    await panel.find('input[data-column="direction"]').setValue(false)
    await panel.find('input[data-column="netQuantity"]').setValue(false)
    await flushPromises()
    expect(gridHeaders(panel)).toEqual(['Symbol', 'Average cost'])
    expect(countText(panel)).toBe('2 of 4 columns shown')
    expect(showAllButton(panel).attributes('aria-disabled')).toBe('false')

    const button = showAllButton(panel)
    await press(button)

    expect(gridHeaders(panel)).toEqual(['Symbol', 'Direction', 'Net quantity', 'Average cost'])
    expect(widths()).toEqual(resized)
    expect(boxStates(panel)).toEqual([['symbol', true, true], ['direction', true, false], ['netQuantity', true, false], ['averageCost', true, false]])
    expect(countText(panel)).toBe('4 of 4 columns shown')
    expect(panel.find('.column-chooser > button').attributes('aria-expanded')).toBe('true')
    expect(panel.find('.column-chooser-panel').isVisible()).toBe(true)
    expect(document.activeElement).toBe(button.element)
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(panel.find('tbody tr').findAll('th, td').map((cell) => cell.text())).toEqual(['AAPL', 'Short', '-10', '187.12, exactly 187.125'])
  })

  it('still closes with Escape from Show all columns, returning focus to the Columns button', async () => {
    const panel = await showPositions()
    await panel.find('input[data-column="direction"]').setValue(false)
    const button = showAllButton(panel)
    await press(button)
    await button.trigger('keydown', { key: 'Escape' })
    const columns = panel.find('.column-chooser > button')
    expect(columns.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(columns.element)
  })

  it('keeps Symbol fixed: its box is checked and cannot be changed', async () => {
    const panel = await showPositions()
    const symbol = panel.find<HTMLInputElement>('input[data-column="symbol"]')
    expect([symbol.element.checked, symbol.element.disabled]).toEqual([true, true])
    // A disabled box takes no input; were a change to arrive anyway, Symbol would stay.
    await symbol.setValue(false)
    expect(gridHeaders(panel)[0]).toBe('Symbol')
    expect(countText(panel)).toBe('4 of 4 columns shown')
  })
})

describe('Show all columns: Positions & Trade Details', () => {
  const POSITIONS = '[{"symbol":"MS","netQuantity":60,"averageCost":90.125},{"symbol":"MSFT","netQuantity":-3,"averageCost":5}]'
  const TRADE = tradeJson({
    id: 'ms-1', bookingSequence: 7, symbol: 'MS', side: 'Buy', quantity: '60', price: '90.125', notional: '5407.5',
    executedAt: '2026-03-01T15:00:00.000Z',
  })

  async function openDetails() {
    const server = fakeApi({ 'GET /trades/page': pageJson([TRADE], { page: 1, pageSize: 25, totalCount: 1 }), 'GET /positions': json(POSITIONS) })
    const page = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
    wrapper = page
    await flushPromises()
    await page.find('#tab-details').trigger('click')
    const master = page.find('section[aria-labelledby="master-heading"]')
    await master.findAll('tbody tr')[0]?.trigger('click')
    await flushPromises()
    return { server, master, details: page.find('section[aria-labelledby="details-heading"]') }
  }

  it('in the Open positions grid, shows a hidden column again in its place and keeps Symbol fixed', async () => {
    const { master } = await openDetails()
    await master.find('.column-chooser > button').trigger('click')
    await flushPromises()
    expect(showAllButton(master).attributes('aria-disabled')).toBe('true')
    await master.find('input[data-column="netQuantity"]').setValue(false)
    expect(gridHeaders(master)).toEqual(['Symbol', 'Direction', 'Average cost'])
    expect(countText(master)).toBe('3 of 4 columns shown')

    const button = showAllButton(master)
    await press(button)
    expect(gridHeaders(master)).toEqual(['Symbol', 'Direction', 'Net quantity', 'Average cost'])
    expect(countText(master)).toBe('4 of 4 columns shown')
    expect(boxStates(master)[0]).toEqual(['symbol', true, true])
    expect(document.activeElement).toBe(button.element)
    expect(master.find('tr.is-selected th').text()).toBe('MS')
  })

  it('in Trade Details, shows the five columns hidden by default too, in order, which Restore hides again', async () => {
    const { server, details } = await openDetails()
    const requests = server.sequence().length
    await details.find('.column-chooser > button').trigger('click')
    await flushPromises()
    expect(countText(details)).toBe('5 of 10 columns shown')
    expect(boxStates(details)[0]).toEqual(['executedAt', true, true])

    const button = showAllButton(details)
    expect(button.attributes('aria-disabled')).toBe('false')
    await press(button)

    expect(gridHeaders(details)).toEqual([
      'Executed at', 'Side', 'Quantity', 'Price', 'Notional', 'Symbol', 'Created at', 'Updated at', 'Booking sequence', 'Trade ID',
    ])
    expect(boxStates(details).every(([, checked]) => checked)).toBe(true)
    expect(countText(details)).toBe('10 of 10 columns shown')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button.element)
    expect(details.find('.column-chooser-panel').isVisible()).toBe(true)
    expect(details.find('tbody td.cell-id').text()).toBe('ms-1')

    const restore = details.findAll('.column-chooser-panel button').find((candidate) => candidate.text() === 'Restore default columns')
    await restore?.trigger('click')
    await flushPromises()
    expect(gridHeaders(details)).toEqual(['Executed at', 'Side', 'Quantity', 'Price', 'Notional'])
    expect(countText(details)).toBe('5 of 10 columns shown')
    expect(button.attributes('aria-disabled')).toBe('false')
    // Showing and hiding columns asks the API for nothing.
    expect(server.sequence()).toHaveLength(requests)
  })

  it('in Trade Details, keeps Executed at fixed whatever is chosen', async () => {
    const { details } = await openDetails()
    await details.find('.column-chooser > button').trigger('click')
    await flushPromises()
    await press(showAllButton(details))
    expect(boxStates(details)[0]).toEqual(['executedAt', true, true])
    await details.find('input[data-column="executedAt"]').setValue(false)
    expect(gridHeaders(details)[0]).toBe('Executed at')
    expect(countText(details)).toBe('10 of 10 columns shown')
  })
})

// -------------------------------------------------------------------------------------------------
// Restore default columns keeps focus: aria-disabled, never natively disabled, in all three grids.
// jsdom does not turn Enter or Space on a button into a click; a click on the focused button is
// what both do in a browser, and npm run check:ui presses the real keys.

describe('Restore default columns keeps keyboard focus', () => {
  const restoreButton = (scope: Scope) => scope.find('.column-chooser-panel button.restore-columns')

  /**
   * The chooser open in a grid at its defaults: Restore is unavailable but focusable and does
   * nothing; after `change`, activating it restores `defaults` with focus kept on it; activating it
   * again does nothing; Escape closes and returns to Columns.
   */
  async function expectRestoreKeepsFocus(scope: Scope, change: () => Promise<void>, defaults: readonly string[], total: number): Promise<void> {
    await scope.find('.column-chooser > button').trigger('click')
    await flushPromises()
    const restore = restoreButton(scope)
    expect(restore.text()).toBe('Restore default columns')
    expect(restore.attributes('aria-disabled')).toBe('true')
    expect(restore.attributes('disabled')).toBeUndefined()
    await press(restore)
    expect(document.activeElement).toBe(restore.element)
    expect(gridHeaders(scope)).toEqual(defaults)

    await change()
    expect(restore.attributes('aria-disabled')).toBe('false')

    await press(restore)
    expect(gridHeaders(scope)).toEqual(defaults)
    expect(countText(scope)).toBe(`${String(defaults.length)} of ${String(total)} columns shown`)
    expect(restore.attributes('aria-disabled')).toBe('true')
    expect(restore.attributes('disabled')).toBeUndefined()
    expect(document.activeElement).toBe(restore.element)
    expect(scope.find('.column-chooser-panel').isVisible()).toBe(true)

    // Activated again while unavailable: nothing changes, focus stays.
    const before = [gridHeaders(scope), boxStates(scope), countText(scope)]
    await press(restore)
    await press(restore)
    expect([gridHeaders(scope), boxStates(scope), countText(scope)]).toEqual(before)
    expect(document.activeElement).toBe(restore.element)

    await restore.trigger('keydown', { key: 'Escape' })
    const columns = scope.find('.column-chooser > button')
    expect(columns.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(columns.element)
  }

  it('in the Trading Positions grid', async () => {
    fakeApi({ 'GET /positions': json('[{"symbol":"AAPL","netQuantity":-10,"averageCost":187.125}]') })
    const pinia = createPinia()
    setActivePinia(pinia)
    const panel = mount(PositionsPanel, { global: { plugins: [pinia] }, attachTo: document.body })
    wrapper = panel
    await useBlotterStore().loadPositions()
    await flushPromises()
    await expectRestoreKeepsFocus(panel, async () => {
      await panel.find('input[data-column="direction"]').setValue(false)
      await panel.find('input[data-column="averageCost"]').setValue(false)
    }, ['Symbol', 'Direction', 'Net quantity', 'Average cost'], 4)
    // Show all columns, still a separate action, has nothing to show at these defaults.
    expect(showAllButton(panel).attributes('aria-disabled')).toBe('true')
  })

  describe('on Positions & Trade Details', () => {
    const TRADE = tradeJson({
      id: 'ms-1', bookingSequence: 7, symbol: 'MS', side: 'Buy', quantity: '60', price: '90.125', notional: '5407.5',
      executedAt: '2026-03-01T15:00:00.000Z',
    })

    async function openDetails() {
      fakeApi({ 'GET /trades/page': pageJson([TRADE], { page: 1, pageSize: 25, totalCount: 1 }), 'GET /positions': json('[{"symbol":"MS","netQuantity":60,"averageCost":90.125}]') })
      const page = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
      wrapper = page
      await flushPromises()
      await page.find('#tab-details').trigger('click')
      const master = page.find('section[aria-labelledby="master-heading"]')
      await master.findAll('tbody tr')[0]?.trigger('click')
      await flushPromises()
      return { master, details: page.find('section[aria-labelledby="details-heading"]') }
    }

    it('in the Open positions grid', async () => {
      const { master } = await openDetails()
      await expectRestoreKeepsFocus(master, async () => {
        await master.find('input[data-column="netQuantity"]').setValue(false)
      }, ['Symbol', 'Direction', 'Net quantity', 'Average cost'], 4)
      expect(master.find('tr.is-selected th').text()).toBe('MS')
    })

    it('in Trade Details, hiding again the columns hidden by default after Show all columns, which still works afterwards', async () => {
      const { details } = await openDetails()
      const defaults = ['Executed at', 'Side', 'Quantity', 'Price', 'Notional']
      await expectRestoreKeepsFocus(details, async () => {
        await details.find('input[data-column="side"]').setValue(false)
        await press(showAllButton(details))
        expect(gridHeaders(details)).toHaveLength(10)
      }, defaults, 10)
      expect(boxStates(details).filter(([, checked]) => !checked).map(([key]) => key)).toEqual(['symbol', 'createdAt', 'updatedAt', 'bookingSequence', 'id'])

      // Show all columns is unaffected: it shows all ten again, and Restore becomes available.
      await details.find('.column-chooser > button').trigger('click')
      await flushPromises()
      const showAll = showAllButton(details)
      expect(showAll.attributes('aria-disabled')).toBe('false')
      await press(showAll)
      expect(gridHeaders(details)).toHaveLength(10)
      expect(document.activeElement).toBe(showAll.element)
      expect(restoreButton(details).attributes('aria-disabled')).toBe('false')
    })
  })
})
