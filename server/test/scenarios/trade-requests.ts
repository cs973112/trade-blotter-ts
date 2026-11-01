/**
 * POST /trades request scenarios: what the API accepts, how it normalises what it accepts, and
 * which fields it names when it rejects. Every value is synthetic. The rules are defined in
 * docs/architecture.md ("Validation", "Numeric policy", "Timestamps").
 *
 * Bodies are raw JSON text so decimals reach the API exactly as written, never via a JS number.
 */
import type { Side } from './positions.ts'

export type TradeField = 'symbol' | 'side' | 'quantity' | 'price' | 'executedAt'

export interface Accepted {
  readonly status: 201
  readonly symbol: string
  readonly side: Side
  readonly quantity: string
  readonly price: string
  readonly notional: string
  /**
   * Canonical UTC execution time, or 'server clock' when the request omits it. `createdAt` and
   * `updatedAt` are not listed: they are always the server clock, whatever the request contains.
   */
  readonly executedAt: string
}

export interface Rejected {
  readonly status: 400
  /** Fields named in the problem's `errors` map, in order. Empty for a body that is not a JSON object. */
  readonly fields: readonly TradeField[]
}

export interface TradeRequestScenario {
  readonly name: string
  readonly body: string
  readonly expected: Accepted | Rejected
}

/** The default symbol length limit, in characters (code points). Configurable. */
export const SYMBOL_MAX_LENGTH = 64

const T0 = '2026-01-01T09:00:00Z'
const T0_UTC = '2026-01-01T09:00:00.000Z'

/** A JSON object whose member values are inserted verbatim; undefined members are left out. */
export function rawBody(members: Readonly<Record<string, string | undefined>>): string {
  const parts = Object.entries(members)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
  return `{${parts.join(',')}}`
}

const str = (text: string): string => JSON.stringify(text)

interface Members {
  readonly symbol?: string
  readonly side?: string
  readonly quantity?: string
  readonly price?: string
  readonly executedAt?: string
}

/** A valid trade body (ABC, Buy, 1 at 1, T0) with some members replaced by raw JSON text. */
function body(overrides: Members = {}): string {
  return rawBody({ symbol: str('ABC'), side: str('Buy'), quantity: '1', price: '1', executedAt: str(T0), ...overrides })
}

function accepted(fields: Partial<Omit<Accepted, 'status'>> = {}): Accepted {
  return { status: 201, symbol: 'ABC', side: 'Buy', quantity: '1', price: '1', notional: '1', executedAt: T0_UTC, ...fields }
}

const rejected = (...fields: TradeField[]): Rejected => ({ status: 400, fields })

const scenario = (name: string, requestBody: string, expected: Accepted | Rejected): TradeRequestScenario =>
  ({ name, body: requestBody, expected })

