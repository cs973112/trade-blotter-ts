<script setup lang="ts">
import { onMounted } from 'vue'

import PositionsPanel from './components/PositionsPanel.vue'
import TradeBlotter from './components/TradeBlotter.vue'
import TradeForm from './components/TradeForm.vue'
import { useBlotterStore } from './stores/blotter.ts'

const store = useBlotterStore()

onMounted(() => {
  void store.refresh()
})
</script>

<template>
  <header class="app-header">
    <h1>Trade Blotter</h1>
  </header>
  <main class="app-main">
    <div class="app-entry">
      <TradeForm />
      <PositionsPanel />
    </div>
    <TradeBlotter />
  </main>
</template>
