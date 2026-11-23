import type { Dec } from './decimal.ts'
import { isUtcTimestamp, type UtcTimestamp } from './timestamp.ts'
import type { TradeSide, ValidTradeRequest } from './trade.ts'

/**
 * Trade lifecycle rules.
 *
 * Every record is a physical row of the trades table, a LifecycleTrade. A trade has a status,
 * Pending, Executed or Cancelled, and records which actor created and last changed it. A Pending
 * trade has no execution time; an Executed trade has one. Every new trade is booked Pending (M7);
 * the only transitions are Pending → Executed (executeTrade) and Pending → Cancelled (cancelTrade),
 * and Executed and Cancelled are final. Execution changes the trade's own row and adds none.
 * Trades Executed before M7 were booked as Executed and keep their execution time. A cancellation
 * makes two rows of one logical trade:
 *
 * - the original keeps its id, symbol, side, quantity, price, creation time and creator (User),
 *   and becomes Cancelled, last changed by Admin at the cancellation time;
 * - a new cancellation row, with an id of its own, names the original (originalTradeId), copies
 *   its economic fields, is Cancelled, carries the reason, and is created and last changed by
 *   Admin at the same time.
 *
 * Neither row counts towards positions. Actors are fixed by the operation, never read from a
 * request: bookings and executions are made by User, cancellations by Admin. The application has no
 * authentication: these are labels the server assigns to each operation, not identities anyone
 * proved.
 */

export const TRADE_STATUSES = ['Pending', 'Executed', 'Cancelled'] as const
export type TradeStatus = (typeof TRADE_STATUSES)[number]

/** Every booking is Pending: a trade becomes Executed only by being executed. */
export const BOOKING_STATUS = 'Pending' satisfies TradeStatus

export const ACTORS = ['User', 'Admin'] as const
export type Actor = (typeof ACTORS)[number]

/** Who each operation is performed by. Not configurable, and never read from a request. */
export const BOOKING_ACTOR: Actor = 'User'
export const EXECUTION_ACTOR: Actor = 'User'
export const CANCELLATION_ACTOR: Actor = 'Admin'

/** One physical row of the trades table, with its lifecycle. */
export interface LifecycleTrade {
  readonly id: string
  /** Assigned when the row is stored. */
  readonly bookingSequence: number
  readonly symbol: string
  readonly side: TradeSide
  readonly quantity: Dec
  readonly price: Dec
  readonly status: TradeStatus
  /** Set exactly when the status is Executed; null for Pending and Cancelled rows. */
  readonly executedAt: UtcTimestamp | null
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
  readonly createdBy: Actor
  readonly updatedBy: Actor
  /** The cancelled original, on a cancellation row only; null on every other row. */
  readonly originalTradeId: string | null
  /** Why the original was cancelled, on a cancellation row only; null on every other row. */
  readonly cancellationReason: string | null
}

/**
 * A trade as the trade lists show it: one entry per logical trade. It is the original row (Pending,
 * Executed, or Cancelled once cancelled), never a cancellation row; a cancelled trade carries what
 * its cancellation row records.
 */
export interface ListedTrade extends LifecycleTrade {
  readonly cancellation: { readonly id: string; readonly reason: string; readonly cancelledAt: UtcTimestamp; readonly cancelledBy: Actor } | null
}

/** A row that has not been stored yet, and so has no booking sequence. */
export type NewLifecycleTrade = Omit<LifecycleTrade, 'bookingSequence'>

/** A cancellation row: the record of a cancellation, not a trade of its own. */
export const isCancellationRecord = (trade: Pick<LifecycleTrade, 'originalTradeId'>): boolean => trade.originalTradeId !== null

export type BookingStatus = typeof BOOKING_STATUS

export type BookingStatusResult =
  | { readonly ok: true; readonly value: BookingStatus }
  | { readonly ok: false; readonly message: string }

/**
 * The status a booking request names: omitted (or null) and Pending, read ignoring case and
 * surrounding whitespace as sides are, are Pending. Executed and Cancelled are refused: a trade
 * becomes Executed only by being executed, and Cancelled only by being cancelled. Anything else is
 * refused.
 */
export function validateBookingStatus(input: unknown): BookingStatusResult {
  if (input === undefined || input === null) return { ok: true, value: BOOKING_STATUS }
  const text = typeof input === 'string' ? input.trim().toLowerCase() : undefined
  if (text === 'pending') return { ok: true, value: BOOKING_STATUS }
  if (text === 'executed') return { ok: false, message: 'A trade cannot be booked as Executed: it is booked as Pending, then executed (POST /trades/{id}/execution).' }
  if (text === 'cancelled') return { ok: false, message: 'A trade cannot be booked as Cancelled.' }
  return { ok: false, message: 'Status must be Pending, or omitted.' }
}