const BODY_SHAPE: readonly TradeRequestScenario[] = [
  scenario('a valid trade', body(), accepted()),
  scenario('no executedAt uses the server clock', rawBody({ symbol: str('ABC'), side: str('Buy'), quantity: '1', price: '1' }),
    accepted({ executedAt: 'server clock' })),
  scenario('null executedAt uses the server clock', body({ executedAt: 'null' }), accepted({ executedAt: 'server clock' })),
  scenario('client createdAt and updatedAt are ignored',
    body().replace('{', '{"createdAt":"2000-01-01T00:00:00Z","updatedAt":"2000-01-01T00:00:00Z",'), accepted()),
  scenario('invalid client createdAt and updatedAt are ignored', body().replace('{', '{"createdAt":123,"updatedAt":"x",'), accepted()),
  scenario('client createdAt does not stand in for executedAt',
    rawBody({ symbol: str('ABC'), side: str('Buy'), quantity: '1', price: '1', createdAt: str('2000-01-01T00:00:00Z') }),
    accepted({ executedAt: 'server clock' })),
  scenario('empty object names every required field', '{}', rejected('symbol', 'side', 'quantity', 'price')),
  scenario('every field invalid at once', body({ symbol: str(''), side: str('x'), quantity: '0', price: '0', executedAt: str('x') }),
    rejected('symbol', 'side', 'quantity', 'price', 'executedAt')),
  scenario('missing side', rawBody({ symbol: str('ABC'), quantity: '1', price: '1' }), rejected('side')),
  scenario('missing quantity', rawBody({ symbol: str('ABC'), side: str('Buy'), price: '1' }), rejected('quantity')),
  scenario('missing price', rawBody({ symbol: str('ABC'), side: str('Buy'), quantity: '1' }), rejected('price')),
  scenario('unknown members are ignored', body({}).replace('}', ',"extra":{"nested":true}}'), accepted()),
  scenario('property names are case-sensitive', rawBody({ SYMBOL: str('ABC'), SIDE: str('Buy'), QUANTITY: '1', PRICE: '1' }),
    rejected('symbol', 'side', 'quantity', 'price')),
  scenario('a differently cased duplicate is just an unknown member', body().replace('{', '{"Symbol":"OTHER",'), accepted()),
  scenario('an exact duplicate member: the last one wins', body().replace('{', '{"symbol":"FIRST",'), accepted()),
  scenario('quantity as a non-numeric string', body({ quantity: str('abc') }), rejected('quantity')),
  scenario('quantity null', body({ quantity: 'null' }), rejected('quantity')),
  scenario('price null', body({ price: 'null' }), rejected('price')),
  scenario('quantity boolean', body({ quantity: 'true' }), rejected('quantity')),
  scenario('quantity object', body({ quantity: '{}' }), rejected('quantity')),
  scenario('symbol number', body({ symbol: '123' }), rejected('symbol')),
  scenario('side number', body({ side: '1' }), rejected('side')),
  scenario('executedAt number', body({ executedAt: '123' }), rejected('executedAt')),
  scenario('body is an array', '[]', rejected()),
  scenario('body is null', 'null', rejected()),
  scenario('body is a string', '"trade"', rejected()),
  scenario('body is a number', '42', rejected()),
  scenario('malformed JSON', '{ not json', rejected()),
  scenario('trailing comma', body().replace('}', ',}'), rejected()),
  scenario('JSON comment', body().replace('{', '{ /* comment */ '), rejected()),
]

const SYMBOLS: readonly TradeRequestScenario[] = [
  scenario('symbol is trimmed and upper-cased', body({ symbol: str(' abc ') }), accepted()),
  scenario('symbol null', body({ symbol: 'null' }), rejected('symbol')),
  scenario('symbol only spaces', body({ symbol: str('   ') }), rejected('symbol')),
  scenario('symbol tabs and line breaks are trimmed', body({ symbol: str('\t msft \r\n') }), accepted({ symbol: 'MSFT' })),
  scenario('symbol no-break spaces are trimmed', body({ symbol: str('\u00a0nbsp\u00a0') }), accepted({ symbol: 'NBSP' })),
  scenario('symbol byte-order mark is trimmed', body({ symbol: str('\ufeffbom') }), accepted({ symbol: 'BOM' })),
  scenario('symbol inner space is kept', body({ symbol: str('brk b') }), accepted({ symbol: 'BRK B' })),
  scenario('symbol with a dot', body({ symbol: str('brk.b') }), accepted({ symbol: 'BRK.B' })),
  scenario('symbol with a hyphen and slash', body({ symbol: str('eur/usd-1') }), accepted({ symbol: 'EUR/USD-1' })),
  scenario('symbol sharp s upper-cases to SS', body({ symbol: str('straße') }), accepted({ symbol: 'STRASSE' })),
  scenario('symbol dotless i upper-cases to I', body({ symbol: str('ıbm') }), accepted({ symbol: 'IBM' })),
  scenario('symbol decomposed accent is composed', body({ symbol: str('cafe\u0301') }), accepted({ symbol: 'CAFÉ' })),
  scenario('symbol with other punctuation', body({ symbol: str('^gspc') }), accepted({ symbol: '^GSPC' })),
  scenario('symbol with a currency sign', body({ symbol: str('a$') }), accepted({ symbol: 'A$' })),
  scenario('symbol in a non-Latin script', body({ symbol: str('株式') }), accepted({ symbol: '株式' })),
  scenario('symbol at the default maximum length', body({ symbol: str('L'.repeat(SYMBOL_MAX_LENGTH)) }),
    accepted({ symbol: 'L'.repeat(SYMBOL_MAX_LENGTH) })),
  scenario('symbol one past the default maximum length', body({ symbol: str('L'.repeat(SYMBOL_MAX_LENGTH + 1)) }),
    rejected('symbol')),
  scenario('symbol length is counted after upper-casing', body({ symbol: str('ß'.repeat(SYMBOL_MAX_LENGTH / 2 + 1)) }),
    rejected('symbol')),
  scenario('symbol only a zero-width space', body({ symbol: str('\u200b') }), rejected('symbol')),
  scenario('symbol with an inner zero-width space', body({ symbol: str('ab\u200bc') }), rejected('symbol')),
  scenario('symbol with a control character', body({ symbol: str('\u0085nel') }), rejected('symbol')),
]

