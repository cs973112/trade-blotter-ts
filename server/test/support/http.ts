import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

export const JSON_TYPE = 'application/json; charset=utf-8'
export const PROBLEM_TYPE = 'application/problem+json; charset=utf-8'

/** POSTs raw JSON text to /trades, so decimals reach the API exactly as written. */
export function postTrade(app: FastifyInstance, body: string, contentType = 'application/json'): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/trades', headers: { 'content-type': contentType }, payload: body })
}

/** A test server: its app, and the fixed clock the app reads. */
export interface ClockedServer {
  readonly app: FastifyInstance
  readonly clock: { set(time: string): void; peek(): string }
}

/**
 * An Executed trade, as M7 makes one: POSTs the booking (raw JSON text, with no executedAt; it is
 * booked Pending) with the server's fixed clock reading `bookedAt`, then POST
 * /trades/{id}/execution with it reading `executedAt`, so the trade executes at that time. By
 * default it is booked at that time too. The clock reads what it read before afterwards. Returns
 * the execution's response; a booking that is refused is returned as it is, and nothing is executed.
 */
export async function bookExecuted(server: ClockedServer, body: string, executedAt: string, bookedAt = executedAt): Promise<LightMyRequestResponse> {
  const before = server.clock.peek()
  server.clock.set(bookedAt)
  try {
    const booked = await postTrade(server.app, body)
    if (booked.statusCode !== 201) return booked
    const { id } = booked.json<{ id: string }>()
    server.clock.set(executedAt)
    return await server.app.inject({ method: 'POST', url: `/trades/${id}/execution` })
  } finally {
    server.clock.set(before)
  }
}

/** POSTs /trades/{id}/execution with no body. */
export function executeTrade(app: FastifyInstance, id: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: `/trades/${id}/execution` })
}

/** The source text of every JSON number under `name` in a response body, in order. */
export function rawNumbers(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`"${name}":(-?[0-9][0-9.eE+-]*)`, 'g'))].map((match) => match[1] ?? '')
}
