import { describe, expect, it } from 'vitest'

import { Dec } from '../../src/domain/decimal.ts'
import type { UtcTimestamp } from '../../src/domain/timestamp.ts'
import type { ValidTradeRequest } from '../../src/domain/trade.ts'
import {
  ACTORS, BOOKING_ACTOR, BOOKING_STATUS, bookTrade, CANCELLATION_ACTOR, CANCELLATION_REASON_MAX_LENGTH, cancelTrade, EXECUTION_ACTOR, executeTrade,
  isCancellationRecord, lifecycleProblems, TRADE_STATUSES, validateBookingStatus, validateCancellationReason, type LifecycleTrade,
} from '../../src/domain/trade-status.ts'
import { utc } from '../support/trades.ts'

/**
 * Trade lifecycle rules (src/domain/trade-status.ts): statuses, fixed actors, Pending-only
 * bookings, execution of the trade's own row, and cancellation as two rows of the trades table (the
 * original updated, a cancellation row inserted). Pure functions; nothing is stored.
 */

const BOOKED = utc('2026-01-05T14:00:00.000Z')
const NOW = utc('2026-02-01T10:00:00.000Z')

/** A stored Pending trade booked by User, with overrides. */
const row = (overrides: Partial<LifecycleTrade> = {}): LifecycleTrade => ({
  id: 'original-1', bookingSequence: 7, symbol: 'MSFT', side: 'Sell', quantity: new Dec('12.5'), price: new Dec('301.25'),
  status: 'Pending', executedAt: null, createdAt: BOOKED, updatedAt: BOOKED, createdBy: 'User', updatedBy: 'User',
  originalTradeId: null, cancellationReason: null, ...overrides,
})
const executed = (overrides: Partial<LifecycleTrade> = {}): LifecycleTrade => row({ status: 'Executed', executedAt: utc('2026-01-05T13:59:00.000Z'), ...overrides })
const request = (): ValidTradeRequest => ({ symbol: 'MSFT', side: 'Buy', quantity: new Dec('1'), price: new Dec('2'), status: 'Pending' })

function cancelled(trade: LifecycleTrade = row()) {
  const result = cancelTrade(trade, { reason: 'Client withdrew the order' }, { id: 'cancel-1', now: NOW })
  if (!result.ok) throw new Error(result.message)
  return result
}

describe('domain: statuses and actors', () => {
  it('has exactly three statuses and two actors, books as Pending, and executes as User', () => {
    expect(TRADE_STATUSES).toEqual(['Pending', 'Executed', 'Cancelled'])
    expect(ACTORS).toEqual(['User', 'Admin'])
    expect(BOOKING_STATUS).toBe('Pending')
    expect([BOOKING_ACTOR, EXECUTION_ACTOR, CANCELLATION_ACTOR]).toEqual(['User', 'User', 'Admin'])
  })
})

describe('domain: the status a booking names', () => {
  it('is Pending when omitted or null, and Pending in any case', () => {
    expect(validateBookingStatus(undefined)).toEqual({ ok: true, value: 'Pending' })
    expect(validateBookingStatus(null)).toEqual({ ok: true, value: 'Pending' })
    for (const input of ['Pending', 'pending', ' PENDING ']) expect(validateBookingStatus(input), input).toEqual({ ok: true, value: 'Pending' })
  })

  it('refuses Executed and Cancelled: a trade reaches them only by being executed or cancelled', () => {
    for (const input of ['Executed', 'executed', ' EXECUTED ']) {
      expect(validateBookingStatus(input), input).toEqual({ ok: false, message: 'A trade cannot be booked as Executed: it is booked as Pending, then executed (POST /trades/{id}/execution).' })
    }
    for (const input of ['Cancelled', 'cancelled', ' CANCELLED']) expect(validateBookingStatus(input), input).toEqual({ ok: false, message: 'A trade cannot be booked as Cancelled.' })
  })

  it('refuses anything that is not a status', () => {
    for (const input of ['', ' ', 'Filled', 'Canceled', 'Pending,Executed', 1, true, {}, []]) {
      expect(validateBookingStatus(input), JSON.stringify(input)).toEqual({ ok: false, message: 'Status must be Pending, or omitted.' })
    }
  })
})

