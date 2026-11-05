import type { QueryErrors } from '../domain/trade-query.ts'
import type { FieldErrors } from '../domain/trade.ts'

/** A trade request had invalid fields. Carries a message list for every invalid field. */
export class TradeValidationError extends Error {
  readonly errors: FieldErrors

  constructor(errors: FieldErrors) {
    super(Object.values(errors)[0]?.[0] ?? 'The trade is invalid.')
    this.name = 'TradeValidationError'
    this.errors = errors
  }
}

/** A request to list trades had invalid query parameters. Carries a message list for every invalid parameter. */
export class TradeQueryValidationError extends Error {
  readonly errors: QueryErrors

  constructor(errors: QueryErrors) {
    super(Object.values(errors)[0]?.[0] ?? 'The query is invalid.')
    this.name = 'TradeQueryValidationError'
    this.errors = errors
  }
}
