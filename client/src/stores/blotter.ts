import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api, ApiError } from '../api/client.ts'
import type { CreateTradeRequest, Position, SortField, Trade, TradePageQuery, TradeQuery } from '../api/contracts.ts'
import { DEFAULT_PAGE_SIZE, DEFAULT_TRADE_SORT, nextSort, type TradeFilterQuery, type TradeSort } from '../lib/trade-filters.ts'

/** The state of one list loaded from the API. */
export interface ListState<T> {
  items: T[]
  /** A request is in flight. */
  loading: boolean
  /** At least one load has succeeded, so `items` is real data (possibly empty). */
  loaded: boolean
  /** The last load failed; safe to show. */
  error: string | undefined
}

/** Where the trades shown sit among every matching trade, as the API counted them. */
export interface ShownPage {
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

function emptyList<T>(): ListState<T> {
  return { items: [], loading: false, loaded: false, error: undefined }
}

function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try reloading the page.'
}

/**
 * The trades and positions shown on the page, shared by the form (which books trades), the trade
 * list and the positions table. Positions come from the API; the client never calculates them.
 * Booking a trade refreshes both lists.
 *
 * The trade list is one page from GET /trades/page, chosen by the applied filters, the sort, the
 * page and the page size. Each is changed only through the actions below, which reload the list;
 * changing the filters, the sort or the page size goes back to page 1. Positions never use any of
 * it: they always cover every trade.
 */
export const useBlotterStore = defineStore('blotter', () => {
  const trades = ref<ListState<Trade>>(emptyList())
  const positions = ref<ListState<Position>>(emptyList())

  /** The filters last applied. Empty: every trade. */
  const filters = ref<TradeFilterQuery>({})
  const sort = ref<TradeSort>(DEFAULT_TRADE_SORT)
  /** The page asked for, which may differ from the page shown while it loads. */
  const page = ref(1)
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE)

  /** The filters and sort the list is loaded with; the default sort is left out, as the API's default. */
  const tradeQuery = computed<TradeQuery>(() => ({
    ...filters.value,
    ...(sort.value.sortBy === DEFAULT_TRADE_SORT.sortBy && sort.value.sortDirection === DEFAULT_TRADE_SORT.sortDirection ? {} : sort.value),
  }))
  /** The query the trades in the list were loaded with, which may differ while a new one loads. */
  const shownTradeQuery = ref<TradeQuery>({})
  /** The page the trades in the list are, and the counts that came with it. Undefined until one loads. */
  const shownPage = ref<ShownPage | undefined>(undefined)

  // Each list keeps only the newest response, so a slow earlier request cannot overwrite a later one.
  let tradesRequest = 0
  let positionsRequest = 0

  // Every API request is numbered as it starts. `latestAnswered` is the number of the newest one
  // that succeeded, so the page can tell whether the API has answered since something failed.
  let requestsStarted = 0
  const latestAnswered = ref(0)

  function answered(request: number): void {
    if (request > latestAnswered.value) latestAnswered.value = request
  }

  /** The number of the newest request started so far. Any request that succeeds later has a higher one. */
  function lastRequestStarted(): number {
    return requestsStarted
  }

  /** Loads the page asked for, with the applied filters and sort. */
  async function loadTrades(): Promise<void> {
    const request = ++tradesRequest
    const number = ++requestsStarted
    const shown = tradeQuery.value
    const query: TradePageQuery = { ...shown, page: page.value, pageSize: pageSize.value }
    trades.value.loading = true
    try {
      const result = await api.listTradePage(query)
      answered(number)
      if (request !== tradesRequest) return
      if (result.page > result.totalPages && result.totalPages > 0) {
        // Past the last page: show the last one rather than an empty page of a list that has trades.
        page.value = result.totalPages
        await loadTrades()
        return
      }
      trades.value = { items: [...result.items], loading: false, loaded: true, error: undefined }
      shownTradeQuery.value = shown
      shownPage.value = { page: result.page, pageSize: result.pageSize, totalCount: result.totalCount, totalPages: result.totalPages }
    } catch (error) {
      if (request !== tradesRequest) return
      trades.value = { ...trades.value, loading: false, error: messageFor(error) }
    }
  }

  async function loadPositions(): Promise<void> {
    const request = ++positionsRequest
    const number = ++requestsStarted
    positions.value.loading = true
    try {
      const items = await api.listPositions()
      answered(number)
      if (request !== positionsRequest) return
      positions.value = { items, loading: false, loaded: true, error: undefined }
    } catch (error) {
      if (request !== positionsRequest) return
      positions.value = { ...positions.value, loading: false, error: messageFor(error) }
    }
  }

  /** Applies new filters (empty for none), keeping the sort, and shows their first page. */
  async function applyFilters(query: TradeFilterQuery): Promise<void> {
    filters.value = query
    page.value = 1
    await loadTrades()
  }

  /** No filters, newest execution first, page 1: the list as the page opens. The page size is kept. */
  async function clearFilters(): Promise<void> {
    filters.value = {}
    sort.value = DEFAULT_TRADE_SORT
    page.value = 1
    await loadTrades()
  }

  /** Sorts by a column (see nextSort), with the applied filters, from page 1. */
  async function sortBy(field: SortField): Promise<void> {
    sort.value = nextSort(sort.value, field)
    page.value = 1
    await loadTrades()
  }

  /** Shows another page. Asking for the page already asked for sends nothing. */
  async function goToPage(target: number): Promise<void> {
    if (!Number.isInteger(target) || target < 1 || target === page.value) return
    page.value = target
    await loadTrades()
  }

  /** Changes the page size and shows page 1. Choosing the current size sends nothing. */
  async function setPageSize(size: number): Promise<void> {
    if (size === pageSize.value) return
    pageSize.value = size
    page.value = 1
    await loadTrades()
  }

  /** Reloads trades and positions together. Never throws: failures are kept in each list's state. */
  async function refresh(): Promise<void> {
    await Promise.all([loadTrades(), loadPositions()])
  }

  /**
   * Books a trade, then refreshes both lists: the trades on the same page, with the same filters
   * and sort. Throws ApiError if the trade is not booked.
   */
  async function createTrade(request: CreateTradeRequest): Promise<Trade> {
    const number = ++requestsStarted
    const trade = await api.createTrade(request)
    answered(number)
    await refresh()
    return trade
  }

  return {
    trades, positions, filters, sort, page, pageSize, tradeQuery, shownTradeQuery, shownPage, latestAnswered, lastRequestStarted,
    loadTrades, loadPositions, applyFilters, clearFilters, sortBy, goToPage, setPageSize, refresh, createTrade,
  }
})
