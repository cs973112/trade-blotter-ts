import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import PositionsPanel from '../src/components/PositionsPanel.vue'
import { clampWidth, LARGE_RESIZE_STEP, RESIZE_STEP, widthAfterDrag, widthAfterKey, widthsFrom } from '../src/lib/column-widths.ts'
import { useBlotterStore } from '../src/stores/blotter.ts'
import { fakeApi, json } from './support/fake-api.ts'

/**
 * The Positions grid: resizable columns (pointer and keyboard), their least widths, and the
 * scrolling box that shows 25 positions at a time. Layout itself (pixels on screen, the sticky
 * header) needs a real browser, and is checked by npm run check:ui; here jsdom measures every
 * element as 0 pixels wide, so the columns start at their least widths.
 */

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

const LIMITS = { minWidth: 100, maxWidth: 400 }

describe('column widths', () => {
  it('stay within each column\'s least and greatest width, in whole pixels', () => {
    expect(clampWidth(150.4, LIMITS)).toBe(150)
    expect(clampWidth(20, LIMITS)).toBe(100)
    expect(clampWidth(9000, LIMITS)).toBe(400)
    expect(clampWidth(Number.NaN, LIMITS)).toBe(100)
  })

  it('change by a step for each arrow key, a larger one with Shift or Page Up and Down, and go to the limits with Home and End', () => {
    expect(widthAfterKey(150, 'ArrowRight', false, LIMITS)).toBe(150 + RESIZE_STEP)
    expect(widthAfterKey(150, 'ArrowUp', false, LIMITS)).toBe(150 + RESIZE_STEP)
    expect(widthAfterKey(150, 'ArrowLeft', false, LIMITS)).toBe(150 - RESIZE_STEP)
    expect(widthAfterKey(150, 'ArrowDown', false, LIMITS)).toBe(150 - RESIZE_STEP)
    expect(widthAfterKey(150, 'ArrowRight', true, LIMITS)).toBe(150 + LARGE_RESIZE_STEP)
    expect(widthAfterKey(150, 'PageDown', false, LIMITS)).toBe(100)
    expect(widthAfterKey(150, 'PageUp', false, LIMITS)).toBe(200)
    expect(widthAfterKey(105, 'ArrowLeft', false, LIMITS)).toBe(100)
    expect(widthAfterKey(395, 'ArrowRight', true, LIMITS)).toBe(400)
    expect(widthAfterKey(150, 'Home', false, LIMITS)).toBe(100)
    expect(widthAfterKey(150, 'End', false, LIMITS)).toBe(400)
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a']) expect(widthAfterKey(150, key, false, LIMITS)).toBeUndefined()
  })

  it('follow the pointer while dragging, within the limits', () => {
    expect(widthAfterDrag(150, 500, 560, LIMITS)).toBe(210)
    expect(widthAfterDrag(150, 500, 480, LIMITS)).toBe(130)
    expect(widthAfterDrag(150, 500, 0, LIMITS)).toBe(100)
    expect(widthAfterDrag(150, 500, 5000, LIMITS)).toBe(400)
  })

  it('are taken from what is measured, held within limits', () => {
    const columns = [{ key: 'a', label: 'A', ...LIMITS }, { key: 'b', label: 'B', minWidth: 50, maxWidth: 60 }]
    expect(widthsFrom(columns, (index) => [180.6, 75][index] ?? 0)).toEqual({ a: 181, b: 60 })
  })
})

/** `count` open positions, P001 to P0nn, alternately long and short, one with a 50-digit average cost. */
function positionsJson(count: number): string {
  const items = Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const quantity = number % 2 === 0 ? `-${String(number * 10)}` : String(number * 10)
    const cost = number === 1 ? '1.6666666666666666666666666666666666666666666666667' : `${String(number)}.25`
    return `{"symbol":"P${String(number).padStart(3, '0')}","netQuantity":${quantity},"averageCost":${cost}}`
  })
  return `[${items.join(',')}]`
}

async function showPositions(count: number) {
  const server = fakeApi({ 'GET /positions': json(positionsJson(count)) })
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(PositionsPanel, { global: { plugins: [pinia] }, attachTo: document.body })
  await useBlotterStore().loadPositions()
  await flushPromises()
  return { server, panel: wrapper }
}

