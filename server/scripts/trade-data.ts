import { existsSync, realpathSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

import { count } from 'drizzle-orm'

import { DEFAULT_DATABASE_PATH } from '../src/config.ts'
import { applyTrade, calculatePositions, flatPosition, type Position } from '../src/domain/position.ts'
import { compareTradeOrder, type Trade } from '../src/domain/trade.ts'
import { closeDatabase, openDatabase, type Database } from '../src/infrastructure/database/connection.ts'
import { applyMigrations } from '../src/infrastructure/database/migrate.ts'
import { trades } from '../src/infrastructure/database/schema.ts'
import { createDrizzleTradeRepository, toRow } from '../src/infrastructure/drizzle-trade-repository.ts'
import { appStatus, DatabaseInUseError, defaultRunDir, refuseIfDatabaseInUse } from './lifecycle.ts'
import { DEFAULT_SEED, generateTrades } from './seed-data.ts'

/**
 * npm run db:seed -- --count <n> --database <path> [--seed <text>]
 * npm run db:clear -- --database <path> --confirm
 *
 * Fill an empty database with deterministic sample trades, or remove every trade from one. Both
 * need an explicit database, refuse the development database and everything beside it in
 * server/data, and refuse while an application started with app:start is running. Neither
 * deletes or recreates a database file, and neither touches anything but trade records.
 *
 * Limitation: only applications started with app:start are known. An API started any other way
 * (npm start, npm run dev) on the same file is not detected: stop it before seeding or clearing.
 */

const MIGRATIONS_TABLE = '__drizzle_migrations'

/** Rows per INSERT statement: 9 columns each, well within SQLite's limit on bound parameters. */
const BATCH_SIZE = 500

export const MAX_COUNT = 1_000_000

export class TargetError extends Error {}

/** What the tools refuse to touch, and where app:start keeps its run state. */
export interface Protection {
  readonly developmentDatabase: string
  /** server/data: the development database, its -wal and -shm files, and its backups. */
  readonly protectedFolder: string
  readonly runDir: string
}

export const DEFAULT_PROTECTION: Protection = {
  developmentDatabase: DEFAULT_DATABASE_PATH,
  protectedFolder: dirname(DEFAULT_DATABASE_PATH),
  runDir: defaultRunDir(),
}

/** The path with its existing part resolved through links and junctions, and case-folded on Windows. */
function realPath(path: string): string {
  const absolute = resolve(path)
  let real: string
  if (existsSync(absolute)) {
    real = realpathSync.native(absolute)
  } else {
    const parent = dirname(absolute)
    real = parent === absolute ? absolute : join(realPath(parent), basename(absolute))
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function inside(folder: string, path: string): boolean {
  const within = relative(realPath(folder), realPath(path))
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))
}

/** The same file under another name, such as a hard link, as the file system identifies it. */
function sameFile(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false
  const [first, second] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })]
  return first.ino !== 0n && first.dev === second.dev && first.ino === second.ino
}

/**
 * The absolute path of an explicitly named database that is neither the development database
 * (however its path is written, including a hard link) nor anything else in server/data; else a
 * TargetError. Also used by the benchmark, which only reads.
 */
export function refuseProtectedDatabase(path: string | undefined, protection: Protection = DEFAULT_PROTECTION): string {
  if (path === undefined || path.trim() === '') throw new TargetError('Name the database with --database <path>.')
  if (path.trim() === ':memory:') throw new TargetError('The database must be a file.')
  const target = resolve(path)
  if (realPath(target) === realPath(protection.developmentDatabase) || sameFile(target, protection.developmentDatabase)) {
    throw new TargetError(`${target} is the development database. These tools never use it; use a separate file.`)
  }
  if (inside(protection.protectedFolder, target)) {
    throw new TargetError(`${target} is in ${protection.protectedFolder}, which holds the development database and its backups. Use a file elsewhere.`)
  }
  return target
}