const SIDES: readonly TradeRequestScenario[] = [
  scenario('side Sell', body({ side: str('Sell') }), accepted({ side: 'Sell' })),
  scenario('side lower-case', body({ side: str('buy') }), accepted()),
  scenario('side upper-case', body({ side: str('SELL') }), accepted({ side: 'Sell' })),
  scenario('side padded', body({ side: str(' sell ') }), accepted({ side: 'Sell' })),
  scenario('side Hold', body({ side: str('Hold') }), rejected('side')),
  scenario('side abbreviation', body({ side: str('B') }), rejected('side')),
  scenario('side null', body({ side: 'null' }), rejected('side')),
  scenario('side empty', body({ side: str('') }), rejected('side')),
]

const DECIMALS: readonly TradeRequestScenario[] = [
  scenario('notional is exact', body({ quantity: '3', price: '101.25' }), accepted({ quantity: '3', price: '101.25', notional: '303.75' })),
  scenario('no floating-point error in the notional', body({ quantity: '0.1', price: '0.2' }),
    accepted({ quantity: '0.1', price: '0.2', notional: '0.02' })),
  scenario('numeric strings', body({ quantity: str('10'), price: str('100.50') }), accepted({ quantity: '10', price: '100.5', notional: '1005' })),
  scenario('exponent numbers', body({ quantity: '1e2', price: '1.50E+1' }), accepted({ quantity: '100', price: '15', notional: '1500' })),
  scenario('negative exponent', body({ quantity: '25e-1' }), accepted({ quantity: '2.5', notional: '2.5' })),
  scenario('exponent in a numeric string', body({ quantity: str('1e2') }), accepted({ quantity: '100', notional: '100' })),
  scenario('trailing zeros are dropped', body({ quantity: '10.500', price: '2.0' }), accepted({ quantity: '10.5', price: '2', notional: '21' })),
  scenario('trailing zeros do not count as decimal places', body({ quantity: '1.000000000000000' }), accepted()),
  scenario('more digits than a double holds', body({ quantity: '123456789012345.1234567891' }),
    accepted({ quantity: '123456789012345.1234567891', notional: '123456789012345.1234567891' })),
  scenario('largest quantity and price', body({ quantity: '999999999999999.9999999999', price: '999999999999999.9999999999' }),
    accepted({
      quantity: '999999999999999.9999999999',
      price: '999999999999999.9999999999',
      notional: '999999999999999999999999800000.00000000000000000001',
    })),
  scenario('smallest quantity and price', body({ quantity: '0.0000000001', price: '0.0000000001' }),
    accepted({ quantity: '0.0000000001', price: '0.0000000001', notional: '0.00000000000000000001' })),
  scenario('quantity of 10^15', body({ quantity: '1000000000000000' }), rejected('quantity')),
  scenario('price of 10^15 as an exponent', body({ price: '1e15' }), rejected('price')),
  scenario('quantity with eleven decimal places', body({ quantity: '0.00000000001' }), rejected('quantity')),
  scenario('quantity 1e400', body({ quantity: '1e400' }), rejected('quantity')),
  scenario('quantity 1e-400', body({ quantity: '1e-400' }), rejected('quantity')),
  scenario('quantity zero', body({ quantity: '0' }), rejected('quantity')),
  scenario('quantity zero with decimal places', body({ quantity: '0.000' }), rejected('quantity')),
  scenario('quantity negative zero', body({ quantity: '-0' }), rejected('quantity')),
  scenario('price negative', body({ price: '-1' }), rejected('price')),
  scenario('numeric string with spaces', body({ quantity: str(' 10 ') }), rejected('quantity')),
  scenario('numeric string with a plus sign', body({ quantity: str('+10') }), rejected('quantity')),
  scenario('numeric string with a thousands separator', body({ quantity: str('1,000') }), rejected('quantity')),
  scenario('numeric string with a leading zero', body({ quantity: str('01') }), rejected('quantity')),
  scenario('numeric string empty', body({ quantity: str('') }), rejected('quantity')),
]

