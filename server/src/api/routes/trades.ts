import type { FastifyPluginAsync, FastifySchema } from 'fastify'
import { Type } from 'typebox'
import { Compile } from 'typebox/compile'

import type { TradeService } from '../../application/trade-service.ts'
import type { TradeRequest } from '../../domain/trade.ts'
import { clientError, PROBLEM_CONTENT_TYPE } from '../problem-details.ts'
import { toTradeResponse } from '../responses.ts'
import { TradeRequestContainer } from '../schemas.ts'

const problem = (description: string) => ({ description, content: { [PROBLEM_CONTENT_TYPE]: { schema: Type.Ref('Problem') } } })

const isTradeRequestContainer = Compile(TradeRequestContainer)

const createTradeSchema = {
  tags: ['Trades'],
  operationId: 'createTrade',
  summary: 'Book a trade',
  description:
    'Validates the trade, assigns its id, booking sequence, createdAt and updatedAt, and stores it. ' +
    'Every invalid field is reported at once. The trade is refused, and nothing is stored, if it would take its ' +
    "symbol's net quantity to the position limit at any point in execution-time order.",
  body: Type.Ref('CreateTradeRequest'),
  response: {
    201: { description: 'The stored trade.', content: { 'application/json': { schema: Type.Ref('Trade') } } },
    400: problem(
      'The body is not a JSON object or is malformed (no errors map); one or more fields are invalid (type ' +
        'urn:trade-blotter:problem:invalid-trade, with an errors map); or the trade would breach the position limit ' +
        '(type urn:trade-blotter:problem:position-limit).',
    ),
    415: problem('The body is not JSON: use application/json or a +json media type.'),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

const listTradesSchema = {
  tags: ['Trades'],
  operationId: 'listTrades',
  summary: 'List every trade, newest first',
  description: 'Ordered by executedAt descending; trades with the same executedAt are ordered by bookingSequence descending.',
  response: {
    200: { description: 'Every trade.', content: { 'application/json': { schema: Type.Array(Type.Ref('Trade')) } } },
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

export interface TradeRoutesOptions {
  readonly tradeService: TradeService
}

/** POST /trades and GET /trades. HTTP translation only: every rule lives in the service and domain. */
export const tradeRoutes: FastifyPluginAsync<TradeRoutesOptions> = (app, { tradeService }) => {
  app.post('/trades', {
    schema: createTradeSchema,
    // The schema documents the contract; the only check here is that the body is a JSON object.
    // Field validation belongs to the domain, which reports every invalid field with one message each.
    validatorCompiler: () => (body: unknown) =>
      isTradeRequestContainer.Check(body) ? { value: body } : { error: clientError('The request body must be a JSON object.') },
    handler: async (request, reply) => {
      const trade = await tradeService.createTrade(request.body as TradeRequest)
      return reply.code(201).send(toTradeResponse(trade))
    },
  })

  app.get('/trades', {
    schema: listTradesSchema,
    handler: async () => (await tradeService.listTrades()).map(toTradeResponse),
  })

  return Promise.resolve()
}
