import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeState } from '../../scripts/lifecycle.ts'
import { DatabaseInUseError } from '../../scripts/lifecycle.ts'
import { clearDatabase, seedDatabase, TargetError, type Protection } from '../../scripts/trade-data.ts'
import { DEFAULT_DATABASE_PATH, loadConfig } from '../../src/config.ts'
import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { applyMigrations } from '../../src/infrastructure/database/migrate.ts'
import { createServer } from '../../src/server.ts'
import { isolatedEnv, runNode, startNode, stopChild } from '../support/child-process.ts'
import { rawRows, schemaObjects } from '../support/database.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * db:seed and db:clear. The development database they must refuse is a stand-in in a temporary
 * folder (Protection); the real one is named only to check that the command refuses it before
 * opening anything.
 */

let dir: string
let protection: Protection

beforeEach(() => {
  dir = createTempDir()
  const developmentDatabase = join(dir, 'data', 'trade-blotter.db')
  const db = openDatabase(developmentDatabase)
  applyMigrations(db)
  closeDatabase(db)
  protection = { developmentDatabase, protectedFolder: join(dir, 'data'), runDir: join(dir, 'run') }
})

afterEach(() => {
  removeTempDir(dir)
})

const target = (name = 'seed.db'): string => join(dir, 'work', name)

/** Reads a database the way an inspector would, closing it again. */
function inspectDatabase<T>(path: string, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(path)
  try {
    return read(db)
  } finally {
    closeDatabase(db)
  }
}

const tradeTotal = (path: string): number => inspectDatabase(path, (db) => rawRows(db).length)
const fingerprint = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('scripts: seeding', () => {
  it.each([100, 1_000, 10_000, 25_000])('seeds exactly %i trades into a new database, as one transaction, and checks them', async (count) => {
    const report = await seedDatabase({ path: target(), count, protection })

    expect(report.created).toBe(true)
    expect(report.summary.trades).toBe(count)
    expect(report.summary.bookingSequences).toEqual([1, count])
    expect(tradeTotal(target())).toBe(count)
    expect(Object.values(report.milliseconds).every((ms) => ms >= 0)).toBe(true)
  }, 60_000)

  it('creates the same schema and migration record as the API does at startup', async () => {
    await seedDatabase({ path: target(), count: 100, protection })

    const seeded = inspectDatabase(target(), (db) => [schemaObjects(db), rawRows(db, '__drizzle_migrations')])
    const reference = inspectDatabase(protection.developmentDatabase, (db) => [schemaObjects(db), rawRows(db, '__drizzle_migrations')])
    expect(seeded[0]).toEqual(reference[0])
    expect((seeded[1] as { hash: string }[]).map((row) => row.hash)).toEqual((reference[1] as { hash: string }[]).map((row) => row.hash))
  })

  it('stores the same rows for the same count and seed', async () => {
    await seedDatabase({ path: target('a.db'), count: 300, seed: 'same', protection })
    await seedDatabase({ path: target('b.db'), count: 300, seed: 'same', protection })

    expect(inspectDatabase(target('a.db'), rawRows)).toEqual(inspectDatabase(target('b.db'), rawRows))
  })

  it('refuses a database that already holds trades, changing nothing', async () => {
    await seedDatabase({ path: target(), count: 100, protection })
    const before = inspectDatabase(target(), rawRows)

    await expect(seedDatabase({ path: target(), count: 100, protection })).rejects.toThrow('already holds 100 trades. Seeding needs an empty trade table')
    expect(inspectDatabase(target(), rawRows)).toEqual(before)
  })

  it('seeds an existing, empty Trade Blotter database', async () => {
    const db = openDatabase(target())
    applyMigrations(db)
    closeDatabase(db)

    const report = await seedDatabase({ path: target(), count: 100, protection })

    expect(report.created).toBe(false)
    expect(tradeTotal(target())).toBe(100)
  })

  it.each([0, -5, 1.5, 1_000_001])('refuses a count of %s', async (count) => {
    await expect(seedDatabase({ path: target(), count, protection })).rejects.toThrow('--count must be an integer from 1 to 1,000,000')
    expect(existsSync(target())).toBe(false)
  })
})

