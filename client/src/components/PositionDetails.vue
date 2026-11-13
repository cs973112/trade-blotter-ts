<script setup lang="ts">
import { storeToRefs } from 'pinia'

import { useDetailsStore } from '../stores/details.ts'
import PositionsPanel from './PositionsPanel.vue'
import TradeDetailsPanel from './TradeDetailsPanel.vue'

/**
 * Positions & Trade Details: the open positions (master) beside the chosen position's trades
 * (details); stacked, master first, on narrower screens, where a link leads from the chosen
 * position to its trades. Positions are the ones the Trading tab shows, loaded once for both.
 */
const details = useDetailsStore()
const { symbol } = storeToRefs(details)

function select(next: string): void {
  void details.select(next)
}

/** Stacked, the trades are below the positions: this moves there, focus included. */
function goToDetails(): void {
  const heading = document.getElementById('details-heading')
  heading?.scrollIntoView({ block: 'start' })
  heading?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="master-detail">
    <div class="master">
      <PositionsPanel id-prefix="master" title="Open positions" selectable :selected="symbol" @select="select" />
      <button v-if="symbol" type="button" class="button-secondary to-details" @click="goToDetails()">
        Go to the trades for {{ symbol }}
      </button>
    </div>
    <TradeDetailsPanel />
  </div>
</template>