/**
 * A new booking from a validated request, by User at `now`: always Pending, with no execution time.
 * `now` is its createdAt and updatedAt.
 */
export function bookTrade(request: Pick<ValidTradeRequest, 'symbol' | 'side' | 'quantity' | 'price'>, assigned: { readonly id: string; readonly now: UtcTimestamp }): NewLifecycleTrade {
  return Object.freeze({
    id: assigned.id, symbol: request.symbol, side: request.side, quantity: request.quantity, price: request.price, status: BOOKING_STATUS,
    executedAt: null, createdAt: assigned.now, updatedAt: assigned.now, createdBy: BOOKING_ACTOR, updatedBy: BOOKING_ACTOR,
    originalTradeId: null, cancellationReason: null,
  })
}

export type ExecutionProblem = 'cancellation-record' | 'already-executed' | 'already-cancelled' | 'invalid-trade' | 'invalid-time'

export type ExecutionResult =
  | { readonly ok: true; readonly trade: LifecycleTrade }
  | { readonly ok: false; readonly problem: ExecutionProblem; readonly message: string }

/**
 * Executes a Pending trade at `now`: the same row, now Executed, with `now` as its execution time
 * and its updatedAt, last changed by User; its id, booking sequence, economic fields, createdAt and
 * creator are kept. No row is added. Refused, in this order: a cancellation row, a trade already
 * Executed (a trade is executed once), a Cancelled trade, a row that breaks the lifecycle rules,
 * and a time that is not canonical UTC or is before the trade last changed. Never throws for
 * these. The caller checks the position limit and writes the row only while it is still Pending.
 */
export function executeTrade(trade: LifecycleTrade, assigned: { readonly now: UtcTimestamp }): ExecutionResult {
  if (isCancellationRecord(trade)) return { ok: false, problem: 'cancellation-record', message: `${trade.id} records a cancellation; it cannot be executed.` }
  if (trade.status === 'Executed') return { ok: false, problem: 'already-executed', message: `Trade ${trade.id} is already executed.` }
  if (trade.status === 'Cancelled') return { ok: false, problem: 'already-cancelled', message: `Trade ${trade.id} is cancelled; only a Pending trade can be executed.` }
  const problems = lifecycleProblems(trade)
  if (problems.length > 0) return { ok: false, problem: 'invalid-trade', message: `Trade ${trade.id} breaks the lifecycle rules: ${problems.join(' ')}` }
  if (!isUtcTimestamp(assigned.now) || assigned.now < trade.updatedAt) {
    return { ok: false, problem: 'invalid-time', message: `The execution time ${String(assigned.now)} must be canonical UTC, not before the trade last changed (${trade.updatedAt}).` }
  }
  return { ok: true, trade: Object.freeze({ ...trade, status: 'Executed', executedAt: assigned.now, updatedAt: assigned.now, updatedBy: EXECUTION_ACTOR }) }
}

/** Longest cancellation reason accepted, in code points. */
export const CANCELLATION_REASON_MAX_LENGTH = 500

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export type ReasonResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }

/** A cancellation reason: required, trimmed, NFC, at most CANCELLATION_REASON_MAX_LENGTH code points, no control or invisible characters. */
export function validateCancellationReason(input: unknown): ReasonResult {
  if (input === undefined || input === null) return { ok: false, message: 'Reason is required.' }
  if (typeof input !== 'string') return { ok: false, message: 'Reason must be a string.' }
  const value = input.trim().normalize('NFC')
  if (value === '') return { ok: false, message: 'Reason is required.' }
  if (CONTROL.test(value)) return { ok: false, message: 'Reason must not contain control or invisible characters.' }
  if (Array.from(value).length > CANCELLATION_REASON_MAX_LENGTH) return { ok: false, message: `Reason must be at most ${String(CANCELLATION_REASON_MAX_LENGTH)} characters.` }
  return { ok: true, value }
}

export type CancellationProblem =
  | 'cancellation-record' | 'already-cancelled' | 'not-pending' | 'invalid-trade' | 'invalid-reason' | 'same-id' | 'invalid-time'

export type CancellationResult =
  | { readonly ok: true; readonly original: LifecycleTrade; readonly cancellation: NewLifecycleTrade }
  | { readonly ok: false; readonly problem: CancellationProblem; readonly message: string }

/**
 * Cancels a Pending trade at `now`: the original updated, and the cancellation row to insert, as
 * described above. Refused, in this order: a cancellation row (it records a cancellation and is
 * not a trade), a trade already Cancelled (a trade is cancelled once), an Executed trade (only a
 * Pending trade can be cancelled), a row that breaks the lifecycle rules, an invalid reason, a new
 * id equal to the original's, and a time that is not canonical UTC or is before the original last
 * changed. Never throws for these. The caller writes both rows in one transaction, or neither, and
 * also refuses a second cancellation row for the same original (M3: a unique constraint).
 */
