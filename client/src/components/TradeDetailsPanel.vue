<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'

import type { SortField, Trade } from '../api/contracts.ts'
import { describeTrade } from '../lib/cancellation.ts'
import { useColumnVisibility, type ChoosableColumn } from '../lib/column-visibility.ts'
import { useResizableGrid, type ResizableColumn } from '../lib/column-widths.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { positionDirection } from '../lib/positions.ts'
import { ariaSortFor, DEFAULT_TRADE_SORT, directionLabel, SORT_FIELDS } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import { useCancellationStore } from '../stores/cancellation.ts'
import { useExecutionStore } from '../stores/execution.ts'
import { useDetailsStore } from '../stores/details.ts'
import { useTradeDialogStore } from '../stores/trade-dialog.ts'
import ColumnChooser from './ColumnChooser.vue'
import ColumnResizer from './ColumnResizer.vue'
import ExactValuesToggle from './ExactValuesToggle.vue'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'
import SortButton from './SortButton.vue'
import StatusBadge from './StatusBadge.vue'
import TradePager from './TradePager.vue'

/**
 * The trades of the position chosen in the master grid: one page at a time from GET /trades/page
 * with symbolMatch=exact, so only that symbol's trades (MS never shows MSFT or MSTR). The API
 * sorts, counts and pages them; this panel never loads every trade. Columns can be resized and
 * hidden, as in the Positions grid. Each row's first cell has an edit button, which opens the trade
 * dialog (Execute, Keep Pending, Cancel with a reason, for a Pending trade), and a History button,
 * which opens the same dialog with the trade's audit history.
 */
const blotter = useBlotterStore()
const details = useDetailsStore()
const { positions } = storeToRefs(blotter)
const { symbol, trades, sort, page, pageSize, shownSymbol, shownSort, shownPage, showsChosen } = storeToRefs(details)
const cancellation = useCancellationStore()
const { outcome } = storeToRefs(cancellation)
const execution = useExecutionStore()
const { outcome: executed } = storeToRefs(execution)

const tradeDialog = useTradeDialogStore()

const opener = (event: Event): HTMLElement | null => event.currentTarget instanceof HTMLElement ? event.currentTarget : null

/** A row's edit button: the trade dialog, which offers Execute and Cancel for a Pending trade. */
function startEdit(trade: Trade, event: Event): void {
  tradeDialog.openFor(trade, opener(event), 'details')
}

/** The summary's button: the chosen symbol's Pending trades, to choose one from. */
function startCancelForSymbol(event: Event): void {
  if (symbol.value !== undefined) void cancellation.openForSymbol(symbol.value, 'details', opener(event))
}

/** A row's History button: the trade dialog with the trade's audit history, read only. */
function showHistory(trade: Trade, event: Event): void {
  tradeDialog.openFor(trade, opener(event), 'details', true)
}

const VISIBLE_TRADES = 25

type TradeColumn = ResizableColumn & ChoosableColumn & { readonly field?: SortField; readonly numeric?: boolean }

/**
 * In order. Actions comes first, so each trade's edit and History buttons are always in view; the
 * execution time identifies a trade within one symbol, so it is always shown too.
 */
const COLUMNS: readonly TradeColumn[] = [
  { key: 'actions', label: 'Actions', essential: true, minWidth: 96, maxWidth: 200 },
  { key: 'executedAt', label: 'Executed at', field: 'executedAt', essential: true, minWidth: 150, maxWidth: 480 },
  { key: 'side', label: 'Side', minWidth: 76, maxWidth: 240 },
  { key: 'status', label: 'Status', minWidth: 112, maxWidth: 240 },
  { key: 'quantity', label: 'Quantity', field: 'quantity', numeric: true, minWidth: 120, maxWidth: 800 },
  { key: 'price', label: 'Price', field: 'price', numeric: true, minWidth: 100, maxWidth: 800 },
  { key: 'notional', label: 'Notional', numeric: true, minWidth: 116, maxWidth: 800 },
  { key: 'symbol', label: 'Symbol', field: 'symbol', hiddenByDefault: true, minWidth: 104, maxWidth: 480 },
  { key: 'createdAt', label: 'Created at', hiddenByDefault: true, minWidth: 136, maxWidth: 480 },
  { key: 'updatedAt', label: 'Updated at', hiddenByDefault: true, minWidth: 136, maxWidth: 480 },
  { key: 'bookingSequence', label: 'Booking sequence', numeric: true, hiddenByDefault: true, minWidth: 176, maxWidth: 400 },
  { key: 'id', label: 'Trade ID', hiddenByDefault: true, minWidth: 104, maxWidth: 480 },
]

const visibility = useColumnVisibility(COLUMNS)
const visibleColumns = visibility.visibleColumns

const table = ref<HTMLTableElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const grid = useResizableGrid(visibleColumns, table, scroller)
const { resized, tableStyle, columnStyle, dragging, reset, scrollbarRoom } = grid

const MONEY_COLUMNS = ['price', 'notional'] as const

