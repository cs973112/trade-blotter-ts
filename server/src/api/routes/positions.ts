import type { FastifyPluginAsync, FastifySchema } from 'fastify'
import { Type } from 'typebox'

import type { PositionService } from '../../application/position-service.ts'
import { PROBLEM_CONTENT_TYPE } from '../problem-details.ts'
import { toPositionResponse } from '../responses.ts'

const listPositionsSchema = {
  tags: ['Positions'],
  operationId: 'listPositions',
  summary: 'List open positions',
  description:
    'Derived from every trade, applied in executedAt order with bookingSequence breaking ties. ' +
    'Flat positions are omitted; the rest are sorted by symbol in Unicode code-point order.',
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