export function cancelTrade(
  trade: LifecycleTrade,
  request: { readonly reason?: unknown },
  assigned: { readonly id: string; readonly now: UtcTimestamp },
): CancellationResult {
  if (isCancellationRecord(trade)) return { ok: false, problem: 'cancellation-record', message: `${trade.id} records a cancellation; it cannot itself be cancelled.` }
  if (trade.status === 'Cancelled') return { ok: false, problem: 'already-cancelled', message: `Trade ${trade.id} is already cancelled.` }
  if (trade.status !== 'Pending') return { ok: false, problem: 'not-pending', message: `Trade ${trade.id} is Executed; only a Pending trade can be cancelled.` }
  const problems = lifecycleProblems(trade)
  if (problems.length > 0) return { ok: false, problem: 'invalid-trade', message: `Trade ${trade.id} breaks the lifecycle rules: ${problems.join(' ')}` }
  const reason = validateCancellationReason(request.reason)
  if (!reason.ok) return { ok: false, problem: 'invalid-reason', message: reason.message }
  if (assigned.id === trade.id) return { ok: false, problem: 'same-id', message: 'A cancellation row needs an id of its own.' }
  if (!isUtcTimestamp(assigned.now) || assigned.now < trade.updatedAt) {
    return { ok: false, problem: 'invalid-time', message: `The cancellation time ${String(assigned.now)} must be canonical UTC, not before the trade last changed (${trade.updatedAt}).` }
  }
  return {
    ok: true,
    original: Object.freeze({ ...trade, status: 'Cancelled', updatedBy: CANCELLATION_ACTOR, updatedAt: assigned.now }),
    cancellation: Object.freeze({
      symbol: trade.symbol, side: trade.side, quantity: trade.quantity, price: trade.price, id: assigned.id, status: 'Cancelled', executedAt: null,
      createdAt: assigned.now, updatedAt: assigned.now, createdBy: CANCELLATION_ACTOR, updatedBy: CANCELLATION_ACTOR,
      originalTradeId: trade.id, cancellationReason: reason.value,
    }),
  }
}

/**
 * What a row breaks of the lifecycle rules (none when it is valid); the rules M3's CHECK
 * constraints will hold the table to:
 * - Executed: a canonical UTC execution time; Pending and Cancelled: none;
 * - an ordinary trade (no originalTradeId) has no reason and was created by User;
 * - a cancellation row is Cancelled, has a reason, an original other than itself, and was
 *   created and last changed by Admin at one time;
 * - updatedAt is not before createdAt, both canonical UTC;
 * - actors are User or Admin, statuses one of the three.
 */
export function lifecycleProblems(trade: NewLifecycleTrade): string[] {
  const problems: string[] = []
  if (!(TRADE_STATUSES as readonly string[]).includes(trade.status)) problems.push(`Unknown status ${trade.status}.`)
  for (const [field, actor] of [['createdBy', trade.createdBy], ['updatedBy', trade.updatedBy]] as const) {
    if (!(ACTORS as readonly string[]).includes(actor)) problems.push(`${field} must be User or Admin.`)
  }
  if (trade.status === 'Executed') {
    if (trade.executedAt === null || !isUtcTimestamp(trade.executedAt)) problems.push('An Executed trade needs a canonical UTC execution time.')
  } else if (trade.executedAt !== null) {
    problems.push(`A ${trade.status} row has no execution time.`)
  }
  if (!isUtcTimestamp(trade.createdAt) || !isUtcTimestamp(trade.updatedAt)) problems.push('createdAt and updatedAt must be canonical UTC.')
  else if (trade.updatedAt < trade.createdAt) problems.push('updatedAt must not be before createdAt.')
  if (trade.originalTradeId === null) {
    if (trade.cancellationReason !== null) problems.push('Only a cancellation row has a reason.')
    if (trade.createdBy !== BOOKING_ACTOR) problems.push('An ordinary trade is created by User.')
  } else {
    if (trade.originalTradeId === trade.id) problems.push('A cancellation row cannot name itself as the original.')
    if (trade.status !== 'Cancelled') problems.push('A cancellation row is Cancelled.')
    if (trade.cancellationReason === null || !validateCancellationReason(trade.cancellationReason).ok) problems.push('A cancellation row has a valid reason.')
    if (trade.createdBy !== CANCELLATION_ACTOR || trade.updatedBy !== CANCELLATION_ACTOR) problems.push('A cancellation row is created and last changed by Admin.')
    if (trade.createdAt !== trade.updatedAt) problems.push('A cancellation row is created and last changed at one time.')
  }
  return problems
}
