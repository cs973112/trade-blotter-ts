<script setup lang="ts">
import { computed, nextTick, reactive, ref, useTemplateRef, watch } from 'vue'

import { ApiError } from '../api/client.ts'
import type { CreateTradeRequest, FieldErrors, Side, Trade, TradeField } from '../api/contracts.ts'
import { checkDecimalInput, formatDecimal, type DecimalInputProblem } from '../lib/decimal-text.ts'
import { browserTimeZone, resolveLocalDateTime } from '../lib/timestamps.ts'
import { narrowsList, tradeMatchesFilters } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'

const store = useBlotterStore()

const form = reactive({
  symbol: '',
  side: '' as Side | '',
  quantity: '',
  price: '',
  executedAt: '',
  /** Which occurrence of a repeated local time the user meant, as an RFC 3339 value. */
  occurrence: '',
})

const submitted = ref(false)
const submitting = ref(false)
const serverErrors = ref<FieldErrors>({})
const formError = ref<string>()
const success = ref<string>()
const timeZone = browserTimeZone()

/**
 * When booking failed because the API could not be reached, the newest request started by then.
 * Once the API answers a later request, the alert no longer describes the situation and is removed;
 * what was typed stays, so the trade can be booked again. Other failures stay until the next submit.
 */
let outageAfter: number | undefined

watch(() => store.latestAnswered, (latest) => {
  if (outageAfter !== undefined && latest > outageAfter) {
    formError.value = undefined
    outageAfter = undefined
  }
})

const fieldIds: Record<TradeField, string> = {
  symbol: 'trade-symbol',
  side: 'trade-side-buy',
  quantity: 'trade-quantity',
  price: 'trade-price',
  executedAt: 'trade-executed-at',
}

const resolution = computed(() => resolveLocalDateTime(form.executedAt))

// A different date or time needs its own answer about which occurrence was meant.
watch(() => form.executedAt, () => {
  form.occurrence = ''
})

const decimalMessages = (label: string): Record<DecimalInputProblem, string> => ({
  required: `Enter a ${label.toLowerCase()}.`,
  format: `Enter the ${label.toLowerCase()} as a number such as 100 or 101.25, without spaces or separators.`,
  zero: `${label} must be greater than zero.`,
})

/** Checks made before sending, so obvious mistakes are caught at once. The server checks everything else. */
const clientErrors = computed<FieldErrors>(() => {
  const errors: Partial<Record<TradeField, readonly string[]>> = {}
  if (form.symbol.trim() === '') errors.symbol = ['Enter a symbol.']
  if (form.side === '') errors.side = ['Choose Buy or Sell.']
  const quantity = checkDecimalInput(form.quantity)
  if (!quantity.ok) errors.quantity = [decimalMessages('Quantity')[quantity.problem]]
  const price = checkDecimalInput(form.price)
  if (!price.ok) errors.price = [decimalMessages('Price')[price.problem]]
  const time = resolution.value
  if (time.kind === 'invalid') errors.executedAt = ['Enter a complete date and time, or clear the field.']
  if (time.kind === 'nonexistent') {
    errors.executedAt = ['This time does not exist in your time zone, because the clocks go forward then. Choose another time.']
  }
  if (time.kind === 'ambiguous' && form.occurrence === '') {
    errors.executedAt = ['This time happens twice in your time zone, because the clocks go back then. Choose which one you mean.']
  }
  return errors
})

/** Client errors after the first attempt to submit; server errors until the field changes. */
const shownErrors = computed<FieldErrors>(() => ({ ...serverErrors.value, ...(submitted.value ? clientErrors.value : {}) }))

function errorFor(field: TradeField): string | undefined {
  return shownErrors.value[field]?.[0]
}

function clearServerError(field: TradeField): void {
  if (serverErrors.value[field] === undefined) return
  serverErrors.value = Object.fromEntries(Object.entries(serverErrors.value).filter(([name]) => name !== field))
}

