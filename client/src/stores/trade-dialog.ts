import { defineStore } from 'pinia'
import { ref } from 'vue'

import { api } from '../api/client.ts'
import type { AuditEntry, Trade } from '../api/contracts.ts'
import { isCancellable, isExecutable } from '../lib/cancellation.ts'
import { useBlotterStore } from './blotter.ts'
import { cancellationProblem, cancelledMessage, useCancellationStore } from './cancellation.ts'
import { AUDIT_PAGE_SIZE } from './details.ts'
import { executedMessage, executionProblem, useExecutionStore } from './execution.ts'
import { emptyList, messageFor, type ListState } from './list-state.ts'

/** Where the dialog was opened, and so where its outcome is reported and focus falls back to. */
export type TradeDialogContext = 'history' | 'details'

/** What went wrong with the last action: by the reason (the API refused it), or for the whole request. */
export interface TradeDialogProblem {
  readonly message: string
  readonly reason: boolean
  /** The trade can no longer be executed or cancelled as things stand: only closing is offered. */
  readonly final: boolean
}

/**
 * The trade dialog, opened from a row's details button in Trade History or its edit button in Trade
 * Details. It shows the trade; for a Pending trade it offers Execute, Keep Pending, and Cancel with a
 * reason. Opened from Trade History's History button it also shows the trade's audit history
 * (GET /trades/{id}/audit, scope logical), read only. Each opening is a session: an answer that
 * arrives for an earlier session (the dialog was closed or opened again meanwhile) is dropped. While
 * an action is being sent the dialog cannot be closed and no second action is sent.
 *
 * It sends what the execution and cancellation dialogs send (the id; the id and the reason), through
 * the same blotter actions, and reports the outcome where those dialogs report theirs: the execution
 * and cancellation stores' outcomes in the panel's context, with the same messages.
 */
export const useTradeDialogStore = defineStore('trade-dialog', () => {
  const open = ref(false)
  const context = ref<TradeDialogContext>('history')
  const trade = ref<Trade>()
  /** The action being sent, if any. */
  const submitting = ref<'execute' | 'cancel'>()
  const problem = ref<TradeDialogProblem>()
  /** The element that opened the dialog, for focus to return to. */
  const opener = ref<HTMLElement | null>(null)
  /** Whether the audit history is shown, and its first page of entries. */
  const showsAudit = ref(false)
  const audit = ref<ListState<AuditEntry>>(emptyList())
  /** The entries there are in all, which may be more than one page shows. */
  const auditTotal = ref(0)

  let session = 0

  /**
   * Opens the dialog for one trade, whatever its status, from Trade History or Trade Details; with
   * `withAudit`, its audit history too. An outcome already shown in that panel is dismissed.
   */
  function openFor(chosen: Trade, element: HTMLElement | null = null, where: TradeDialogContext = 'history', withAudit = false): void {
    session++
    open.value = true
    context.value = where
    opener.value = element
    trade.value = chosen
    submitting.value = undefined
    problem.value = undefined
    showsAudit.value = withAudit
    audit.value = emptyList()
    auditTotal.value = 0
    const execution = useExecutionStore()
    const cancellation = useCancellationStore()
    if (execution.outcome?.context === where) execution.dismissOutcome()
    if (cancellation.outcome?.context === where) cancellation.dismissOutcome()
    if (withAudit) void loadAudit()
  }

  /** Loads the first page of the trade's audit history; an answer for an earlier session is dropped. */
  async function loadAudit(): Promise<void> {
    const chosen = trade.value
    if (chosen === undefined || !showsAudit.value) return
    const mine = session
    audit.value = { ...audit.value, loading: true, error: undefined }
    try {
      const result = await api.tradeAudit(chosen.id, { scope: 'logical', page: 1, pageSize: AUDIT_PAGE_SIZE })
      if (mine !== session) return
      audit.value = { items: [...result.items], loading: false, loaded: true, error: undefined }
      auditTotal.value = result.totalCount
    } catch (error) {
      if (mine !== session) return
      audit.value = { ...audit.value, loading: false, error: messageFor(error) }
    }
  }

  /** Closes the dialog, unless an action is being sent. Answers still on their way are dropped. */
  function close(): boolean {
    if (submitting.value !== undefined) return false
    session++
    open.value = false
    return true
  }

  /** Whether an action may be sent now. */
  function ready(): Trade | undefined {
    const chosen = trade.value
    if (submitting.value !== undefined || !open.value || chosen === undefined || problem.value?.final === true) return undefined
    return chosen
  }

  /** Executes the Pending trade. True when it was executed (the dialog is then closed and the outcome reported). */
  async function execute(): Promise<boolean> {
    const chosen = ready()
    if (chosen === undefined || !isExecutable(chosen)) return false
    const mine = session
    submitting.value = 'execute'
    problem.value = undefined
    try {
      const result = await useBlotterStore().executeTrade(chosen.id, chosen.symbol)
      if (mine !== session) return false
      useExecutionStore().outcome = { context: context.value, trade: result, message: executedMessage(result) }
      submitting.value = undefined
      close()
      return true
    } catch (error) {
      if (mine !== session) return false
      problem.value = { ...executionProblem(error, chosen.symbol), reason: false }
      return false
    } finally {
      if (mine === session) submitting.value = undefined
    }
  }

  /** Cancels the Pending trade with the reason (already checked). True when it was cancelled. */
  async function cancel(reason: string): Promise<boolean> {
    const chosen = ready()
    if (chosen === undefined || !isCancellable(chosen)) return false
    const mine = session
    submitting.value = 'cancel'
    problem.value = undefined
    try {
      const result = await useBlotterStore().cancelTrade(chosen.id, reason, chosen.symbol)
      if (mine !== session) return false
      useCancellationStore().outcome = { context: context.value, trade: result.trade, message: cancelledMessage(result, reason) }
      submitting.value = undefined
      close()
      return true
    } catch (error) {
      if (mine !== session) return false
      problem.value = cancellationProblem(error)
      return false
    } finally {
      if (mine === session) submitting.value = undefined
    }
  }

  /** Forgets a problem shown by the reason, such as when the reason changes. */
  function clearReasonProblem(): void {
    if (problem.value?.reason === true) problem.value = undefined
  }

  return { open, context, trade, submitting, problem, opener, showsAudit, audit, auditTotal, openFor, loadAudit, close, execute, cancel, clearReasonProblem }
})