/** [name, executedAt text, canonical UTC result or undefined when rejected]. */
const EXECUTED_AT_CASES: readonly (readonly [string, string, string | undefined])[] = [
  ['zero offset', '2026-01-01T09:00:00+00:00', T0_UTC],
  ['Z suffix', '2026-01-01T09:00:00Z', T0_UTC],
  ['positive offset', '2026-01-01T09:00:00+05:30', '2026-01-01T03:30:00.000Z'],
  ['negative offset', '2026-01-01T09:00:00-04:00', '2026-01-01T13:00:00.000Z'],
  ['same wall time, two offsets: first', '2026-11-01T01:30:00-04:00', '2026-11-01T05:30:00.000Z'],
  ['same wall time, two offsets: second', '2026-11-01T01:30:00-05:00', '2026-11-01T06:30:00.000Z'],
  ['offset crosses the date line', '2026-01-01T09:00:00+14:00', '2025-12-31T19:00:00.000Z'],
  ['one fraction digit', '2026-01-01T09:00:00.1Z', '2026-01-01T09:00:00.100Z'],
  ['three fraction digits', '2026-01-01T09:00:00.123Z', '2026-01-01T09:00:00.123Z'],
  ['lower-case separators', '2026-01-01t09:00:00z', T0_UTC],
  ['earliest instant', '0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
  ['latest instant', '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
  ['no offset', '2026-01-01T09:00:00', undefined],
  ['date only', '2026-01-01', undefined],
  ['no seconds', '2026-01-01T09:00Z', undefined],
  ['space separator', '2026-01-01 09:00:00Z', undefined],
  ['four fraction digits', '2026-01-01T09:00:00.1234Z', undefined],
  ['hour 24', '2026-01-01T24:00:00Z', undefined],
  ['leap second', '2026-06-30T23:59:60Z', undefined],
  ['day that does not exist', '2026-02-30T00:00:00Z', undefined],
  ['basic format', '20260101T090000Z', undefined],
  ['offset without colon', '2026-01-01T09:00:00+0530', undefined],
  ['hour-only offset', '2026-01-01T09:00:00+05', undefined],
  ['offset hour 24', '2026-01-01T09:00:00+24:00', undefined],
  ['not a date', 'not a date', undefined],
  ['empty string', '', undefined],
]

const EXECUTED_AT: readonly TradeRequestScenario[] = EXECUTED_AT_CASES.map(([name, text, utc]) =>
  scenario(`executedAt: ${name}`, body({ executedAt: str(text) }), utc === undefined ? rejected('executedAt') : accepted({ executedAt: utc })))

export const TRADE_REQUEST_SCENARIOS: readonly TradeRequestScenario[] = [
  ...BODY_SHAPE,
  ...SYMBOLS,
  ...SIDES,
  ...DECIMALS,
  ...EXECUTED_AT,
]
