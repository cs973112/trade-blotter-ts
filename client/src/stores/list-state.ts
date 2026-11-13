import { ApiError } from '../api/client.ts'

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

export function emptyList<T>(): ListState<T> {
  return { items: [], loading: false, loaded: false, error: undefined }
}

/** A failure's message, safe to show. */
export function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try reloading the page.'
}
