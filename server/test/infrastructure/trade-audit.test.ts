import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.ts'
import type { Database } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createServer } from '../../src/server.ts'
import { createTestDatabase, rawRows } from '../support/database.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'
import { newTrade } from '../support/trades.ts'

/**
 * The audit trail (trade_audit, filled by SQLite triggers): a snapshot of every column of a trades
 * row at each physical write, with the action, SQLite's write time and 'System'. Writes here are
 * made through the repository and directly in SQL, as any writer could; each is audited the same.
 */

let database: ReturnType<typeof createTestDatabase>
let db: Database

beforeEach(() => {
  database = createTestDatabase()
  db = database.open()
})

afterEach(() => {
  database.dispose()
})

const TRIGGERS = ['trade_audit_no_delete', 'trade_audit_no_update', 'trades_audit_delete', 'trades_audit_insert', 'trades_audit_update']
const META = ['audit_id', 'audit_action', 'audit_on', 'audit_by']
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type Row = Record<string, unknown>
const audit = (): Row[] => db.$client.prepare('select * from trade_audit order by audit_id').all()
const trade = (id: string): Row => db.$client.prepare('select * from trades where id = ?').get(id) as Row
/** The trade's columns of an audit entry. */
const snapshot = (entry: Row | undefined): Row => Object.fromEntries(Object.entries(entry ?? {}).filter(([name]) => !META.includes(name)))
const T = '2026-01-01T09:00:00.000Z'
const insertSql = (id: string, quantity = '12.5') => db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by)
  values (?, 'MSFT', 'Buy', ?, '301.25', ?, ?, ?, 'Executed', 'User', 'User')`).run(id, quantity, T, T, T)

describe('infrastructure: the audit table holds every trades column', () => {
  it('has a column for each column of trades, the generated ones included, stored as plain values', () => {
    const columns = (table: string) => db.$client.prepare(`pragma table_xinfo(${table})`).all() as { name: string; type: string; hidden: number }[]
    const tradeColumns = columns('trades')
    const auditColumns = columns('trade_audit')

    // hidden 2 and 3: generated columns (virtual, stored); 0: ordinary.
    expect(tradeColumns.filter((column) => column.hidden !== 0).map((column) => column.name)).toEqual(['quantity_key', 'price_key'])
    expect(auditColumns.map((column) => column.name)).toEqual([...META, ...tradeColumns.map((column) => column.name)])
    expect(auditColumns.every((column) => column.hidden === 0)).toBe(true)
    expect(auditColumns.filter((column) => !META.includes(column.name)).map((column) => column.type)).toEqual(tradeColumns.map((column) => column.type))
  })

  it('constrains the audit metadata: an action of the three, canonical UTC, System, none missing', () => {
    const insertAudit = (action: unknown, on: unknown, by: unknown) => db.$client.prepare(`insert into trade_audit (audit_action, audit_on, audit_by, booking_sequence, id, symbol, side, quantity, price,
      executed_at, created_at, updated_at, quantity_key, price_key, status, created_by, updated_by) values (?, ?, ?, 1, 'x', 'A', 'Buy', '1', '1', null, ?, ?, 'k', 'k', 'Pending', 'User', 'User')`).run(action as string, on as string, by as string, T, T)

    expect(() => insertAudit('Changed', T, 'System')).toThrow(/CHECK constraint failed: trade_audit_action/)
    expect(() => insertAudit('Inserted', '2026-01-01 09:00:00', 'System')).toThrow(/CHECK constraint failed: trade_audit_on/)
    expect(() => insertAudit('Inserted', T, 'User')).toThrow(/CHECK constraint failed: trade_audit_by/)
    expect(() => insertAudit(null, T, 'System')).toThrow(/NOT NULL constraint failed: trade_audit.audit_action/)
    expect(() => insertAudit('Inserted', null, 'System')).toThrow(/NOT NULL constraint failed: trade_audit.audit_on/)
    expect(() => insertAudit('Inserted', T, null)).toThrow(/NOT NULL constraint failed: trade_audit.audit_by/)
  })
})

describe('infrastructure: audit snapshots of each write', () => {
  it('records an insert: the new row, every column, generated values included, Inserted by System', async () => {
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'i-1', quantity: '0.5' }))

    const entries = audit()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ audit_id: 1, audit_action: 'Inserted', audit_by: 'System' })
    expect(snapshot(entries[0])).toEqual(trade('i-1'))
    expect(entries[0]?.['quantity_key']).toBe('00000000010.5')
  })

  it('records an update: the row after the change, and leaves the earlier entry as it was', () => {
    insertSql('u-1', '10')
    const inserted = audit()[0]

    db.$client.exec(`update trades set quantity = '2000.5', updated_at = '2026-01-02T00:00:00.000Z' where id = 'u-1'`)

    const entries = audit()
    expect(entries.map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Updated'])
    expect(snapshot(entries[1])).toEqual(trade('u-1'))
    expect(entries[1]).toMatchObject({ quantity: '2000.5', quantity_key: '00000000042000.5', updated_at: '2026-01-02T00:00:00.000Z' })
    // The insert's snapshot keeps the values, generated key included, of the row when it was inserted.
    expect(entries[0]).toEqual(inserted)
    expect(entries[0]).toMatchObject({ quantity: '10', quantity_key: '000000000210' })
  })

  it('records a delete: the row as it was before it went', () => {
    insertSql('d-1')
    const before = trade('d-1')

    db.$client.exec(`delete from trades where id = 'd-1'`)

    const entries = audit()
    expect(entries.map((entry) => entry['audit_action'])).toEqual(['Inserted', 'Deleted'])
    expect(snapshot(entries[1])).toEqual(before)
    expect(rawRows(db)).toEqual([])
  })

  it('keeps every snapshot unchanged however the trade changes later', () => {
    insertSql('s-1', '1')
    const first = audit()
    for (const quantity of ['2', '3', '4']) db.$client.prepare(`update trades set quantity = ? where id = 's-1'`).run(quantity)
    db.$client.exec(`delete from trades where id = 's-1'`)

    const entries = audit()
    expect(entries.slice(0, 1)).toEqual(first)
    expect(entries.map((entry) => [entry['audit_action'], entry['quantity']])).toEqual([['Inserted', '1'], ['Updated', '2'], ['Updated', '3'], ['Updated', '4'], ['Deleted', '4']])
  })

  it('is written by System at SQLite\'s own time, canonical UTC, for every action', () => {
    const before = Date.now()
    insertSql('t-1')
    db.$client.exec(`update trades set updated_at = '2026-01-03T00:00:00.000Z' where id = 't-1'`)
    db.$client.exec(`delete from trades where id = 't-1'`)
    const after = Date.now()

    for (const entry of audit()) {
      expect(entry['audit_by']).toBe('System')
      const on = String(entry['audit_on'])
      expect(on).toMatch(CANONICAL)
      expect(Date.parse(on)).toBeGreaterThanOrEqual(before - 1_000)
      expect(Date.parse(on)).toBeLessThanOrEqual(after + 1_000)
    }
  })

  it('audits nothing for a write that fails a constraint: the statement and its trigger roll back together', () => {
    expect(() => db.$client.prepare(`insert into trades (id, symbol, side, quantity, price, executed_at, created_at, updated_at, status, created_by, updated_by)
      values ('bad', 'MSFT', 'Buy', '1', '1', null, ?, ?, 'Executed', 'User', 'User')`).run(T, T)).toThrow(/CHECK constraint failed: trades_executed_at/)
    expect(audit()).toEqual([])
  })
})

describe('infrastructure: the audit trail is append-only', () => {
  it('refuses to change or remove an entry, and keeps it as it was', () => {
    insertSql('a-1')
    const entries = audit()

    expect(() => { db.$client.exec(`update trade_audit set audit_by = 'Admin'`); }).toThrow('trade_audit is append-only: an entry cannot be changed')
    expect(() => { db.$client.exec(`update trade_audit set quantity = '99' where audit_id = 1`); }).toThrow('trade_audit is append-only: an entry cannot be changed')
    expect(() => { db.$client.exec('delete from trade_audit'); }).toThrow('trade_audit is append-only: an entry cannot be removed')
    expect(audit()).toEqual(entries)
  })
})

describe('infrastructure: the triggers exist after every initialisation', () => {
  // Its own timeout, 15 s (vitest's default, 5 s, stays for every other test). This is the only test
  // in the file that composes the whole server, and the first composition in a process loads Fastify,
  // Ajv and the Swagger plugins synchronously as they register (241 CommonJS modules and 654
  // synchronous file-system calls, measured), then compiles the routes: about 0.3 s (0.33-0.49 s in
  // 15 runs of this file alone and 10 failure-detection controls); the second and third compositions
  // take under 0.03 s. In check:all run 20261121T144350.160Z-af960e, in failure detection's control
  // on a freshly copied server, that process's imports took 18.7 s instead of about 1.3 s, and this
  // test took 6.05 s, the event loop blocked past its deadline, while the file's other tests took
  // their usual 17-29 ms: the same first-time loading, slowed by the machine's file access at the
  // time. No lock, leak or open-ended wait was found: each connection here is opened and closed in
  // turn, and another process's lock does not block a composition on a migrated database. Every
  // assertion is unchanged.
  it('are present after migration and after the server is composed again on the same database, and are not duplicated', async () => {
    const dir = createTempDir()
    try {
      const config = loadConfig({ DATABASE_PATH: join(dir, 'trade-blotter.db') })
      for (let start = 0; start < 3; start++) {
        const app = await createServer(config, { logger: false })
        const check = new DatabaseSync(config.databasePath)
        try {
          expect(check.prepare(`select name from sqlite_master where type = 'trigger' order by name`).all().map((row) => row['name'])).toEqual(TRIGGERS)
        } finally {
          check.close()
          await app.close()
        }
      }
    } finally {
      removeTempDir(dir)
    }
  }, 15_000)
})
