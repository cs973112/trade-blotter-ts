<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import type { SortField, Trade } from '../api/contracts.ts'
import { describeTrade } from '../lib/cancellation.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { ariaSortFor, DEFAULT_TRADE_SORT, directionLabel, narrowsList, SORT_FIELDS, type TradeSort } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import { useCancellationStore } from '../stores/cancellation.ts'
import { useExecutionStore } from '../stores/execution.ts'
import { useTradeDialogStore } from '../stores/trade-dialog.ts'
import ExactValuesToggle from './ExactValuesToggle.vue'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'
import SortButton from './SortButton.vue'
import StatusBadge from './StatusBadge.vue'
import TradeFilters from './TradeFilters.vue'
import TradePager from './TradePager.vue'

const store = useBlotterStore()
const { trades, sort, page, pageSize, shownTradeQuery, shownPage } = storeToRefs(store)
const cancellation = useCancellationStore()
const { outcome } = storeToRefs(cancellation)
const execution = useExecutionStore()
const { outcome: executed } = storeToRefs(execution)
const tradeDialog = useTradeDialogStore()

/** Opens the trade dialog for any trade, with focus to come back to this button. */
function openDetails(trade: Trade, event: Event): void {
  tradeDialog.openFor(trade, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
}

/** Opens the trade dialog with the trade's audit history shown, with focus to come back to this button. */
function openHistory(trade: Trade, event: Event): void {
  tradeDialog.openFor(trade, event.currentTarget instanceof HTMLElement ? event.currentTarget : null, 'history', true)
}

/** The columns, in order. Four sort the list when their header is chosen; the API does the sorting. */
const COLUMNS: readonly { readonly label: string; readonly field?: SortField; readonly numeric?: boolean }[] = [
  // First, so every trade's details button (and a Pending trade's Execute and Cancel in its dialog) is always in view.
  { label: 'Actions' },
  { label: 'Symbol', field: 'symbol' },
  { label: 'Side' },
  { label: 'Status' },
  { label: 'Quantity', field: 'quantity', numeric: true },
  { label: 'Price', field: 'price', numeric: true },
  { label: 'Notional', numeric: true },
  { label: 'Executed at', field: 'executedAt' },
  { label: 'Created at' },
  { label: 'Updated at' },
]

/** Whether the trades shown are a subset: then "no trades" means "none match". */
const filtered = computed(() => narrowsList(shownTradeQuery.value))

/** The order of the trades on screen, which headers and the caption describe. */
const shownSort = computed<TradeSort>(() => ({
  sortBy: shownTradeQuery.value.sortBy ?? DEFAULT_TRADE_SORT.sortBy,
  sortDirection: shownTradeQuery.value.sortDirection ?? DEFAULT_TRADE_SORT.sortDirection,
}))

const caption = computed(() => {
  const { sortBy: field, sortDirection: direction } = shownSort.value
  const fieldLabel = SORT_FIELDS.find((option) => option.value === field)?.label ?? field
  const order = field === DEFAULT_TRADE_SORT.sortBy && direction === DEFAULT_TRADE_SORT.sortDirection
    ? 'newest execution first'
    : `sorted by ${fieldLabel.toLowerCase()}, ${directionLabel(field, direction).toLowerCase()}`
  const subject = filtered.value ? 'Trades matching the filters' : 'Every trade'
  return `${subject}, ${order}. Each trade is listed once, with its status. Times are in your time zone, with the UTC offset shown; a Pending trade has no execution time. Prices and notionals are rounded to 2 decimal places.`
})

/** Exact values on: rounded prices and notionals show their exact values too. */
const showExact = ref(false)

/** The pagers' state and actions: this list's page, from the store. */
const pager = computed(() => ({
  shown: shownPage.value, page: page.value, pageSize: pageSize.value, filtered: narrowsList(shownTradeQuery.value),
  goToPage: store.goToPage, setPageSize: store.setPageSize,
}))

const hasTrades = computed(() => trades.value.items.length > 0 && shownPage.value !== undefined)

/** Announced when a page has loaded, since the visible counts are in two places. */
const summary = computed(() => {
  const shown = shownPage.value
  if (shown === undefined || shown.totalCount === 0) return ''
  const first = (shown.page - 1) * shown.pageSize + 1
  const last = Math.min(shown.page * shown.pageSize, shown.totalCount)
  const noun = `${filtered.value ? 'matching ' : ''}${shown.totalCount === 1 ? 'trade' : 'trades'}`
  const grouped = (value: number): string => value.toLocaleString('en-US')
  return `Showing ${grouped(first)}–${grouped(last)} of ${grouped(shown.totalCount)} ${noun}, page ${grouped(shown.page)} of ${grouped(shown.totalPages)}.`
})
</script>

<template>
  <section class="panel" aria-labelledby="blotter-heading">
    <div class="panel-heading">
      <h2 id="blotter-heading" tabindex="-1">Trades</h2>
      <div class="panel-actions">
        <ExactValuesToggle v-model="showExact" grid-label="trade list" />
        <button type="button" class="button-secondary refresh-trades" :disabled="trades.loading" @click="store.loadTrades()">
          Refresh
        </button>
      </div>
    </div>

    <TradeFilters />

    <p
      v-if="outcome?.context === 'history'"
      id="history-cancellation-outcome"
      class="alert alert-success cancellation-outcome"
      role="status"
      tabindex="-1"
    >
      {{ outcome.message }}
    </p>
    <p
      v-if="executed?.context === 'history'"
      id="history-execution-outcome"
      class="alert alert-success execution-outcome"
      role="status"
      tabindex="-1"
    >
      {{ executed.message }}
    </p>

    <p v-if="trades.error" class="alert alert-error" role="alert">
      Trades could not be loaded. {{ trades.error }}
    </p>
    <!-- Always one line high, so "Updating trades…" never moves the pager under the pointer. -->
    <div class="list-status">
      <p v-if="trades.loading && !trades.loaded" class="state" role="status">Loading trades…</p>
      <p v-else-if="trades.loading" class="state" role="status">Updating trades…</p>
      <template v-else-if="trades.loaded">
        <p v-if="filtered && trades.items.length === 0" class="state" role="status">
          No trades match these filters. Change them, or choose Clear to see every trade.
        </p>
        <p v-else-if="trades.items.length === 0" class="state">No trades yet. Book one to see it here.</p>
        <p v-else class="visually-hidden" role="status">{{ summary }}</p>
      </template>
    </div>

    <template v-if="hasTrades">
      <TradePager placement="top" v-bind="pager" />
      <div class="table-scroll" tabindex="0" aria-labelledby="blotter-heading" :aria-busy="trades.loading">
        <table class="data-table">
          <caption class="visually-hidden">{{ caption }}</caption>
          <thead>
            <tr>
              <th
                v-for="column in COLUMNS"
                :key="column.label"
                scope="col"
                :class="{ numeric: column.numeric, sortable: column.field !== undefined }"
                :aria-sort="ariaSortFor(shownSort, column.field)"
              >
                <SortButton
                  v-if="column.field"
                  :field="column.field"
                  :label="column.label"
                  :shown="shownSort"
                  :current="sort"
                  @sort="(field: SortField) => store.sortBy(field)"
                />
                <template v-else>{{ column.label }}</template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="trade in trades.items" :key="trade.id" :data-trade-id="trade.id">
              <td class="actions">
                <button
                  type="button"
                  class="icon-button trade-details"
                  :aria-label="`Trade details: ${describeTrade(trade)}, ${trade.status}`"
                  title="Trade details"
                  @click="openDetails(trade, $event)"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                    <path d="M8 7.2v4.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                    <circle cx="8" cy="4.8" r="1" fill="currentColor" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-button show-history"
                  :aria-label="`Audit history of the trade: ${describeTrade(trade)}, ${trade.status}`"
                  title="History"
                  @click="openHistory(trade, $event)"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                    <path d="M8 4.4V8l2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </td>
              <th scope="row" class="symbol">{{ trade.symbol }}</th>
              <td><span class="side-badge" :class="trade.side === 'Buy' ? 'side-badge-buy' : 'side-badge-sell'">{{ trade.side }}</span></td>
              <td class="status"><StatusBadge :status="trade.status" :reason="trade.cancellationReason" /></td>
              <td class="numeric">{{ formatDecimal(trade.quantity) }}</td>
              <td class="numeric price"><MoneyValue :value="trade.price" :show-exact="showExact" /></td>
              <td class="numeric notional"><MoneyValue :value="trade.notional" :show-exact="showExact" /></td>
              <td class="executed"><LocalTimestamp :utc="trade.executedAt" none="Not executed" /></td>
              <td class="recorded"><LocalTimestamp :utc="trade.createdAt" /></td>
              <td class="recorded"><LocalTimestamp :utc="trade.updatedAt" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <TradePager placement="bottom" v-bind="pager" />
      <p class="hint">
        Executed at is when the trade happened (a Pending trade has none); created and updated at are when it was recorded.
        Each trade is listed once: a cancelled trade shows as Cancelled, with its reason as a tooltip. Every trade is booked Pending.
        The details button at the start of each row shows the trade; for a Pending trade it also offers Execute, Keep Pending and
        Cancel with a reason. The History button beside it shows the trade with its audit history. Executed and Cancelled trades are final.
        Times are in your time zone. Choose Symbol, Quantity, Price or Executed at to sort by that column.
        Prices and notionals are shown to 2 decimal places; point at one, or turn on Exact values, for its exact value.
      </p>
    </template>
  </section>
</template>
