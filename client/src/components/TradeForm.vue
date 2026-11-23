<script setup lang="ts">
import { computed, nextTick, reactive, ref, useTemplateRef, watch } from 'vue'

import { ApiError } from '../api/client.ts'
import type { CreateTradeRequest, FieldErrors, Side, Trade } from '../api/contracts.ts'
import { checkDecimalInput, formatDecimal, numericOnly, type DecimalInputProblem } from '../lib/decimal-text.ts'
import { narrowsList, tradeMatchesFilters } from '../lib/trade-filters.ts'
import { useBlotterStore } from '../stores/blotter.ts'

/**
 * Booking a trade: symbol, side, quantity and price. Every trade is booked Pending, with no
 * execution time; it is executed afterwards, separately, from Trade History or Trade Details,
 * when the server sets its execution time. Nothing about status or time is typed or sent.
 */
const store = useBlotterStore()

/** The form's fields, in the order errors are focused. */
const FIELDS = ['symbol', 'side', 'quantity', 'price'] as const
type FormField = (typeof FIELDS)[number]

const form = reactive({
  symbol: '',
  side: '' as Side | '',
  quantity: '',
  price: '',
})

const submitted = ref(false)
const submitting = ref(false)
const serverErrors = ref<FieldErrors>({})
const formError = ref<string>()
const success = ref<string>()

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

const fieldIds: Record<FormField, string> = {
  symbol: 'trade-symbol',
  side: 'trade-side-buy',
  quantity: 'trade-quantity',
  price: 'trade-price',
}

const decimalMessages = (label: string): Record<DecimalInputProblem, string> => ({
  required: `Enter a ${label.toLowerCase()}.`,
  format: `Enter the ${label.toLowerCase()} as a number such as 100 or 101.25, without spaces or separators.`,
  zero: `${label} must be greater than zero.`,
})

/** Checks made before sending, so obvious mistakes are caught at once. The server checks everything else. */
const clientErrors = computed<FieldErrors>(() => {
  const errors: Partial<Record<FormField, readonly string[]>> = {}
  if (form.symbol.trim() === '') errors.symbol = ['Enter a symbol.']
  if (form.side === '') errors.side = ['Choose Buy or Sell.']
  const quantity = checkDecimalInput(form.quantity)
  if (!quantity.ok) errors.quantity = [decimalMessages('Quantity')[quantity.problem]]
  const price = checkDecimalInput(form.price)
  if (!price.ok) errors.price = [decimalMessages('Price')[price.problem]]
  return errors
})

/** Client errors after the first attempt to submit; server errors until the field changes. */
const shownErrors = computed<FieldErrors>(() => ({ ...serverErrors.value, ...(submitted.value ? clientErrors.value : {}) }))

function errorFor(field: FormField): string | undefined {
  return shownErrors.value[field]?.[0]
}

function clearServerError(field: FormField): void {
  if (serverErrors.value[field] === undefined) return
  serverErrors.value = Object.fromEntries(Object.entries(serverErrors.value).filter(([name]) => name !== field))
}

watch(() => form.symbol, () => { clearServerError('symbol') })
watch(() => form.side, () => { clearServerError('side') })
// Quantity and price accept numbers only: anything but digits and one decimal point is dropped as it is typed or pasted.
watch(() => form.quantity, (value) => {
  const kept = numericOnly(value)
  if (kept !== value) form.quantity = kept
  clearServerError('quantity')
})
watch(() => form.price, (value) => {
  const kept = numericOnly(value)
  if (kept !== value) form.price = kept
  clearServerError('price')
})

const formElement = useTemplateRef<HTMLFormElement>('formElement')

async function focusFirstError(): Promise<void> {
  await nextTick()
  const field = FIELDS.find((name) => errorFor(name) !== undefined)
  if (field !== undefined) formElement.value?.querySelector<HTMLElement>(`#${fieldIds[field]}`)?.focus()
}

function buildRequest(): CreateTradeRequest | undefined {
  const quantity = checkDecimalInput(form.quantity)
  const price = checkDecimalInput(form.price)
  if (form.side === '' || !quantity.ok || !price.ok) return undefined
  // No status and no execution time: the API books every trade Pending.
  return { symbol: form.symbol.trim(), side: form.side, quantity: quantity.text, price: price.text }
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
    const what = `${trade.side} ${formatDecimal(trade.quantity)} ${trade.symbol} at ${formatDecimal(trade.price)}`
    success.value = `Booked as Pending: ${what}. Execute it from Trade History or Trade Details; it counts in the Executed net and ` +
      `average cost once executed.${whereListed(trade)}`
    Object.assign(form, { symbol: '', side: '', quantity: '', price: '' })
    submitted.value = false
    serverErrors.value = {}
    await nextTick()
    formElement.value?.querySelector<HTMLElement>(`#${fieldIds.symbol}`)?.focus()
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'invalid-trade') {
      serverErrors.value = error.fieldErrors
      // Errors for anything the form does not have (it never sends status or executedAt) are shown with the form's message.
      const others = Object.entries(error.fieldErrors).filter(([field]) => !(FIELDS as readonly string[]).includes(field)).flatMap(([, messages]) => messages ?? [])
      formError.value = [error.message, ...others].join(' ')
      await focusFirstError()
    } else if (error instanceof ApiError && error.problem === 'position-limit') {
      formError.value = `${error.message} A booking is checked against the Executed and Pending trades together, with this one.`
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

const describedBy = (field: FormField, hint?: string): string | undefined =>
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

      <p id="trade-booking-hint" class="hint">
        Every trade is booked as Pending, with no execution time. Execute it from Trade History or Trade Details: the server then
        records when it was executed.
      </p>

      <button type="submit" class="button-primary" :disabled="submitting" :aria-busy="submitting">
        {{ submitting ? 'Booking…' : 'Book trade' }}
      </button>
    </form>
  </section>
</template>