/**
 * Exact values on: rounded money in the grid and the position's average cost above it show their
 * exact values too (otherwise only as a tooltip and for screen readers). A column of fixed width
 * grows to fit them.
 */
const showExact = ref(false)
watch(showExact, async () => {
  if (!grid.resized.value) return
  await nextTick()
  for (const key of MONEY_COLUMNS) if (visibleColumns.value.some((column) => column.key === key)) grid.fitToContents(key)
})

/** The chosen position as GET /positions last listed it; undefined once it is flat. */
const position = computed(() => positions.value.items.find((candidate) => candidate.symbol === symbol.value))

const grouped = (value: number): string => value.toLocaleString('en-US')

/** "120 trades", for the chosen position, once its trades are shown. */
const total = computed(() => {
  const shown = shownPage.value
  if (!showsChosen.value || shown === undefined) return undefined
  return `${grouped(shown.totalCount)} ${shown.totalCount === 1 ? 'trade' : 'trades'}`
})

const caption = computed(() => {
  const { sortBy: field, sortDirection: direction } = shownSort.value
  const fieldLabel = SORT_FIELDS.find((option) => option.value === field)?.label ?? field
  const order = field === DEFAULT_TRADE_SORT.sortBy && direction === DEFAULT_TRADE_SORT.sortDirection
    ? 'newest execution first'
    : `sorted by ${fieldLabel.toLowerCase()}, ${directionLabel(field, direction).toLowerCase()}`
  return `Trades in ${shownSymbol.value ?? ''}, ${order}. Each trade is shown with its status. Times are in your time zone; a Pending trade has no execution time. Prices and notionals are rounded to 2 decimal places.`
})

const pager = computed(() => ({
  shown: showsChosen.value ? shownPage.value : undefined, page: page.value, pageSize: pageSize.value,
  goToPage: details.goToPage, setPageSize: details.setPageSize, idPrefix: 'details-pager', name: `Pages of ${symbol.value ?? ''} trades`,
}))

/** Announced when a page of the chosen position's trades has loaded. */
const summary = computed(() => {
  const shown = shownPage.value
  if (!showsChosen.value || shown === undefined || shown.totalCount === 0) return ''
  const first = (shown.page - 1) * shown.pageSize + 1
  const last = Math.min(shown.page * shown.pageSize, shown.totalCount)
  return `${shownSymbol.value ?? ''}: showing ${grouped(first)}–${grouped(last)} of ${total.value ?? ''}, page ${grouped(shown.page)} of ${grouped(shown.totalPages)}.`
})

const cellText = (trade: Trade, key: string): string => {
  switch (key) {
    case 'quantity': return formatDecimal(trade.quantity)
    case 'symbol': return trade.symbol
    case 'bookingSequence': return trade.bookingSequence.toLocaleString('en-US')
    case 'id': return trade.id
    default: return ''
  }
}
</script>

