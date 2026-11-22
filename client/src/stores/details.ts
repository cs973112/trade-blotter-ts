import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api, ApiError } from '../api/client.ts'
import type { AuditEntry, SortField, Trade, TradePageQuery } from '../api/contracts.ts'
import { DEFAULT_TRADE_SORT, nextSort, PAGE_SIZES, type TradeSort } from '../lib/trade-filters.ts'
import { emptyList, messageFor, type ListState, type ShownPage } from './list-state.ts'

/** Trades a page in the details, the smallest size the trade list offers, as the details panel is half the page. */
export const DETAIL_PAGE_SIZE: number = PAGE_SIZES[0]

/**
 * The query for one page of a position's trades: the whole symbol (symbolMatch=exact, never a
 * search within symbols, so MS never lists MSFT or MSTR), the sort (left out when it is the API's
 * default), the page and the page size. The API filters, sorts, counts and pages them.
 */
export function detailQuery(symbol: string, sort: TradeSort, page: number, pageSize: number): TradePageQuery {
  const isDefault = sort.sortBy === DEFAULT_TRADE_SORT.sortBy && sort.sortDirection === DEFAULT_TRADE_SORT.sortDirection
  return { symbol, symbolMatch: 'exact', ...(isDefault ? {} : sort), page, pageSize }
}

const OTHER_SYMBOL = 'The server returned trades for another symbol. Try again in a moment.'

/** Audit entries a page. A logical trade has two (booked) or three (cancelled); more would be pages. */
export const AUDIT_PAGE_SIZE = 25