/**
 * The absolute path of a database the tools may change, or a TargetError saying why not. Checked
 * before the database is opened.
 */
export function checkTarget(path: string | undefined, protection: Protection = DEFAULT_PROTECTION): string {
  const target = refuseProtectedDatabase(path, protection)
  refuseIfDatabaseInUse(target, protection.runDir)
  const { state, statuses } = appStatus(protection.runDir)
  if (state !== undefined && statuses.some((status) => status === 'running' || status === 'unverified')) {
    throw new TargetError(`The application started with app:start is running (database ${state.databasePath}). Stop it first: npm run app:stop`)
  }
  if (existsSync(target) && statSync(target).isDirectory()) throw new TargetError(`${target} is a folder, not a database file.`)
  return target
}

/**
 * 'new' for a file that does not exist yet or is empty; 'trade-blotter' for a database this
 * application created. Anything else is refused without being changed: it is opened read-only.
 */
function inspect(path: string): 'new' | 'trade-blotter' {
  if (!existsSync(path) || statSync(path).size === 0) return 'new'
  let tables: string[]
  try {
    const client = new DatabaseSync(path, { readOnly: true })
    try {
      tables = client.prepare("select name from sqlite_master where type = 'table'").all().map((row) => String(row['name']))
    } finally {
      client.close()
    }
  } catch (error) {
    throw new TargetError(`${path} is not a SQLite database this tool can read: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!tables.includes('trades') || !tables.includes(MIGRATIONS_TABLE)) {
    throw new TargetError(`${path} is not a Trade Blotter database (its tables: ${tables.join(', ') || 'none'}). It was not changed.`)
  }
  return 'trade-blotter'
}

function tradeCount(db: Pick<Database, 'select'>): number {
  return db.select({ total: count() }).from(trades).get()?.total ?? 0
}

export type PositionChange = 'open' | 'increase' | 'reduce' | 'close' | 'cross'

export interface DataSummary {
  readonly trades: number
  readonly symbols: number
  readonly buys: number
  readonly sells: number
  readonly firstExecution: string | undefined
  readonly lastExecution: string | undefined
  /** Trades whose execution time another trade shares. */
  readonly sharedExecutionTimes: number
  readonly distinctQuantities: number
  readonly distinctPrices: number
  readonly bookingSequences: readonly [number, number] | undefined
  readonly changes: Readonly<Record<PositionChange, number>>
  readonly openPositions: number
  readonly flatSymbols: number
}

/**
 * Describes stored trades, and checks them with the domain's own accounting: every trade is
 * applied in trade order with applyTrade, which throws if any position would breach its limit,
 * and the open positions are those calculatePositions reports. A change is named by comparing the
 * net quantity before and after each trade.
 */
export function summariseTrades(stored: readonly Trade[]): DataSummary {
  const changes: Record<PositionChange, number> = { open: 0, increase: 0, reduce: 0, close: 0, cross: 0 }
  const positions = new Map<string, Position>()
  for (const trade of [...stored].sort(compareTradeOrder)) {
    const before = positions.get(trade.symbol) ?? flatPosition(trade.symbol)
    const after = applyTrade(before, trade)
    positions.set(trade.symbol, after)
    const [from, to] = [before.netQuantity, after.netQuantity]
    const change: PositionChange = from.isZero() ? 'open'
      : to.isZero() ? 'close'
        : from.isPositive() !== to.isPositive() ? 'cross'
          : to.abs().gt(from.abs()) ? 'increase' : 'reduce'
    changes[change]++
  }
  const executions = new Map<string, number>()
  for (const trade of stored) executions.set(trade.executedAt, (executions.get(trade.executedAt) ?? 0) + 1)
  const sequences = stored.map((trade) => trade.bookingSequence)
  const ordered = [...stored].sort(compareTradeOrder)
  const open = calculatePositions(stored)
  return {
    trades: stored.length,
    symbols: positions.size,
    buys: stored.filter((trade) => trade.side === 'Buy').length,
    sells: stored.filter((trade) => trade.side === 'Sell').length,
    firstExecution: ordered[0]?.executedAt,
    lastExecution: ordered.at(-1)?.executedAt,
    sharedExecutionTimes: [...executions.values()].filter((times) => times > 1).reduce((sum, times) => sum + times, 0),
    distinctQuantities: new Set(stored.map((trade) => trade.quantity.toFixed())).size,
    distinctPrices: new Set(stored.map((trade) => trade.price.toFixed())).size,
    bookingSequences: sequences.length === 0 ? undefined : [Math.min(...sequences), Math.max(...sequences)],
    changes,
    openPositions: open.length,
    flatSymbols: positions.size - open.length,
  }
}

export interface SeedReport {
  readonly databasePath: string
  readonly created: boolean
  readonly seed: string
  readonly summary: DataSummary
  readonly milliseconds: Readonly<{ generate: number; insert: number; verify: number; total: number }>
}

/**
 * Seeds an empty database with `count` deterministic trades. A new file is created and migrated
 * as the API would at startup; an existing one must be a Trade Blotter database without trades.
 * All trades are inserted in one transaction, in batches, so either all of them are stored or
 * none. Then the stored trades are read back through the application's repository, counted and
 * checked (summariseTrades).
 */
export async function seedDatabase(options: {
  readonly path: string | undefined
  readonly count: number
  readonly seed?: string
  readonly protection?: Protection
}): Promise<SeedReport> {
  const started = performance.now()
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_COUNT) {
    throw new TargetError(`--count must be an integer from 1 to ${MAX_COUNT.toLocaleString('en-US')}, got ${String(options.count)}.`)
  }
  const seed = options.seed ?? DEFAULT_SEED
  const path = checkTarget(options.path, options.protection)
  const created = inspect(path) === 'new'

  const db = openDatabase(path)
  try {
    applyMigrations(db)
    const existing = tradeCount(db)
    if (existing > 0) {
      throw new TargetError(`${path} already holds ${existing.toLocaleString('en-US')} trades. Seeding needs an empty trade table; ` +
        `clear it first: npm run db:clear -- --database "${path}" --confirm`)
    }

    const generated = generateTrades(options.count, seed)
    const rows = generated.map(toRow)
    const afterGenerate = performance.now()

    // Synchronous, as the node:sqlite driver requires; anything thrown rolls every batch back.
    db.transaction((tx) => {
      if (tradeCount(tx) > 0) throw new TargetError(`${path} received trades from elsewhere while seeding; nothing was added.`)
      for (let start = 0; start < rows.length; start += BATCH_SIZE) tx.insert(trades).values(rows.slice(start, start + BATCH_SIZE)).run()
    }, { behavior: 'immediate' })
    const afterInsert = performance.now()

    const stored = await createDrizzleTradeRepository(db).listInTradeOrder()
    const total = tradeCount(db)
    if (total !== options.count || stored.length !== options.count) {
      throw new Error(`Expected ${String(options.count)} trades in ${path} after seeding, found ${String(total)}.`)
    }
    const summary = summariseTrades(stored)
    const finished = performance.now()
    return {
      databasePath: path, created, seed, summary,
      milliseconds: { generate: afterGenerate - started, insert: afterInsert - afterGenerate, verify: finished - afterInsert, total: finished - started },
    }
  } finally {
    closeDatabase(db)
  }
}

export interface ClearReport {
  readonly databasePath: string
  readonly removed: number
  readonly remaining: number
  readonly milliseconds: number
}

/**
 * Removes every trade from a Trade Blotter database, in one transaction, and checks that none is
 * left. The file, its schema, its applied migrations and SQLite's record of the highest booking
 * sequence used (so a new trade never reuses one) stay as they are. Running it again removes
 * nothing and succeeds.
 */
export function clearDatabase(options: { readonly path: string | undefined; readonly confirm: boolean; readonly protection?: Protection }): ClearReport {
  const started = performance.now()
  const path = checkTarget(options.path, options.protection)
  if (!existsSync(path)) throw new TargetError(`${path} does not exist; there is nothing to clear.`)
  if (inspect(path) !== 'trade-blotter') throw new TargetError(`${path} is empty, not a Trade Blotter database; there is nothing to clear.`)
  if (!options.confirm) {
    throw new TargetError(`This removes every trade in ${path}. Add --confirm to go ahead.`)
  }
  const db = openDatabase(path)
  try {
    const { removed, remaining } = db.transaction((tx) => {
      const before = tradeCount(tx)
      tx.delete(trades).run()
      const after = tradeCount(tx)
      if (after !== 0) throw new Error(`${String(after)} trades were left in ${path}; nothing was removed.`)
      return { removed: before, remaining: after }
    }, { behavior: 'immediate' })
    return { databasePath: path, removed, remaining, milliseconds: performance.now() - started }
  } finally {
    closeDatabase(db)
  }
}

const number = (value: number): string => value.toLocaleString('en-US')
const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(2)} s`

function printSeed(report: SeedReport): void {
  const { summary: s, milliseconds: ms } = report
  console.log(`Seeded ${number(s.trades)} trades into ${report.databasePath}${report.created ? ' (a new database)' : ''} in ${seconds(ms.total)} ` +
    `(generate ${seconds(ms.generate)}, insert ${seconds(ms.insert)}, read back and check ${seconds(ms.verify)}).`)
  console.log(`  Seed "${report.seed}": the same count and seed always give the same trades.`)
  console.log(`  ${String(s.symbols)} symbols; ${number(s.buys)} Buy, ${number(s.sells)} Sell; executed ${s.firstExecution ?? '-'} to ${s.lastExecution ?? '-'}.`)
  console.log(`  ${number(s.sharedExecutionTimes)} trades share an execution time; ${number(s.distinctQuantities)} distinct quantities, ` +
    `${number(s.distinctPrices)} distinct prices.`)
  console.log(`  Position changes: ${Object.entries(s.changes).map(([change, times]) => `${change} ${number(times)}`).join(', ')}.`)
  console.log(`  ${String(s.openPositions)} open positions, ${String(s.flatSymbols)} symbols flat; booking sequences ` +
    `${s.bookingSequences === undefined ? '-' : `${number(s.bookingSequences[0])} to ${number(s.bookingSequences[1])}`}.`)
  console.log(`Verified: ${number(s.trades)} trades stored.`)
  console.log(`Open it with: npm run app:start -- --database "${report.databasePath}"`)
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  try {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: { database: { type: 'string' }, count: { type: 'string' }, seed: { type: 'string' }, confirm: { type: 'boolean' } },
    })
    // Relative to the folder the command was run from, not to the npm package folder.
    const path = values.database === undefined ? undefined : resolve(process.env['INIT_CWD'] ?? process.cwd(), values.database)
    if (command === 'seed') {
      if (values.count === undefined || !/^[0-9]+$/.test(values.count)) throw new TargetError('Give the number of trades with --count <n>, such as --count 1000.')
      printSeed(await seedDatabase({ path, count: Number(values.count), ...(values.seed === undefined ? {} : { seed: values.seed }) }))
      return 0
    }
    if (command === 'clear') {
      const report = clearDatabase({ path, confirm: values.confirm === true })
      console.log(`Removed ${number(report.removed)} trades from ${report.databasePath} in ${seconds(report.milliseconds)}; ` +
        `${String(report.remaining)} remain. The file, its schema and its migrations were kept.`)
      return 0
    }
    console.error('Usage: npm run db:seed -- --count <n> --database <path> [--seed <text>]\n       npm run db:clear -- --database <path> --confirm')
    return 2
  } catch (error) {
    if (error instanceof TargetError || error instanceof DatabaseInUseError) {
      console.error(error.message)
      return 1
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(error.message)
      return 2
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main()
}
