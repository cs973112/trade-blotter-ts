<script setup lang="ts">
import { computed } from 'vue'

import { formatMoney } from '../lib/decimal-text.ts'

/**
 * A price, notional or average cost: shown to two decimal places (half to even), never through a
 * JavaScript number. When that hides digits, the exact value is in the tooltip and is read out to
 * screen readers after the rounded one; with `showExact` (the grid's Exact values button) it is
 * also shown beside it, for anyone using the keyboard. The value itself is never changed.
 */
const props = withDefaults(defineProps<{ value: string; showExact?: boolean }>(), { showExact: false })

const money = computed(() => formatMoney(props.value))
</script>

<template>
  <span class="money" :title="money.rounded ? `Exactly ${money.exact}` : undefined" :data-exact="money.exact">{{ money.shown }}<span
    v-if="money.rounded"
    :class="showExact ? 'exact-inline' : 'visually-hidden'"
  >{{ showExact ? ' ' : ', ' }}exactly {{ money.exact }}</span></span>
</template>
