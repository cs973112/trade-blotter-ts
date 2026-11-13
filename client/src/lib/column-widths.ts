import { computed, nextTick, onBeforeUnmount, onMounted, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

/**
 * Resizable table columns. Until a column is resized the table sizes itself to its contents
 * (compact, nothing cut off). The first resize takes every column's current width as its own, so
 * one column changes and the others stay put; from then on the table has fixed widths, shared by
 * the header and every row, until the widths are reset. Hiding a column keeps its width for when
 * it is shown again, and the table becomes narrower by that width, leaving no gap.
 */

export interface ResizableColumn {
  readonly key: string
  readonly label: string
  /** Narrowest it may become, wide enough for its header. */
  readonly minWidth: number
  readonly maxWidth: number
}

/** One arrow-key press, and one with Shift (or Page Up and Page Down). */
export const RESIZE_STEP = 10
export const LARGE_RESIZE_STEP = 50

/** A width within the column's limits, in whole pixels. */
export function clampWidth(width: number, column: Pick<ResizableColumn, 'minWidth' | 'maxWidth'>): number {
  if (!Number.isFinite(width)) return column.minWidth
  return Math.round(Math.min(column.maxWidth, Math.max(column.minWidth, width)))
}

/**
 * The width after a key press on a column's resize handle, or undefined for a key that does not
 * resize: arrows by a step (Shift for a larger one), Page Up and Page Down by a larger step, Home
 * to the narrowest and End to the widest.
 */
export function widthAfterKey(width: number, key: string, shift: boolean, column: Pick<ResizableColumn, 'minWidth' | 'maxWidth'>): number | undefined {
  const step = shift ? LARGE_RESIZE_STEP : RESIZE_STEP
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return clampWidth(width + step, column)
    case 'ArrowLeft': case 'ArrowDown': return clampWidth(width - step, column)
    case 'PageUp': return clampWidth(width + LARGE_RESIZE_STEP, column)
    case 'PageDown': return clampWidth(width - LARGE_RESIZE_STEP, column)
    case 'Home': return column.minWidth
    case 'End': return column.maxWidth
    default: return undefined
  }
}

/** The width while dragging: the width at the start plus how far the pointer moved, within limits. */
export function widthAfterDrag(startWidth: number, startX: number, x: number, column: Pick<ResizableColumn, 'minWidth' | 'maxWidth'>): number {
  return clampWidth(startWidth + (x - startX), column)
}

/** Every column's width, from what is measured, held within its limits. */
export function widthsFrom(columns: readonly ResizableColumn[], measured: (index: number) => number): Record<string, number> {
  return Object.fromEntries(columns.map((column, index) => [column.key, clampWidth(measured(index), column)]))
}

/**
 * Column widths for a table element: what the template binds, and what the resize handles call.
 * `columnsSource` is the columns on screen, in order: every one, or those a column chooser leaves
 * shown.
 */
export function useColumnWidths(columnsSource: MaybeRefOrGetter<readonly ResizableColumn[]>, table: Ref<HTMLTableElement | null>) {
  const columns = (): readonly ResizableColumn[] => toValue(columnsSource)
  /** Undefined: sized to the contents. Otherwise each column's width in pixels, kept while it is hidden. */
  const widths = ref<Record<string, number> | undefined>(undefined)
  /** The widths as last measured or set, for the handles' accessible values. */
  const shown = ref<Record<string, number>>({})

  const headerCell = (index: number): HTMLTableCellElement | undefined => table.value?.tHead?.rows[0]?.cells[index]
  const measure = (): Record<string, number> => widthsFrom(columns(), (index) => headerCell(index)?.getBoundingClientRect().width ?? 0)

  /** Reads the widths on screen again (the handles report them). */
  function remeasure(): void {
    shown.value = widths.value === undefined ? measure() : { ...measure(), ...widths.value }
  }

  function widthOf(key: string): number {
    return widths.value?.[key] ?? shown.value[key] ?? columns().find((column) => column.key === key)?.minWidth ?? 0
  }

  function setWidth(key: string, width: number): void {
    const column = columns().find((candidate) => candidate.key === key)
    if (column === undefined) return
    // The first resize fixes every column shown at its width now, so only this one changes.
    widths.value = { ...(widths.value ?? measure()), [key]: clampWidth(width, column) }
    shown.value = widths.value
  }

  /**
   * The width the column's widest content needs, header included: a cell's own overflow, and any
   * text cut short inside it (.cell-text, such as a long symbol) shown whole.
   */
  function fitToContents(key: string): void {
    const index = columns().findIndex((column) => column.key === key)
    if (index < 0) return
    const rows = [...(table.value?.rows ?? [])]
    const needed = Math.max(0, ...rows.map((row) => {
      const cell = row.cells[index]
      if (cell === undefined) return 0
      const inner = cell.querySelector('.cell-text')
      return cell.scrollWidth + (inner === null ? 0 : Math.max(0, inner.scrollWidth - inner.clientWidth))
    }))
    setWidth(key, needed)
  }

  /** Back to sizing by contents. */
  async function reset(): Promise<void> {
    widths.value = undefined
    await nextTick()
    remeasure()
  }

  // A column shown again keeps the width it had. One never sized, shown while the widths are
  // fixed, is fitted to its contents rather than squeezed to its least width.
  watch(() => columns().map((column) => column.key).join(' '), async () => {
    await nextTick()
    const fixed = widths.value
    if (fixed !== undefined) {
      for (const column of columns()) if (fixed[column.key] === undefined) fitToContents(column.key)
    }
    remeasure()
  })

  const resized = computed(() => widths.value !== undefined)
  const tableStyle = computed(() => {
    const fixed = widths.value
    if (fixed === undefined) return {}
    const total = columns().reduce((sum, column) => sum + (fixed[column.key] ?? column.minWidth), 0)
    return { tableLayout: 'fixed' as const, width: `${String(total)}px` }
  })
  const columnStyle = (column: ResizableColumn): Record<string, string> => {
    const width = widths.value?.[column.key]
    // Sized by contents, a cell's width is its column's least width; fixed, it is the column's width.
    return { width: `${String(width ?? column.minWidth)}px` }
  }

  return { widths, shown, resized, tableStyle, columnStyle, widthOf, setWidth, fitToContents, reset, remeasure }
}

