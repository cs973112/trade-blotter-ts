<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'

import { describeAuditEntry, isCancellationRecordEntry } from '../lib/audit.ts'
import { checkReason, describeTrade, isCancellable, isExecutable, REASON_MAX_LENGTH, reasonLength } from '../lib/cancellation.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { useTradeDialogStore } from '../stores/trade-dialog.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'
import StatusBadge from './StatusBadge.vue'

/**
 * The trade dialog, opened from a row's details or History button in Trade History, or its edit
 * button in Trade Details: every field of the trade, and, for a Pending trade, Execute (at the
 * server's time, by User), Keep Pending, and Cancel with a reason (by Admin). An Executed or
 * Cancelled trade is final: the dialog only shows it. Opened from Trade History's History button it
 * also shows the trade's audit history, read only. The rest of the page is inert while it is open
 * (App.vue); focus starts on the safe choice (Keep Pending, or Close), or on the audit history when
 * that was asked for, so Enter never changes a trade by accident, and stays in the dialog. Escape,
 * the close button and Keep Pending (or Close) close it, and focus returns to the button that opened
 * it, or to the outcome reported in that panel. While an action is being sent nothing else can be
 * pressed and the dialog cannot be closed.
 */
const dialogStore = useTradeDialogStore()
const { open, context, trade, submitting, problem, opener, showsAudit, audit, auditTotal } = storeToRefs(dialogStore)

const reason = ref('')
const attempted = ref(false)

const dialog = useTemplateRef<HTMLElement>('dialog')

const pending = computed(() => trade.value !== undefined && isExecutable(trade.value) && isCancellable(trade.value))
/** Execute and Cancel are offered: a Pending trade, with no final refusal. */
const actionable = computed(() => pending.value && problem.value?.final !== true)
const busy = computed(() => submitting.value !== undefined)

const reasonCheck = computed(() => checkReason(reason.value))
const reasonError = computed(() => {
  if (problem.value?.reason === true) return problem.value.message
  return attempted.value && !reasonCheck.value.ok ? reasonCheck.value.message : undefined
})
const requestError = computed(() => problem.value?.reason === false ? problem.value.message : undefined)
const length = computed(() => reasonLength(reason.value))
const describedBy = computed(() => ['trade-reason-hint', reasonError.value === undefined ? undefined : 'trade-reason-error'].filter(Boolean).join(' '))

const intro = computed(() => {
  switch (trade.value?.status) {
    case 'Pending':
      return 'This trade is Pending. Execute it at the server\'s time (recorded by User; it then counts in the Executed net and average cost), ' +
        'keep it Pending, or cancel it with a reason (recorded by Admin). Executing and cancelling cannot be undone.'
    case 'Executed':
      return 'This trade is Executed: it is final, and counts in the Executed net and average cost.'
    case 'Cancelled':
      return 'This trade is Cancelled: it is final, and never counted in the Executed net or average cost.'
    default:
      return ''
  }
})

// Each opening starts afresh, with focus on the safe choice, or on the audit history when it was asked for.
watch(open, async (isOpen) => {
  if (!isOpen) return
  reason.value = ''
  attempted.value = false
  await nextTick()
  dialog.value?.querySelector<HTMLElement>(showsAudit.value ? '#trade-dialog-audit-heading' : '.keep-pending')?.focus()
})

/** Where focus goes when the button that opened the dialog cannot take it back. */
const panelHeading = computed(() => (context.value === 'history' ? 'blotter-heading' : 'details-heading'))

const auditSummary = computed(() => {
  const shown = audit.value.items.length
  if (shown === 0) return ''
  const records = audit.value.items.some(isCancellationRecordEntry) ? ' and its cancellation record' : ''
  const count = auditTotal.value > shown ? `The first ${String(shown)} of ${String(auditTotal.value)} entries` : `${String(shown)} ${shown === 1 ? 'entry' : 'entries'}`
  return `${count} for this trade${records}, oldest first.`
})

// The reason the server refused is shown until the reason changes.
watch(reason, () => { dialogStore.clearReasonProblem() })

/**
 * Focus goes back to the opener while it can take it (still on the page, enabled and shown),
 * otherwise to the fallback: whether it took focus is what decides, not a guess from its state.
 */
