import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

export const JSON_TYPE = 'application/json; charset=utf-8'
export const PROBLEM_TYPE = 'application/problem+json; charset=utf-8'

/** POSTs raw JSON text to /trades, so decimals reach the API exactly as written. */
export function postTrade(app: FastifyInstance, body: string, contentType = 'application/json'): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/trades', headers: { 'content-type': contentType }, payload: body })
}

/** The source text of every JSON number under `name` in a response body, in order. */
export function rawNumbers(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`"${name}":(-?[0-9][0-9.eE+-]*)`, 'g'))].map((match) => match[1] ?? '')
}
