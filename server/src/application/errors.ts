import type { AuditQueryErrors, QueryErrors } from '../domain/trade-query.ts'
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

/** No trade has the id a request names. */
export class TradeNotFoundError extends Error {
  readonly tradeId: string

  constructor(tradeId: string) {
    super(`No trade has the id ${tradeId}.`)
    this.name = 'TradeNotFoundError'
    this.tradeId = tradeId
  }
}

/** A cancellation request is invalid: its body, or its reason. Carries the messages by field. */
export class CancellationValidationError extends Error {
  readonly errors: Readonly<Record<string, readonly string[]>>

  constructor(errors: Readonly<Record<string, readonly string[]>>) {
    super(Object.values(errors)[0]?.[0] ?? 'The cancellation is invalid.')
    this.name = 'CancellationValidationError'
    this.errors = errors
  }
}

/** An execution request is invalid: its body is not a JSON object, or has members (the server sets everything). */
export class ExecutionValidationError extends Error {
  readonly errors: Readonly<Record<string, readonly string[]>>

  constructor(message: string, errors: Readonly<Record<string, readonly string[]>> = {}) {
    super(message)
    this.name = 'ExecutionValidationError'
    this.errors = errors
  }
}

/**
 * A trade cannot make the transition asked of it: only a Pending trade can be cancelled or
 * executed, so an Executed or Cancelled trade, or a cancellation row, cannot. `reason` names which.
 */
export class TradeStateError extends Error {
  readonly reason: 'not-pending' | 'already-cancelled' | 'already-executed' | 'cancellation-record'
  readonly tradeId: string

  constructor(tradeId: string, reason: TradeStateError['reason'], message: string) {
    super(message)
    this.name = 'TradeStateError'
    this.tradeId = tradeId
    this.reason = reason
  }
}

/**
 * Executing the trade would take its symbol's Executed position to the position limit: a conflict
 * with the trades already executed, not an invalid request (a booking that would breach the limit
 * is a PositionLimitError, 400). Nothing was written.
 */
export class ExecutionLimitError extends Error {
  readonly tradeId: string
  readonly symbol: string

  constructor(tradeId: string, symbol: string, message: string) {
    super(message)
    this.name = 'ExecutionLimitError'
    this.tradeId = tradeId
    this.symbol = symbol
  }
}

/** A request for a trade's audit trail had invalid query parameters. */
export class AuditQueryValidationError extends Error {
  readonly errors: AuditQueryErrors

  constructor(errors: AuditQueryErrors) {
    super(Object.values(errors)[0]?.[0] ?? 'The query is invalid.')
    this.name = 'AuditQueryValidationError'
    this.errors = errors
  }
}
