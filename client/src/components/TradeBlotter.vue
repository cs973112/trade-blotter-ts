<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

import type { SortDirection, SortField } from '../api/contracts.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { DEFAULT_TRADE_SORT, directionLabel, narrowsList, nextSort, SORT_FIELDS } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import TradeFilters from './TradeFilters.vue'
import TradePager from './TradePager.vue'

const store = useBlotterStore()
const { trades, sort, shownTradeQuery, shownPage } = storeToRefs(store)

/** The columns, in order. Four sort the list when their header is chosen; the API does the sorting. */
const COLUMNS: readonly { readonly label: string; readonly field?: SortField; readonly numeric?: boolean }[] = [
  { label: 'Symbol', field: 'symbol' },
  { label: 'Side' },
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
const shownSort = computed(() => ({
  field: shownTradeQuery.value.sortBy ?? DEFAULT_TRADE_SORT.sortBy,
  direction: shownTradeQuery.value.sortDirection ?? DEFAULT_TRADE_SORT.sortDirection,
}))

const ARIA_SORT: Record<SortDirection, 'ascending' | 'descending'> = { asc: 'ascending', desc: 'descending' }

function ariaSort(field: SortField | undefined): 'ascending' | 'descending' | undefined {
  return field !== undefined && field === shownSort.value.field ? ARIA_SORT[shownSort.value.direction] : undefined
}

function indicator(field: SortField): string {
  if (field !== shownSort.value.field) return '↕'
  return shownSort.value.direction === 'asc' ? '↑' : '↓'
}

/** What choosing a header does, for screen readers: the direction it will sort in. */
function sortAction(field: SortField): string {
  const next = nextSort(sort.value, field)
  return `sort ${directionLabel(field, next.sortDirection).toLowerCase()}`
}

const caption = computed(() => {
  const { field, direction } = shownSort.value
  const fieldLabel = SORT_FIELDS.find((option) => option.value === field)?.label ?? field
  const order = field === DEFAULT_TRADE_SORT.sortBy && direction === DEFAULT_TRADE_SORT.sortDirection
    ? 'newest execution first'
    : `sorted by ${fieldLabel.toLowerCase()}, ${directionLabel(field, direction).toLowerCase()}`
  const subject = filtered.value ? 'Trades matching the filters' : 'Every trade'
  return `${subject}, ${order}. Times are in your time zone, with the UTC offset shown.`
})

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
      <h2 id="blotter-heading">Trades</h2>
      <button type="button" class="button-secondary" :disabled="trades.loading" @click="store.loadTrades()">
        Refresh
      </button>
    </div>

    <TradeFilters />

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
      <TradePager placement="top" />
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
                :aria-sort="ariaSort(column.field)"
              >
                <button v-if="column.field" type="button" class="sort-button" @click="store.sortBy(column.field)">
                  {{ column.label }}<span class="sort-indicator" aria-hidden="true">{{ indicator(column.field) }}</span><span
                    class="visually-hidden"
                  >, {{ sortAction(column.field) }}</span>
                </button>
                <template v-else>{{ column.label }}</template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="trade in trades.items" :key="trade.id">
              <th scope="row" class="symbol">{{ trade.symbol }}</th>
              <td><span class="side-badge" :class="trade.side === 'Buy' ? 'side-badge-buy' : 'side-badge-sell'">{{ trade.side }}</span></td>
              <td class="numeric">{{ formatDecimal(trade.quantity) }}</td>
              <td class="numeric">{{ formatDecimal(trade.price) }}</td>
              <td class="numeric">{{ formatDecimal(trade.notional) }}</td>
              <td class="executed"><LocalTimestamp :utc="trade.executedAt" /></td>
              <td class="recorded"><LocalTimestamp :utc="trade.createdAt" /></td>
              <td class="recorded"><LocalTimestamp :utc="trade.updatedAt" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <TradePager placement="bottom" />
      <p class="hint">
        Executed at is when the trade happened; created and updated at are when it was recorded.
        Times are in your time zone. Choose Symbol, Quantity, Price or Executed at to sort by that column.
      </p>
    </template>
  </section>
</template>
