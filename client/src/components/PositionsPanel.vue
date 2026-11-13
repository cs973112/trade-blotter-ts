<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'

import type { Position } from '../api/contracts.ts'
import { useColumnVisibility, type ChoosableColumn } from '../lib/column-visibility.ts'
import { useResizableGrid, type ResizableColumn } from '../lib/column-widths.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import ColumnChooser from './ColumnChooser.vue'
import ColumnResizer from './ColumnResizer.vue'
import ExactValuesToggle from './ExactValuesToggle.vue'
import MoneyValue from './MoneyValue.vue'

/**
 * The open positions from GET /positions, in the API's order (by symbol), as a grid: compact
 * columns that can be resized and hidden, 25 rows in view under a header that stays put.
 *
 * On the Trading tab it only shows them. On Positions & Trade Details it is the master grid
 * (`selectable`): each row can be chosen with the pointer, or with the keyboard (arrow keys, Page
 * Up and Down, Home and End move between rows; Enter or Space chooses one), and the chosen row is
 * marked for the eye and for screen readers (aria-selected in a grid). Choosing emits `select`;
 * the parent decides what it shows.
 *
 * Both grids show the total above the table, "Total: 167 positions": every open position GET
 * /positions last returned, however many rows are in view. Both read the one list in the store, so
 * they always agree, and it changes only when that list is loaded again (after a booking or Refresh).
 */
const props = withDefaults(defineProps<{
  /** Prefix for the ids in this grid, unique on the page. */
  idPrefix?: string
  title?: string
  selectable?: boolean
  /** The symbol of the chosen row, when selectable. */
  selected?: string | undefined
}>(), { idPrefix: 'positions', title: 'Positions', selectable: false, selected: undefined })

const emit = defineEmits<{ select: [symbol: string] }>()

const store = useBlotterStore()
const { positions } = storeToRefs(store)

const isShort = (netQuantity: string): boolean => netQuantity.startsWith('-')

/** The grid shows this many positions at a time; the rest scroll, under a header that stays in view. */
const VISIBLE_POSITIONS = 25

type PositionColumn = ResizableColumn & ChoosableColumn & { readonly numeric?: boolean }

const COLUMNS: readonly PositionColumn[] = [
  { key: 'symbol', label: 'Symbol', minWidth: 88, maxWidth: 480, essential: true },
  { key: 'direction', label: 'Direction', minWidth: 112, maxWidth: 320 },
  { key: 'netQuantity', label: 'Net quantity', minWidth: 136, maxWidth: 800, numeric: true },
  { key: 'averageCost', label: 'Average cost', minWidth: 136, maxWidth: 800, numeric: true },
]

const visibility = useColumnVisibility(COLUMNS)
const visibleColumns = visibility.visibleColumns

const table = ref<HTMLTableElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const grid = useResizableGrid(visibleColumns, table, scroller)
const { resized, tableStyle, columnStyle, dragging, reset, scrollbarRoom } = grid

const MONEY_COLUMNS = ['averageCost'] as const

/** Exact values on: rounded money shows its exact value too. A column of fixed width grows to fit it. */
const showExact = ref(false)
watch(showExact, async () => {
  if (!grid.resized.value) return
  await nextTick()
  for (const key of MONEY_COLUMNS) if (visibleColumns.value.some((column) => column.key === key)) grid.fitToContents(key)
})

const headingId = computed(() => `${props.idPrefix}-heading`)
const helpId = computed(() => `${props.idPrefix}-resize-help`)
const gridLabel = computed(() => `${props.title.toLowerCase()} grid`)

// ---------------------------------------------------------------------------------------------
// Choosing a row (master grid only)

/** The row the keyboard is on: one tab stop for the whole grid, on that row's symbol. */
const active = ref<string>()

const activeSymbol = computed(() => {
  const items = positions.value.items
  if (active.value !== undefined && items.some((position) => position.symbol === active.value)) return active.value
  if (props.selected !== undefined && items.some((position) => position.symbol === props.selected)) return props.selected
  return items[0]?.symbol
})

watch(() => props.selected, (symbol) => { if (symbol !== undefined) active.value = symbol })

function choose(position: Position): void {
  if (!props.selectable) return
  active.value = position.symbol
  emit('select', position.symbol)
}

async function focusRow(symbol: string): Promise<void> {
  active.value = symbol
  await nextTick()
  const cells = [...(table.value?.querySelectorAll<HTMLElement>('tbody th[data-symbol]') ?? [])]
  cells.find((cell) => cell.dataset['symbol'] === symbol)?.focus()
}

function onRowKey(event: KeyboardEvent, index: number): void {
  const items = positions.value.items
  const position = items[index]
  if (position === undefined) return
  let target: number | undefined
  switch (event.key) {
    case 'ArrowDown': target = index + 1; break
    case 'ArrowUp': target = index - 1; break
    case 'PageDown': target = index + VISIBLE_POSITIONS; break
    case 'PageUp': target = index - VISIBLE_POSITIONS; break
    case 'Home': target = 0; break
    case 'End': target = items.length - 1; break
    case 'Enter': case ' ':
      event.preventDefault()
      choose(position)
      return
    default: return
  }
  event.preventDefault()
  const next = items[Math.min(items.length - 1, Math.max(0, target))]
  if (next !== undefined) void focusRow(next.symbol)
}

