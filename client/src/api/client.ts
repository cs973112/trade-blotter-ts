import {
  TRADE_PAGE_QUERY_PARAMETERS,
  TRADE_QUERY_PARAMETERS,
  type Actor,
  type AuditEntry,
  type AuditPage,
  type AuditTradeSnapshot,
  type Cancellation,
  type CreateTradeRequest,
  type FieldErrors,
  type Position,
  type Side,
  type Trade,
  type TradeField,
  type TradePage,
  type TradePageQuery,
  type TradeQuery,
  type TradeStatus,
} from './contracts.ts'
import { parseJsonKeepingNumberText } from './json.ts'

/**
 * A small typed client for the API's seven endpoints. Paths are relative: in development the Vite
 * server forwards them to the API. Every failure becomes an ApiError whose message is safe to
 * show; server-side details are never passed on.
 */

export type ApiErrorKind =
  /** 400 with field errors: show them next to the fields. */
  | 'invalid-trade'
  /** 400 for GET /trades query parameters the API did not accept: show the message with the trade list. */
  | 'invalid-query'
  /** 400 for a business reason, such as the position limit: show the message. */
  | 'rejected'
  /** 400 for a cancellation whose reason the API did not accept: show the message by the reason. */
  | 'invalid-cancellation'
  /** 404 for a trade that does not exist (any more). */
  | 'not-found'
  /**
   * 409: the trade cannot make the change asked of it, such as one already cancelled, or executing it
   * would breach the position limit (problem position-limit). Nothing was written.
   */
  | 'conflict'
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
  /** The problem type's last part, such as position-limit, when the API named one. */
  readonly problem: string | undefined

  constructor(kind: ApiErrorKind, message: string, fieldErrors: FieldErrors = {}, problem?: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.fieldErrors = fieldErrors
    this.problem = problem
  }
}

const NETWORK_MESSAGE = 'The server could not be reached. Check your connection, or that the API is running, and try again.'
const UNAVAILABLE_MESSAGE = 'The API is not available. Check that it is running, and try again in a moment.'
const SERVER_MESSAGE = 'The server could not complete the request. Try again in a moment.'
const UNEXPECTED_RESPONSE = 'The server sent a response this page does not understand. Try reloading the page.'