/** A pointer event as the browser sends it (test-utils cannot set a pointer event's own properties). */
async function pointer(target: DOMWrapper<Element>, type: string, init: PointerEventInit): Promise<void> {
  target.element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
  await nextTick()
}

const handle = (panel: VueWrapper, label: string): DOMWrapper<Element> => panel.find(`[role="separator"][aria-label="Resize the ${label} column"]`)
const headerWidths = (panel: VueWrapper): string[] => panel.findAll('thead th').map((cell) => (cell.element as HTMLElement).style.width)

describe('positions grid', () => {
  it('lists every position in the table, in a focusable box that scrolls, saying 25 are shown at a time', async () => {
    const { panel } = await showPositions(40)

    expect(panel.findAll('tbody tr')).toHaveLength(40)
    expect(panel.findAll('tbody th').map((cell) => cell.text()).at(-1)).toBe('P040')
    const box = panel.find('.positions-scroll')
    expect(box.attributes('tabindex')).toBe('0')
    expect(box.attributes('aria-labelledby')).toBe('positions-heading')
    expect(box.attributes('style')).toContain('--visible-rows: 25')
    expect(panel.find('caption').text()).toContain('40 in all')
    expect(panel.find('#positions-resize-help').text()).toContain('Showing 25 positions at a time; scroll the table for the rest.')
  })

  it('does not mention scrolling when every position fits', async () => {
    const { panel } = await showPositions(25)
    expect(panel.find('#positions-resize-help').text()).not.toContain('Showing 25')
  })

  it('keeps every quantity exact, shows average costs to 2 places, and keeps the exact cost as its title and for screen readers', async () => {
    const { panel } = await showPositions(2)
    expect(panel.findAll('tbody tr').map((row) => row.findAll('th, td').map((cell) => cell.text()))).toEqual([
      ['P001', 'Long', '10', '1.67, exactly 1.6666666666666666666666666666666666666666666666667'],
      ['P002', 'Short', '-20', '2.25'],
    ])
    expect(panel.find('td.average-cost .money').attributes('title')).toBe('Exactly 1.6666666666666666666666666666666666666666666666667')
    expect(panel.find('td.average-cost .visually-hidden').text()).toBe(', exactly 1.6666666666666666666666666666666666666666666666667')
  })

  it('has a resize handle for each column, a separator described by the instructions, with its limits', async () => {
    const { panel } = await showPositions(3)

    const handles = panel.findAll('[role="separator"]')
    expect(handles.map((element) => element.attributes('aria-label'))).toEqual([
      'Resize the Symbol column', 'Resize the Direction column', 'Resize the Net quantity column', 'Resize the Average cost column',
    ])
    for (const element of handles) {
      expect(element.attributes('tabindex')).toBe('0')
      expect(element.attributes('aria-orientation')).toBe('vertical')
      expect(element.attributes('aria-describedby')).toBe('positions-resize-help')
      expect(Number(element.attributes('aria-valuenow'))).toBeGreaterThanOrEqual(Number(element.attributes('aria-valuemin')))
    }
    expect(handle(panel, 'Symbol').attributes('aria-valuemin')).toBe('88')
    expect(panel.find('#positions-resize-help').text()).toContain('press the Left or Right arrow key')
  })

  it('sizes to its contents until a column is resized; then every column keeps a fixed width', async () => {
    const { panel } = await showPositions(3)
    expect(panel.find('table').attributes('style') ?? '').not.toContain('table-layout')
    expect(headerWidths(panel)).toEqual(['88px', '112px', '136px', '136px'])

    await handle(panel, 'Net quantity').trigger('keydown', { key: 'ArrowRight' })

    expect(panel.find('table').attributes('style')).toContain('table-layout: fixed')
    expect(headerWidths(panel)).toEqual(['88px', '112px', '146px', '136px'])
    expect(panel.find('table').attributes('style')).toContain(`width: ${String(88 + 112 + 146 + 136)}px`)
    expect(handle(panel, 'Net quantity').attributes('aria-valuenow')).toBe('146')
    expect(handle(panel, 'Net quantity').attributes('aria-valuetext')).toBe('146 pixels wide')
  })

  it('resizes from the keyboard: arrows, Shift, Home to the least width, and never narrower', async () => {
    const { panel } = await showPositions(3)
    const symbol = handle(panel, 'Symbol')

    await symbol.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    await symbol.trigger('keydown', { key: 'ArrowRight' })
    expect(symbol.attributes('aria-valuenow')).toBe(String(88 + 60))
    await symbol.trigger('keydown', { key: 'ArrowLeft' })
    expect(symbol.attributes('aria-valuenow')).toBe(String(88 + 50))
    await symbol.trigger('keydown', { key: 'Home' })
    expect(symbol.attributes('aria-valuenow')).toBe('88')
    await symbol.trigger('keydown', { key: 'ArrowLeft', shiftKey: true })
    expect(symbol.attributes('aria-valuenow')).toBe('88')
    await symbol.trigger('keydown', { key: 'End' })
    expect(symbol.attributes('aria-valuenow')).toBe('480')
  })

  it('resizes by dragging a handle, never below the least width, and Escape puts the width back', async () => {
    const { server, panel } = await showPositions(3)
    const cost = handle(panel, 'Average cost')

    await pointer(cost, 'pointerdown', { button: 0, clientX: 300, pointerId: 7 })
    await pointer(cost, 'pointermove', { clientX: 380, pointerId: 7 })
    expect(cost.attributes('aria-valuenow')).toBe(String(136 + 80))
    expect(panel.find('table').classes()).toContain('is-resizing')
    await pointer(cost, 'pointermove', { clientX: -500, pointerId: 7 })
    expect(cost.attributes('aria-valuenow')).toBe('136')
    await pointer(cost, 'pointermove', { clientX: 340, pointerId: 7 })
    await pointer(cost, 'pointerup', { clientX: 340, pointerId: 7 })
    expect(cost.attributes('aria-valuenow')).toBe(String(136 + 40))
    expect(panel.find('table').classes()).not.toContain('is-resizing')
    // After the drag the pointer no longer resizes.
    await pointer(cost, 'pointermove', { clientX: 900, pointerId: 7 })
    expect(cost.attributes('aria-valuenow')).toBe(String(136 + 40))

    await pointer(cost, 'pointerdown', { button: 0, clientX: 300, pointerId: 8 })
    await pointer(cost, 'pointermove', { clientX: 400, pointerId: 8 })
    await cost.trigger('keydown', { key: 'Escape' })
    expect(cost.attributes('aria-valuenow')).toBe(String(136 + 40))

    // Only the left button drags; nothing is loaded by resizing.
    await pointer(cost, 'pointerdown', { button: 2, clientX: 300, pointerId: 9 })
    await pointer(cost, 'pointermove', { clientX: 600, pointerId: 9 })
    expect(cost.attributes('aria-valuenow')).toBe(String(136 + 40))
    expect(server.sequence()).toEqual(['GET /positions'])
  })

  it('keeps the widths when the positions are loaded again, and goes back to fitting the contents on Reset column widths', async () => {
    const { server, panel } = await showPositions(3)
    expect(panel.find('.panel-actions').text()).not.toContain('Reset column widths')
    await handle(panel, 'Symbol').trigger('keydown', { key: 'PageUp' })
    const widths = headerWidths(panel)

    await panel.findAll('.panel-actions button').find((button) => button.text() === 'Refresh')?.trigger('click')
    await flushPromises()
    expect(server.sequence()).toEqual(['GET /positions', 'GET /positions'])
    expect(headerWidths(panel)).toEqual(widths)

    const reset = panel.findAll('.panel-actions button').find((button) => button.text() === 'Reset column widths')
    await reset?.trigger('click')
    await flushPromises()
    expect(panel.find('table').attributes('style') ?? '').not.toContain('table-layout')
    expect(panel.find('.panel-actions').text()).not.toContain('Reset column widths')
  })

  it('fits a column to its contents with Enter or a double click, never below its least width', async () => {
    const { panel } = await showPositions(3)
    await handle(panel, 'Direction').trigger('keydown', { key: 'End' })
    await handle(panel, 'Direction').trigger('keydown', { key: 'Enter' })
    // jsdom measures the contents as 0 pixels, so the fit is the least width.
    expect(handle(panel, 'Direction').attributes('aria-valuenow')).toBe('112')
    await handle(panel, 'Direction').trigger('keydown', { key: 'End' })
    await handle(panel, 'Direction').trigger('dblclick')
    expect(handle(panel, 'Direction').attributes('aria-valuenow')).toBe('112')
  })
})