describe('domain: booking', () => {
  it('books a Pending trade with no execution time, by User, as an ordinary trade', () => {
    const booked = bookTrade(request(), { id: 't1', now: NOW })

    expect(booked).toEqual({
      id: 't1', symbol: 'MSFT', side: 'Buy', quantity: new Dec('1'), price: new Dec('2'), status: 'Pending', executedAt: null,
      createdAt: NOW, updatedAt: NOW, createdBy: 'User', updatedBy: 'User', originalTradeId: null, cancellationReason: null,
    })
    expect(lifecycleProblems(booked)).toEqual([])
    expect(Object.isFrozen(booked)).toBe(true)
  })
})

describe('domain: execution', () => {
  const LATER = utc('2026-02-01T10:00:00.123Z')

  it('executes a Pending trade: the same row, Executed at the time given, last changed by User then', () => {
    const before = row()
    const result = executeTrade(before, { now: LATER })

    expect(result).toEqual({ ok: true, trade: { ...before, status: 'Executed', executedAt: LATER, updatedAt: LATER, updatedBy: 'User' } })
    if (!result.ok) return
    // Its identity, booking sequence, economic fields, creation time and creator are kept.
    for (const field of ['id', 'bookingSequence', 'symbol', 'side', 'quantity', 'price', 'createdAt', 'createdBy', 'originalTradeId', 'cancellationReason'] as const) {
      expect(result.trade[field], field).toEqual(before[field])
    }
    expect(lifecycleProblems(result.trade)).toEqual([])
    expect(Object.isFrozen(result.trade)).toBe(true)
  })

  it('executes at the very time the trade last changed, but not before it', () => {
    expect(executeTrade(row(), { now: BOOKED }).ok).toBe(true)
    expect(executeTrade(row(), { now: utc('2026-01-05T13:59:59.999Z') })).toMatchObject({ ok: false, problem: 'invalid-time' })
  })

  it('refuses a time that is not canonical UTC', () => {
    for (const now of ['2026-02-01T10:00:00Z', '2026-02-01T05:00:00.000-05:00', 'now', '']) {
      expect(executeTrade(row(), { now: now as never }), now).toMatchObject({ ok: false, problem: 'invalid-time' })
    }
  })

  it('refuses a trade already Executed, a Cancelled trade and a cancellation row: Executed and Cancelled are final', () => {
    expect(executeTrade(executed(), { now: LATER })).toEqual({ ok: false, problem: 'already-executed', message: 'Trade original-1 is already executed.' })
    const { original, cancellation } = cancelled()
    expect(executeTrade(original, { now: LATER })).toEqual({ ok: false, problem: 'already-cancelled', message: 'Trade original-1 is cancelled; only a Pending trade can be executed.' })
    expect(executeTrade({ ...cancellation, bookingSequence: 8 }, { now: LATER })).toEqual({ ok: false, problem: 'cancellation-record', message: 'cancel-1 records a cancellation; it cannot be executed.' })
  })

  it('refuses a row that breaks the lifecycle rules', () => {
    expect(executeTrade(row({ executedAt: BOOKED }), { now: LATER })).toMatchObject({ ok: false, problem: 'invalid-trade' })
  })

  it('cannot be followed by a cancellation, nor a cancellation by an execution', () => {
    const result = executeTrade(row(), { now: LATER })
    if (!result.ok) throw new Error(result.message)
    expect(cancelTrade(result.trade, { reason: 'Too late' }, { id: 'cancel-2', now: utc('2026-02-02T00:00:00.000Z') })).toMatchObject({ ok: false, problem: 'not-pending' })
  })
})

describe('domain: the cancellation reason', () => {
  it('is required, trimmed and normalised', () => {
    expect(validateCancellationReason('  Booked twice  ')).toEqual({ ok: true, value: 'Booked twice' })
    expect(validateCancellationReason('Café')).toEqual({ ok: true, value: 'Café' })
    for (const input of [undefined, null, '', '   ']) expect(validateCancellationReason(input), String(input)).toEqual({ ok: false, message: 'Reason is required.' })
    expect(validateCancellationReason(42)).toEqual({ ok: false, message: 'Reason must be a string.' })
  })

  it('refuses control and invisible characters, and more than the maximum length in code points', () => {
    for (const input of ['a\u0000b', 'a\nb', 'a​b', 'a b']) {
      expect(validateCancellationReason(input), JSON.stringify(input)).toEqual({ ok: false, message: 'Reason must not contain control or invisible characters.' })
    }
    expect(validateCancellationReason('x'.repeat(CANCELLATION_REASON_MAX_LENGTH)).ok).toBe(true)
    // 500 emoji are 1,000 UTF-16 units but 500 code points: accepted.
    expect(validateCancellationReason('😀'.repeat(CANCELLATION_REASON_MAX_LENGTH)).ok).toBe(true)
    expect(validateCancellationReason('x'.repeat(CANCELLATION_REASON_MAX_LENGTH + 1))).toEqual({ ok: false, message: 'Reason must be at most 500 characters.' })
  })
})

