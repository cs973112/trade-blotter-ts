import { defineStore } from 'pinia'
import { ref } from 'vue'

import { ApiError } from '../api/client.ts'
import type { Trade } from '../api/contracts.ts'
import { describeTrade, isExecutable } from '../lib/cancellation.ts'
import { useBlotterStore } from './blotter.ts'
import { messageFor } from './list-state.ts'

/** Where the execution was started, and so where its outcome is reported. */
export type ExecutionContext = 'history' | 'details'

export interface ExecutionOutcome {
  readonly context: ExecutionContext
  readonly message: string
  /** The trade as the API returned it, now Executed. */
  readonly trade: Trade
}

/** What went wrong with the last attempt. */
export interface ExecutionProblem {
  readonly message: string
  /** The trade cannot be executed as things stand (409 or 404): only closing is offered. */
  readonly final: boolean
}

/**
 * The one execution dialog, opened for a Pending trade from a row's Execute button. Each opening is
 * a session: an answer that arrives for an earlier session (the dialog was closed or opened again
 * meanwhile) is dropped, so it never changes what is shown. While an execution is being sent the
 * dialog cannot be closed and a second one is not sent.
 *
 * Nothing is sent but the trade's id. The server sets the execution time and the actor (User); the
 * page never supplies or overrides them.
 */
export const useExecutionStore = defineStore('execution', () => {
  const open = ref(false)
  const context = ref<ExecutionContext>('history')
  const trade = ref<Trade>()
  const submitting = ref(false)
  const problem = ref<ExecutionProblem>()
  /** The last execution that succeeded, reported where it was started. */
  const outcome = ref<ExecutionOutcome>()
  /** The element that opened the dialog, for focus to return to. */
  const opener = ref<HTMLElement | null>(null)

  let session = 0

  /** Opens the dialog for one trade. A trade that is not Pending opens nothing. */
  function openFor(chosen: Trade, where: ExecutionContext, element: HTMLElement | null = null): void {
    if (!isExecutable(chosen)) return
    session++
    open.value = true
    context.value = where
    opener.value = element
    trade.value = chosen
    outcome.value = undefined
    problem.value = undefined
    submitting.value = false
  }

  /** Closes the dialog, unless an execution is being sent. Answers still on their way are dropped. */
  function close(): boolean {
    if (submitting.value) return false
    session++
    open.value = false
    return true
  }

  /**
   * Sends the execution. Returns true when it was executed (the dialog is then closed and the outcome
   * reported); false when it was refused, with the problem kept. A call while one is being sent, or
   * after a final refusal, does nothing.
   */
  async function confirm(): Promise<boolean> {
    const chosen = trade.value
    if (submitting.value || !open.value || chosen === undefined || problem.value?.final === true) return false
    const mine = session
    submitting.value = true
    problem.value = undefined
    try {
      const result = await useBlotterStore().executeTrade(chosen.id, chosen.symbol)
      if (mine !== session) return false
      outcome.value = {
        context: context.value,
        trade: result,
        message: `Executed: ${describeTrade(result)}, recorded by ${result.updatedBy}. It now counts in the Executed net and average cost.`,
      }
      submitting.value = false
      close()
      return true
    } catch (error) {
      if (mine !== session) return false
      const kind = error instanceof ApiError ? error.kind : undefined
      if (error instanceof ApiError && error.problem === 'position-limit') {
        // Its message already says the trade was not executed and stays Pending.
        problem.value = { message: `${error.message} Executing other trades of ${chosen.symbol} first may make room for it. The lists have been refreshed.`, final: true }
      } else if (kind === 'conflict' || kind === 'not-found') {
        problem.value = { message: `The trade was not executed. ${messageFor(error)} The lists have been refreshed.`, final: true }
      } else {
        problem.value = { message: `The trade was not executed. ${messageFor(error)}`, final: false }
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

  return { open, context, trade, submitting, problem, outcome, opener, openFor, close, confirm, dismissOutcome }
})
