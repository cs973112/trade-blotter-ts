<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

import { describeAuditEntry, isCancellationRecordEntry } from '../lib/audit.ts'
import { formatDecimal } from '../lib/decimal-text.ts'
import { useDetailsStore } from '../stores/details.ts'
import LocalTimestamp from './LocalTimestamp.vue'
import MoneyValue from './MoneyValue.vue'
import StatusBadge from './StatusBadge.vue'

/**
 * The audit history of one trade in Trade Details, read only: every write the database recorded
 * for the logical trade (GET /trades/{id}/audit?scope=logical), oldest first, so the original
 * trade's entries and its cancellation record's are one timeline. Each entry shows the action, when
 * and by whom it was recorded (always System, the database), and the row as it was then. There is
 * nothing here to change or remove an entry.
 */
const details = useDetailsStore()
const { auditTradeId, audit, auditPage, shownAudit } = storeToRefs(details)

const shows = computed(() => auditTradeId.value !== undefined && shownAudit.value?.tradeId === auditTradeId.value && audit.value.loaded)

/** More than one page: only a trade with an unusual number of writes has one. */
const pages = computed(() => (shows.value ? shownAudit.value?.totalPages ?? 0 : 0))

const summary = computed(() => {
  const shown = shownAudit.value
  if (!shows.value || shown === undefined) return ''
  const records = shown.tradeIds.length > 1 ? ' and its cancellation record' : ''
  return `${String(shown.totalCount)} ${shown.totalCount === 1 ? 'entry' : 'entries'} for trade ${shown.tradeId}${records}, oldest first.`
})
</script>

<template>
  <section v-if="auditTradeId" class="audit-history" aria-labelledby="audit-heading">
    <div class="panel-heading">
      <h3 id="audit-heading" tabindex="-1">Audit history: trade <span class="trade-id">{{ auditTradeId }}</span></h3>
      <div class="panel-actions">
        <button type="button" class="button-secondary refresh-audit" :disabled="audit.loading" @click="details.reloadAudit()">Refresh</button>
        <button type="button" class="button-secondary close-audit" @click="details.closeAudit()">Close</button>
      </div>
    </div>
    <p class="hint audit-legend">
      Read only. Trades are booked by User; a cancellation is made by Admin, who creates the cancellation record and changes the
      original to Cancelled; each entry is recorded by the database, shown as System.
    </p>

    <p v-if="audit.error" class="alert alert-error" role="alert">
      The audit history could not be loaded. {{ audit.error }}
      <button type="button" class="button-secondary" @click="details.reloadAudit()">Try again</button>
    </p>
    <div class="list-status">
      <p v-if="audit.loading && !shows" class="state" role="status">Loading the audit history…</p>
      <p v-else-if="audit.loading" class="state" role="status">Updating the audit history…</p>
      <p v-else-if="shows && audit.items.length === 0" class="state" role="status">No audit entries for this trade.</p>
      <p v-else-if="shows" class="state audit-summary" role="status">{{ summary }}</p>
    </div>

    <template v-if="shows && audit.items.length > 0">
      <nav v-if="pages > 1" class="pager audit-pager" aria-label="Pages of the audit history">
        <div class="pager-controls">
          <button type="button" class="button-secondary" :disabled="auditPage <= 1" @click="details.auditGoToPage(auditPage - 1)">
            Previous<span class="visually-hidden"> page of entries</span>
          </button>
          <span class="pager-position">Page {{ auditPage }} of {{ pages }}</span>
          <button type="button" class="button-secondary" :disabled="auditPage >= pages" @click="details.auditGoToPage(auditPage + 1)">
            Next<span class="visually-hidden"> page of entries</span>
          </button>
        </div>
      </nav>
      <div class="table-scroll audit-scroll" tabindex="0" aria-labelledby="audit-heading" :aria-busy="audit.loading">
        <table class="data-table audit-table">
          <caption class="visually-hidden">
            The audit entries of trade {{ auditTradeId }}, oldest first: what was written, when, by whom, and the row as it was then.
            Prices are rounded to 2 decimal places.
          </caption>
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
</template>