describe('domain: cancelling a Pending trade', () => {
  it('updates the original: Cancelled, last changed by Admin at the cancellation time, everything else kept', () => {
    const trade = row()

    const { original } = cancelled(trade)

    expect(original).toEqual({ ...trade, status: 'Cancelled', updatedBy: 'Admin', updatedAt: NOW })
    expect(original).toMatchObject({ id: 'original-1', bookingSequence: 7, symbol: 'MSFT', side: 'Sell', createdAt: BOOKED, createdBy: 'User', executedAt: null, originalTradeId: null, cancellationReason: null })
    expect(Object.isFrozen(original)).toBe(true)
  })

  it('inserts a cancellation row: its own id, naming the original, the economic fields copied, Cancelled, by Admin, with the reason', () => {
    const { cancellation } = cancelled()

    expect(cancellation).toEqual({
      id: 'cancel-1', symbol: 'MSFT', side: 'Sell', quantity: new Dec('12.5'), price: new Dec('301.25'), status: 'Cancelled', executedAt: null,
      createdAt: NOW, updatedAt: NOW, createdBy: 'Admin', updatedBy: 'Admin', originalTradeId: 'original-1', cancellationReason: 'Client withdrew the order',
    })
    // Not yet stored: the table gives it a booking sequence of its own.
    expect('bookingSequence' in cancellation).toBe(false)
    expect(isCancellationRecord(cancellation)).toBe(true)
    expect(Object.isFrozen(cancellation)).toBe(true)
  })

  it('gives both rows one canonical UTC cancellation time, and both satisfy the lifecycle rules', () => {
    const { original, cancellation } = cancelled()

    expect([original.updatedAt, cancellation.createdAt, cancellation.updatedAt]).toEqual([NOW, NOW, NOW])
    expect(original.createdAt).toBe(BOOKED)
    expect(lifecycleProblems(original)).toEqual([])
    expect(lifecycleProblems(cancellation)).toEqual([])
  })

  it('refuses a time that is not canonical UTC, or is before the original last changed; the same instant is allowed', () => {
    const trade = row({ updatedAt: NOW })

    for (const now of ['2026-02-01T10:00:00Z', '2026-02-01T11:00:00+01:00', '2026-02-01 10:00:00.000Z', '']) {
      expect(cancelTrade(trade, { reason: 'x' }, { id: 'c', now: now as UtcTimestamp }), now).toMatchObject({ ok: false, problem: 'invalid-time' })
    }
    expect(cancelTrade(trade, { reason: 'x' }, { id: 'c', now: utc('2026-02-01T09:59:59.999Z') })).toMatchObject({ ok: false, problem: 'invalid-time' })
    expect(cancelTrade(trade, { reason: 'x' }, { id: 'c', now: NOW }).ok).toBe(true)
  })

  it('refuses an invalid reason and a row id equal to the original\'s', () => {
    expect(cancelTrade(row(), {}, { id: 'c', now: NOW })).toEqual({ ok: false, problem: 'invalid-reason', message: 'Reason is required.' })
    expect(cancelTrade(row(), { reason: 'x' }, { id: 'original-1', now: NOW })).toMatchObject({ ok: false, problem: 'same-id' })
  })

  it('takes the actor from the operation, never from the request', () => {
    const result = cancelTrade(row(), { reason: 'x', updatedBy: 'User', createdBy: 'User', actor: 'User' } as { reason: string }, { id: 'c', now: NOW })

    if (!result.ok) throw new Error(result.message)
    expect([result.original.updatedBy, result.cancellation.createdBy, result.cancellation.updatedBy]).toEqual(['Admin', 'Admin', 'Admin'])
  })

  it('leaves the trade it is given unchanged', () => {
    const trade = row()
    const before = { ...trade }

    cancelled(trade)

    expect(trade).toEqual(before)
  })
})

