import type { FastifyPluginAsync, FastifySchema } from 'fastify'
import { Type } from 'typebox'
import { Compile } from 'typebox/compile'

import type { TradeService } from '../../application/trade-service.ts'
import type { TradePageQueryRequest, TradeQueryRequest } from '../../domain/trade-query.ts'
import type { TradeRequest } from '../../domain/trade.ts'
import { clientError, PROBLEM_CONTENT_TYPE } from '../problem-details.ts'
import { toAuditPageResponse, toCancellationResponse, toTradePageResponse, toTradeResponse } from '../responses.ts'
import { AuditQuery, ListTradePageQuery, ListTradesQuery, TradeRequestContainer } from '../schemas.ts'

const problem = (description: string) => ({ description, content: { [PROBLEM_CONTENT_TYPE]: { schema: Type.Ref('Problem') } } })

const isTradeRequestContainer = Compile(TradeRequestContainer)

const createTradeSchema = {
  tags: ['Trades'],
  operationId: 'createTrade',
  summary: 'Book a trade, as Pending',
  description:
    'Validates the trade, assigns its id, booking sequence, createdAt and updatedAt, sets createdBy and updatedBy to User, and ' +
    'stores it as Pending, with no executedAt: every trade is booked Pending and executed separately (POST /trades/{id}/execution). ' +
    'A status other than Pending, or an executedAt, is refused. Every invalid field is reported at once. The trade is refused, and ' +
    'nothing stored, if the projected net quantity, Executed and Pending together with it, would reach the position limit.',
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
  summary: 'List trades: search, filter and sort',
  description:
    'One entry per logical trade: Pending, Executed and Cancelled trades, never a cancellation record. Without query parameters, ' +
    'every trade, ordered by executedAt descending, trades without an execution time (Pending, or cancelled while Pending) last; ' +
    'trades with the same executedAt, or none, are ordered by bookingSequence descending. symbol (anywhere in the symbol, or the ' +
    'whole symbol with symbolMatch=exact), side, status, executedFrom and executedTo filter, combined with AND; ' +
    'sortBy and sortDirection sort. Every order is total: ties are broken by executedAt, then bookingSequence, in the ' +
    'sort direction. Filtering never changes stored trades or positions, which always use the full history.',
  querystring: ListTradesQuery,
  response: {
    200: { description: 'The matching trades, possibly none.', content: { 'application/json': { schema: Type.Array(Type.Ref('Trade')) } } },
    400: problem(
      'One or more query parameters are invalid or repeated (type urn:trade-blotter:problem:invalid-query, with an ' +
        'errors map keyed by parameter).',
    ),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

const listTradePageSchema = {
  tags: ['Trades'],
  operationId: 'listTradePage',
  summary: 'List one page of trades: search, filter, sort and page',
  description:
    'The trades GET /trades lists for the same symbol, symbolMatch, side, status, executedFrom, executedTo, sortBy and sortDirection, one ' +
    'page at a time, with the number of matching trades and pages. page counts from 1; pageSize is 1 to 100, default ' +
    '50. A page past the last is not an error: it has no items, and totalCount and totalPages are still given. The ' +
    'count and the page are read together, so they always agree. GET /trades itself is unchanged and lists every match.',
  querystring: ListTradePageQuery,
  response: {
    200: { description: 'The page, possibly with no trades.', content: { 'application/json': { schema: Type.Ref('TradePage') } } },
    400: problem(
      'One or more query parameters are invalid or repeated, including page and pageSize (type ' +
        'urn:trade-blotter:problem:invalid-query, with an errors map keyed by parameter).',
    ),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

const cancelTradeSchema = {
  tags: ['Trades'],
  operationId: 'cancelTrade',
  summary: 'Cancel a Pending trade',
  description:
    'Cancels a Pending trade, as Admin, in one transaction: the trade becomes Cancelled (updatedBy Admin, updatedAt the ' +
    'cancellation time) and a cancellation record is inserted, with its own id, originalTradeId naming the trade, the reason, and ' +
    'createdBy and updatedBy Admin. Both are written, or neither. Of concurrent requests for one trade, exactly one succeeds. ' +
    'The database audits both writes (auditBy System). Cancellations are never refused for the position limit.',
  params: Type.Object({ id: Type.String({ description: 'The id of the trade to cancel.' }) }),
  body: Type.Ref('CancellationRequest'),
  response: {
    201: { description: 'Cancelled: the logical trade and its cancellation record.', content: { 'application/json': { schema: Type.Ref('Cancellation') } } },
    400: problem('The body is not a JSON object, or the reason is missing or invalid (type urn:trade-blotter:problem:invalid-cancellation, with an errors map keyed by reason).'),
    404: problem('No trade has this id (type urn:trade-blotter:problem:trade-not-found).'),
    409: problem('The trade cannot be cancelled: it is Executed, it is already cancelled, or it is a cancellation record (type urn:trade-blotter:problem:invalid-transition). Nothing was written.'),
    415: problem('The body is not JSON: use application/json or a +json media type.'),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

const executeTradeSchema = {
  tags: ['Trades'],
  operationId: 'executeTrade',
  summary: 'Execute a Pending trade',
  description:
    'Executes a Pending trade, as User, in one transaction: the same trade becomes Executed, with executedAt and updatedAt the ' +
    'server clock, read once the database write lock is held, and updatedBy User; its id, booking sequence, economic fields, createdAt ' +
    'and createdBy are kept, and no record is added. No request body (or an empty JSON object): the time and the actor are the ' +
    'server\'s, and any member is refused. The trade is refused, and nothing written, if executing it would take its symbol\'s Executed ' +
    'net quantity to the position limit at any point in execution-time order. Of concurrent executions and cancellations of one trade, ' +
    'exactly one succeeds. The database audits the change (auditBy System). User is a label the server assigns, not an authenticated identity.',
  params: Type.Object({ id: Type.String({ description: 'The id of the trade to execute.' }) }),
  response: {
    200: { description: 'Executed: the trade as lists now show it.', content: { 'application/json': { schema: Type.Ref('Trade') } } },
    400: problem('The body is not empty or an empty JSON object, or is malformed (type urn:trade-blotter:problem:invalid-execution, with an errors map keyed by each member sent).'),
    404: problem('No trade has this id (type urn:trade-blotter:problem:trade-not-found).'),
    409: problem('The trade cannot be executed: it is already Executed, it is Cancelled, or it is a cancellation record (type ' +
      'urn:trade-blotter:problem:invalid-transition); or executing it would breach the position limit (type ' +
      'urn:trade-blotter:problem:position-limit, naming the symbol). Nothing was written.'),
    415: problem('The body is not JSON: use application/json or a +json media type.'),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

const tradeAuditSchema = {
  tags: ['Audit'],
  operationId: 'tradeAudit',
  summary: 'Read a trade\'s audit history',
  description:
    'Every write the database recorded for a trade, oldest first (auditId order), a page at a time, with a snapshot of every ' +
    'column of the physical row at that write. scope=trade (the default) lists the entries of the physical row the id names; ' +
    'scope=logical those of the logical trade: the original and its cancellation record, whichever of the two the id names. ' +
    'Read only: no endpoint writes, changes or removes an audit entry.',
  params: Type.Object({ id: Type.String({ description: 'A trade id: an ordinary trade or a cancellation record.' }) }),
  querystring: AuditQuery,
  response: {
    200: { description: 'The page, possibly with no entries.', content: { 'application/json': { schema: Type.Ref('AuditPage') } } },
    400: problem('scope, page or pageSize is invalid or repeated (type urn:trade-blotter:problem:invalid-query, with an errors map).'),
    404: problem('No trade has this id and no audit entry names it (type urn:trade-blotter:problem:trade-not-found).'),
    500: problem('An unexpected error. Logged by the server; the body has no detail.'),
  },
} satisfies FastifySchema

export interface TradeRoutesOptions {
  readonly tradeService: TradeService
}

/**
 * POST /trades, GET /trades, GET /trades/page, POST /trades/{id}/execution, POST
 * /trades/{id}/cancellation and GET /trades/{id}/audit. HTTP translation only: every rule lives in
 * the service and domain.
 */
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
    // As for the body: the schema documents the parameters, and the domain validates them.
    validatorCompiler: () => (query: unknown) => ({ value: query }),
    handler: async (request) => (await tradeService.listTrades(request.query as TradeQueryRequest)).map(toTradeResponse),
  })

  app.get('/trades/page', {
    schema: listTradePageSchema,
    validatorCompiler: () => (query: unknown) => ({ value: query }),
    handler: async (request) => toTradePageResponse(await tradeService.listTradePage(request.query as TradePageQueryRequest)),
  })

  app.post('/trades/:id/cancellation', {
    schema: cancelTradeSchema,
    // As for a booking: the body must be a JSON object; the reason is the domain's to judge.
    validatorCompiler: ({ httpPart }) => (value: unknown) => httpPart !== 'body' || isTradeRequestContainer.Check(value)
      ? { value }
      : { error: clientError('The request body must be a JSON object with a reason.') },
    handler: async (request, reply) => {
      const { id } = request.params as { readonly id: string }
      return reply.code(201).send(toCancellationResponse(await tradeService.cancelTrade(id, request.body)))
    },
  })

  app.post('/trades/:id/execution', {
    schema: executeTradeSchema,
    // The body is optional; the service refuses anything but nothing or an empty object.
    validatorCompiler: () => (value: unknown) => ({ value }),
    handler: async (request) => {
      const { id } = request.params as { readonly id: string }
      return toTradeResponse(await tradeService.executeTrade(id, request.body))
    },
  })

  app.get('/trades/:id/audit', {
    schema: tradeAuditSchema,
    validatorCompiler: () => (value: unknown) => ({ value }),
    handler: async (request) => {
      const { id } = request.params as { readonly id: string }
      return toAuditPageResponse(await tradeService.tradeAudit(id, request.query as Record<string, unknown>))
    },
  })

  return Promise.resolve()
}
