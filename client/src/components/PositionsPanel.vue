<script setup lang="ts">
import { storeToRefs } from 'pinia'

import { formatDecimal } from '../lib/decimal-text.ts'
import { useBlotterStore } from '../stores/blotter.ts'

const store = useBlotterStore()
const { positions } = storeToRefs(store)

const isShort = (netQuantity: string): boolean => netQuantity.startsWith('-')
</script>

<template>
  <section class="panel positions-panel" aria-labelledby="positions-heading">
    <div class="panel-heading">
      <h2 id="positions-heading">Positions</h2>
      <button type="button" class="button-secondary" :disabled="positions.loading" @click="store.loadPositions()">
        Refresh
      </button>
    </div>

    <p v-if="positions.error" class="alert alert-error" role="alert">
      Positions could not be loaded. {{ positions.error }}
    </p>
    <p v-if="positions.loading && !positions.loaded" class="state" role="status">Loading positions…</p>
    <p v-else-if="positions.loaded && positions.items.length === 0" class="state">No open positions.</p>

    <div v-if="positions.items.length > 0" class="table-scroll" tabindex="0" aria-labelledby="positions-heading">
      <table class="data-table positions-table">
        <caption class="visually-hidden">Open positions by symbol. Flat positions are not shown.</caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col">Direction</th>
            <th scope="col" class="numeric">Net quantity</th>
            <th scope="col" class="numeric">Average cost</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="position in positions.items"
            :key="position.symbol"
            :class="isShort(position.netQuantity) ? 'position-short' : 'position-long'"
          >
            <th scope="row" class="symbol">{{ position.symbol }}</th>
            <td class="direction">
              <span class="direction-badge" :class="isShort(position.netQuantity) ? 'direction-short' : 'direction-long'">
                {{ isShort(position.netQuantity) ? 'Short' : 'Long' }}
              </span>
            </td>
            <td class="numeric net-quantity" data-label="Net quantity">{{ formatDecimal(position.netQuantity) }}</td>
            <td class="numeric average-cost" data-label="Average cost">{{ formatDecimal(position.averageCost) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
