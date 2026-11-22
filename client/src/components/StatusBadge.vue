<script setup lang="ts">
import type { TradeStatus } from '../api/contracts.ts'

/**
 * A trade's status as a badge: its name always written out, so colour is never the only cue, and a
 * different shape for each (an outline for Pending, filled for Executed, struck through for
 * Cancelled). A Cancelled trade's reason is its tooltip and is read after the status.
 */
defineProps<{ status: TradeStatus; reason?: string | null }>()
</script>

<template>
  <span class="status-badge" :class="`status-${status.toLowerCase()}`" :title="status === 'Cancelled' && reason ? `Reason: ${reason}` : undefined">{{ status }}<span
    v-if="status === 'Cancelled' && reason"
    class="visually-hidden"
  >, reason: {{ reason }}</span></span>
</template>
