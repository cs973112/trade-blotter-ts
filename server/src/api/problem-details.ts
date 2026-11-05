import { STATUS_CODES } from 'node:http'

import type { FastifyError, FastifyInstance } from 'fastify'

import { TradeQueryValidationError, TradeValidationError } from '../application/errors.ts'
import { PositionLimitError } from '../domain/position.ts'

/**
 * RFC 9457 problem bodies for every error the API returns. Generic HTTP errors use the
 * `about:blank` type with the status phrase as title. Three rejections have their own types: an
 * invalid trade carries an `errors` map keyed by request field, an invalid query an `errors` map
 * keyed by query parameter, and a position limit breach names the symbol. Unexpected errors are
 * logged and answered with a bare 500, so no internal detail reaches the client.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export const INVALID_TRADE_TYPE = 'urn:trade-blotter:problem:invalid-trade'
export const POSITION_LIMIT_TYPE = 'urn:trade-blotter:problem:position-limit'
export const INVALID_QUERY_TYPE = 'urn:trade-blotter:problem:invalid-query'

export interface ProblemDetails {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
  readonly errors?: Readonly<Record<string, readonly string[]>>
  readonly symbol?: string
}

export function problemFor(status: number, detail?: string): ProblemDetails {
  return { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status, ...(detail === undefined ? {} : { detail }) }
}

const exposed = Symbol('exposed')

/** A 400 error whose message is safe and useful to show the client, such as a JSON syntax error. */
export function clientError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400, [exposed]: true })
}

function isExposed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && exposed in error
}

function problemForError(error: FastifyError): ProblemDetails {
  if (error instanceof TradeValidationError) {
    return { type: INVALID_TRADE_TYPE, title: 'Invalid trade', status: 400, detail: error.message, errors: error.errors }
  }
  if (error instanceof TradeQueryValidationError) {
    return { type: INVALID_QUERY_TYPE, title: 'Invalid query', status: 400, detail: error.message, errors: error.errors }
  }
  if (error instanceof PositionLimitError) {
    return { type: POSITION_LIMIT_TYPE, title: 'Position limit exceeded', status: 400, detail: error.message, symbol: error.symbol }
  }
  const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
  return problemFor(status, status < 500 && isExposed(error) ? error.message : undefined)
}

/**
 * Error and not-found handling. Records every route's methods as routes are added, so a request
 * for a known path with an unsupported method gets 405 and an Allow header (RFC 9110) instead of
 * 404. Must be registered before the routes.
 */
export function registerProblemDetails(app: FastifyInstance): void {
  const methodsByPath = new Map<string, Set<string>>()
  app.addHook('onRoute', (route) => {
    const methods = methodsByPath.get(route.url) ?? new Set<string>()
    for (const method of [route.method].flat()) methods.add(method)
    methodsByPath.set(route.url, methods)
  })

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    const methods = methodsByPath.get(path.length > 1 ? path.replace(/[/]$/, '') : path)
    if (methods !== undefined) {
      return reply.code(405).header('allow', [...methods].sort().join(', ')).type(PROBLEM_CONTENT_TYPE).send(problemFor(405))
    }
    return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problemFor(404))
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const problem = problemForError(error)
    if (problem.status >= 500) {
      request.log.error({ err: error }, 'Unhandled error')
    }
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem)
  })
}