function returnFocus(element: HTMLElement | null, fallbackId: string): void {
  if (element?.isConnected === true) element.focus()
  if (element === null || document.activeElement !== element) document.getElementById(fallbackId)?.focus()
}

async function execute(): Promise<void> {
  if (!actionable.value || busy.value) return
  const opened = opener.value
  const done = await dialogStore.execute()
  await nextTick()
  if (done) returnFocus(opened, `${context.value}-execution-outcome`)
  else dialog.value?.querySelector<HTMLElement>('.dialog-error')?.focus()
}

async function cancel(): Promise<void> {
  if (!actionable.value || busy.value) return
  attempted.value = true
  const check = reasonCheck.value
  if (!check.ok) {
    await nextTick()
    dialog.value?.querySelector<HTMLElement>('#trade-reason')?.focus()
    return
  }
  const opened = opener.value
  const done = await dialogStore.cancel(check.value)
  await nextTick()
  if (done) returnFocus(opened, `${context.value}-cancellation-outcome`)
  else if (problem.value?.reason === true) dialog.value?.querySelector<HTMLElement>('#trade-reason')?.focus()
  else dialog.value?.querySelector<HTMLElement>('.dialog-error')?.focus()
}

async function close(): Promise<void> {
  const opened = opener.value
  const fallback = panelHeading.value
  if (!dialogStore.close()) return
  await nextTick()
  returnFocus(opened, fallback)
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
</script>

<template>
  <div v-if="open && trade" class="dialog-backdrop">
    <div
      ref="dialog"
      class="dialog trade-dialog"
      :class="{ 'with-audit': showsAudit }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-dialog-heading"
      aria-describedby="trade-dialog-intro"
      @keydown="onKey"
    >
      <div class="dialog-heading">
        <h2 id="trade-dialog-heading">Trade details</h2>
        <button type="button" class="dialog-close" aria-label="Close the trade details" title="Close" :disabled="busy" @click="close()">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <p id="trade-dialog-intro" class="hint">{{ intro }}</p>

      <form novalidate @submit.prevent="cancel">
        <dl class="cancel-trade-summary trade-dialog-summary" aria-label="Trade">
          <div><dt>Trade</dt><dd>{{ describeTrade(trade) }}</dd></div>
          <div><dt>Status</dt><dd><StatusBadge :status="trade.status" :reason="trade.cancellationReason" /></dd></div>
          <div><dt>Quantity</dt><dd class="numeric">{{ formatDecimal(trade.quantity) }}</dd></div>
          <div><dt>Price</dt><dd class="numeric"><MoneyValue :value="trade.price" /></dd></div>
          <div><dt>Notional</dt><dd class="numeric"><MoneyValue :value="trade.notional" /></dd></div>
          <div><dt>Executed at</dt><dd class="executed"><LocalTimestamp :utc="trade.executedAt" none="Not executed" /></dd></div>
          <div><dt>Booked</dt><dd class="booked"><LocalTimestamp :utc="trade.createdAt" />, by {{ trade.createdBy }}</dd></div>
          <div><dt>Last updated</dt><dd class="last-updated"><LocalTimestamp :utc="trade.updatedAt" />, by {{ trade.updatedBy }}</dd></div>
          <div v-if="trade.cancellationReason !== null"><dt>Reason</dt><dd class="cancellation-reason">{{ trade.cancellationReason }}</dd></div>
          <div v-if="trade.cancellationTradeId !== null"><dt>Cancellation record</dt><dd class="trade-id">{{ trade.cancellationTradeId }}</dd></div>
          <div><dt>Booking sequence</dt><dd class="numeric booking-sequence">{{ trade.bookingSequence }}</dd></div>
          <div><dt>Trade ID</dt><dd class="trade-id">{{ trade.id }}</dd></div>
        </dl>

        <section v-if="showsAudit" class="trade-dialog-audit" aria-labelledby="trade-dialog-audit-heading">
          <h3 id="trade-dialog-audit-heading" tabindex="-1">Audit history</h3>
          <p class="hint">
            Read only: every write the database recorded for this trade, by System. Trades are booked by User; a cancellation is made by Admin.
          </p>
          <p v-if="audit.error" class="alert alert-error" role="alert">
            The audit history could not be loaded. {{ audit.error }}
            <button type="button" class="button-secondary retry-audit" @click="dialogStore.loadAudit()">Try again</button>
          </p>
          <p v-else-if="audit.loading" class="state" role="status">Loading the audit history…</p>
          <p v-else-if="audit.loaded && audit.items.length === 0" class="state" role="status">No audit entries for this trade.</p>
          <template v-else-if="audit.loaded">
            <p class="state audit-summary" role="status">{{ auditSummary }}</p>
            <div class="table-scroll audit-scroll" tabindex="0" aria-labelledby="trade-dialog-audit-heading">
              <table class="data-table audit-table trade-dialog-audit-table">
                <caption class="visually-hidden">The audit entries of this trade, oldest first: what happened, when, by whom, and the row as it was then.</caption>
                <thead>
                  <tr>
                    <th scope="col">What happened</th>
                    <th scope="col">Audit action</th>
                    <th scope="col">Audit on</th>
                    <th scope="col">Audit by</th>
                    <th scope="col">Trade ID</th>
                    <th scope="col">Original trade ID</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created by</th>
                    <th scope="col">Updated by</th>
                    <th scope="col">Side</th>
                    <th scope="col" class="numeric">Quantity</th>
                    <th scope="col" class="numeric">Price</th>
                    <th scope="col">Executed at</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in audit.items" :key="entry.auditId" :class="{ 'audit-record': isCancellationRecordEntry(entry) }">
                    <th scope="row" class="audit-what">{{ describeAuditEntry(entry) }}</th>
                    <td class="audit-action">{{ entry.auditAction }}</td>
                    <td><LocalTimestamp :utc="entry.auditOn" /></td>
                    <td class="audit-by">{{ entry.auditBy }}</td>
                    <td class="trade-id">{{ entry.trade.id }}</td>
                    <td class="trade-id">{{ entry.trade.originalTradeId ?? '—' }}</td>
                    <td><StatusBadge :status="entry.trade.status" /></td>
                    <td class="audit-created-by">{{ entry.trade.createdBy }}</td>
                    <td class="audit-updated-by">{{ entry.trade.updatedBy }}</td>
                    <td>{{ entry.trade.side }}</td>
                    <td class="numeric">{{ formatDecimal(entry.trade.quantity) }}</td>
                    <td class="numeric price"><MoneyValue :value="entry.trade.price" /></td>
                    <td><LocalTimestamp :utc="entry.trade.executedAt" /></td>
                    <td class="audit-reason">{{ entry.trade.cancellationReason ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>

        <div v-if="actionable" class="field">
          <label for="trade-reason">Reason for cancelling</label>
          <input
            id="trade-reason"
            v-model="reason"
            type="text"
            name="reason"
            autocomplete="off"
            :disabled="busy"
            :aria-invalid="reasonError !== undefined"
            :aria-describedby="describedBy"
          >
          <p id="trade-reason-hint" class="hint">Needed only to cancel: up to {{ REASON_MAX_LENGTH }} characters, {{ length }} used.</p>
          <p v-if="reasonError" id="trade-reason-error" class="field-error">{{ reasonError }}</p>
        </div>

        <p v-if="requestError" class="alert alert-error dialog-error" role="alert" tabindex="-1">{{ requestError }}</p>

        <div class="dialog-actions">
          <button
            v-if="actionable"
            type="button"
            class="button-primary confirm-execution"
            :disabled="busy"
            :aria-busy="submitting === 'execute'"
            @click="execute()"
          >
            {{ submitting === 'execute' ? 'Executing…' : 'Execute' }}
          </button>
          <button
            v-if="actionable"
            type="submit"
            class="button-danger confirm-cancellation"
            :disabled="busy"
            :aria-busy="submitting === 'cancel'"
          >
            {{ submitting === 'cancel' ? 'Cancelling…' : 'Cancel trade' }}
          </button>
          <button type="button" class="button-secondary keep-pending" :disabled="busy" @click="close()">
            {{ actionable ? 'Keep Pending' : 'Close' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
