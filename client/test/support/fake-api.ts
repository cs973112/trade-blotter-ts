import { vi } from 'vitest'

/** A response the fake API sends: raw JSON text, so tests control every digit. */
export interface FakeResponse {
  readonly status?: number
  readonly body: string
  readonly contentType?: string
}

/** What a route does: answer, fail like a dropped connection, or wait until released. */
export type Route =
  | FakeResponse
  | Error
  | ((body: string | undefined, url: string) => FakeResponse | Error | Promise<FakeResponse | Error>)

export type RouteKey = 'GET /trades' | 'GET /trades/page' | 'GET /positions' | 'POST /trades' | 'POST /trades/:id/execution' | 'POST /trades/:id/cancellation' | 'GET /trades/:id/audit'

export interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

/**
 * Replaces the global fetch with a scripted API. A route is chosen by method and path, where :id
 * stands for one path segment (a trade id); the query string is passed to a route function in the
 * full URL. Unknown routes answer 404. Every call is recorded, so tests can check what the client
 * sent and in what order.
 */
export function fakeApi(initial: Partial<Record<RouteKey, Route>> = {}) {
  const routes = new Map<string, Route>(Object.entries(initial))
  const calls: RecordedCall[] = []

  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, url: input, headers: { ...(init?.headers as Record<string, string> | undefined) }, body })
    const path = input.split('?')[0] ?? input
    const route = routes.get(`${method} ${path}`) ?? routes.get(`${method} ${path.replace(/^\/trades\/[^/]+\/(execution|cancellation|audit)$/, '/trades/:id/$1')}`)
    if (route === undefined) {
      return new Response('{"type":"about:blank","title":"Not Found","status":404}', { status: 404 })
    }
    const result = typeof route === 'function' ? await route(body, input) : route
    if (result instanceof Error) throw result
    return new Response(result.body, {
      status: result.status ?? 200,
      headers: { 'content-type': result.contentType ?? 'application/json; charset=utf-8' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    calls,
    set(key: RouteKey, route: Route): void {
      routes.set(key, route)
    },
    /** "GET /trades", "POST /trades", ... in call order. */
    sequence(): string[] {
      return calls.map((call) => `${call.method} ${call.url}`)
    },
  }
}

/** A trade as the API writes it, with exact numbers in the JSON text. Executed by User unless told otherwise. */
export function tradeJson(fields: {
  id: string
  bookingSequence: number
  symbol: string
  side: 'Buy' | 'Sell'
  quantity: string
  price: string
  notional: string
  executedAt: string
  createdAt?: string
  updatedAt?: string
  status?: 'Pending' | 'Executed' | 'Cancelled'
  /** For a Cancelled trade: its reason and its cancellation record's id. */
  cancellationReason?: string
  cancellationTradeId?: string
  /** For a cancellation record: the original's id. */
  originalTradeId?: string
}): string {
  const createdAt = fields.createdAt ?? '2026-03-01T12:00:00.000Z'
  const status = fields.status ?? 'Executed'
  const cancelled = status === 'Cancelled'
  const text = (value: string | undefined): string => value === undefined ? 'null' : JSON.stringify(value)
  // Pending, and a trade cancelled while Pending, have no execution time.
  const executedAt = status === 'Executed' ? `"${fields.executedAt}"` : 'null'
  return `{"id":"${fields.id}","bookingSequence":${String(fields.bookingSequence)},"symbol":"${fields.symbol}",` +
    `"side":"${fields.side}","quantity":${fields.quantity},"price":${fields.price},"notional":${fields.notional},"status":"${status}",` +
    `"executedAt":${executedAt},"createdAt":"${createdAt}","updatedAt":"${fields.updatedAt ?? createdAt}",` +
    `"createdBy":"${fields.originalTradeId === undefined ? 'User' : 'Admin'}","updatedBy":"${cancelled ? 'Admin' : 'User'}",` +
    `"originalTradeId":${text(fields.originalTradeId)},"cancellationReason":${text(fields.cancellationReason)},"cancellationTradeId":${text(fields.cancellationTradeId)}}`
}

/** A position as the API writes it: the Executed net (twice, as netQuantity too), the Pending and Projected net, exact. */
export function positionJson(symbol: string, executed: string, averageCost: string, pending = '0'): string {
  const projected = String(Number(executed) + Number(pending))
  return `{"symbol":"${symbol}","netQuantity":${executed},"averageCost":${averageCost},"executedNetQuantity":${executed},` +
    `"pendingNetQuantity":${pending},"projectedNetQuantity":${projected}}`
}

export const json = (body: string, status = 200): FakeResponse => ({ status, body })

/** A GET /trades/page body: the items given (as JSON text) and the page's numbers, as the API writes them. */
export function pageJson(items: readonly string[], page: { page: number; pageSize: number; totalCount: number }): FakeResponse {
  const totalPages = Math.ceil(page.totalCount / page.pageSize)
  return json(`{"items":[${items.join(',')}],"page":${String(page.page)},"pageSize":${String(page.pageSize)},` +
    `"totalCount":${String(page.totalCount)},"totalPages":${String(totalPages)}}`)
}

/**
 * A GET /trades/page route over trades already in the order the API would list them: answers the
 * page and page size the request asks for (default 1 and 50), with the totals, as the API does.
 * It neither filters nor sorts; tests give it the list the query should produce.
 */
export function pagedTrades(ordered: readonly string[]): (body: string | undefined, url: string) => FakeResponse {
  return (_body, url) => {
    const parameters = new URL(url, 'http://localhost').searchParams
    const page = Number(parameters.get('page') ?? '1')
    const pageSize = Number(parameters.get('pageSize') ?? '50')
    return pageJson(ordered.slice((page - 1) * pageSize, page * pageSize), { page, pageSize, totalCount: ordered.length })
  }
}

export const problem = (status: number, members: Record<string, unknown>): FakeResponse => ({
  status,
  body: JSON.stringify({ type: 'about:blank', title: 'Error', status, ...members }),
  contentType: 'application/problem+json; charset=utf-8',
})

/**
 * A trade's JSON as a booking answers it: Pending, with no execution time. Rewritten as text, so
 * exact decimals keep every digit.
 */
export function asPending(trade: string): string {
  return trade.replace(/"status":"[A-Za-z]+"/, '"status":"Pending"').replace(/"executedAt":(?:"[^"]*"|null)/, '"executedAt":null')
}
