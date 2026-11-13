<script setup lang="ts">
/**
 * Exact values: a checkbox for one grid. Checked, every rounded price, notional or average cost in
 * the grid (and, in Trade Details, the chosen position's average cost) shows its exact value beside
 * the two-place one, so it can be read without a pointer (tooltips) or a screen reader. One tab
 * stop, however many rows; Space checks and unchecks it.
 */
defineProps<{ gridLabel: string }>()
const checked = defineModel<boolean>({ required: true })
</script>

<template>
  <label class="exact-values-option">
    <input v-model="checked" type="checkbox" class="exact-toggle">
    Exact values<span class="visually-hidden"> in the {{ gridLabel }}</span>
  </label>
</template>
