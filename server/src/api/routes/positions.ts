import type { FastifyPluginAsync, FastifySchema } from 'fastify'
import { Type } from 'typebox'

import type { PositionService } from '../../application/position-service.ts'
import { PROBLEM_CONTENT_TYPE } from '../problem-details.ts'
import { toPositionResponse } from '../responses.ts'

const listPositionsSchema = {
  tags: ['Positions'],
  operationId: 'listPositions',
  summary: 'List positions: Executed, Pending and Projected',
  description:
    'Derived from every trade on each request. Executed trades apply in executedAt order with bookingSequence breaking ties, ' +
    'giving the Executed Net and the average cost; Pending trades add up to the Pending Net; Projected Net is the two together. ' +
    'Cancelled trades and cancellation records count for nothing. A symbol is listed while its Executed or Pending Net is not ' +
    'zero, so a symbol with only Pending trades is listed; symbols are sorted in Unicode code-point order.',
  response: {
    200: { description: 'Every open position.', content: { 'application/json': { schema: Type.Array(Type.Ref('Position')) } } },
    500: {
      description: 'An unexpected error. Logged by the server; the body has no detail.',
      content: { [PROBLEM_CONTENT_TYPE]: { schema: Type.Ref('Problem') } },
    },
  },
} satisfies FastifySchema

export interface PositionRoutesOptions {
  readonly positionService: PositionService
}

/** GET /positions. */
export const positionRoutes: FastifyPluginAsync<PositionRoutesOptions> = (app, { positionService }) => {
  app.get('/positions', {
    schema: listPositionsSchema,
    handler: async () => (await positionService.listPositions()).map(toPositionResponse),
  })

  return Promise.resolve()
}
