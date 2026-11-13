<script setup lang="ts">
import { onMounted, ref } from 'vue'

import PositionDetails from './components/PositionDetails.vue'
import PositionsPanel from './components/PositionsPanel.vue'
import TradeBlotter from './components/TradeBlotter.vue'
import TradeForm from './components/TradeForm.vue'
import { tabAfterKey, TABS, type TabId } from './lib/tabs.ts'
import { useBlotterStore } from './stores/blotter.ts'

const store = useBlotterStore()

/**
 * Three tabs. Every panel stays in the page while another is shown (v-show), so what was typed in
 * the form, and the trade list's filters, sort and page, are kept, and nothing is loaded again.
 */
const selected = ref<TabId>('trading')

function select(id: TabId, focus = false): void {
  selected.value = id
  if (focus) document.getElementById(`tab-${id}`)?.focus()
}

/** Arrow keys move between tabs (wrapping), Home and End to the first and last; the tab moved to is shown. */
function onTabKey(event: KeyboardEvent, id: TabId): void {
  const next = tabAfterKey(id, event.key)
  if (next === undefined) return
  event.preventDefault()
  select(next, true)
}

onMounted(() => {
  void store.refresh()
})
</script>

<template>
  <header class="app-header">
    <h1>Trade Blotter</h1>
  </header>
  <div class="app-tabs">
    <div class="tab-list" role="tablist" aria-label="Trade Blotter sections">
      <button
        v-for="tab in TABS"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="tab"
        :aria-selected="selected === tab.id"
        :aria-controls="`panel-${tab.id}`"
        :tabindex="selected === tab.id ? 0 : -1"
        @click="select(tab.id)"
        @keydown="onTabKey($event, tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>
  </div>
  <main class="app-main">
    <div v-show="selected === 'trading'" id="panel-trading" class="tab-panel" role="tabpanel" aria-labelledby="tab-trading" tabindex="0">
      <div class="app-entry">
        <TradeForm />
        <PositionsPanel />
      </div>
    </div>
    <div v-show="selected === 'details'" id="panel-details" class="tab-panel" role="tabpanel" aria-labelledby="tab-details" tabindex="0">
      <PositionDetails />
    </div>
    <div v-show="selected === 'history'" id="panel-history" class="tab-panel" role="tabpanel" aria-labelledby="tab-history" tabindex="0">
      <TradeBlotter />
    </div>
  </main>
</template>
