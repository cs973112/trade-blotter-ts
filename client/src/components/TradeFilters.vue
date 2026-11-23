<script setup lang="ts">
import { computed, nextTick, reactive, ref, useTemplateRef, watch } from 'vue'

import { browserTimeZone } from '../lib/timestamps.ts'
import {
  DEFAULT_TRADE_FILTERS,
  INCOMPLETE_DATE_MESSAGES,
  toTradeQuery,
  type DateFilterErrors,
  type TradeFilters,
} from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'

const store = useBlotterStore()

/**
 * What the controls show. Only Apply and Clear send it to the store; until then the list, its
 * sort and its pages keep the filters last applied.
 */
const draft = reactive<TradeFilters>({ ...DEFAULT_TRADE_FILTERS })
/** The filters the list was last asked to show. */
const applied = ref<TradeFilters>({ ...DEFAULT_TRADE_FILTERS })
const errors = ref<DateFilterErrors>({})
const timeZone = browserTimeZone()

const unapplied = computed(() => (Object.keys(DEFAULT_TRADE_FILTERS) as (keyof TradeFilters)[])
  .some((name) => draft[name] !== applied.value[name]))

// The date messages stay until either date changes; Apply checks the dates again.
watch(() => [draft.fromDate, draft.toDate], () => { errors.value = {} })

const fieldIds: Record<keyof DateFilterErrors, string> = { fromDate: 'filter-from-date', toDate: 'filter-to-date' }

const formElement = useTemplateRef<HTMLFormElement>('formElement')

/**
 * A date input that is only partly filled in (03/__/2026) has the value '', like an empty one; only
 * the browser's validity state tells them apart. Such a date is refused, never read as no bound.
 */
function partlyTyped(field: keyof DateFilterErrors): boolean {
  return formElement.value?.querySelector<HTMLInputElement>(`#${fieldIds[field]}`)?.validity.badInput === true
}

async function apply(): Promise<void> {
  const result = toTradeQuery(draft)
  const found: DateFilterErrors = result.ok ? {} : { ...result.errors }
  for (const field of ['fromDate', 'toDate'] as const) {
    if (partlyTyped(field)) found[field] ??= INCOMPLETE_DATE_MESSAGES[field]
  }
  if (!result.ok || found.fromDate !== undefined || found.toDate !== undefined) {
    errors.value = found
    await nextTick()
    const first = found.fromDate === undefined ? fieldIds.toDate : fieldIds.fromDate
    formElement.value?.querySelector<HTMLElement>(`#${first}`)?.focus()
    return
  }
  errors.value = {}
  applied.value = { ...draft }
  await store.applyFilters(result.query)
}

async function clear(): Promise<void> {
  Object.assign(draft, DEFAULT_TRADE_FILTERS)
  // A partly typed date is already '' in the draft, so Vue would leave its typed digits on screen.
  for (const id of Object.values(fieldIds)) {
    const input = formElement.value?.querySelector<HTMLInputElement>(`#${id}`)
    if (input) input.value = ''
  }
  errors.value = {}
  applied.value = { ...DEFAULT_TRADE_FILTERS }
  await store.clearFilters()
}

const describedBy = (field: keyof DateFilterErrors): string =>
  ['filter-dates-hint', errors.value[field] === undefined ? undefined : `${fieldIds[field]}-error`].filter(Boolean).join(' ')
</script>

<template>
  <form ref="formElement" class="trade-filters" role="search" aria-label="Search and filter trades" novalidate @submit.prevent="apply">
    <div class="filter-grid">
      <div class="field">
        <label for="filter-symbol">Symbol</label>
        <input
          id="filter-symbol"
          v-model="draft.symbol"
          type="search"
          name="symbol"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          aria-describedby="filter-symbol-hint"
        >
        <p id="filter-symbol-hint" class="hint">All or part of a symbol, any case.</p>
      </div>

      <div class="field">
        <label for="filter-side">Side</label>
        <select id="filter-side" v-model="draft.side" name="side">
          <option value="">All</option>
          <option value="Buy">Buy</option>
          <option value="Sell">Sell</option>
        </select>
      </div>

      <div class="field">
        <label for="filter-from-date">From</label>
        <input
          id="filter-from-date"
          v-model="draft.fromDate"
          type="date"
          name="fromDate"
          min="0001-01-01"
          max="9999-12-31"
          :aria-invalid="errors.fromDate !== undefined"
          :aria-describedby="describedBy('fromDate')"
        >
        <p v-if="errors.fromDate" id="filter-from-date-error" class="field-error">{{ errors.fromDate }}</p>
      </div>

      <div class="field">
        <label for="filter-to-date">To</label>
        <input
          id="filter-to-date"
          v-model="draft.toDate"
          type="date"
          name="toDate"
          min="0001-01-01"
          max="9999-12-31"
          :aria-invalid="errors.toDate !== undefined"
          :aria-describedby="describedBy('toDate')"
        >
        <p v-if="errors.toDate" id="filter-to-date-error" class="field-error">{{ errors.toDate }}</p>
      </div>
    </div>
    <p id="filter-dates-hint" class="hint">
      From and To are calendar dates in your time zone ({{ timeZone }}), and both are included.
    </p>

    <div class="filter-actions">
      <button type="submit" class="button-primary">Apply</button>
      <button type="button" class="button-secondary" @click="clear">Clear</button>
      <span v-if="unapplied" class="hint filter-pending">Changes not applied yet.</span>
    </div>
  </form>
</template>