function onRowClick(position: Position): void {
  if (!props.selectable) return
  choose(position)
  void focusRow(position.symbol)
}

/** "Total: 167 positions", once positions have loaded. */
const total = computed(() => {
  const count = positions.value.items.length
  return `Total: ${count.toLocaleString('en-US')} ${count === 1 ? 'position' : 'positions'}`
})

const caption = computed(() => {
  const count = positions.value.items.length
  const base = `Open positions by symbol, ${String(count)} in all. Flat positions are not shown. Average costs are rounded to 2 decimal places.`
  return props.selectable ? `${base} Choose a position to see its trades.` : base
})
</script>

<template>
  <section class="panel positions-panel" :aria-labelledby="headingId">
    <div class="panel-heading">
      <h2 :id="headingId">{{ title }}</h2>
      <div class="panel-actions">
        <button v-if="resized" type="button" class="button-secondary" @click="reset()">
          Reset column widths
        </button>
        <ExactValuesToggle v-model="showExact" :grid-label="gridLabel" />
        <ColumnChooser :visibility="visibility" :grid-label="gridLabel" />
        <button type="button" class="button-secondary refresh-positions" :disabled="positions.loading" @click="store.loadPositions()">
          Refresh
        </button>
      </div>
    </div>

    <p v-if="positions.error" class="alert alert-error" role="alert">
      Positions could not be loaded. {{ positions.error }}
    </p>
    <p v-if="positions.loaded" class="pager-range positions-total">{{ total }}</p>
    <p v-if="positions.loading && !positions.loaded" class="state" role="status">Loading positions…</p>
    <p v-else-if="positions.loaded && positions.items.length === 0" class="state">No open positions.</p>

    <template v-if="positions.items.length > 0">
      <div
        ref="scroller"
        class="table-scroll grid-scroll positions-scroll"
        :tabindex="selectable ? undefined : 0"
        :aria-labelledby="selectable ? undefined : headingId"
        :style="{ '--visible-rows': VISIBLE_POSITIONS, '--scrollbar-room': `${scrollbarRoom}px` }"
      >
        <table
          ref="table"
          class="data-table grid-table positions-table"
          :class="{ 'is-resizing': dragging !== undefined, 'is-selectable': selectable, 'is-fixed': resized }"
          :style="tableStyle"
          :role="selectable ? 'grid' : undefined"
          :aria-readonly="selectable ? 'true' : undefined"
          :aria-labelledby="selectable ? headingId : undefined"
        >
          <caption class="visually-hidden">{{ caption }}</caption>
          <thead>
            <tr>
              <th
                v-for="column in visibleColumns"
                :key="column.key"
                scope="col"
                :class="[`column-${column.key}`, { numeric: column.numeric }]"
                :style="columnStyle(column)"
              >
                <span class="column-label">{{ column.label }}</span>
                <ColumnResizer :column="column" :grid="grid" :help-id="helpId" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(position, index) in positions.items"
              :key="position.symbol"
              :class="[isShort(position.netQuantity) ? 'position-short' : 'position-long', { 'is-selected': selectable && position.symbol === selected }]"
              :aria-selected="selectable ? position.symbol === selected : undefined"
              @click="onRowClick(position)"
            >
              <template v-for="column in visibleColumns" :key="column.key">
                <th
                  v-if="column.key === 'symbol'"
                  scope="row"
                  class="symbol"
                  :title="position.symbol"
                  :data-symbol="position.symbol"
                  :tabindex="selectable ? (position.symbol === activeSymbol ? 0 : -1) : undefined"
                  @keydown="selectable ? onRowKey($event, index) : undefined"
                >
                  <span class="cell-text">{{ position.symbol }}</span>
                </th>
                <td v-else-if="column.key === 'direction'" class="direction">
                  <span class="direction-badge" :class="isShort(position.netQuantity) ? 'direction-short' : 'direction-long'">
                    {{ isShort(position.netQuantity) ? 'Short' : 'Long' }}
                  </span>
                </td>
                <td v-else-if="column.key === 'netQuantity'" class="numeric net-quantity" :title="formatDecimal(position.netQuantity)">
                  {{ formatDecimal(position.netQuantity) }}
                </td>
                <td v-else class="numeric average-cost"><MoneyValue :value="position.averageCost" :show-exact="showExact" /></td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <p :id="helpId" class="hint">
        <template v-if="selectable">
          Choose a position to see its trades: click its row, or move with the Up and Down arrow keys and press Enter.
        </template>
        <template v-if="positions.items.length > VISIBLE_POSITIONS">
          Showing {{ VISIBLE_POSITIONS }} positions at a time; scroll the table for the rest.
        </template>
        Average costs are shown to 2 decimal places; point at one, or turn on Exact values, for its exact value.
        To resize a column, drag the edge of its header, or focus the edge and press the Left or Right arrow key
        (with Shift for larger steps, Home for the narrowest, Enter to fit the contents).
      </p>
    </template>
  </section>
</template>