watch(() => form.symbol, () => { clearServerError('symbol') })
watch(() => form.side, () => { clearServerError('side') })
watch(() => form.quantity, () => { clearServerError('quantity') })
watch(() => form.price, () => { clearServerError('price') })
watch(() => [form.executedAt, form.occurrence], () => { clearServerError('executedAt') })

const formElement = useTemplateRef<HTMLFormElement>('formElement')

async function focusFirstError(): Promise<void> {
  await nextTick()
  const field = (['symbol', 'side', 'quantity', 'price', 'executedAt'] as const).find((name) => errorFor(name) !== undefined)
  if (field !== undefined) formElement.value?.querySelector<HTMLElement>(`#${fieldIds[field]}`)?.focus()
}

function buildRequest(): CreateTradeRequest | undefined {
  const quantity = checkDecimalInput(form.quantity)
  const price = checkDecimalInput(form.price)
  const time = resolution.value
  if (form.side === '' || !quantity.ok || !price.ok) return undefined
  const executedAt =
    time.kind === 'exact' ? time.time.value
    : time.kind === 'ambiguous' ? (form.occurrence === '' ? undefined : form.occurrence)
    : undefined
  return {
    symbol: form.symbol.trim(),
    side: form.side,
    quantity: quantity.text,
    price: price.text,
    ...(executedAt === undefined ? {} : { executedAt }),
  }
}

/**
 * Where the booked trade is, after the list reloaded the same page with the same filters and sort:
 * on this page, on another page, or left out by the filters. Judged only from the list on screen
 * when it is that reload, not while a newer load (filters applied meanwhile) is on its way or
 * after it failed. No page number is guessed.
 */
function whereListed(trade: Trade): string {
  if (store.trades.error !== undefined || store.trades.loading) return ''
  if (store.trades.items.some((listed) => listed.id === trade.id)) return ' It is on this page of the trade list.'
  if (!tradeMatchesFilters(trade, store.shownTradeQuery)) return ' It is not in the trade list because it does not match the current filters.'
  return narrowsList(store.shownTradeQuery)
    ? ' It matches the filters but is on another page of the trade list.'
    : ' It is on another page of the trade list.'
}

async function submit(): Promise<void> {
  submitted.value = true
  formError.value = undefined
  outageAfter = undefined
  success.value = undefined
  const request = Object.keys(clientErrors.value).length === 0 ? buildRequest() : undefined
  if (request === undefined) {
    await focusFirstError()
    return
  }

  submitting.value = true
  try {
    const trade = await store.createTrade(request)
    success.value = `Booked: ${trade.side} ${formatDecimal(trade.quantity)} ${trade.symbol} at ${formatDecimal(trade.price)}.` +
      whereListed(trade)
    Object.assign(form, { symbol: '', side: '', quantity: '', price: '', executedAt: '', occurrence: '' })
    submitted.value = false
    serverErrors.value = {}
    await nextTick()
    formElement.value?.querySelector<HTMLElement>(`#${fieldIds.symbol}`)?.focus()
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'invalid-trade') {
      serverErrors.value = error.fieldErrors
      formError.value = error.message
      await focusFirstError()
    } else {
      formError.value = error instanceof ApiError ? error.message : 'Something went wrong. Try again.'
      if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'unavailable')) {
        outageAfter = store.lastRequestStarted()
      }
    }
  } finally {
    submitting.value = false
  }
}

const describedBy = (field: TradeField, hint?: string): string | undefined =>
  [hint, errorFor(field) === undefined ? undefined : `${fieldIds[field]}-error`].filter(Boolean).join(' ') || undefined
</script>