/**
 * A grid with resizable columns: the widths above, and what the resize handles do with the pointer
 * and the keyboard. Dragging a handle changes only that column (Escape puts it back), and nothing
 * else on the page reacts: no sorting, selecting or text selection. On a focused handle the arrow
 * keys, Page Up and Down, Home and End resize (widthAfterKey), and Enter fits the contents.
 *
 * It also measures the room a horizontal scroll bar takes in the grid's box (`scrollbarRoom`), so a
 * box that shows a fixed number of rows never lets the scroll bar cover the last one. Overlay
 * scroll bars take none.
 */
export function useResizableGrid(columns: MaybeRefOrGetter<readonly ResizableColumn[]>, table: Ref<HTMLTableElement | null>, scroller: Ref<HTMLElement | null>) {
  const widthsApi = useColumnWidths(columns, table)
  const { widthOf, setWidth, fitToContents, remeasure } = widthsApi

  let drag: { key: string; startX: number; startWidth: number; pointerId: number; handle: HTMLElement } | undefined
  /** The key of the column being dragged. */
  const dragging = ref<string>()

  function startDrag(event: PointerEvent, column: ResizableColumn): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    remeasure()
    const handle = event.currentTarget as HTMLElement
    drag = { key: column.key, startX: event.clientX, startWidth: widthOf(column.key), pointerId: event.pointerId, handle }
    dragging.value = column.key
    if ('setPointerCapture' in handle) handle.setPointerCapture(event.pointerId)
    handle.focus({ preventScroll: true })
  }

  function moveDrag(event: PointerEvent, column: ResizableColumn): void {
    if (drag?.key !== column.key || event.pointerId !== drag.pointerId) return
    event.preventDefault()
    setWidth(column.key, widthAfterDrag(drag.startWidth, drag.startX, event.clientX, column))
  }

  function endDrag(event: PointerEvent): void {
    if (drag === undefined || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    if ('hasPointerCapture' in drag.handle && drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId)
    drag = undefined
    dragging.value = undefined
  }

  function resizeByKey(event: KeyboardEvent, column: ResizableColumn): void {
    if (event.key === 'Escape' && drag !== undefined) {
      setWidth(drag.key, drag.startWidth)
      drag = undefined
      dragging.value = undefined
      event.preventDefault()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      fitToContents(column.key)
      return
    }
    remeasure()
    const next = widthAfterKey(widthOf(column.key), event.key, event.shiftKey, column)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    setWidth(column.key, next)
  }

  const scrollbarRoom = ref(0)
  let observer: ResizeObserver | undefined

  function measureScrollbar(): void {
    const box = scroller.value
    if (box === null || box.offsetHeight === 0) return
    const style = getComputedStyle(box)
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    scrollbarRoom.value = Math.max(0, box.offsetHeight - box.clientHeight - (Number.isFinite(borders) ? borders : 0))
  }

  onMounted(() => {
    if (typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => { measureScrollbar(); remeasure() })
    watch(scroller, (box, previous) => {
      if (previous) observer?.unobserve(previous)
      if (box) observer?.observe(box)
    }, { immediate: true })
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
  })

  return { ...widthsApi, dragging, startDrag, moveDrag, endDrag, resizeByKey, scrollbarRoom }
}

export type ResizableGrid = ReturnType<typeof useResizableGrid>
