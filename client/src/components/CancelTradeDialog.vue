<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'

import type { Trade } from '../api/contracts.ts'
import { checkReason, describeTrade, REASON_MAX_LENGTH, reasonLength } from '../lib/cancellation.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { useCancellationStore } from '../stores/cancellation.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'

/**
 * Cancelling a Pending trade: a modal dialog that asks for the reason and for confirmation. Opened
 * for one trade, it shows that trade; opened for a symbol, it lists the symbol's Pending trades
 * (side, quantity, price, when booked, and id) to choose one from. The rest of the page is inert
 * while it is open (App.vue); Escape or Keep trade closes it and focus returns to what opened it,
 * or, once the trade is cancelled and its button gone, to the outcome reported in that panel.
 */
const cancellation = useCancellationStore()
const { open, symbol, candidates, more, loading, loadError, submitting, problem, opener, context } = storeToRefs(cancellation)

const reason = ref('')
const chosenId = ref('')
const attempted = ref(false)

const dialog = useTemplateRef<HTMLElement>('dialog')

const single = computed(() => candidates.value.length === 1 ? candidates.value[0] : undefined)
const chosen = computed<Trade | undefined>(() => single.value ?? candidates.value.find((trade) => trade.id === chosenId.value))

const reasonCheck = computed(() => checkReason(reason.value))
const reasonError = computed(() => {
  if (problem.value?.reason === true) return problem.value.message
  return attempted.value && !reasonCheck.value.ok ? reasonCheck.value.message : undefined
})
const choiceError = computed(() => attempted.value && candidates.value.length > 1 && chosen.value === undefined ? 'Choose the trade to cancel.' : undefined)
const requestError = computed(() => problem.value?.reason === false ? problem.value.message : undefined)
const length = computed(() => reasonLength(reason.value))

/** The confirm button: never while sending, after a final refusal, or with nothing to cancel. */
const canConfirm = computed(() => !submitting.value && problem.value?.final !== true && candidates.value.length > 0)

const heading = computed(() => single.value === undefined && symbol.value !== undefined ? `Cancel a Pending trade in ${symbol.value}` : 'Cancel a Pending trade')

// Each opening starts afresh, with focus inside the dialog.
watch(open, async (isOpen) => {
  if (!isOpen) return
  reason.value = ''
  chosenId.value = ''
  attempted.value = false
  await nextTick()
  focusFirst()
})

// Once the Pending trades of a symbol have loaded, focus moves to the first choice (or the reason).
watch(loading, async (busy, was) => {
  if (busy || !was || !open.value) return
  await nextTick()
  focusFirst()
})

// The reason the server refused is shown until the reason changes.
watch(reason, () => {
  if (problem.value?.reason === true) cancellation.problem = undefined
})

function focusFirst(): void {
  const root = dialog.value
  if (root === null) return
  const target = root.querySelector<HTMLElement>('input[name="cancel-choice"], #cancel-reason') ?? root.querySelector<HTMLElement>('.dialog-actions button')
  target?.focus()
}

async function confirm(): Promise<void> {
  attempted.value = true
  const trade = chosen.value
  const check = reasonCheck.value
  if (trade === undefined || !check.ok) {
    await nextTick()
    dialog.value?.querySelector<HTMLElement>(trade === undefined ? 'input[name="cancel-choice"]' : '#cancel-reason')?.focus()
    return
  }
  const opened = opener.value
  const where = context.value
  const done = await cancellation.confirm(trade, check.value)
  await nextTick()
  if (done) {
    returnFocus(opened, `${where}-cancellation-outcome`)
  } else if (problem.value?.reason === true) {
    dialog.value?.querySelector<HTMLElement>('#cancel-reason')?.focus()
  } else {
    dialog.value?.querySelector<HTMLElement>('.dialog-error')?.focus()
  }
}

/**
 * Focus goes back to the opener while it can take it (still on the page, enabled and shown),
 * otherwise to the fallback: whether it took focus is what decides, not a guess from its state.
 */
function returnFocus(element: HTMLElement | null, fallbackId: string): void {
  if (element?.isConnected === true) element.focus()
  if (element === null || document.activeElement !== element) document.getElementById(fallbackId)?.focus()
}

