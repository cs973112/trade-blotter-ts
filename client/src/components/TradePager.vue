<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, useTemplateRef } from 'vue'

import { narrowsList, PAGE_SIZES } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'

/**
 * Previous, Next, the page shown and the page size for the trade list. The list shows one above
 * and one below the table; both read and change the same store state, so they always agree.
 */
const props = defineProps<{ placement: 'top' | 'bottom' }>()

const store = useBlotterStore()
const { page, pageSize, shownPage, shownTradeQuery } = storeToRefs(store)

const sizeId = computed(() => `pager-${props.placement}-size`)
const label = computed(() => `Trade pages, ${props.placement === 'top' ? 'above' : 'below'} the table`)

const grouped = (value: number): string => value.toLocaleString('en-US')

/** "51–100 of 25,000 trades", or "matching trades" when filters are applied. */
const range = computed(() => {
  const shown = shownPage.value
  if (shown === undefined || shown.totalCount === 0) return ''
  const first = (shown.page - 1) * shown.pageSize + 1
  const last = Math.min(shown.page * shown.pageSize, shown.totalCount)
  const noun = `${narrowsList(shownTradeQuery.value) ? 'matching ' : ''}${shown.totalCount === 1 ? 'trade' : 'trades'}`
  return `${grouped(first)}–${grouped(last)} of ${grouped(shown.totalCount)} ${noun}`
})

// Relative to the page asked for, so pressing Next twice before the first answer moves two pages.
const canGoBack = computed(() => page.value > 1)
const canGoForward = computed(() => shownPage.value !== undefined && page.value < shownPage.value.totalPages)

const previousButton = useTemplateRef<HTMLButtonElement>('previousButton')
const nextButton = useTemplateRef<HTMLButtonElement>('nextButton')

async function go(step: -1 | 1): Promise<void> {
  const loading = store.goToPage(page.value + step)
  // On the first or last page the button just used is disabled, which would drop keyboard focus.
  await nextTick()
  if (step === 1 && !canGoForward.value && document.activeElement === nextButton.value) previousButton.value?.focus()
  if (step === -1 && !canGoBack.value && document.activeElement === previousButton.value) nextButton.value?.focus()
  await loading
}

function choosePageSize(event: Event): void {
  void store.setPageSize(Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <nav v-if="shownPage" class="pager" :aria-label="label">
    <p class="pager-range">{{ range }}</p>
    <div class="pager-controls">
      <button ref="previousButton" type="button" class="button-secondary" :disabled="!canGoBack" @click="go(-1)">
        Previous<span class="visually-hidden"> page</span>
      </button>
      <span class="pager-position">Page {{ grouped(shownPage.page) }} of {{ grouped(shownPage.totalPages) }}</span>
      <button ref="nextButton" type="button" class="button-secondary" :disabled="!canGoForward" @click="go(1)">
        Next<span class="visually-hidden"> page</span>
      </button>
      <span class="pager-size">
        <label :for="sizeId">Trades per page</label>
        <select :id="sizeId" :value="pageSize" @change="choosePageSize">
          <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
        </select>
      </span>
    </div>
  </nav>
</template>