/** Which audit history is shown: the logical trade's, by the id it was asked for, and the page of it. */
export interface ShownAudit {
  readonly tradeId: string
  /** The physical trades the entries are of: the original, and its cancellation record once cancelled. */
  readonly tradeIds: readonly string[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

/**
 * Positions & Trade Details: the position chosen in the master grid, and one page of its trades
 * from GET /trades/page, filtered by the API on that exact symbol. Positions themselves come from
 * the blotter store, shared with the Trading tab, so this tab loads none of its own.
 *
 * Choosing another position starts again at page 1 (keeping the sort and page size) and clears the
 * trades shown, so one position's trades are never shown under another's name. Only the newest
 * request may change what is shown: an answer for an earlier choice, page or sort is dropped.
 * Choosing the position already chosen, or the page already shown, sends nothing.
 *
 * The audit history of one of the position's trades (GET /trades/{id}/audit, scope logical: the
 * original and its cancellation record) can be shown beside them, read only. It has its own request
 * numbering, so a late answer for another trade is dropped too; choosing another position closes it.
 */
export const useDetailsStore = defineStore('details', () => {
  /** The position chosen, by symbol; undefined until one is. */
  const symbol = ref<string>()
  const trades = ref<ListState<Trade>>(emptyList())
  const sort = ref<TradeSort>(DEFAULT_TRADE_SORT)
  /** The page asked for, which may differ from the page shown while it loads. */
  const page = ref(1)
  const pageSize = ref(DETAIL_PAGE_SIZE)
  /** The symbol, sort and page of the trades shown, with the counts that came with them. */
  const shownSymbol = ref<string>()
  const shownSort = ref<TradeSort>(DEFAULT_TRADE_SORT)
  const shownPage = ref<ShownPage>()

  let latest = 0

  /** The trade whose audit history is shown, by id; undefined when none is. */
  const auditTradeId = ref<string>()
  const audit = ref<ListState<AuditEntry>>(emptyList())
  const auditPage = ref(1)
  const shownAudit = ref<ShownAudit>()
  let latestAudit = 0

  /** Whether the trades shown are the chosen position's (and not still the previous one's). */
  const showsChosen = computed(() => symbol.value !== undefined && shownSymbol.value === symbol.value && trades.value.loaded)

  async function load(): Promise<void> {
    const chosen = symbol.value
    if (chosen === undefined) return
    const request = ++latest
    const wantedSort = sort.value
    const query = detailQuery(chosen, wantedSort, page.value, pageSize.value)
    trades.value.loading = true
    trades.value.error = undefined
    try {
      const result = await api.listTradePage(query)
      if (request !== latest) return
      if (result.items.some((trade) => trade.symbol !== chosen)) throw new ApiError('server', OTHER_SYMBOL)
      if (result.page > result.totalPages && result.totalPages > 0) {
        // Past the last page (trades changed meanwhile): show the last one.
        page.value = result.totalPages
        await load()
        return
      }
      trades.value = { items: [...result.items], loading: false, loaded: true, error: undefined }
      shownSymbol.value = chosen
      shownSort.value = wantedSort
      shownPage.value = { page: result.page, pageSize: result.pageSize, totalCount: result.totalCount, totalPages: result.totalPages }
    } catch (error) {
      if (request !== latest) return
      trades.value = { ...trades.value, loading: false, error: messageFor(error) }
    }
  }

  async function loadAudit(): Promise<void> {
    const tradeId = auditTradeId.value
    if (tradeId === undefined) return
    const request = ++latestAudit
    const page = auditPage.value
    audit.value.loading = true
    audit.value.error = undefined
    try {
      const result = await api.tradeAudit(tradeId, { scope: 'logical', page, pageSize: AUDIT_PAGE_SIZE })
      if (request !== latestAudit) return
      if (result.page > result.totalPages && result.totalPages > 0) {
        auditPage.value = result.totalPages
        await loadAudit()
        return
      }
      audit.value = { items: [...result.items], loading: false, loaded: true, error: undefined }
      shownAudit.value = { tradeId, tradeIds: result.tradeIds, page: result.page, pageSize: result.pageSize, totalCount: result.totalCount, totalPages: result.totalPages }
    } catch (error) {
      if (request !== latestAudit) return
      audit.value = { ...audit.value, loading: false, error: messageFor(error) }
    }
  }

  /** Shows a trade's audit history from its first page. The trade already shown loads nothing. */
  async function showAudit(tradeId: string): Promise<void> {
    if (tradeId === auditTradeId.value && audit.value.error === undefined) return
    auditTradeId.value = tradeId
    auditPage.value = 1
    audit.value = { ...emptyList(), loading: true }
    shownAudit.value = undefined
    await loadAudit()
  }

  /** Closes the audit history; an answer still on its way is then dropped. */
  function closeAudit(): void {
    latestAudit++
    auditTradeId.value = undefined
    audit.value = emptyList()
    shownAudit.value = undefined
  }

  async function auditGoToPage(target: number): Promise<void> {
    if (auditTradeId.value === undefined || !Number.isInteger(target) || target < 1 || target === auditPage.value) return
    auditPage.value = target
    await loadAudit()
  }

  /** Loads the audit history shown again, if any (after a cancellation, or Refresh). */
  async function reloadAudit(): Promise<void> {
    await loadAudit()
  }

  /** Shows a position's trades from page 1. The position already chosen loads nothing. */
  async function select(next: string): Promise<void> {
    if (next === symbol.value) return
    closeAudit()
    symbol.value = next
    page.value = 1
    trades.value = { ...emptyList(), loading: true }
    shownSymbol.value = undefined
    shownPage.value = undefined
    await load()
  }

  async function sortBy(field: SortField): Promise<void> {
    if (symbol.value === undefined) return
    sort.value = nextSort(sort.value, field)
    page.value = 1
    await load()
  }

  async function goToPage(target: number): Promise<void> {
    if (symbol.value === undefined || !Number.isInteger(target) || target < 1 || target === page.value) return
    page.value = target
    await load()
  }

  async function setPageSize(size: number): Promise<void> {
    if (symbol.value === undefined || size === pageSize.value) return
    pageSize.value = size
    page.value = 1
    await load()
  }

  /** Loads the page shown again (Refresh, or after a trade for this symbol is booked). */
  async function reload(): Promise<void> {
    await load()
  }

  return {
    symbol, trades, sort, page, pageSize, shownSymbol, shownSort, shownPage, showsChosen, select, sortBy, goToPage, setPageSize, reload,
    auditTradeId, audit, auditPage, shownAudit, showAudit, closeAudit, auditGoToPage, reloadAudit,
  }
})
