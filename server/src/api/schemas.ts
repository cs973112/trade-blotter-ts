import { Type } from 'typebox'

import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS } from '../domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../domain/symbol.ts'
import { TRADE_SIDES } from '../domain/trade.ts'
import { JSON_NUMBER_PATTERN } from './json.ts'

/**
 * The HTTP contract as TypeBox schemas. They document the API in OpenAPI; they do not validate
 * trade fields, which is the domain's job (validateTradeRequest), so every field error comes from
 * one place with one message. Request bodies are checked only for being a JSON object
 * (TradeRequestContainer). Responses are written by the lossless JSON serializer, not from these
 * schemas. Each schema's $id is its name under components.schemas.
 */

const DECIMAL_RULE =
  `Greater than 0 and less than 10^${String(MAX_INTEGER_DIGITS)}, with at most ${String(MAX_DECIMAL_PLACES)} decimal places. ` +
  'Send a JSON number or a string in JSON number grammar; either way the exact digits are kept.'

const TIMESTAMP_FORMAT = 'Canonical UTC with milliseconds, such as 2026-01-01T09:00:00.000Z.'

const DecimalInput = (description: string) =>
  Type.Union([Type.Number(), Type.String({ pattern: JSON_NUMBER_PATTERN })], { description: `${description} ${DECIMAL_RULE}` })

const DecimalOutput = (description: string, extra: { readOnly?: boolean } = {}) =>
  Type.Number({ description: `${description} Exact: written with every significant digit, never rounded through a binary float.`, ...extra })

const ServerTimestamp = (description: string) =>
  Type.String({ format: 'date-time', readOnly: true, description: `${description} Set by the server. ${TIMESTAMP_FORMAT}` })

export const CreateTradeRequest = Type.Object(
  {
    symbol: Type.String({
      description: 'Trimmed, Unicode NFC-normalised and upper-cased. 1 to the configured maximum characters ' +
        `(default ${String(DEFAULT_SYMBOL_MAX_LENGTH)}); no control or invisible characters.`,
      examples: ['MSFT'],
    }),
    side: Type.String({ description: 'Buy or Sell, ignoring case and surrounding whitespace.', examples: ['Buy'] }),
    quantity: DecimalInput('Units traded.'),
    price: DecimalInput('Price per unit.'),
    executedAt: Type.Optional(Type.Union([
      Type.String({ format: 'date-time', description: 'RFC 3339 date-time with an offset and at most millisecond precision.' }),
      Type.Null(),
    ], { description: 'When the trade was executed. Omitted or null: the server clock. Normalised to UTC. Future times are accepted.' })),
  },
  {
    $id: 'CreateTradeRequest',
    description: 'A trade to book. id, bookingSequence, createdAt and updatedAt are assigned by the server: ' +
      'members with those names, like any unknown member, are ignored.',
    examples: [{ symbol: 'MSFT', side: 'Buy', quantity: 100, price: '101.25', executedAt: '2026-01-01T09:00:00-05:00' }],
  },
)

export const TradeResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid', readOnly: true, description: 'Assigned by the server.' }),
    bookingSequence: Type.Integer({
      minimum: 1,
      readOnly: true,
      description: 'Assigned by the database when the trade is stored; increases with every booking and is never reused. ' +
        'Breaks ties between trades with the same executedAt.',
    }),
    symbol: Type.String({ description: 'Normalised symbol.' }),
    side: Type.Union(TRADE_SIDES.map((side) => Type.Literal(side))),
    quantity: DecimalOutput('Units traded.'),
    price: DecimalOutput('Price per unit.'),
    notional: DecimalOutput('quantity × price.', { readOnly: true }),
    executedAt: Type.String({ format: 'date-time', description: `When the trade was executed: as sent, or the server clock. ${TIMESTAMP_FORMAT}` }),
    createdAt: ServerTimestamp('When the trade was recorded.'),
    updatedAt: ServerTimestamp('When the record last changed; equal to createdAt, since trades are never amended.'),
  },
  { $id: 'Trade' },
)

export const PositionResponse = Type.Object(
  {
    symbol: Type.String(),
    netQuantity: Type.Number({ description: 'Signed: positive long, negative short. Never zero; flat positions are omitted. Exact.' }),
    averageCost: Type.Number({
      description: 'Quantity-weighted average price of the open quantity, computed to 50 significant digits ' +
        '(half to even) where the exact value does not terminate. Not rounded for display.',
    }),
  },
  { $id: 'Position' },
)

export const Problem = Type.Object(
  {
    type: Type.String({ description: 'about:blank for generic HTTP errors, or a URN naming the problem.' }),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.Optional(Type.String()),
    errors: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), {
      description: 'Invalid trade fields, in request order (symbol, side, quantity, price, executedAt), each with its messages.',
    })),
    symbol: Type.Optional(Type.String({ description: 'The symbol whose position limit would be breached.' })),
  },
  { $id: 'Problem', description: 'RFC 9457 problem details, served as application/problem+json.' },
)

/** The only check made on a trade request before the domain sees it: the body is a JSON object. */
export const TradeRequestContainer = Type.Object({})

export const SHARED_SCHEMAS = [CreateTradeRequest, TradeResponse, PositionResponse, Problem]
