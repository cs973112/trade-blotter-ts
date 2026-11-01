/**
 * HTTP scenarios outside trade validation: media types, routing and methods. Every error
 * response is an RFC 9457 problem body with content type application/problem+json.
 */
import { rawBody } from './trade-requests.ts'

export interface HttpScenario {
  readonly name: string
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
  readonly path: string
  /** Sent exactly as given. No content-type entry means no Content-Type header. */
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly expected: { readonly status: number; readonly allow?: string }
}

const TRADE = rawBody({ symbol: '"CT"', side: '"Buy"', quantity: '1', price: '1', executedAt: '"2026-01-01T09:00:00Z"' })

const post = (name: string, contentType: string | undefined, body: string, status: number): HttpScenario => ({
  name,
  method: 'POST',
  path: '/trades',
  ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
  body,
  expected: { status },
})

export const HTTP_SCENARIOS: readonly HttpScenario[] = [
  // Media types.
  post('application/json', 'application/json', TRADE, 201),
  post('application/json with charset', 'application/json; charset=utf-8', TRADE, 201),
  post('structured +json suffix', 'application/vnd.trade+json', TRADE, 201),
  post('no content type', undefined, TRADE, 415),
  post('text/plain', 'text/plain', TRADE, 415),
  post('text/json', 'text/json', TRADE, 415),
  post('form urlencoded', 'application/x-www-form-urlencoded', 'symbol=CT&side=Buy&quantity=1&price=1', 415),
  post('empty body', 'application/json', '', 400),
  post('whitespace body', 'application/json', '   ', 400),

  // Routing.
  { name: 'trades', method: 'GET', path: '/trades', expected: { status: 200 } },
  { name: 'positions', method: 'GET', path: '/positions', expected: { status: 200 } },
  { name: 'trailing slash is ignored', method: 'GET', path: '/trades/', expected: { status: 200 } },
  { name: 'query string is ignored', method: 'GET', path: '/trades?symbol=ABC', expected: { status: 200 } },
  { name: 'paths are case-sensitive', method: 'GET', path: '/TRADES', expected: { status: 404 } },
  { name: 'unknown route', method: 'GET', path: '/unknown', expected: { status: 404 } },
  { name: 'no single-trade resource', method: 'GET', path: '/trades/00000000-0000-0000-0000-000000000000', expected: { status: 404 } },
  { name: 'HEAD trades', method: 'HEAD', path: '/trades', expected: { status: 200 } },

  // Methods a resource does not support: 405 with an Allow header (RFC 9110).
  { name: 'PUT trades', method: 'PUT', path: '/trades', headers: { 'content-type': 'application/json' }, body: '{}',
    expected: { status: 405, allow: 'GET, HEAD, POST' } },
  { name: 'DELETE trades', method: 'DELETE', path: '/trades', expected: { status: 405, allow: 'GET, HEAD, POST' } },
  { name: 'OPTIONS trades', method: 'OPTIONS', path: '/trades', expected: { status: 405, allow: 'GET, HEAD, POST' } },
  { name: 'POST positions', method: 'POST', path: '/positions', headers: { 'content-type': 'application/json' }, body: '{}',
    expected: { status: 405, allow: 'GET, HEAD' } },
  { name: 'PATCH positions', method: 'PATCH', path: '/positions', headers: { 'content-type': 'application/json' }, body: '{}',
    expected: { status: 405, allow: 'GET, HEAD' } },
]