describe('domain: what cannot be cancelled', () => {
  it('only a Pending original: an Executed trade is refused', () => {
    expect(cancelTrade(executed(), { reason: 'x' }, { id: 'c', now: NOW }))
      .toEqual({ ok: false, problem: 'not-pending', message: 'Trade original-1 is Executed; only a Pending trade can be cancelled.' })
  })

  it('a cancellation row is refused: it records a cancellation and is not a trade', () => {
    const { cancellation } = cancelled()

    expect(cancelTrade({ ...cancellation, bookingSequence: 8 }, { reason: 'x' }, { id: 'c2', now: NOW }))
      .toEqual({ ok: false, problem: 'cancellation-record', message: 'cancel-1 records a cancellation; it cannot itself be cancelled.' })
  })

  it('a second cancellation of the same original is refused', () => {
    const { original } = cancelled()

    expect(cancelTrade(original, { reason: 'again' }, { id: 'cancel-2', now: NOW }))
      .toEqual({ ok: false, problem: 'already-cancelled', message: 'Trade original-1 is already cancelled.' })
  })

  it('a row that breaks the lifecycle rules is refused, not cancelled', () => {
    expect(cancelTrade(row({ executedAt: BOOKED }), { reason: 'x' }, { id: 'c', now: NOW })).toMatchObject({ ok: false, problem: 'invalid-trade' })
  })
})

describe('domain: the lifecycle rules for a row', () => {
  it('holds Pending and Cancelled rows to no execution time, and Executed ones to a canonical UTC one', () => {
    expect(lifecycleProblems(row())).toEqual([])
    expect(lifecycleProblems(executed())).toEqual([])
    expect(lifecycleProblems(row({ executedAt: BOOKED }))).toEqual(['A Pending row has no execution time.'])
    expect(lifecycleProblems(row({ status: 'Cancelled', executedAt: BOOKED }))).toEqual(['A Cancelled row has no execution time.'])
    expect(lifecycleProblems(executed({ executedAt: null }))).toEqual(['An Executed trade needs a canonical UTC execution time.'])
    expect(lifecycleProblems(executed({ executedAt: '2026-01-01T09:00:00Z' as UtcTimestamp }))).toEqual(['An Executed trade needs a canonical UTC execution time.'])
  })

  it('gives an ordinary trade no original and no reason, created by User', () => {
    expect(lifecycleProblems(row({ cancellationReason: 'why' }))).toEqual(['Only a cancellation row has a reason.'])
    expect(lifecycleProblems(row({ createdBy: 'Admin' }))).toEqual(['An ordinary trade is created by User.'])
  })

  it('holds a cancellation row to Cancelled, a valid reason, another original, Admin and one time', () => {
    const { cancellation } = cancelled()

    expect(lifecycleProblems({ ...cancellation, status: 'Pending' })).toEqual(['A cancellation row is Cancelled.'])
    expect(lifecycleProblems({ ...cancellation, cancellationReason: null })).toEqual(['A cancellation row has a valid reason.'])
    expect(lifecycleProblems({ ...cancellation, originalTradeId: 'cancel-1' })).toEqual(['A cancellation row cannot name itself as the original.'])
    expect(lifecycleProblems({ ...cancellation, createdBy: 'User' })).toEqual(['A cancellation row is created and last changed by Admin.'])
    expect(lifecycleProblems({ ...cancellation, updatedAt: utc('2026-02-01T10:00:01.000Z') })).toEqual(['A cancellation row is created and last changed at one time.'])
  })

  it('refuses unknown statuses and actors, and an update before creation', () => {
    expect(lifecycleProblems(row({ status: 'Filled' as LifecycleTrade['status'] }))).toContain('Unknown status Filled.')
    expect(lifecycleProblems(row({ updatedBy: 'System' as LifecycleTrade['updatedBy'] }))).toContain('updatedBy must be User or Admin.')
    expect(lifecycleProblems(row({ updatedAt: utc('2026-01-05T13:00:00.000Z') }))).toEqual(['updatedAt must not be before createdAt.'])
  })
})
