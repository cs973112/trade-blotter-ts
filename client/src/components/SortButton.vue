<script setup lang="ts">
import type { SortField } from '../api/contracts.ts'
import { sortAction, sortIndicator, type TradeSort } from '../lib/trade-filters.ts'

/**
 * A column header that sorts the list by its column, through the API: the arrow shows the order
 * shown, and screen readers hear which order choosing it gives. The header cell carries aria-sort.
 */
defineProps<{ field: SortField; label: string; shown: TradeSort; current: TradeSort }>()
defineEmits<{ sort: [field: SortField] }>()
</script>

<template>
  <button type="button" class="sort-button" @click="$emit('sort', field)">
    {{ label }}<span class="sort-indicator" aria-hidden="true">{{ sortIndicator(shown, field) }}</span><span
      class="visually-hidden"
    >, {{ sortAction(current, field) }}</span>
  </button>
</template>