describe('scripts: the seeded database in the application', () => {
  it('is served, searched, filtered, sorted and booked into by the real application', async () => {
    const report = await seedDatabase({ path: target(), count: 2_000, protection })
    const app = await createServer(loadConfig({ DATABASE_PATH: target(), DOCS_ENABLED: 'false' }), { logger: false })
    try {
      const all = (await app.inject({ method: 'GET', url: '/trades' })).json<unknown[]>()
      const ms = (await app.inject({ method: 'GET', url: '/trades?symbol=mS&side=Sell&sortBy=price&sortDirection=asc' })).json<{ symbol: string; side: string }[]>()
      const positions = (await app.inject({ method: 'GET', url: '/positions' })).json<unknown[]>()
      const booked = await app.inject({
        method: 'POST', url: '/trades', headers: { 'content-type': 'application/json' }, payload: '{"symbol":"NEW","side":"Buy","quantity":"1","price":"1"}',
      })

      expect(all).toHaveLength(2_000)
      expect(ms.length).toBeGreaterThan(0)
      expect(ms.every((trade) => trade.symbol.includes('MS') && trade.side === 'Sell')).toBe(true)
      expect(positions).toHaveLength(report.summary.openPositions)
      expect(booked.statusCode).toBe(201)
      expect(booked.json()).toMatchObject({ bookingSequence: 2_001 })
    } finally {
      await app.close()
    }
  }, 60_000)
})

describe('scripts: clearing', () => {
  it('removes every trade and nothing else, keeping the file, schema, migrations and booking-sequence record', async () => {
    await seedDatabase({ path: target(), count: 500, protection })
    const before = inspectDatabase(target(), (db) => ({
      schema: schemaObjects(db), migrations: rawRows(db, '__drizzle_migrations'), sequence: rawRows(db, 'sqlite_sequence'),
    }))
    const file = statSync(target(), { bigint: true }).ino

    const report = clearDatabase({ path: target(), confirm: true, protection })

    expect(report).toMatchObject({ removed: 500, remaining: 0 })
    expect(tradeTotal(target())).toBe(0)
    expect(statSync(target(), { bigint: true }).ino).toBe(file)
    expect(inspectDatabase(target(), (db) => ({
      schema: schemaObjects(db), migrations: rawRows(db, '__drizzle_migrations'), sequence: rawRows(db, 'sqlite_sequence'),
    }))).toEqual(before)
  })

  it('can be repeated, removing nothing the second time', async () => {
    await seedDatabase({ path: target(), count: 100, protection })
    clearDatabase({ path: target(), confirm: true, protection })

    expect(clearDatabase({ path: target(), confirm: true, protection })).toMatchObject({ removed: 0, remaining: 0 })
  })

  it('lets the database be seeded again, continuing the booking sequence so no number is reused', async () => {
    await seedDatabase({ path: target(), count: 100, protection })
    clearDatabase({ path: target(), confirm: true, protection })

    const report = await seedDatabase({ path: target(), count: 100, protection })

    expect(report.summary.bookingSequences).toEqual([101, 200])
  })

  it('needs --confirm, and changes nothing without it', async () => {
    await seedDatabase({ path: target(), count: 100, protection })

    expect(() => clearDatabase({ path: target(), confirm: false, protection })).toThrow('Add --confirm to go ahead.')
    expect(tradeTotal(target())).toBe(100)
  })

  it('refuses a database that does not exist, without creating it', () => {
    expect(() => clearDatabase({ path: target('missing.db'), confirm: true, protection })).toThrow('does not exist; there is nothing to clear')
    expect(existsSync(target('missing.db'))).toBe(false)
  })
})