/** Bad gateway, service unavailable, gateway timeout: the API did not answer. Any other 5xx is its own failure. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

const TRADE_FIELDS: readonly TradeField[] = ['symbol', 'side', 'quantity', 'price', 'executedAt', 'status']
const DECIMAL = /^-?[0-9]+(?:[.][0-9]+)?$/

type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isDecimal = (value: unknown): value is string => isString(value) && DECIMAL.test(value)
const isSide = (value: unknown): value is Side => value === 'Buy' || value === 'Sell'
const isStatus = (value: unknown): value is TradeStatus => value === 'Pending' || value === 'Executed' || value === 'Cancelled'
const isActor = (value: unknown): value is Actor => value === 'User' || value === 'Admin'
const isOptionalText = (value: unknown): value is string | null => value === null || isString(value)

function unexpected(): ApiError {
  return new ApiError('server', UNEXPECTED_RESPONSE)
}

function toTrade(value: unknown): Trade {
  if (!isObject(value)) throw unexpected()
  const {
    id, bookingSequence, symbol, side, quantity, price, notional, status, executedAt, createdAt, updatedAt, createdBy, updatedBy,
    originalTradeId, cancellationReason, cancellationTradeId,
  } = value
  if (
    !isString(id) || !isString(bookingSequence) || !/^[0-9]+$/.test(bookingSequence) || !isString(symbol) || !isSide(side) ||
    !isDecimal(quantity) || !isDecimal(price) || !isDecimal(notional) || !isStatus(status) ||
    !isOptionalText(executedAt) || !isString(createdAt) || !isString(updatedAt) || !isActor(createdBy) || !isActor(updatedBy) ||
    !isOptionalText(originalTradeId) || !isOptionalText(cancellationReason) || !isOptionalText(cancellationTradeId)
  ) {
    throw unexpected()
  }
  return {
    id, bookingSequence: Number(bookingSequence), symbol, side, quantity, price, notional, status, executedAt, createdAt, updatedAt,
    createdBy, updatedBy, originalTradeId, cancellationReason, cancellationTradeId,
  }
}

function toPosition(value: unknown): Position {
  if (!isObject(value)) throw unexpected()
  const { symbol, netQuantity, averageCost, executedNetQuantity, pendingNetQuantity, projectedNetQuantity } = value
  if (!isString(symbol) || !isDecimal(netQuantity) || !isDecimal(averageCost) || !isDecimal(executedNetQuantity) ||
    !isDecimal(pendingNetQuantity) || !isDecimal(projectedNetQuantity)) throw unexpected()
  return { symbol, netQuantity, averageCost, executedNetQuantity, pendingNetQuantity, projectedNetQuantity }
}

function toCancellation(value: unknown): Cancellation {
  if (!isObject(value)) throw unexpected()
  const trade = toTrade(value['trade'])
  const cancellationRecord = toTrade(value['cancellationRecord'])
  // The trade is now Cancelled, and the record names it; anything else is not this contract.
  if (trade.status !== 'Cancelled' || cancellationRecord.originalTradeId !== trade.id || trade.cancellationTradeId !== cancellationRecord.id) throw unexpected()
  return { trade, cancellationRecord }
}

const AUDIT_ACTIONS: ReadonlySet<unknown> = new Set(['Inserted', 'Updated', 'Deleted'])

function toSnapshot(value: unknown): AuditTradeSnapshot {
  if (!isObject(value)) throw unexpected()
  const {
    bookingSequence, id, symbol, side, quantity, price, executedAt, createdAt, updatedAt, quantityKey, priceKey, status, createdBy, updatedBy,
    originalTradeId, cancellationReason,
  } = value
  if (
    !isString(bookingSequence) || !/^[0-9]+$/.test(bookingSequence) || !isString(id) || !isString(symbol) || !isString(side) ||
    !isDecimal(quantity) || !isDecimal(price) || !isOptionalText(executedAt) || !isString(createdAt) || !isString(updatedAt) ||
    !isString(quantityKey) || !isString(priceKey) || !isStatus(status) || !isActor(createdBy) || !isActor(updatedBy) ||
    !isOptionalText(originalTradeId) || !isOptionalText(cancellationReason)
  ) {
    throw unexpected()
  }
  return {
    bookingSequence: Number(bookingSequence), id, symbol, side, quantity, price, executedAt, createdAt, updatedAt, quantityKey, priceKey, status,
    createdBy, updatedBy, originalTradeId, cancellationReason,
  }
}

function toAuditEntry(value: unknown): AuditEntry {
  if (!isObject(value)) throw unexpected()
  const { auditId, auditAction, auditOn, auditBy } = value
  if (!isString(auditId) || !/^[0-9]+$/.test(auditId) || !AUDIT_ACTIONS.has(auditAction) || !isString(auditOn) || auditBy !== 'System') throw unexpected()
  return { auditId: Number(auditId), auditAction: auditAction as AuditEntry['auditAction'], auditOn, auditBy, trade: toSnapshot(value['trade']) }
}

interface AuditAsked {
  readonly tradeId: string
  readonly scope: AuditPage['scope']
  readonly page: number
  readonly pageSize: number
}

/** A page of an audit history, refused unless it is the page asked for and its numbers agree, as for trades. */
function toAuditPage(value: unknown, asked: AuditAsked): AuditPage {
  if (!isObject(value)) throw unexpected()
  const items = toList(value['items'], toAuditEntry)
  const { tradeId, scope } = value
  const tradeIds = toList(value['tradeIds'], (id) => {
    if (!isString(id)) throw unexpected()
    return id
  })
  const page = toWholeNumber(value['page'])
  const pageSize = toWholeNumber(value['pageSize'])
  const totalCount = toWholeNumber(value['totalCount'])
  const totalPages = toWholeNumber(value['totalPages'])
  if (tradeId !== asked.tradeId || scope !== asked.scope || page !== asked.page || pageSize !== asked.pageSize ||
    totalPages !== Math.ceil(totalCount / pageSize)) throw unexpected()
  const onPage = page > totalPages ? 0 : Math.min(pageSize, totalCount - (page - 1) * pageSize)
  if (items.length !== onPage || items.some((entry) => !tradeIds.includes(entry.trade.id))) throw unexpected()
  return { tradeId: asked.tradeId, scope: asked.scope, tradeIds, items, page, pageSize, totalCount, totalPages }
}

