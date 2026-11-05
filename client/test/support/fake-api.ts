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

export type RouteKey = 'GET /trades' | 'GET /positions' | 'POST /trades'

export interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

/**
 * Replaces the global fetch with a scripted API. A route is chosen by method and path; the query
 * string is passed to a route function in the full URL. Unknown routes answer 404. Every call is
 * recorded, so tests can check what the client sent and in what order.
 */
export function fakeApi(initial: Partial<Record<RouteKey, Route>> = {}) {
  const routes = new Map<string, Route>(Object.entries(initial))
  const calls: RecordedCall[] = []

  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, url: input, headers: { ...(init?.headers as Record<string, string> | undefined) }, body })
    const route = routes.get(`${method} ${input.split('?')[0] ?? input}`)
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

/** A trade as the API writes it, with exact numbers in the JSON text. */
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
}): string {
  const createdAt = fields.createdAt ?? '2026-03-01T12:00:00.000Z'
  return `{"id":"${fields.id}","bookingSequence":${String(fields.bookingSequence)},"symbol":"${fields.symbol}",` +
    `"side":"${fields.side}","quantity":${fields.quantity},"price":${fields.price},"notional":${fields.notional},` +
    `"executedAt":"${fields.executedAt}","createdAt":"${createdAt}","updatedAt":"${fields.updatedAt ?? createdAt}"}`
}

export const json = (body: string, status = 200): FakeResponse => ({ status, body })

export const problem = (status: number, members: Record<string, unknown>): FakeResponse => ({
  status,
  body: JSON.stringify({ type: 'about:blank', title: 'Error', status, ...members }),
  contentType: 'application/problem+json; charset=utf-8',
})