<template>
  <section class="panel trade-details-panel" aria-labelledby="details-heading">
    <div class="panel-heading">
      <h2 id="details-heading" tabindex="-1">
        Trade Details<template v-if="symbol">: <span class="details-symbol">{{ symbol }}</span></template>
      </h2>
      <div class="panel-actions">
        <button v-if="resized" type="button" class="button-secondary" @click="reset()">
          Reset column widths
        </button>
        <ExactValuesToggle v-model="showExact" grid-label="trade details grid" />
        <ColumnChooser :visibility="visibility" grid-label="trade details grid" />
        <button type="button" class="button-secondary refresh-details" :disabled="symbol === undefined || trades.loading" @click="details.reload()">
          Refresh
        </button>
      </div>
    </div>

    <p v-if="symbol === undefined" class="state">
      Choose a position to see the trades that make it up.
    </p>

    <template v-else>
      <dl class="position-summary" aria-label="Chosen position">
        <div><dt>Symbol</dt><dd class="symbol">{{ symbol }}</dd></div>
        <template v-if="position">
          <div>
            <dt>Direction</dt>
            <dd>
              <span class="direction-badge" :class="`direction-${positionDirection(position).toLowerCase()}`">
                {{ positionDirection(position) }}
              </span>
            </dd>
          </div>
          <div><dt>Executed net</dt><dd class="numeric executed-net">{{ formatDecimal(position.executedNetQuantity) }}</dd></div>
          <div>
            <dt>Average cost</dt>
            <dd class="numeric average-cost"><MoneyValue :value="position.averageCost" :show-exact="showExact" /></dd>
          </div>
        </template>
        <div v-if="total"><dt>Trades</dt><dd class="numeric trade-count">{{ total }}</dd></div>
      </dl>
      <div class="details-actions">
        <button type="button" class="button-secondary cancel-pending" @click="startCancelForSymbol($event)">
          Cancel a Pending trade in {{ symbol }}…
        </button>
      </div>
      <p
        v-if="outcome?.context === 'details'"
        id="details-cancellation-outcome"
        class="alert alert-success cancellation-outcome"
        role="status"
        tabindex="-1"
      >
        {{ outcome.message }}
      </p>
      <p
        v-if="executed?.context === 'details'"
        id="details-execution-outcome"
        class="alert alert-success execution-outcome"
        role="status"
        tabindex="-1"
      >
        {{ executed.message }}
      </p>
      <p v-if="positions.loaded && position === undefined" class="state">{{ symbol }} is no longer an open position; its trades are still listed.</p>

      <p v-if="trades.error" class="alert alert-error" role="alert">
        Trades for {{ symbol }} could not be loaded. {{ trades.error }}
        <button type="button" class="button-secondary retry-details" @click="details.reload()">Try again</button>
      </p>
      <div class="list-status">
        <p v-if="trades.loading && !showsChosen" class="state" role="status">Loading trades for {{ symbol }}…</p>
        <p v-else-if="trades.loading" class="state" role="status">Updating trades…</p>
        <template v-else-if="showsChosen">
          <p v-if="trades.items.length === 0" class="state" role="status">No trades for {{ symbol }}.</p>
          <p v-else class="visually-hidden" role="status">{{ summary }}</p>
        </template>
      </div>

      <template v-if="showsChosen && trades.items.length > 0">
        <TradePager placement="top" v-bind="pager" />
        <div
          ref="scroller"
          class="table-scroll grid-scroll details-scroll"
          tabindex="0"
          aria-labelledby="details-heading"
          :aria-busy="trades.loading"
          :style="{ '--visible-rows': VISIBLE_TRADES, '--scrollbar-room': `${scrollbarRoom}px` }"
        >
          <table ref="table" class="data-table grid-table details-table" :class="{ 'is-resizing': dragging !== undefined }" :style="tableStyle">
            <caption class="visually-hidden">{{ caption }}</caption>
            <thead>
              <tr>
                <th
                  v-for="column in visibleColumns"
                  :key="column.key"
                  scope="col"
                  :class="[`column-${column.key}`, { numeric: column.numeric, sortable: column.field !== undefined }]"
                  :style="columnStyle(column)"
                  :aria-sort="ariaSortFor(shownSort, column.field)"
                >
                  <SortButton
                    v-if="column.field"
                    :field="column.field"
                    :label="column.label"
                    :shown="shownSort"
                    :current="sort"
                    @sort="(field: SortField) => details.sortBy(field)"
                  />
                  <span v-else class="column-label">{{ column.label }}</span>
                  <ColumnResizer :column="column" :grid="grid" help-id="details-help" />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="trade in trades.items" :key="trade.id" :data-trade-id="trade.id">
                <template v-for="column in visibleColumns" :key="column.key">
                  <th v-if="column.key === 'executedAt'" scope="row" class="executed"><LocalTimestamp :utc="trade.executedAt" none="Not executed" /></th>
                  <td v-else-if="column.key === 'side'">
                    <span class="side-badge" :class="trade.side === 'Buy' ? 'side-badge-buy' : 'side-badge-sell'">{{ trade.side }}</span>
                  </td>
                  <td v-else-if="column.key === 'status'" class="status"><StatusBadge :status="trade.status" :reason="trade.cancellationReason" /></td>
                  <td v-else-if="column.key === 'actions'" class="actions">
                    <button
                      type="button"
                      class="icon-button trade-edit"
                      :aria-label="`Edit the trade: ${describeTrade(trade)}, ${trade.status}`"
                      title="Edit"
                      @click="startEdit(trade, $event)"
                    >
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                        <path d="M10.6 2.6l2.8 2.8-7.6 7.6-3.4.6.6-3.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                        <path d="M9.2 4l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="icon-button show-history"
                      :aria-label="`Audit history of the trade: ${describeTrade(trade)}, ${trade.status}`"
                      title="History"
                      @click="showHistory(trade, $event)"
                    >
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                        <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                        <path d="M8 4.4V8l2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </td>
                  <td v-else-if="column.key === 'price'" class="numeric price"><MoneyValue :value="trade.price" :show-exact="showExact" /></td>
                  <td v-else-if="column.key === 'notional'" class="numeric notional"><MoneyValue :value="trade.notional" :show-exact="showExact" /></td>
                  <td v-else-if="column.key === 'createdAt'" class="recorded"><LocalTimestamp :utc="trade.createdAt" /></td>
                  <td v-else-if="column.key === 'updatedAt'" class="recorded"><LocalTimestamp :utc="trade.updatedAt" /></td>
                  <td v-else :class="[`cell-${column.key}`, { numeric: column.numeric }]" :title="cellText(trade, column.key)">{{ cellText(trade, column.key) }}</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
        <TradePager placement="bottom" v-bind="pager" />
      </template>
      <p id="details-help" class="hint">
        Only trades in exactly {{ symbol }} are listed, each once with its status. The edit button opens a trade, to execute or cancel it
        while it is Pending; History opens it with its audit history. Prices and notionals are shown to 2 decimal places; point at one,
        or turn on Exact values, for its exact value. Choose Executed at, Quantity or Price to sort. To resize a column, drag the edge of its header,
        or focus the edge and press the Left or Right arrow key.
      </p>
    </template>
  </section>
</template>