function toList<T>(value: unknown, convert: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw unexpected()
  return value.map(convert)
}

/** A count or page number: the exact text of a non-negative JSON integer that a number holds exactly. */
function toWholeNumber(value: unknown): number {
  if (!isString(value) || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw unexpected()
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw unexpected()
  return number
}

/**
 * A page of trades, refused unless it is the page asked for and its numbers agree: totalPages is
 * totalCount divided by pageSize, rounded up, and the page holds exactly the trades that fall on it.
 */
function toTradePage(value: unknown, query: TradePageQuery): TradePage {
  if (!isObject(value)) throw unexpected()
  const items = toList(value['items'], toTrade)
  const page = toWholeNumber(value['page'])
  const pageSize = toWholeNumber(value['pageSize'])
  const totalCount = toWholeNumber(value['totalCount'])
  const totalPages = toWholeNumber(value['totalPages'])
  if (page !== query.page || pageSize !== query.pageSize || totalPages !== Math.ceil(totalCount / pageSize)) throw unexpected()
  const onPage = page > totalPages ? 0 : Math.min(pageSize, totalCount - (page - 1) * pageSize)
  if (items.length !== onPage) throw unexpected()
  return { items, page, pageSize, totalCount, totalPages }
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

/** The messages of an invalid-query problem, in parameter order. They name the parameters, not the page's labels. */
function queryMessages(value: unknown): string[] {
  if (!isObject(value)) return []
  return TRADE_PAGE_QUERY_PARAMETERS.flatMap((parameter) => {
    const messages = value[parameter]
    return Array.isArray(messages) ? messages.filter(isString) : []
  })
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
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:invalid-query') {
    return new ApiError('invalid-query', `The filters were not accepted. ${queryMessages(problem['errors']).join(' ')}`.trim())
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:position-limit' && isString(problem['detail'])) {
    // 409 for an execution (its detail says it was not executed), 400 for a booking.
    return status === 409
      ? new ApiError('conflict', problem['detail'], {}, 'position-limit')
      : new ApiError('rejected', `The trade was not booked. ${problem['detail']}`, {}, 'position-limit')
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:invalid-execution') {
    return new ApiError('rejected', 'The execution request was not accepted. Reload the page and try again.', {}, 'invalid-execution')
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:invalid-cancellation') {
    const errors = isObject(problem['errors']) ? problem['errors'] : {}
    const reason = Array.isArray(errors['reason']) ? errors['reason'].filter(isString) : []
    const message = reason[0] ?? (isString(problem['detail']) ? problem['detail'] : 'The reason was not accepted.')
    return new ApiError('invalid-cancellation', message, {}, 'invalid-cancellation')
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:trade-not-found') {
    return new ApiError('not-found', 'The trade no longer exists.', {}, 'trade-not-found')
  }
  if (isObject(problem) && problem['type'] === 'urn:trade-blotter:problem:invalid-transition' && isString(problem['detail'])) {
    return new ApiError('conflict', problem['detail'], {}, 'invalid-transition')
  }
  return new ApiError('rejected', `The request was not accepted (HTTP ${String(status)}). Reload the page and try again.`)
}

/** The members of a query that are set and not empty, in TRADE_QUERY_PARAMETERS order. */
function queryParameters(query: TradeQuery): URLSearchParams {
  const parameters = new URLSearchParams()
  for (const name of TRADE_QUERY_PARAMETERS) {
    const value = query[name]
    if (value !== undefined && value !== '') parameters.append(name, value)
  }
  return parameters
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
  /**
   * POST /trades. Sends only the request fields; the server assigns the rest, the actors included,
   * and books the trade Pending, with no execution time. The answer must be a Pending trade.
   */
  async createTrade(trade: CreateTradeRequest): Promise<Trade> {
    const body: CreateTradeRequest = {
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      ...(trade.status === undefined ? {} : { status: trade.status }),
    }
    const booked = toTrade(await request('/trades', { method: 'POST', body: JSON.stringify(body) }))
    if (booked.status !== 'Pending' || booked.executedAt !== null) throw unexpected()
    return booked
  },

  /**
   * POST /trades/{id}/execution: executes a Pending trade. Nothing is sent: the server sets the
   * execution time and records it as User. The answer must be the same trade, now Executed.
   */
  async executeTrade(id: string): Promise<Trade> {
    const trade = toTrade(await request(`/trades/${encodeURIComponent(id)}/execution`, { method: 'POST' }))
    if (trade.id !== id || trade.status !== 'Executed' || trade.executedAt === null) throw unexpected()
    return trade
  },

  /**
   * GET /trades, in the order the API sends: newest execution first unless the query sorts. Only
   * the query members that are set and not empty are sent, so an empty query is plain /trades.
   */
  async listTrades(query: TradeQuery = {}): Promise<Trade[]> {
    const search = queryParameters(query).toString()
    return toList(await request(search === '' ? '/trades' : `/trades?${search}`), toTrade)
  },

  /**
   * GET /trades/page: one page of what listTrades would return for the same query, sorted and
   * counted by the API. page and pageSize are always sent; the other members as for listTrades.
   * The response must be the page asked for, with numbers that agree (see toTradePage).
   */
  async listTradePage(query: TradePageQuery): Promise<TradePage> {
    const parameters = queryParameters(query)
    parameters.append('page', String(query.page))
    parameters.append('pageSize', String(query.pageSize))
    return toTradePage(await request(`/trades/page?${parameters.toString()}`), query)
  },

  /**
   * POST /trades/{id}/cancellation: cancels a Pending trade with a reason. Only the reason is sent:
   * the server records the cancellation as Admin, at its own time. The answer must be the trade,
   * now Cancelled, and the cancellation record that names it.
   */
  async cancelTrade(id: string, reason: string): Promise<Cancellation> {
    const body = JSON.stringify({ reason })
    return toCancellation(await request(`/trades/${encodeURIComponent(id)}/cancellation`, { method: 'POST', body }))
  },

  /**
   * GET /trades/{id}/audit: one page of a trade's audit history, oldest first. Read only. scope
   * logical (the default here) lists the original and its cancellation record together.
   */
  async tradeAudit(id: string, options: { readonly scope?: AuditPage['scope']; readonly page?: number; readonly pageSize?: number } = {}): Promise<AuditPage> {
    const asked: AuditAsked = { tradeId: id, scope: options.scope ?? 'logical', page: options.page ?? 1, pageSize: options.pageSize ?? 50 }
    const parameters = new URLSearchParams({ scope: asked.scope, page: String(asked.page), pageSize: String(asked.pageSize) })
    return toAuditPage(await request(`/trades/${encodeURIComponent(id)}/audit?${parameters.toString()}`), asked)
  },

  /** GET /positions: open positions sorted by symbol, as the API orders them. */
  async listPositions(): Promise<Position[]> {
    return toList(await request('/positions'), toPosition)
  },
}
