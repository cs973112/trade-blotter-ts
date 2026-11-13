<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from 'vue'

import { PAGE_SIZES } from '../lib/trade-filters.ts'
import type { ShownPage } from '../stores/list-state.ts'

/**
 * Previous, Next, the page shown and the page size for a paged list of trades. A list shows one
 * above and one below its table; both read and change the same state, given here, so they always
 * agree. The trade list and the Trade Details each pass their own.
 */
const props = withDefaults(defineProps<{
  placement: 'top' | 'bottom'
  /** The page shown and its counts; nothing is shown until one has loaded. */
  shown: ShownPage | undefined
  /** The page asked for, which may be ahead of the page shown while it loads. */
  page: number
  pageSize: number
  goToPage: (page: number) => Promise<void>
  setPageSize: (size: number) => Promise<void>
  /** "matching trades" rather than "trades". */
  filtered?: boolean
  /** Makes the page-size control's id unique on the page. */
  idPrefix?: string
  /** What the pages are of, for screen readers: "Trade pages". */
  name?: string
}>(), { filtered: false, idPrefix: 'pager', name: 'Trade pages' })

const sizeId = computed(() => `${props.idPrefix}-${props.placement}-size`)
const label = computed(() => `${props.name}, ${props.placement === 'top' ? 'above' : 'below'} the table`)

const grouped = (value: number): string => value.toLocaleString('en-US')

/** "51–100 of 25,000 trades", or "matching trades" when filters are applied. */
const range = computed(() => {
  const shown = props.shown
  if (shown === undefined || shown.totalCount === 0) return ''
  const first = (shown.page - 1) * shown.pageSize + 1
  const last = Math.min(shown.page * shown.pageSize, shown.totalCount)
  const noun = `${props.filtered ? 'matching ' : ''}${shown.totalCount === 1 ? 'trade' : 'trades'}`
  return `${grouped(first)}–${grouped(last)} of ${grouped(shown.totalCount)} ${noun}`
})

// Relative to the page asked for, so pressing Next twice before the first answer moves two pages.
const canGoBack = computed(() => props.page > 1)
const canGoForward = computed(() => props.shown !== undefined && props.page < props.shown.totalPages)

const previousButton = useTemplateRef<HTMLButtonElement>('previousButton')
const nextButton = useTemplateRef<HTMLButtonElement>('nextButton')

async function go(step: -1 | 1): Promise<void> {
  const loading = props.goToPage(props.page + step)
  // On the first or last page the button just used is disabled, which would drop keyboard focus.
  await nextTick()
  if (step === 1 && !canGoForward.value && document.activeElement === nextButton.value) previousButton.value?.focus()
  if (step === -1 && !canGoBack.value && document.activeElement === previousButton.value) nextButton.value?.focus()
  await loading
}

function choosePageSize(event: Event): void {
  void props.setPageSize(Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <nav v-if="shown" class="pager" :aria-label="label">
    <p class="pager-range">{{ range }}</p>
    <div class="pager-controls">
      <button ref="previousButton" type="button" class="button-secondary" :disabled="!canGoBack" @click="go(-1)">
        Previous<span class="visually-hidden"> page</span>
      </button>
      <span class="pager-position">Page {{ grouped(shown.page) }} of {{ grouped(shown.totalPages) }}</span>
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
