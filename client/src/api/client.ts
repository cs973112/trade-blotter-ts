import type { CreateTradeRequest, FieldErrors, Position, Side, Trade, TradeField } from './contracts.ts'
import { parseJsonKeepingNumberText } from './json.ts'

/**
 * A small typed client for the three API endpoints. Paths are relative: in development the Vite
 * server forwards them to the API. Every failure becomes an ApiError whose message is safe to
 * show; server-side details are never passed on.
 */

export type ApiErrorKind =
  /** 400 with field errors: show them next to the fields. */
  | 'invalid-trade'
  /** 400 for a business reason, such as the position limit: show the message. */
  | 'rejected'
  /** The server could not be reached: the request failed before any response arrived. */
  | 'network'
  /**
   * A gateway in front of the API answered for it: 502, 503 or 504. The development and preview
   * servers answer 502 when the API is not running, and the API answers 503 while shutting down.
   */
  | 'unavailable'
  /** The server failed, or answered with something unexpected. */
  | 'server'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly fieldErrors: FieldErrors

  constructor(kind: ApiErrorKind, message: string, fieldErrors: FieldErrors = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.fieldErrors = fieldErrors
  }
}

const NETWORK_MESSAGE = 'The server could not be reached. Check your connection, or that the API is running, and try again.'
const UNAVAILABLE_MESSAGE = 'The API is not available. Check that it is running, and try again in a moment.'
const SERVER_MESSAGE = 'The server could not complete the request. Try again in a moment.'
const UNEXPECTED_RESPONSE = 'The server sent a response this page does not understand. Try reloading the page.'

/** Bad gateway, service unavailable, gateway timeout: the API did not answer. Any other 5xx is its own failure. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

const TRADE_FIELDS: readonly TradeField[] = ['symbol', 'side', 'quantity', 'price', 'executedAt']
const DECIMAL = /^-?[0-9]+(?:[.][0-9]+)?$/

type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isDecimal = (value: unknown): value is string => isString(value) && DECIMAL.test(value)
const isSide = (value: unknown): value is Side => value === 'Buy' || value === 'Sell'

function unexpected(): ApiError {
  return new ApiError('server', UNEXPECTED_RESPONSE)
}

function toTrade(value: unknown): Trade {
  if (!isObject(value)) throw unexpected()
  const { id, bookingSequence, symbol, side, quantity, price, notional, executedAt, createdAt, updatedAt } = value
  if (
    !isString(id) || !isString(bookingSequence) || !/^[0-9]+$/.test(bookingSequence) || !isString(symbol) || !isSide(side) ||
    !isDecimal(quantity) || !isDecimal(price) || !isDecimal(notional) ||
    !isString(executedAt) || !isString(createdAt) || !isString(updatedAt)
  ) {
    throw unexpected()
  }
  return { id, bookingSequence: Number(bookingSequence), symbol, side, quantity, price, notional, executedAt, createdAt, updatedAt }
}

function toPosition(value: unknown): Position {
  if (!isObject(value)) throw unexpected()
  const { symbol, netQuantity, averageCost } = value
  if (!isString(symbol) || !isDecimal(netQuantity) || !isDecimal(averageCost)) throw unexpected()
  return { symbol, netQuantity, averageCost }
}

function toList<T>(value: unknown, convert: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw unexpected()
  return value.map(convert)
}

function toFieldErrors(value: unknown): FieldErrors {
  if (!isObject(value)) return {}
  const errors: Partial<Record<TradeField, readonly string[]>> = {}
  for (const field of TRADE_FIELDS) {
    const messages = value[field]
    if (Array.isArray(messages) && messages.every(isString)) errors[field] = messages
  }
  return errors
}

/** Turns an error response into an ApiError. Only messages written for users are shown. */
function toApiError(status: number, body: string): ApiError {
  if (GATEWAY_STATUSES.has(status)) return new ApiError('unavailable', UNAVAILABLE_MESSAGE)
  if (status >= 500) return new ApiError('server', SERVER_MESSAGE)
  let problem: unknown
  try {
    problem = JSON.parse(body)
  } catch {
    problem = undefined
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:invalid-trade') {
    return new ApiError('invalid-trade', 'Some fields need attention.', toFieldErrors(problem['errors']))
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:position-limit' && isString(problem['detail'])) {
    return new ApiError('rejected', `The trade was not booked. ${problem['detail']}`)
  }
  return new ApiError('rejected', `The request was not accepted (HTTP ${String(status)}). Reload the page and try again.`)
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly body?: string
}

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  let response: Response
  let body: string
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  try {
    response = await fetch(path, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }) })
    body = await response.text()
  } catch {
    throw new ApiError('network', NETWORK_MESSAGE)
  }
  if (!response.ok) throw toApiError(response.status, body)
  try {
    return parseJsonKeepingNumberText(body)
  } catch {
    throw unexpected()
  }
}

export const api = {
  /** POST /trades. Sends only the request fields; the server assigns the rest. */
  async createTrade(trade: CreateTradeRequest): Promise<Trade> {
    const body: CreateTradeRequest = {
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      ...(trade.executedAt === undefined ? {} : { executedAt: trade.executedAt }),
    }
    return toTrade(await request('/trades', { method: 'POST', body: JSON.stringify(body) }))
  },

  /** GET /trades: newest execution first, as the API orders them. */
  async listTrades(): Promise<Trade[]> {
    return toList(await request('/trades'), toTrade)
  },

  /** GET /positions: open positions sorted by symbol, as the API orders them. */
  async listPositions(): Promise<Position[]> {
    return toList(await request('/positions'), toPosition)
  },
}
