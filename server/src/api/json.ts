import type { FastifyInstance } from 'fastify'
import secureJson from 'secure-json-parse'

import { DECIMAL_TEXT_PATTERN } from '../domain/decimal.ts'
import { clientError } from './problem-details.ts'

/**
 * Lossless JSON for decimal fields. Request decimals are read from their exact source text, so
 * a value such as 0.12345678901234567890 never passes through a JavaScript number. Response
 * decimals are written with JSON.rawJSON, so they leave as exact JSON numbers.
 *
 * Every other value is parsed and serialized exactly as JSON.parse and JSON.stringify would.
 */

/**
 * JSON number grammar (RFC 8259). A decimal may also be sent as a string in this grammar, for
 * clients that cannot write an arbitrary-precision JSON number. Defined by the domain.
 */
export const JSON_NUMBER_PATTERN = DECIMAL_TEXT_PATTERN

/** application/json plus structured-syntax `+json` media types (RFC 6839). */
const JSON_CONTENT_TYPES: readonly (string | RegExp)[] = ['application/json', /^application\/[\w.!#$&^-]+\+json$/i]

export interface LosslessJsonOptions {
  /** Property names whose JSON numbers are kept as source text. */
  readonly decimalFields: readonly string[]
}

interface ReviverContext {
  readonly source?: string
}

/**
 * Parses JSON like JSON.parse, with prototype-poisoning protection, except that a JSON number
 * under one of the decimal field names becomes its exact source text (a string). Numbers and
 * numeric strings therefore reach validation in the same form.
 */
export function parseJsonPreservingDecimals(text: string, decimalFields: ReadonlySet<string>): unknown {
  const reviver = (key: string, value: unknown, context?: ReviverContext): unknown => {
    if (typeof value !== 'number' || !decimalFields.has(key)) return value
    if (context?.source === undefined) {
      throw new Error('JSON number source text is unavailable; refusing to lose decimal precision.')
    }
    return context.source
  }
  return secureJson.parse(text, reviver, { protoAction: 'error', constructorAction: 'error' })
}

/**
 * The message shown to the client for a body that could not be parsed, or undefined when the
 * failure is not a problem with the body. Messages are fixed text: the parser's own message is
 * never passed on, because it can quote the body or describe the implementation. Only the position
 * of a syntax error, a number, is carried over.
 */
export function describeParseFailure(error: unknown): string | undefined {
  if (!(error instanceof SyntaxError)) return undefined
  if (/forbidden prototype property/.test(error.message)) {
    return 'The request body contains a forbidden property name (__proto__, or constructor with prototype).'
  }
  const position = /at position (\d+)/.exec(error.message)?.[1]
  return position === undefined ? 'The request body is not valid JSON.' : `The request body is not valid JSON (at character ${position}).`
}

/** A decimal's exact text, emitted by JSON.stringify as a bare JSON number. */
export function rawJsonNumber(text: string): JsonRawNumber {
  return JSON.rawJSON(text)
}

/**
 * Replaces Fastify's body parsers and its schema-based response serializer. Response schemas
 * remain in place for OpenAPI and contract tests; they no longer drive serialization, because
 * fast-json-stringify would turn exact decimals into lossy JavaScript numbers.
 */
export function registerLosslessJson(app: FastifyInstance, options: LosslessJsonOptions): void {
  const decimalFields = new Set(options.decimalFields)

  // Fastify also parses text/plain by default; this API accepts JSON only and answers 415 otherwise.
  app.removeAllContentTypeParsers()
  for (const contentType of JSON_CONTENT_TYPES) {
    app.addContentTypeParser(contentType, { parseAs: 'string' }, (_request, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8')
      if (text.trim() === '') {
        done(clientError('The request body is empty.'), undefined)
        return
      }
      try {
        done(null, parseJsonPreservingDecimals(text, decimalFields))
      } catch (error) {
        const message = describeParseFailure(error)
        // A failure that is not a syntax error is the server's, not the client's: a logged 500.
        done(message === undefined ? (error instanceof Error ? error : new Error(String(error))) : clientError(message), undefined)
      }
    })
  }

  app.setSerializerCompiler(() => (data) => JSON.stringify(data))
}