describe('scripts: unsafe targets', () => {
  const both = (path: string | undefined) => [
    () => seedDatabase({ path, count: 100, protection }),
    () => Promise.resolve().then(() => clearDatabase({ path, confirm: true, protection })),
  ]

  it('needs an explicit database', async () => {
    for (const run of both(undefined)) await expect(run()).rejects.toThrow('Name the database with --database <path>.')
    for (const run of both(':memory:')) await expect(run()).rejects.toThrow('The database must be a file.')
  })

  it('refuses the development database however it is written, including through a hard link', async () => {
    const dev = protection.developmentDatabase
    const before = fingerprint(dev)
    mkdirSync(join(dir, 'work'), { recursive: true })
    linkSync(dev, target('hard-link.db'))
    const spellings = [dev, join(dir, 'data', '.', 'x', '..', 'trade-blotter.db'), target('hard-link.db'),
      ...(process.platform === 'win32' ? [dev.toUpperCase()] : [])]

    for (const path of spellings) {
      for (const run of both(path)) await expect(run()).rejects.toThrow(TargetError)
    }
    await expect(both(target('hard-link.db'))[0]?.()).rejects.toThrow('is the development database')
    expect(fingerprint(dev)).toBe(before)
  })

  it('refuses anything else in the development data folder, such as a backup', async () => {
    const backup = join(dir, 'data', 'backups', 'copy.db')

    for (const run of both(backup)) await expect(run()).rejects.toThrow('which holds the development database and its backups')
    expect(existsSync(backup)).toBe(false)
  })

  it('refuses a SQLite file that is not a Trade Blotter database, and leaves it byte for byte as it was', async () => {
    mkdirSync(join(dir, 'work'), { recursive: true })
    const other = new DatabaseSync(target('other.db'))
    other.exec("create table notes (text text); insert into notes values ('keep me')")
    other.close()
    const before = fingerprint(target('other.db'))

    for (const run of both(target('other.db'))) await expect(run()).rejects.toThrow('is not a Trade Blotter database (its tables: notes). It was not changed.')
    expect(fingerprint(target('other.db'))).toBe(before)
    expect(existsSync(`${target('other.db')}-wal`)).toBe(false)
  })

  it('refuses a file that is not a database, and a folder', async () => {
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeFileSync(target('notes.txt'), 'not a database, but long enough to be read as a header '.repeat(4))

    for (const run of both(target('notes.txt'))) await expect(run()).rejects.toThrow('is not a SQLite database this tool can read')
    expect(readFileSync(target('notes.txt'), 'utf8')).toContain('not a database')
    for (const run of both(join(dir, 'work'))) await expect(run()).rejects.toThrow('is a folder, not a database file')
  })

  it('refuses while an application started with app:start is running, on that database or any other', async () => {
    await seedDatabase({ path: target(), count: 100, protection })
    // A live process whose command line holds the recorded token, as a process app:start starts does.
    const token = '5eed5eed-0000-4000-8000-000000000001'
    const app = startNode(['-e', 'setInterval(() => {}, 1000)', token], isolatedEnv({ DATABASE_PATH: target() }))
    try {
      writeState(protection.runDir, {
        version: 1, startedAt: '2026-11-05T00:00:00.000Z', phase: 'ready', databasePath: target(),
        apps: [{ name: 'api', label: 'API', pid: app.pid ?? 0, token, host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1', log: join(dir, 'api.log') }],
      })

      expect(() => clearDatabase({ path: target(), confirm: true, protection })).toThrow(DatabaseInUseError)
      await expect(seedDatabase({ path: target('other.db'), count: 100, protection })).rejects.toThrow('Stop it first: npm run app:stop')
      expect(tradeTotal(target())).toBe(100)
      expect(existsSync(target('other.db'))).toBe(false)
    } finally {
      await stopChild(app)
    }

    expect(clearDatabase({ path: target(), confirm: true, protection })).toMatchObject({ removed: 100 })
  }, 60_000)
})

describe('scripts: the db:seed and db:clear commands', () => {
  const env = (): NodeJS.ProcessEnv => ({ ...isolatedEnv({ DATABASE_PATH: target('from-env.db') }), TRADE_BLOTTER_RUN_DIR: protection.runDir, INIT_CWD: dir })

  it('seeds, reporting the count it verified and the time it took, then clears', () => {
    const seeded = runNode(['scripts/trade-data.ts', 'seed', '--count', '250', '--seed', 'cli', '--database', 'work/cli.db'], env(), 60_000)
    const cleared = runNode(['scripts/trade-data.ts', 'clear', '--database', 'work/cli.db', '--confirm'], env(), 60_000)

    expect(seeded.status, seeded.stderr).toBe(0)
    expect(seeded.stdout).toMatch(new RegExp(`^Seeded 250 trades into ${join(dir, 'work', 'cli.db').replaceAll('\\', '\\\\')} \\(a new database\\) in \\d+\\.\\d\\d s`))
    expect(seeded.stdout).toContain('Verified: 250 trades stored.')
    expect(cleared.status, cleared.stderr).toBe(0)
    expect(cleared.stdout).toContain('Removed 250 trades')
    expect(cleared.stdout).toContain('0 remain')
  }, 90_000)

  it('ignores DATABASE_PATH: the database must be named on the command line', () => {
    const result = runNode(['scripts/trade-data.ts', 'seed', '--count', '10'], env(), 30_000)

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe('Name the database with --database <path>.')
    expect(existsSync(target('from-env.db'))).toBe(false)
  })

  it('refuses the real development database before opening anything', () => {
    const existed = existsSync(DEFAULT_DATABASE_PATH)

    for (const args of [['seed', '--count', '10'], ['clear', '--confirm']]) {
      const result = runNode(['scripts/trade-data.ts', ...args, '--database', DEFAULT_DATABASE_PATH], env(), 30_000)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('is the development database. These tools never use it')
    }
    expect(existsSync(DEFAULT_DATABASE_PATH)).toBe(existed)
  })

  it('explains a missing count, a missing confirmation and an unknown command', () => {
    const noCount = runNode(['scripts/trade-data.ts', 'seed', '--database', 'work/x.db'], env(), 30_000)
    const unknown = runNode(['scripts/trade-data.ts', 'reset'], env(), 30_000)

    expect([noCount.status, noCount.stderr.trim()]).toEqual([1, 'Give the number of trades with --count <n>, such as --count 1000.'])
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('Usage: npm run db:seed')
  })
})
