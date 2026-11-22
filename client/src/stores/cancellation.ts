import { defineStore } from 'pinia'
import { ref } from 'vue'

import { api, ApiError } from '../api/client.ts'
import type { Trade } from '../api/contracts.ts'
import { describeTrade, isCancellable } from '../lib/cancellation.ts'
import { useBlotterStore } from './blotter.ts'
import { messageFor } from './list-state.ts'

/** Where the cancellation was started, and so where its outcome is reported. */
export type CancellationContext = 'history' | 'details'

/** At most this many Pending trades of one symbol are offered to choose from (the API's largest page). */
export const PENDING_CHOICES = 100

export interface CancellationOutcome {
  readonly context: CancellationContext
  readonly message: string
  /** The trade as the API returned it, now Cancelled. */
  readonly trade: Trade
}

/** What went wrong with the last attempt: by the reason (the API refused it), or for the whole request. */
export interface CancellationProblem {
  readonly message: string
  readonly reason: boolean
  /** The trade can no longer be cancelled (409 or 404): only closing is offered. */
  readonly final: boolean
}

/**
 * The one cancellation dialog: opened for a trade (a row's Cancel button), or for a symbol (Trade
 * Details), when the Pending trades of that symbol are loaded to choose from. Each opening is a
 * session: an answer that arrives for an earlier session (the dialog was closed or opened again
 * meanwhile) is dropped, so it never changes what is shown. While a cancellation is being sent the
 * dialog cannot be closed and a second one is not sent.
 *
 * Only the reason is sent. The server sets the actors (Admin), the time and the cancellation record;
 * the page never supplies or overrides them.
 */
export const useCancellationStore = defineStore('cancellation', () => {
  const open = ref(false)
  const context = ref<CancellationContext>('history')
  const symbol = ref<string>()
  /** The Pending trades offered: one when opened for a trade. */
  const candidates = ref<Trade[]>([])
  /** The symbol has more Pending trades than were offered. */
  const more = ref(false)
  const loading = ref(false)
  const loadError = ref<string>()
  const submitting = ref(false)
  const problem = ref<CancellationProblem>()
  /** The last cancellation that succeeded, reported where it was started. */
  const outcome = ref<CancellationOutcome>()
  /** The element that opened the dialog, for focus to return to. */
  const opener = ref<HTMLElement | null>(null)

  let session = 0

  function begin(where: CancellationContext, element: HTMLElement | null): number {
    session++
    open.value = true
    context.value = where
    opener.value = element
    outcome.value = undefined
    candidates.value = []
    more.value = false
    loading.value = false
    loadError.value = undefined
    problem.value = undefined
    submitting.value = false
    return session
  }

  /** Opens the dialog for one trade. A trade that is not Pending opens nothing. */
  function openFor(trade: Trade, where: CancellationContext, element: HTMLElement | null = null): void {
    if (!isCancellable(trade)) return
    begin(where, element)
    symbol.value = trade.symbol
    candidates.value = [trade]
  }

  /** Opens the dialog for a symbol, and loads its Pending trades to choose from. */
  async function openForSymbol(chosen: string, where: CancellationContext, element: HTMLElement | null = null): Promise<void> {
    const mine = begin(where, element)
    symbol.value = chosen
    loading.value = true
    try {
      const page = await api.listTradePage({ symbol: chosen, symbolMatch: 'exact', status: 'Pending', page: 1, pageSize: PENDING_CHOICES })
      if (mine !== session) return
      candidates.value = page.items.filter((trade) => trade.symbol === chosen && isCancellable(trade))
      more.value = page.totalCount > page.items.length
    } catch (error) {
      if (mine !== session) return
      loadError.value = messageFor(error)
    } finally {
      if (mine === session) loading.value = false
    }
  }

  /** Closes the dialog, unless a cancellation is being sent. Answers still on their way are dropped. */
  function close(): boolean {
    if (submitting.value) return false
    session++
    open.value = false
    loading.value = false
    return true
  }

  /**
   * Sends the cancellation of one of the candidates. Returns true when it was cancelled (the dialog
   * is then closed and the outcome reported); false when it was refused, with the problem kept.
   * A call while one is being sent does nothing.
   */
  async function confirm(trade: Trade, reason: string): Promise<boolean> {
    if (submitting.value || !open.value) return false
    const mine = session
    submitting.value = true
    problem.value = undefined
    try {
      const result = await useBlotterStore().cancelTrade(trade.id, reason, trade.symbol)
      if (mine !== session) return false
      outcome.value = {
        context: context.value,
        trade: result.trade,
        message: `Cancelled: ${describeTrade(result.trade)}. Reason: ${result.trade.cancellationReason ?? reason}. ` +
          `Cancellation record ${result.cancellationRecord.id}, recorded by ${result.cancellationRecord.createdBy}.`,
      }
      submitting.value = false
      close()
      return true
    } catch (error) {
      if (mine !== session) return false
      const kind = error instanceof ApiError ? error.kind : undefined
      if (kind === 'invalid-cancellation') {
        problem.value = { message: messageFor(error), reason: true, final: false }
      } else if (kind === 'conflict' || kind === 'not-found') {
        problem.value = { message: `The trade was not cancelled. ${messageFor(error)} The lists have been refreshed.`, reason: false, final: true }
      } else {
        problem.value = { message: `The trade was not cancelled. ${messageFor(error)}`, reason: false, final: false }
      }
      return false
    } finally {
      if (mine === session) submitting.value = false
    }
  }

  /** Forgets the outcome shown, such as when its message is dismissed. */
  function dismissOutcome(): void {
    outcome.value = undefined
  }

  return {
    open, context, symbol, candidates, more, loading, loadError, submitting, problem, outcome, opener,
    openFor, openForSymbol, close, confirm, dismissOutcome,
  }
})
