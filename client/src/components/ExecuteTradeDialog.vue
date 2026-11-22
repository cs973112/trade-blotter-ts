<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, useTemplateRef, watch } from 'vue'

import { describeTrade } from '../lib/cancellation.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { useExecutionStore } from '../stores/execution.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'

/**
 * Executing a Pending trade: a modal dialog that shows the trade and asks for confirmation. The
 * server sets the execution time and records it as User; nothing is typed. The rest of the page is
 * inert while it is open (App.vue); focus starts on Keep Pending, so Enter never executes by
 * accident, and stays in the dialog; Escape or Keep Pending closes it and focus returns to what
 * opened it, or, once the trade is executed and its button gone, to the outcome reported in that
 * panel. While the execution is being sent, the dialog cannot be closed and Confirm cannot be
 * pressed again.
 */
const execution = useExecutionStore()
const { open, trade, submitting, problem, opener, context } = storeToRefs(execution)

const dialog = useTemplateRef<HTMLElement>('dialog')

/** The confirm button: never while sending, or after a final refusal. */
const canConfirm = computed(() => !submitting.value && problem.value?.final !== true && trade.value !== undefined)

// Each opening starts with focus inside the dialog, on the safe choice.
watch(open, async (isOpen) => {
  if (!isOpen) return
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('.keep-pending')?.focus()
})

async function confirm(): Promise<void> {
  if (!canConfirm.value) return
  const opened = opener.value
  const where = context.value
  const done = await execution.confirm()
  await nextTick()
  if (done) returnFocus(opened, `${where}-execution-outcome`)
  else dialog.value?.querySelector<HTMLElement>('.dialog-error')?.focus()
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
  if (!execution.close()) return
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
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button, [tabindex="0"]')].filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
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
</script>

<template>
  <div v-if="open && trade" class="dialog-backdrop">
    <div
      ref="dialog"
      class="dialog execute-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="execute-dialog-heading"
      aria-describedby="execute-dialog-intro"
      @keydown="onKey"
    >
      <h2 id="execute-dialog-heading">Execute a Pending trade</h2>
      <p id="execute-dialog-intro" class="hint">
        Executing makes the trade Executed, at the server's time, recorded by User. It then counts in the Executed net and
        average cost. It cannot be undone, and an Executed trade cannot be cancelled.
      </p>

      <form novalidate @submit.prevent="confirm">
        <dl class="cancel-trade-summary" aria-label="Trade to execute">
          <div><dt>Trade</dt><dd>{{ describeTrade(trade) }}</dd></div>
          <div><dt>Quantity</dt><dd class="numeric">{{ formatDecimal(trade.quantity) }}</dd></div>
          <div><dt>Price</dt><dd class="numeric"><MoneyValue :value="trade.price" /></dd></div>
          <div><dt>Notional</dt><dd class="numeric"><MoneyValue :value="trade.notional" /></dd></div>
          <div><dt>Booked</dt><dd><LocalTimestamp :utc="trade.createdAt" /></dd></div>
          <div><dt>Trade ID</dt><dd class="trade-id">{{ trade.id }}</dd></div>
        </dl>

        <p v-if="problem" class="alert alert-error dialog-error" role="alert" tabindex="-1">{{ problem.message }}</p>

        <div class="dialog-actions">
          <button
            v-if="problem?.final !== true"
            type="submit"
            class="button-primary confirm-execution"
            :disabled="!canConfirm"
            :aria-busy="submitting"
          >
            {{ submitting ? 'Executing…' : 'Confirm execution' }}
          </button>
          <button type="button" class="button-secondary keep-pending" :disabled="submitting" @click="close()">
            {{ problem?.final === true ? 'Close' : 'Keep Pending' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