<template>
  <section class="panel" aria-labelledby="trade-form-heading">
    <h2 id="trade-form-heading">Book a trade</h2>
    <form ref="formElement" novalidate @submit.prevent="submit">
      <p v-if="formError" class="alert alert-error" role="alert">{{ formError }}</p>
      <p v-if="success" class="alert alert-success" role="status">{{ success }}</p>

      <div class="field">
        <label :for="fieldIds.symbol">Symbol</label>
        <input
          :id="fieldIds.symbol"
          v-model="form.symbol"
          type="text"
          name="symbol"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          required
          :aria-invalid="errorFor('symbol') !== undefined"
          :aria-describedby="describedBy('symbol')"
        >
        <p v-if="errorFor('symbol')" :id="`${fieldIds.symbol}-error`" class="field-error">{{ errorFor('symbol') }}</p>
      </div>

      <fieldset
        class="field side"
        :aria-invalid="errorFor('side') !== undefined"
        :aria-describedby="describedBy('side')"
      >
        <legend>Side</legend>
        <div class="side-options">
          <label class="side-option side-buy">
            <input :id="fieldIds.side" v-model="form.side" type="radio" name="side" value="Buy" required>
            Buy
          </label>
          <label class="side-option side-sell">
            <input id="trade-side-sell" v-model="form.side" type="radio" name="side" value="Sell" required>
            Sell
          </label>
        </div>
        <p v-if="errorFor('side')" :id="`${fieldIds.side}-error`" class="field-error">{{ errorFor('side') }}</p>
      </fieldset>

      <div class="field-row">
        <div class="field">
          <label :for="fieldIds.quantity">Quantity</label>
          <input
            :id="fieldIds.quantity"
            v-model="form.quantity"
            type="text"
            name="quantity"
            inputmode="decimal"
            autocomplete="off"
            class="numeric"
            required
            :aria-invalid="errorFor('quantity') !== undefined"
            :aria-describedby="describedBy('quantity')"
          >
          <p v-if="errorFor('quantity')" :id="`${fieldIds.quantity}-error`" class="field-error">{{ errorFor('quantity') }}</p>
        </div>

        <div class="field">
          <label :for="fieldIds.price">Price</label>
          <input
            :id="fieldIds.price"
            v-model="form.price"
            type="text"
            name="price"
            inputmode="decimal"
            autocomplete="off"
            class="numeric"
            required
            :aria-invalid="errorFor('price') !== undefined"
            :aria-describedby="describedBy('price')"
          >
          <p v-if="errorFor('price')" :id="`${fieldIds.price}-error`" class="field-error">{{ errorFor('price') }}</p>
        </div>
      </div>

      <div class="field">
        <label :for="fieldIds.executedAt">Execution time <span class="optional">(optional)</span></label>
        <div class="input-with-action">
          <input
            :id="fieldIds.executedAt"
            v-model="form.executedAt"
            type="datetime-local"
            name="executedAt"
            step="1"
            min="0001-01-01T00:00"
            max="9999-12-31T23:59:59"
            :aria-invalid="errorFor('executedAt') !== undefined"
            :aria-describedby="describedBy('executedAt', 'trade-executed-at-hint')"
          >
          <button v-if="form.executedAt !== ''" type="button" class="button-secondary" @click="form.executedAt = ''">
            Clear
          </button>
        </div>
        <p id="trade-executed-at-hint" class="hint">
          Your local time ({{ timeZone }}). Leave blank to use the time the server receives the trade.
        </p>
        <fieldset v-if="resolution.kind === 'ambiguous'" class="occurrence">
          <legend>This time happens twice. Which one?</legend>
          <label v-for="(time, index) in resolution.times" :key="time.value" class="occurrence-option">
            <input v-model="form.occurrence" type="radio" name="occurrence" :value="time.value">
            {{ index === 0 ? 'First' : 'Second' }}, {{ time.offsetLabel }}
          </label>
        </fieldset>
        <p v-if="errorFor('executedAt')" :id="`${fieldIds.executedAt}-error`" class="field-error">{{ errorFor('executedAt') }}</p>
      </div>

      <button type="submit" class="button-primary" :disabled="submitting" :aria-busy="submitting">
        {{ submitting ? 'Booking…' : 'Book trade' }}
      </button>
    </form>
  </section>
</template>
