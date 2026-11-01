<script setup lang="ts">
import { storeToRefs } from 'pinia'

import { formatDecimal } from '../lib/decimal-text.ts'
import { useBlotterStore } from '../stores/blotter.ts'
import LocalTimestamp from './LocalTimestamp.vue'

const store = useBlotterStore()
const { trades } = storeToRefs(store)
</script>

<template>
  <section class="panel" aria-labelledby="blotter-heading">
    <div class="panel-heading">
      <h2 id="blotter-heading">Trades</h2>
      <button type="button" class="button-secondary" :disabled="trades.loading" @click="store.loadTrades()">
        Refresh
      </button>
    </div>

    <p v-if="trades.error" class="alert alert-error" role="alert">
      Trades could not be loaded. {{ trades.error }}
    </p>
    <p v-if="trades.loading && !trades.loaded" class="state" role="status">Loading trades…</p>
    <p v-else-if="trades.loaded && trades.items.length === 0" class="state">No trades yet. Book one to see it here.</p>

    <div v-if="trades.items.length > 0" class="table-scroll" tabindex="0" aria-labelledby="blotter-heading">
      <table class="data-table">
        <caption class="visually-hidden">
          Every trade, newest execution first. Times are in your time zone, with the UTC offset shown.
        </caption>
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