async function close(): Promise<void> {
  const opened = opener.value
  const where = context.value
  if (!cancellation.close()) return
  await nextTick()
  returnFocus(opened, `${where === 'history' ? 'blotter' : 'details'}-heading`)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    void close()
    return
  }
  if (event.key !== 'Tab' || dialog.value === null) return
  // Focus stays in the dialog: the page behind is inert, and Tab wraps from the last control to the first.
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('input, button, [tabindex="0"]')].filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (first === undefined || last === undefined) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const describedBy = computed(() => ['cancel-reason-hint', reasonError.value === undefined ? undefined : 'cancel-reason-error'].filter(Boolean).join(' '))
</script>

<template>
  <div v-if="open" class="dialog-backdrop">
    <div
      ref="dialog"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-dialog-heading"
      aria-describedby="cancel-dialog-intro"
      @keydown="onKey"
    >
      <h2 id="cancel-dialog-heading">{{ heading }}</h2>
      <p id="cancel-dialog-intro" class="hint">
        Cancelling keeps the trade in the history as Cancelled, records who cancelled it (Admin) and why. A Pending trade never
        counted in the Executed net or average cost, so they do not change. It cannot be undone.
      </p>

      <form novalidate @submit.prevent="confirm">
        <p v-if="loading" class="state" role="status">Loading the Pending trades in {{ symbol }}…</p>
        <p v-else-if="loadError" class="alert alert-error" role="alert">The Pending trades could not be loaded. {{ loadError }}</p>
        <p v-else-if="candidates.length === 0" class="state" role="status">There are no Pending trades in {{ symbol }} to cancel.</p>

        <dl v-else-if="single" class="cancel-trade-summary" aria-label="Trade to cancel">
          <div><dt>Trade</dt><dd>{{ describeTrade(single) }}</dd></div>
          <div><dt>Quantity</dt><dd class="numeric">{{ formatDecimal(single.quantity) }}</dd></div>
          <div><dt>Price</dt><dd class="numeric"><MoneyValue :value="single.price" /></dd></div>
          <div><dt>Notional</dt><dd class="numeric"><MoneyValue :value="single.notional" /></dd></div>
          <div><dt>Booked</dt><dd><LocalTimestamp :utc="single.createdAt" /></dd></div>
          <div><dt>Trade ID</dt><dd class="trade-id">{{ single.id }}</dd></div>
        </dl>

        <fieldset
          v-else
          class="field cancel-choices"
          :aria-invalid="choiceError !== undefined"
          :aria-describedby="choiceError === undefined ? undefined : 'cancel-choice-error'"
        >
          <legend>Which Pending trade in {{ symbol }}?</legend>
          <p v-if="more" class="hint">The first {{ candidates.length }} Pending trades are listed; cancel one from the trade list to reach the rest.</p>
          <label v-for="trade in candidates" :key="trade.id" class="cancel-choice">
            <input v-model="chosenId" type="radio" name="cancel-choice" :value="trade.id">
            <span class="cancel-choice-text">
              <span class="side-badge" :class="trade.side === 'Buy' ? 'side-badge-buy' : 'side-badge-sell'">{{ trade.side }}</span>{{ ' ' }}<span
                class="numeric"
              >{{ formatDecimal(trade.quantity) }}</span> at <span class="numeric"><MoneyValue :value="trade.price" /></span>,
              booked <LocalTimestamp :utc="trade.createdAt" />,
              <span class="trade-id">ID {{ trade.id }}</span>
            </span>
          </label>
          <p v-if="choiceError" id="cancel-choice-error" class="field-error">{{ choiceError }}</p>
        </fieldset>

        <div v-if="!loading && !loadError && candidates.length > 0" class="field">
          <label for="cancel-reason">Reason</label>
          <input
            id="cancel-reason"
            v-model="reason"
            type="text"
            name="reason"
            autocomplete="off"
            required
            :aria-invalid="reasonError !== undefined"
            :aria-describedby="describedBy"
          >
          <p id="cancel-reason-hint" class="hint">Required, up to {{ REASON_MAX_LENGTH }} characters: {{ length }} used.</p>
          <p v-if="reasonError" id="cancel-reason-error" class="field-error">{{ reasonError }}</p>
        </div>

        <p v-if="requestError" class="alert alert-error dialog-error" role="alert" tabindex="-1">{{ requestError }}</p>

        <div class="dialog-actions">
          <button
            v-if="candidates.length > 0 && problem?.final !== true"
            type="submit"
            class="button-danger"
            :disabled="!canConfirm"
            :aria-busy="submitting"
          >
            {{ submitting ? 'Cancelling…' : 'Confirm cancellation' }}
          </button>
          <button type="button" class="button-secondary" :disabled="submitting" @click="close()">
            {{ problem?.final === true || candidates.length === 0 ? 'Close' : 'Keep trade' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
