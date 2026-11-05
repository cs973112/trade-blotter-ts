import { defineStore } from 'pinia'
import { ref } from 'vue'

import { api, ApiError } from '../api/client.ts'
import type { CreateTradeRequest, Position, Trade, TradeQuery } from '../api/contracts.ts'

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

function emptyList<T>(): ListState<T> {
  return { items: [], loading: false, loaded: false, error: undefined }
}

function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try reloading the page.'
}

/**
 * The trades and positions shown on the page, shared by the form (which books trades) and the two
 * tables. Positions come from the API; the client never calculates them. Booking a trade
 * refreshes both lists.
 *
 * The trade list is loaded with the applied query, which only applyTradeQuery changes. Positions
 * never use it: they always cover every trade.
 */
export const useBlotterStore = defineStore('blotter', () => {
  const trades = ref<ListState<Trade>>(emptyList())
  const positions = ref<ListState<Position>>(emptyList())
  /** The search, filters and sort the trade list is loaded with. Empty: every trade, newest first. */
  const tradeQuery = ref<TradeQuery>({})
  /** The query the trades in the list were loaded with, which may differ while a new one loads. */
  const shownTradeQuery = ref<TradeQuery>({})

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

  /** Loads the trade list with the applied query. */
  async function loadTrades(): Promise<void> {
    const request = ++tradesRequest
    const number = ++requestsStarted
    const query = tradeQuery.value
    trades.value.loading = true
    try {
      const items = await api.listTrades(query)
      answered(number)
      if (request !== tradesRequest) return
      trades.value = { items, loading: false, loaded: true, error: undefined }
      shownTradeQuery.value = query
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

  /** Applies a new search, filter and sort (an empty query for none), and reloads the trade list with it. */
  async function applyTradeQuery(query: TradeQuery): Promise<void> {
    tradeQuery.value = query
    await loadTrades()
  }

  /** Reloads trades and positions together. Never throws: failures are kept in each list's state. */
  async function refresh(): Promise<void> {
    await Promise.all([loadTrades(), loadPositions()])
  }

  /** Books a trade, then refreshes both lists, the trades with the applied query. Throws ApiError if the trade is not booked. */
  async function createTrade(request: CreateTradeRequest): Promise<Trade> {
    const number = ++requestsStarted
    const trade = await api.createTrade(request)
    answered(number)
    await refresh()
    return trade
  }

  return {
    trades, positions, tradeQuery, shownTradeQuery, latestAnswered, lastRequestStarted,
    loadTrades, loadPositions, applyTradeQuery, refresh, createTrade,
  }
})
