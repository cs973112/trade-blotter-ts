import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createTestDatabase, rawRows } from '../support/database.ts'

/**
 * The CHECK, NOT NULL and UNIQUE constraints reject rows the repository would never write. These
 * tests insert directly in SQL, bypassing the repository, as a faulty writer or a manual edit would.
 */

const T = '2026-01-01T09:00:00.000Z'
const VALID = { id: 'x', symbol: 'ABC', side: 'Buy', quantity: '1', price: '1', executed_at: T, created_at: T, updated_at: T }
type Row = Record<keyof typeof VALID, string | number | Uint8Array | null>

let database: ReturnType<typeof createTestDatabase>
let db: Database

beforeEach(() => {
  database = createTestDatabase()
  db = database.open()
})

afterEach(() => {
  database.dispose()
})

function insert(overrides: Partial<Row>): void {
  const row: Row = { ...VALID, ...overrides }
  db.$client
    .prepare('insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(...Object.values(row))
}

describe('infrastructure: database constraints', () => {
  it.each<[string, Partial<Row>]>([
    ['a valid row', {}],
    ['a fractional decimal', { quantity: '0.5', price: '101.25' }],
    ['the largest input values', { quantity: '999999999999999.9999999999', price: '999999999999999.9999999999' }],
    ['a value beyond the business input range, which the domain enforces', { quantity: '999999999999999000000000000001' }],
    ['a non-Latin symbol', { symbol: '株式' }],
    ['updatedAt later than createdAt', { updated_at: '2026-01-02T00:00:00.000Z' }],
  ])('accepts %s', (_name, overrides) => {
    insert(overrides)

    expect(rawRows(db)).toHaveLength(1)
  })

  it.each<[string, Partial<Row>]>([
    ['a missing id', { id: null }],
    ['an empty id', { id: '' }],
    ['a blob id', { id: new Uint8Array([1]) }],
    ['an empty symbol', { symbol: '' }],
    ['a symbol with surrounding spaces', { symbol: ' ABC ' }],
    ['a symbol longer than 255 characters', { symbol: 'L'.repeat(256) }],
    ['side Hold', { side: 'Hold' }],
    ['a lower-case side', { side: 'buy' }],
    ['quantity zero', { quantity: '0' }],
    ['quantity zero with a fraction', { quantity: '0.0' }],
    ['a negative quantity', { quantity: '-1' }],
    ['a leading zero', { quantity: '01' }],
    ['a trailing fractional zero', { quantity: '1.50' }],
    ['a trailing point', { quantity: '1.' }],
    ['a leading point', { quantity: '.5' }],
    ['two points', { quantity: '1.2.3' }],
    ['an exponent', { quantity: '1e3' }],
    ['a thousands separator', { quantity: '1,000' }],
    ['an empty quantity', { quantity: '' }],
    ['a blob quantity', { quantity: new Uint8Array([49]) }],
    ['a JavaScript number price, which TEXT affinity stores as 1.0', { price: 1 }],
    ['a missing price', { price: null }],
    ['a price with a space', { price: '1 ' }],
    ['executedAt without milliseconds', { executed_at: '2026-01-01T09:00:00Z' }],
    ['executedAt with an offset', { executed_at: '2026-01-01T09:00:00.000+00:00' }],
    ['executedAt with a space separator', { executed_at: '2026-01-01 09:00:00.000Z' }],
    ['a numeric executedAt', { executed_at: 1767258000000 }],
    ['a non-canonical createdAt', { created_at: '2026-1-1T09:00:00.000Z' }],
    ['updatedAt earlier than createdAt', { updated_at: '2025-12-31T23:59:59.999Z' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => {
      insert(overrides)
    }).toThrow(/constraint failed/i)
    expect(rawRows(db)).toEqual([])
  })

  it('stores a number written to a text column as text, judged by the same checks', () => {
    insert({ quantity: 1.5 })

    expect(db.$client.prepare('select quantity, typeof(quantity) as type from trades').get()).toEqual({ quantity: '1.5', type: 'text' })
  })

  it('rejects a duplicate id', () => {
    insert({ id: 'same' })

    expect(() => {
      insert({ id: 'same', quantity: '2' })
    }).toThrow(/UNIQUE constraint failed: trades.id/)
    expect(rawRows(db)).toHaveLength(1)
  })
})
