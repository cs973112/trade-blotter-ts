<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

import { formatDecimal } from '../lib/decimal-text.ts'
import { narrowsList, SORT_FIELDS, sortDirections } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import TradeFilters from './TradeFilters.vue'

const store = useBlotterStore()
const { trades, shownTradeQuery } = storeToRefs(store)

/** Whether the trades shown are a subset: then "no trades" means "none match". */
const filtered = computed(() => narrowsList(shownTradeQuery.value))

const caption = computed(() => {
  const { sortBy = 'executedAt', sortDirection = 'desc' } = shownTradeQuery.value
  const field = SORT_FIELDS.find((option) => option.value === sortBy)?.label ?? sortBy
  const direction = sortDirections(sortBy).find((option) => option.value === sortDirection)?.label ?? sortDirection
  const order = sortBy === 'executedAt' && sortDirection === 'desc'
    ? 'newest execution first'
    : `sorted by ${field.toLowerCase()}, ${direction.toLowerCase()}`
  const subject = filtered.value ? 'Trades matching the filters' : 'Every trade'
  return `${subject}, ${order}. Times are in your time zone, with the UTC offset shown.`
})

const matchCount = computed(() => `${String(trades.value.items.length)} matching ${trades.value.items.length === 1 ? 'trade' : 'trades'}.`)
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
    <p v-if="trades.loading && !trades.loaded" class="state" role="status">Loading trades…</p>
    <p v-else-if="trades.loading" class="state" role="status">Updating trades…</p>
    <template v-else-if="trades.loaded">
      <p v-if="filtered && trades.items.length === 0" class="state" role="status">
        No trades match these filters. Change them, or choose Clear to see every trade.
      </p>
      <p v-else-if="trades.items.length === 0" class="state">No trades yet. Book one to see it here.</p>
      <p v-else-if="filtered" class="state" role="status">{{ matchCount }}</p>
    </template>

    <div
      v-if="trades.items.length > 0"
      class="table-scroll"
      tabindex="0"
      aria-labelledby="blotter-heading"
      :aria-busy="trades.loading"
    >
      <table class="data-table">
        <caption class="visually-hidden">{{ caption }}</caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col">Side</th>
            <th scope="col" class="numeric">Quantity</th>
            <th scope="col" class="numeric">Price</th>
            <th scope="col" class="numeric">Notional</th>
            <th scope="col">Executed at</th>
            <th scope="col">Created at</th>
            <th scope="col">Updated at</th>
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
    <p v-if="trades.items.length > 0" class="hint">
      Executed at is when the trade happened; created and updated at are when it was recorded.
      Times are in your time zone.
    </p>
  </section>
</template>
