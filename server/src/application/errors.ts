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
