import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrowserLookup } from '../../scripts/browser.ts'
import { isAlive, readState, startApps, StartError, statePath, stopApps, writeState, type AppLaunch } from '../../scripts/lifecycle.ts'
import { readSnapshot, type BenchmarkResult } from '../../scripts/perf-api.ts'
import { checkOwnership, startPair, stopPair } from '../../scripts/review-apps.ts'
import { bookingChecks, readOnlyChecks } from '../../scripts/review-checks.ts'
import {
  EXIT, fingerprintChanges, fingerprintFiles, readBaseline, Report, reviewContext, type FileFingerprint, type ReviewContext, type ReviewPair,
} from '../../scripts/review-context.ts'
import { inspectDataset, prepareDatabase } from '../../scripts/review-data.ts'
import type { UiCheckRun } from '../../scripts/ui-check.ts'
import { dependencyProblems, leftoverUiCheckDatabases, stepPerformance, stepSeed, stepSetup, stepStop, stepTests, testCounts } from '../../scripts/review-steps.ts'
import { loadConfig } from '../../src/config.ts'
import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createServer } from '../../src/server.ts'
import { isolatedEnv, runNode, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'
import { newTrade } from '../support/trades.ts'

/**
 * The reviewer workflow (npm run review:01 ... review:07) on a temporary folder, with a stand-in
 * development database, small datasets, and ports the system picks. Every process started here
 * is a stand-in application (test/support/fake-app.ts) or a child that only waits; no other
 * process is ever looked at, let alone stopped. The full workflow on the real applications is run
 * by hand (see the report of Phase 3).
 */

const FAKE_APP = join(import.meta.dirname, '../support/fake-app.ts')
const TIMEOUT = 120_000
const NPM = { npm_config_user_agent: 'npm/12.0.1 node/v22.23.1 win32 x64' }
const noBrowser = (): BrowserLookup => ({ kind: 'missing', diagnostics: 'CHROME_PATH: not set' })
const chromeAt = (): BrowserLookup => ({ kind: 'found', path: '/chrome', description: 'Google Chrome' })

let dir = ''
let context: ReviewContext
let children: { pid?: number | undefined }[] = []

const silent = (): Report => new Report(() => undefined)
const lines = (report: Report): string[] => report.lines.map((line) => `${line.status} ${line.name}`)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const pair = (name: ReviewPair['name']): ReviewPair => {
  const found = context.pairs.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(name)
  return found
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => { resolve(port) })
    })
  })
}

async function makeContext(): Promise<ReviewContext> {
  const [apiB, webB, apiS, webS] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
  return reviewContext({
    root: join(dir, 'review'),
    ports: { benchmark: [apiB, webB], scratch: [apiS, webS] },
    counts: { benchmark: 300, scratch: 20 },
    protection: { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'app-run') },
  })
}

/** A stand-in development database: a file, and a -wal beside it; never a real database. */
function developmentDatabase(): string {
  const path = context.protection.developmentDatabase
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(path, 'development database bytes')
  writeFileSync(`${path}-wal`, 'write-ahead log bytes')
  return path
}

/** A stand-in API and frontend on the pair's ports, started through the process manager. */
function fakeLaunches(target: ReviewPair): AppLaunch[] {
  return [['api', target.apiPort], ['web', target.webPort]].map(([name, port]) => {
    const url = `http://127.0.0.1:${String(port)}`
    return {
      name: String(name), label: name === 'api' ? 'API' : 'Frontend', args: [FAKE_APP, String(port), 'serve'], cwd: import.meta.dirname, env: process.env,
      host: '127.0.0.1', port: Number(port), url,
      ready: async () => {
        try {
          return (await (await fetch(url, { signal: AbortSignal.timeout(1_000) })).text()) === 'fake app'
        } catch {
          return false
        }
      },
    }
  })
}

async function startFakes(target: ReviewPair, databasePath = target.databasePath): Promise<number[]> {
  const result = await startApps({ runDir: target.runDir, databasePath, launches: fakeLaunches(target), readyTimeoutMs: 30_000 })
  const pids = result.state.apps.map((app) => app.pid)
  children.push(...pids.map((pid) => ({ pid })))
  return pids
}

/** Stand-ins answer "fake app", not as the Trade Blotter API: their identity is checked by the caller's own rule. */
const trusted = { identity: () => Promise.resolve([]) }

beforeEach(async () => {
  dir = createTempDir()
  children = []
  context = await makeContext()
})

afterEach(async () => {
  for (const target of context.pairs) await stopApps(target.runDir).catch(() => undefined)
  for (const child of children) if (child.pid !== undefined && isAlive(child.pid)) process.kill(child.pid, 'SIGKILL')
  removeTempDir(dir)
}, TIMEOUT)

describe('review: results and exit codes', () => {
  it('passes with warnings, fails with any failure, and is incomplete when a required part could not run', () => {
    const passed = silent()
    passed.pass('a')
    passed.warn('b')
    passed.skip('c')
    expect([passed.exitCode, passed.summary()]).toEqual([EXIT.passed, '1 PASS, 0 FAIL, 1 WARN, 1 SKIPPED\nRESULT: PASSED (exit code 0)'])

    const incomplete = silent()
    incomplete.pass('a')
    incomplete.incomplete('no browser')
    expect([incomplete.exitCode, incomplete.summary().split('\n')[1]]).toEqual([3, 'RESULT: INCOMPLETE: no browser (exit code 3)'])

    const failed = silent()
    failed.incomplete('no browser')
    failed.fail('x', 'why')
    expect([failed.exitCode, failed.summary().split('\n')[1]]).toEqual([1, 'RESULT: FAILED (exit code 1)'])
  })

  it('prints each result on its own line, with its detail indented', () => {
    const printed: string[] = []
    new Report((line) => { printed.push(line) }).fail('Something', 'first\nsecond')

    expect(printed).toEqual(['FAIL     Something\n         first\n         second'])
  })
})

describe('review 01: setup', () => {
  it('creates the folders and migrated databases, fingerprints the development database, and warns without a browser', async () => {
    const development = developmentDatabase()
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: noBrowser })

    expect(report.failed).toBe(false)
    expect(lines(report)).toContain('PASS Benchmark database created and migrated')
    expect(lines(report)).toContain('PASS Scratch database created and migrated')
    expect(lines(report)).toContain('WARN No Chrome, Edge or Chromium found (CHROME_PATH, then the usual places)')
    for (const folder of ['logs', 'perf', 'disposable']) expect(existsSync(join(context.root, folder))).toBe(true)
    for (const target of context.pairs) expect(await inspectDataset(target)).toEqual({ kind: 'empty' })
    expect(readBaseline(context)).toMatchObject({ path: development, exists: true, files: { [development]: sha(development), [`${development}-wal`]: sha(`${development}-wal`) } })
    expect(report.exitCode).toBe(0)
  }, TIMEOUT)

  it('keeps existing databases exactly as they are when run again', async () => {
    await stepSetup(context, silent(), { env: NPM, findBrowser: chromeAt })
    await stepSeed(context, silent())
    const before = context.pairs.map((target) => sha(target.databasePath))
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: chromeAt })

    expect(context.pairs.map((target) => sha(target.databasePath))).toEqual(before)
    expect(lines(report)).toContain('PASS Benchmark database exists, kept as it is: its dataset (version 2) of 300 trades')
    expect(lines(report)).toContain('PASS Browser for the UI checks and benchmark: /chrome')
    // The copy it inspected is gone: nothing is kept when nothing was replaced.
    expect(existsSync(context.backupsDir) ? readdirSync(context.backupsDir) : []).toEqual([])
  }, TIMEOUT)

  it('fails, with how to correct it, when CHROME_PATH is set but names no usable browser', async () => {
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: () => ({ kind: 'invalid-setting', message: 'CHROME_PATH is set to /nowhere, which is not found.' }) })

    expect(lines(report)).toContain('FAIL CHROME_PATH does not name a usable browser')
    expect(report.lines.find((l) => l.status === 'FAIL')?.detail).toContain('CHROME_PATH is set to /nowhere, which is not found.')
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('reports a file that is not a Trade Blotter database without changing or replacing it, with how to recover', async () => {
    mkdirSync(context.root, { recursive: true })
    writeFileSync(pair('scratch').databasePath, 'not a database at all, but someone\'s file')
    const before = sha(pair('scratch').databasePath)
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: noBrowser })

    expect(sha(pair('scratch').databasePath)).toBe(before)
    const line = report.lines.find((l) => l.name.startsWith('Scratch database is unexpected'))
    expect(line?.status).toBe('FAIL')
    expect(line?.detail).toContain('Nothing was changed')
    expect(line?.detail).toContain('move the file')
    expect(existsSync(context.backupsDir) ? readdirSync(context.backupsDir) : []).toEqual([])
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('refuses a reviewer folder that would put a database beside the development database', async () => {
    developmentDatabase()
    const inside = reviewContext({ root: join(dir, 'data'), counts: { benchmark: 10, scratch: 10 }, protection: context.protection })
    const report = silent()

    await stepSetup(inside, report, { env: NPM, findBrowser: noBrowser })

    expect(lines(report)).toContain(`FAIL Reviewer folder ${join(dir, 'data')}`)
    expect(report.lines.find((l) => l.status === 'FAIL')?.detail).toMatch(/holds the development database[\s\S]*Nothing was created there/)
    expect(readdirSync(join(dir, 'data')).sort()).toEqual(['trade-blotter.db', 'trade-blotter.db-wal'])
  }, TIMEOUT)

  it('lists packages missing or at another version than package-lock.json records; installs nothing', () => {
    const root = join(dir, 'fake-repository')
    mkdirSync(join(root, 'server'), { recursive: true })
    mkdirSync(join(root, 'client'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { alpha: '1.0.0', beta: '2.0.0' } }))
    writeFileSync(join(root, 'server', 'package.json'), JSON.stringify({ dependencies: { gamma: '3.0.0' } }))
    writeFileSync(join(root, 'client', 'package.json'), JSON.stringify({}))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/alpha': { version: '1.0.0' }, 'node_modules/beta': { version: '2.0.0' } } }))
    mkdirSync(join(root, 'node_modules', 'beta'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'beta', 'package.json'), JSON.stringify({ version: '1.9.0' }))

    expect(dependencyProblems(root)).toEqual({
      checked: 3,
      problems: ['alpha: not installed', 'beta: 1.9.0 installed, package-lock.json records 2.0.0', 'gamma: not in package-lock.json'],
    })
    expect(readdirSync(join(root, 'node_modules'))).toEqual(['beta'])
  })

  it('finds every dependency of this repository installed', () => {
    expect(dependencyProblems(context.repositoryRoot).problems).toEqual([])
  })
})

describe('review 02: seed', () => {
  it('seeds both datasets, then recognises them on the next run and changes nothing', async () => {
    await stepSetup(context, silent(), { env: NPM, findBrowser: noBrowser })
    const report = silent()

    await stepSeed(context, report)
    const seeded = context.pairs.map((target) => sha(target.databasePath))
    const again = silent()
    await stepSeed(context, again)

    expect(lines(report)).toHaveLength(2)
    expect(lines(report)[0]).toMatch(/^PASS Benchmark database seeded with its dataset of 300 trades in \d+\.\d s$/)
    expect(lines(report)[1]).toMatch(/^PASS Scratch database seeded with its dataset of 20 trades in \d+\.\d s$/)
    expect(lines(again)).toEqual([
      'PASS Benchmark database already holds its dataset (version 2) of 300 trades; kept as it is',
      'PASS Scratch database already holds its dataset (version 2) of 20 trades; kept as it is',
    ])
    expect(context.pairs.map((target) => sha(target.databasePath))).toEqual(seeded)
  }, TIMEOUT)

  it('keeps a scratch database with trades booked after seeding, checking them with the domain\'s accounting', async () => {
    await stepSeed(context, silent())
    const db = openDatabase(pair('scratch').databasePath)
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'booked-later', symbol: 'ZZBOOKED', quantity: '1.5', price: '10' }))
    closeDatabase(db)
    const report = silent()

    await stepSeed(context, report)

    expect(await inspectDataset(pair('scratch'))).toEqual({ kind: 'seeded', trades: 21, bookings: 1 })
    expect(lines(report)).toContain('PASS Scratch database already holds its dataset (version 2) of 20 trades, and 1 booked since; kept as it is')
  }, TIMEOUT)

  it('never reseeds a benchmark database with trades booked after seeding: step 02 changes nothing and points to step 01', async () => {
    await stepSeed(context, silent())
    const db = openDatabase(pair('benchmark').databasePath)
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'extra', symbol: 'ZZEXTRA' }))
    closeDatabase(db)
    const before = sha(pair('benchmark').databasePath)
    const report = silent()

    await stepSeed(context, report)

    expect(report.lines[0]).toMatchObject({ status: 'FAIL', name: expect.stringContaining('dataset version 2 and 1 more trade') as string })
    expect(report.lines[0]?.detail).toContain('npm run review:01')
    expect(sha(pair('benchmark').databasePath)).toBe(before)
  }, TIMEOUT)

  it('never reseeds data that differs from the dataset, even with the right number of trades', async () => {
    await stepSeed(context, silent())
    const client = new DatabaseSync(pair('benchmark').databasePath)
    client.exec("update trades set price = '1.25' where booking_sequence = 7")
    client.close()
    const before = sha(pair('benchmark').databasePath)
    const report = silent()

    await stepSeed(context, report)

    expect(report.lines[0]?.status).toBe('FAIL')
    expect(report.lines[0]?.name).toMatch(/not dataset version 2: trade 7 in booking order differs \(price is "1\.25"/)
    expect(sha(pair('benchmark').databasePath)).toBe(before)
    expect(report.lines[1]?.status).toBe('PASS')
  }, TIMEOUT)

  it('names a database holding an earlier generator version\'s dataset for what it is, not by its count', async () => {
    await stepSeed(context, silent())
    const stored = await readSnapshot(pair('benchmark').databasePath)
    // Stands in for version 1: the same count, other trades, a fingerprint the workflow knows.
    const client = new DatabaseSync(pair('benchmark').databasePath)
    client.exec("update trades set symbol = 'OLDV1' where booking_sequence = 1")
    client.close()
    const changed = await readSnapshot(pair('benchmark').databasePath)
    expect(changed.trades).toHaveLength(stored.trades.length)
    const known = [{ version: 1, seed: pair('benchmark').seed, count: 300, fingerprint: changed.fingerprint }]

    const state = await inspectDataset(pair('benchmark'), known)

    expect(state).toMatchObject({ kind: 'unexpected', reason: 'dataset version 1, made by an earlier seed generator; this version makes dataset version 2' })
    expect(state.kind === 'unexpected' && state.recoverable).toEqual({ trades: 300, fingerprint: changed.fingerprint })
  }, TIMEOUT)

  it('never opens, migrates or changes the development database', async () => {
    const development = developmentDatabase()
    const before = fingerprintFiles(development)

    await stepSetup(context, silent(), { env: NPM, findBrowser: noBrowser })
    await stepSeed(context, silent())

    expect(fingerprintFiles(development)).toEqual(before)
    expect(readFileSync(development, 'utf8')).toBe('development database bytes')
  }, TIMEOUT)
})

describe('review 01: preserving and replacing a database that holds other trades', () => {
  /** A seeded benchmark with one trade booked into it, as someone using the benchmark application would. */
  async function bookedIntoBenchmark(): Promise<{ files: Record<string, string>; snapshot: Awaited<ReturnType<typeof readSnapshot>> }> {
    await stepSetup(context, silent(), { env: NPM, findBrowser: chromeAt })
    await stepSeed(context, silent())
    const db = openDatabase(pair('benchmark').databasePath)
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'user-added', symbol: 'MYTRADE', quantity: '1', price: '1' }))
    closeDatabase(db)
    const snapshot = await readSnapshot(pair('benchmark').databasePath)
    const files = Object.fromEntries(['', '-wal', '-shm'].map((suffix) => `${pair('benchmark').databasePath}${suffix}`).filter((file) => existsSync(file))
      .map((file) => [basename(file), sha(file)]))
    return { files, snapshot }
  }

  it('copies it into a verified backup before anything else, replaces it with a new database, and step 02 seeds the dataset', async () => {
    const { files, snapshot } = await bookedIntoBenchmark()
    const before = await inspectDataset(pair('benchmark'))
    const bookingOrderFingerprint = before.kind === 'unexpected' ? before.recoverable?.fingerprint : undefined
    expect(bookingOrderFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: chromeAt })

    const line = report.lines.find((l) => l.name.startsWith('Benchmark database held'))
    expect(line?.status).toBe('WARN')
    expect(line?.name).toBe('Benchmark database held dataset version 2 and 1 more trade; the benchmark database is only ever read: preserved in a verified backup, then replaced by a new, empty database for step 02')
    expect(report.failed).toBe(false)
    const folders = readdirSync(context.backupsDir)
    expect(folders).toHaveLength(1)
    const folder = join(context.backupsDir, folders[0] ?? '')
    expect(folders[0]).toMatch(/^benchmark-\d{8}T\d{6}\.\d{3}Z$/)
    // Every file exactly as it was, and a record of it.
    for (const [name, hash] of Object.entries(files)) expect(sha(join(folder, name))).toBe(hash)
    const record = JSON.parse(readFileSync(join(folder, 'backup.json'), 'utf8')) as { trades: number; tradesFingerprint: string; files: { name: string; sha256: string }[]; database: string; restore: string }
    expect(record).toMatchObject({ trades: 301, tradesFingerprint: bookingOrderFingerprint, database: pair('benchmark').databasePath })
    expect(snapshot.trades).toHaveLength(301)
    expect(Object.fromEntries(record.files.map((file) => [file.name, file.sha256]))).toEqual(files)
    expect(record.restore).toContain('npm run review:07')
    expect(readdirSync(folder).includes('.verify')).toBe(false)
    // The reviewer's database is new; the scratch one, valid, is kept.
    expect(await inspectDataset(pair('benchmark'))).toEqual({ kind: 'empty' })
    expect(lines(report)).toContain('PASS Scratch database exists, kept as it is: its dataset (version 2) of 20 trades')

    const seeded = silent()
    await stepSeed(context, seeded)
    expect(lines(seeded)[0]).toMatch(/^PASS Benchmark database seeded with its dataset of 300 trades/)
    expect(await inspectDataset(pair('benchmark'))).toEqual({ kind: 'seeded', trades: 300, bookings: 0 })
  }, TIMEOUT)

  it('keeps a backup that restores every trade, the one added by hand included', async () => {
    const { snapshot } = await bookedIntoBenchmark()
    await stepSetup(context, silent(), { env: NPM, findBrowser: chromeAt })
    const folder = join(context.backupsDir, readdirSync(context.backupsDir)[0] ?? '')

    // Restored as backup.json says: the files copied back beside each other.
    const restored = join(dir, 'restored')
    mkdirSync(restored)
    for (const name of readdirSync(folder).filter((file) => file !== 'backup.json')) writeFileSync(join(restored, name), readFileSync(join(folder, name)))
    const back = await readSnapshot(join(restored, basename(pair('benchmark').databasePath)))

    expect(back.fingerprint).toBe(snapshot.fingerprint)
    expect(back.trades.find((trade) => trade.id === 'user-added')).toMatchObject({ symbol: 'MYTRADE' })
    expect(back.trades).toHaveLength(301)
  }, TIMEOUT)

  it('preserves and replaces a database whose trades were changed, even with the right count; a second run changes nothing', async () => {
    await stepSetup(context, silent(), { env: NPM, findBrowser: chromeAt })
    await stepSeed(context, silent())
    const client = new DatabaseSync(pair('scratch').databasePath)
    client.exec("update trades set quantity = '7.5' where booking_sequence = 3")
    client.close()

    const report = silent()
    await stepSetup(context, report, { env: NPM, findBrowser: chromeAt })
    await stepSeed(context, silent())

    expect(report.lines.find((l) => l.name.startsWith('Scratch database held'))?.name).toMatch(/^Scratch database held not dataset version 2: trade 3 in booking order differs \(quantity is "7\.5", expected "/)
    expect(await inspectDataset(pair('scratch'))).toEqual({ kind: 'seeded', trades: 20, bookings: 0 })
    const after = context.pairs.map((target) => sha(target.databasePath))
    const again = silent()
    await stepSetup(context, again, { env: NPM, findBrowser: chromeAt })
    await stepSeed(context, again)
    expect(context.pairs.map((target) => sha(target.databasePath))).toEqual(after)
    expect(readdirSync(context.backupsDir)).toHaveLength(1)
    expect(again.lines.filter((l) => l.status === 'WARN' || l.status === 'FAIL')).toEqual([])
  }, TIMEOUT)

  it('never replaces a database an application is recorded as using: it reports it, and changes nothing', async () => {
    const { files } = await bookedIntoBenchmark()
    await startFakes(pair('benchmark'))
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: chromeAt })

    const line = report.lines.find((l) => l.name.startsWith('Benchmark database is unexpected'))
    expect(line?.status).toBe('FAIL')
    expect(line?.detail).toContain('npm run review:07')
    expect(sha(pair('benchmark').databasePath)).toBe(files[basename(pair('benchmark').databasePath)])
    expect(existsSync(context.backupsDir) ? readdirSync(context.backupsDir) : []).toEqual([])
  }, TIMEOUT)
})

describe('review 03 and 07: which applications are the reviewer\'s', () => {
  it('refuses to start on a port another program uses, and leaves that program alone', async () => {
    await stepSeed(context, silent())
    const holder: Server = createTcpServer()
    await new Promise<void>((resolve) => holder.listen(pair('benchmark').apiPort, 'localhost', resolve))
    try {
      await expect(startPair(context, pair('benchmark'))).rejects.toThrow(StartError)
      await expect(startPair(context, pair('benchmark'))).rejects.toThrow(/already in use by another process\. Nothing was started/)
      expect(holder.listening).toBe(true)
      expect(readState(pair('benchmark').runDir)).toBeUndefined()
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  }, TIMEOUT)

  it('stops nothing when nothing was started', async () => {
    const report = silent()

    await stepStop(context, report)

    expect(lines(report).slice(0, 2)).toEqual(['SKIPPED Benchmark applications: none recorded', 'SKIPPED Scratch applications: none recorded'])
    expect(report.exitCode).toBe(0)
  }, TIMEOUT)

  it('confirms ownership, then stops the pair and releases its ports, and only that pair', async () => {
    await startFakes(pair('benchmark'))
    const scratchPids = await startFakes(pair('scratch'))
    expect((await checkOwnership(pair('benchmark'), trusted)).kind).toBe('running')

    const outcome = await stopPair(pair('benchmark'), trusted)

    expect(outcome.kind).toBe('stopped')
    expect(existsSync(statePath(pair('benchmark').runDir))).toBe(false)
    expect(scratchPids.every(isAlive)).toBe(true)
    expect((await checkOwnership(pair('scratch'), trusted)).kind).toBe('running')
  }, TIMEOUT)

  it('removes the record of applications that have already exited, stopping nothing', async () => {
    const { pid } = runNode(['-e', ''], isolatedEnv({ DATABASE_PATH: join(dir, 'x.db') }))
    mkdirSync(pair('scratch').runDir, { recursive: true })
    writeState(pair('scratch').runDir, {
      version: 1, startedAt: '2026-11-07T00:00:00.000Z', phase: 'ready', databasePath: pair('scratch').databasePath,
      apps: [{ name: 'api', label: 'API', pid: pid ?? 0, token: 'aaaaaaaa-0000-4000-8000-000000000000', host: '127.0.0.1', port: pair('scratch').apiPort, url: '', log: '' },
        { name: 'web', label: 'Frontend', pid: pid ?? 0, token: 'bbbbbbbb-0000-4000-8000-000000000000', host: '127.0.0.1', port: pair('scratch').webPort, url: '', log: '' }],
    })

    expect(await stopPair(pair('scratch'))).toEqual({ kind: 'already-stopped' })
    expect(existsSync(statePath(pair('scratch').runDir))).toBe(false)
  }, TIMEOUT)

  it('never stops a process whose id was reused: a live process without the recorded token', async () => {
    const other = startNode(['-e', 'setInterval(() => {}, 1000)'], isolatedEnv({ DATABASE_PATH: join(dir, 'other.db') }))
    children.push(other)
    const target = pair('scratch')
    mkdirSync(target.runDir, { recursive: true })
    writeState(target.runDir, {
      version: 1, startedAt: '2026-11-07T00:00:00.000Z', phase: 'ready', databasePath: target.databasePath,
      apps: [{ name: 'api', label: 'API', pid: other.pid ?? 0, token: 'cccccccc-0000-4000-8000-000000000000', host: '127.0.0.1', port: target.apiPort, url: '', log: '' },
        { name: 'web', label: 'Frontend', pid: other.pid ?? 0, token: 'dddddddd-0000-4000-8000-000000000000', host: '127.0.0.1', port: target.webPort, url: '', log: '' }],
    })
    const report = silent()

    await stepStop(context, report)

    expect(report.lines[1]).toMatchObject({ status: 'FAIL', name: 'Scratch: not stopped, left running' })
    expect(report.lines[1]?.detail).toMatch(/its id now belongs to another program/)
    expect(isAlive(other.pid ?? 0)).toBe(true)
    expect(existsSync(statePath(target.runDir))).toBe(true)
    await stopChild(other)
  }, TIMEOUT)

  it('never stops applications recorded on another database, or that do not answer as the reviewer\'s', async () => {
    const pids = await startFakes(pair('benchmark'), join(dir, 'someone-else.db'))

    const elsewhere = await checkOwnership(pair('benchmark'), trusted)
    expect(elsewhere.kind === 'not-ours' && elsewhere.problems[0]).toMatch(/names the database .*someone-else\.db/)
    expect((await stopPair(pair('benchmark'), trusted)).kind).toBe('refused')
    expect(pids.every(isAlive)).toBe(true)
    await stopApps(pair('benchmark').runDir)

    // The right database and tokens, but the applications do not answer as the Trade Blotter: the real identity check refuses them.
    const fakes = await startFakes(pair('benchmark'))
    const outcome = await stopPair(pair('benchmark'))
    expect(outcome.kind === 'refused' && outcome.problems.join(' ')).toMatch(/does not answer GET \/trades\/page/)
    expect(fakes.every(isAlive)).toBe(true)
  }, TIMEOUT)

  it('never stops a process that is ours but not the only listener on its port', async () => {
    const pids = await startFakes(pair('scratch'))

    const outcome = await stopPair(pair('scratch'), { ...trusted, listeners: () => 'others' })

    expect(outcome.kind === 'refused' && outcome.problems[0]).toMatch(/another process also listens on its port/)
    expect(pids.every(isAlive)).toBe(true)
  }, TIMEOUT)
})

/** A perf:api result with one scenario, as a stand-in for the real benchmark. */
const fakeApiResult = (): BenchmarkResult => ({
  tool: 'perf:api', version: 1, startedAt: '', finishedAt: '',
  environment: { platform: 'win32', release: '', arch: 'x64', node: 'v22.23.1', cpu: 'cpu', logicalCores: 1, totalMemoryBytes: 1 },
  databasePath: '', apiUrl: '', apiPid: 1, datasetTrades: 300, datasetFingerprint: 'f'.repeat(64), datasetUnchanged: true, warmupIterations: 0,
  measuredIterations: 1, method: {}, serverMemoryBefore: undefined,
  scenarios: [{
    name: 'Page', endpoint: 'GET /trades/page', path: '/trades/page', matchedRows: 300, returnedRows: 50, responseBytes: 1, warmupIterations: 0, measuredIterations: 1,
    latencyMs: { min: 1, median: 1, p95: 1, max: 1, mean: 1 }, headersMs: { min: 1, median: 1, p95: 1, max: 1, mean: 1 },
    jsonParseMs: { min: 1, median: 1, p95: 1, max: 1, mean: 1 }, serverMemoryAfter: undefined,
  }],
})

describe('review 06: performance', () => {
  it('runs the API benchmark, reports the UI benchmark SKIPPED without a browser, and ends INCOMPLETE with exit code 3', async () => {
    await stepSeed(context, silent())
    await startFakes(pair('benchmark'))
    const report = silent()

    await stepPerformance(context, report, { ...trusted, findBrowser: noBrowser, apiBenchmark: () => Promise.resolve(fakeApiResult()) })

    expect(lines(report)).toEqual([
      'PASS API benchmark: 1 scenarios on 300 trades, every response correct, data unchanged',
      'SKIPPED UI benchmark',
    ])
    expect(report.exitCode).toBe(3)
    expect(report.summary()).toContain('RESULT: INCOMPLETE')
    const out = readdirSync(context.perfDir)
    expect(out).toHaveLength(1)
    expect(readdirSync(join(context.perfDir, out[0] ?? '')).sort()).toEqual(['api.json', 'api.txt'])
  }, TIMEOUT)

  it('fails the UI benchmark, rather than skipping it, when CHROME_PATH names no usable browser', async () => {
    await stepSeed(context, silent())
    await startFakes(pair('benchmark'))
    const report = silent()

    await stepPerformance(context, report, {
      ...trusted, findBrowser: () => ({ kind: 'invalid-setting', message: 'CHROME_PATH is set to /nowhere, which is not found.' }),
      apiBenchmark: () => Promise.resolve(fakeApiResult()), uiBenchmark: () => Promise.reject(new Error('must not run')),
    })

    expect(lines(report)).toEqual([
      'PASS API benchmark: 1 scenarios on 300 trades, every response correct, data unchanged',
      'FAIL UI benchmark not run: CHROME_PATH does not name a usable browser',
    ])
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('fails, not incomplete, when a benchmark fails', async () => {
    await stepSeed(context, silent())
    await startFakes(pair('benchmark'))
    const report = silent()

    await stepPerformance(context, report, {
      ...trusted, findBrowser: chromeAt, apiBenchmark: () => Promise.resolve(fakeApiResult()),
      uiBenchmark: () => Promise.reject(new Error('the page shows 49 trades; expected 50')),
    })

    expect(lines(report)).toEqual(['PASS API benchmark: 1 scenarios on 300 trades, every response correct, data unchanged', 'FAIL UI benchmark'])
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('measures nothing when the benchmark applications are not running as the reviewer\'s', async () => {
    const report = silent()

    await stepPerformance(context, report, { findBrowser: chromeAt, apiBenchmark: () => Promise.reject(new Error('must not run')) })

    expect(lines(report)).toEqual(['FAIL Benchmark applications are not running as the reviewer\'s'])
  }, TIMEOUT)
})

describe('review 04: functional checks', () => {
  async function serve(path: string) {
    const server = await createServer(loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'fatal' }), { logger: false })
    await server.listen({ host: '127.0.0.1', port: 0 })
    return { server, url: `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}` }
  }

  it('pass against an API serving the database, and fail, naming what differs, against one serving other data', async () => {
    await stepSeed(context, silent())
    const { server, url } = await serve(pair('benchmark').databasePath)
    try {
      const good = silent()
      await readOnlyChecks(good, { label: 'B', apiUrl: url, databasePath: pair('benchmark').databasePath }, await readSnapshot(pair('benchmark').databasePath))
      expect(good.lines.filter((l) => l.status !== 'PASS').map((l) => `${l.status} ${l.name}`)).toEqual(['SKIPPED B: frontend checks'])
      expect(good.count('PASS')).toBe(38)

      // The same API, judged against another database: every check that compares data fails.
      const bad = silent()
      await readOnlyChecks(bad, { label: 'B', apiUrl: url, databasePath: pair('scratch').databasePath }, await readSnapshot(pair('scratch').databasePath))
      expect(bad.exitCode).toBe(1)
      expect(bad.lines.find((l) => l.name === 'B: GET /trades/page, first page of 50')).toMatchObject({ status: 'FAIL', detail: 'totalCount is 300, expected 20' })
      expect(bad.lines.filter((l) => l.name.includes('is refused with 400')).every((l) => l.status === 'PASS')).toBe(true)
    } finally {
      await server.close()
    }
  }, TIMEOUT)

  it('book on a throwaway database of their own, and remove it', async () => {
    const report = silent()

    await bookingChecks(report, { dir: context.disposableDir, seed: pair('scratch').seed, count: 20, protection: context.protection })

    expect(report.lines.filter((l) => l.status !== 'PASS' && l.status !== 'INFO')).toEqual([])
    expect(report.count('PASS')).toBe(5)
    expect(readdirSync(context.disposableDir)).toEqual([])
  }, TIMEOUT)
})

describe('review 05: automated tests', () => {
  const VITEST = ' Test Files  2 passed (2)\n      Tests  10 passed | 1 skipped (11)\n'

  it('reads the test counts vitest prints, skipped tests included', () => {
    expect(testCounts(`\u001b[2m Test Files \u001b[22m 39 passed (39)\n\u001b[2m      Tests \u001b[22m 1386 passed (1386)\n`))
      .toBe('Test files: 39 passed (39); tests: 1386 passed (1386)')
    expect(testCounts(VITEST)).toBe('Test files: 2 passed (2); tests: 10 passed | 1 skipped (11)')
    expect(testCounts('eslint found nothing')).toBeUndefined()
  })

  it('runs every command with a log, reports skipped tests as not run, and stops at the first failure', async () => {
    const run: string[] = []
    const report = silent()

    await stepTests(context, report, {
      runCommand: (_command, args, _cwd, log) => {
        run.push(args.join(' '))
        mkdirSync(context.logsDir, { recursive: true })
        writeFileSync(log, args.includes('test') ? VITEST : 'done\n')
        return Promise.resolve(args.join(' ') === 'run test -w client' ? 1 : 0)
      },
    })

    expect(run).toEqual(['run lint', 'run typecheck', 'run build', 'run test -w server', 'run test -w client'])
    expect(lines(report)).toEqual([
      'PASS Lint (ESLint)', 'PASS Typecheck (tsc and vue-tsc)', 'PASS Build (API and frontend)', 'PASS Server tests (vitest)',
      'WARN Server tests (vitest): some tests were skipped, not run', 'FAIL Client tests (vitest): exit code 1',
      'INFO Stopped at the first failure; the commands after it were not run.',
    ])
    expect(report.lines[3]?.detail).toContain('tests: 10 passed | 1 skipped (11)')
    expect(report.exitCode).toBe(1)
  })

  const COMMANDS = ['PASS Lint (ESLint)', 'PASS Typecheck (tsc and vue-tsc)', 'PASS Build (API and frontend)', 'PASS Server tests (vitest)',
    'PASS Client tests (vitest)', 'PASS Schema check (migrations match the schema)']
  const passing = (_command: string, _args: readonly string[], _cwd: string, log: string): Promise<number> => {
    mkdirSync(dirname(log), { recursive: true })
    writeFileSync(log, 'done\n')
    return Promise.resolve(0)
  }
  const uiRun = (results: UiCheckRun['results'], consoleErrors: readonly string[] = []): UiCheckRun =>
    ({ browser: '/chrome', product: 'Chrome/1.0', results, screenshots: ['/out/ui-1280-trading.png'], consoleErrors })

  it('then checks the page in a real browser, one line per check, with where the screenshots are', async () => {
    const report = silent()
    const asked: string[] = []

    await stepTests(context, report, {
      runCommand: passing, findBrowser: chromeAt,
      uiChecks: (chrome, outDir) => {
        asked.push(chrome, outDir)
        return Promise.resolve(uiRun([{ name: 'Opens on the Trading tab' }, { name: 'Resizing by keyboard' }]))
      },
    })

    expect(lines(report)).toEqual([...COMMANDS, 'PASS UI: Opens on the Trading tab', 'PASS UI: Resizing by keyboard', 'PASS UI: no console errors',
      'INFO UI checks ran in Chrome/1.0'])
    expect(asked[0]).toBe('/chrome')
    expect(asked[1]?.startsWith(context.uiCheckDir)).toBe(true)
    expect(report.lines.at(-1)?.detail).toContain('/out/ui-1280-trading.png')
    expect(report.exitCode).toBe(0)
  })

  it('fails for a failed UI check, or console errors, with why', async () => {
    const report = silent()
    await stepTests(context, report, {
      runCommand: passing, findBrowser: chromeAt,
      uiChecks: () => Promise.resolve(uiRun([{ name: 'Tabs', problem: 'after End: Trading shown' }], ['TypeError: boom'])),
    })

    expect(lines(report).slice(COMMANDS.length)).toEqual(['FAIL UI: Tabs', 'FAIL UI: the page logged errors', 'INFO UI checks ran in Chrome/1.0'])
    expect(report.lines.find((line) => line.name === 'UI: Tabs')?.detail).toBe('after End: Trading shown')
    expect(report.exitCode).toBe(1)
  })

  it('reports the UI checks SKIPPED and the step INCOMPLETE without a browser: never passed', async () => {
    const report = silent()
    let ran = false
    await stepTests(context, report, { runCommand: passing, findBrowser: noBrowser, uiChecks: () => { ran = true; return Promise.resolve(uiRun([])) } })

    expect(ran).toBe(false)
    expect(lines(report).slice(COMMANDS.length)).toEqual(['SKIPPED UI checks in a real browser'])
    expect(report.lines.at(-1)?.detail).toContain('CHROME_PATH: not set')
    expect(report.exitCode).toBe(3)
    expect(report.summary()).toContain('INCOMPLETE: the UI checks were skipped (no browser)')
  })

  it('fails without running the UI checks when CHROME_PATH names no usable browser', async () => {
    const report = silent()
    await stepTests(context, report, {
      runCommand: passing,
      findBrowser: () => ({ kind: 'invalid-setting', message: 'CHROME_PATH is set to /nowhere, which is not found.' }),
      uiChecks: () => Promise.reject(new Error('must not run')),
    })

    expect(lines(report).slice(COMMANDS.length)).toEqual(['FAIL UI checks not run: CHROME_PATH does not name a usable browser'])
    expect(report.exitCode).toBe(1)
  })

  it('reports a UI check run that could not start as a failure', async () => {
    const report = silent()
    await stepTests(context, report, { runCommand: passing, findBrowser: chromeAt, uiChecks: () => Promise.reject(new Error('Chrome exited at startup.')) })

    expect(lines(report).slice(COMMANDS.length)).toEqual(['FAIL UI checks'])
    expect(report.lines.at(-1)?.detail).toBe('Chrome exited at startup.')
  })

  it('does not look for a browser when a command failed', async () => {
    const report = silent()
    let looked = false
    await stepTests(context, report, { runCommand: () => Promise.resolve(1), findBrowser: () => { looked = true; return chromeAt() } })
    expect(looked).toBe(false)
  })
})

describe('review 07: the development database', () => {
  it('reports it unchanged, or what changed, compared with step 01\'s fingerprint', async () => {
    const development = developmentDatabase()
    await stepSetup(context, silent(), { env: NPM, findBrowser: noBrowser })

    const unchanged = silent()
    await stepStop(context, unchanged)
    expect(unchanged.lines.find((l) => l.name.startsWith('Development database'))?.status).toBe('PASS')

    writeFileSync(`${development}-shm`, 'shared memory written by its own application')
    const changed = silent()
    await stepStop(context, changed)
    const line = changed.lines.find((l) => l.name.startsWith('Development database'))
    expect(line?.status).toBe('WARN')
    expect(line?.detail).toContain(`${development}-shm: absent -> present`)
  }, TIMEOUT)

  // Step 01 and step 07 can run from shells that spell the drive differently (c:\ and C:\).
  const fingerprint = (path: string, files: Record<string, string | undefined>): FileFingerprint =>
    ({ path, exists: files[path] !== undefined, files })
  const UPPER = 'C:\\repo\\server\\data\\trade-blotter.db'
  const LOWER = 'c:\\repo\\server\\data\\trade-blotter.db'

  it('matches files whose Windows paths differ only in the drive letter\'s case, and still reports real changes', () => {
    const before = fingerprint(UPPER, { [UPPER]: 'aa', [`${UPPER}-wal`]: 'bb' })

    expect(fingerprintChanges(before, fingerprint(LOWER, { [LOWER]: 'aa', [`${LOWER}-wal`]: 'bb', [`${LOWER}-shm`]: undefined }), 'win32')).toEqual([])
    expect(fingerprintChanges(before, fingerprint(LOWER, { [LOWER]: 'aa', [`${LOWER}-wal`]: 'cc', [`${LOWER}-shm`]: 'dd' }), 'win32'))
      .toEqual([`${LOWER}-wal: present -> changed`, `${LOWER}-shm: absent -> present`])
    expect(fingerprintChanges(before, fingerprint(LOWER, { [LOWER]: 'aa' }), 'win32')).toEqual([`${UPPER}-wal: present -> absent`])
  })

  it('keeps paths that differ in case apart on Linux and macOS', () => {
    const before = fingerprint('/data/Trades.db', { '/data/Trades.db': 'aa' })

    expect(fingerprintChanges(before, fingerprint('/data/Trades.db', { '/data/Trades.db': 'aa' }), 'linux')).toEqual([])
    expect(fingerprintChanges(before, fingerprint('/data/trades.db', { '/data/trades.db': 'aa' }), 'linux'))
      .toEqual(['/data/Trades.db: present -> absent', '/data/trades.db: absent -> present'])
  })

  it('compares step 01\'s fingerprint, recorded under another spelling of the drive, as the same file', async () => {
    const development = developmentDatabase()
    await stepSetup(context, silent(), { env: NPM, findBrowser: noBrowser })
    // Rewrite step 01's record as a shell with the other drive-letter case would have written it.
    // Elsewhere, a path in another case is another file, so the record names another database.
    const flip = (path: string): string => process.platform === 'win32'
      ? `${path.charAt(0) === path.charAt(0).toUpperCase() ? path.charAt(0).toLowerCase() : path.charAt(0).toUpperCase()}${path.slice(1)}`
      : join(dirname(path), basename(path).toUpperCase())
    const recorded = JSON.parse(readFileSync(context.baselineFile, 'utf8')) as FileFingerprint & { recordedAt: string }
    writeFileSync(context.baselineFile, JSON.stringify({
      ...recorded, path: flip(recorded.path), files: Object.fromEntries(Object.entries(recorded.files).map(([name, hash]) => [flip(name), hash])),
    }))

    const report = silent()
    await stepStop(context, report)
    const line = report.lines.find((l) => l.name.startsWith('Development database'))
    if (process.platform === 'win32') {
      expect(line?.status).toBe('PASS')
      writeFileSync(`${development}-shm`, 'shared memory written by its own application')
      const changed = silent()
      await stepStop(context, changed)
      const after = changed.lines.find((l) => l.name.startsWith('Development database'))
      expect(after?.status).toBe('WARN')
      expect(after?.detail).toBe(`${development}-shm: absent -> present\nThe reviewer workflow never opens it; your own application, if it ran meanwhile, would explain this.`)
    } else {
      expect(line?.name).toBe('Development database: step 01 fingerprinted another path')
      expect(line?.status).toBe('WARN')
    }
  }, TIMEOUT)

  it('cleans up whatever failed before: a pair that throws does not stop the other being stopped, left UI check databases are removed, the database is still compared', async () => {
    const run = join(context.uiCheckDir, '2026-11-12T10-00-00-000Z')
    mkdirSync(join(run, 'db-abc123'), { recursive: true })
    writeFileSync(join(run, 'db-abc123', 'ui-check.db'), 'left by an interrupted run')
    writeFileSync(join(run, 'ui-1280-trading.png'), 'a screenshot, kept')
    const seen: string[] = []
    const report = silent()

    await stepStop(context, report, {
      stopPair: (target) => {
        seen.push(target.name)
        if (target.name === 'benchmark') return Promise.reject(new Error('the record could not be read'))
        return Promise.resolve({ kind: 'not-started' })
      },
    })

    expect(seen).toEqual(['benchmark', 'scratch'])
    expect(lines(report)).toEqual([
      'FAIL Benchmark: stopping failed',
      'SKIPPED Scratch applications: none recorded',
      'PASS Removed 1 UI check database folder(s) left by an interrupted step 05',
      expect.stringMatching(/^(PASS|WARN) Development database/),
      `INFO Kept: ${context.root}`,
    ])
    expect(report.lines[0]?.detail).toMatch(/the record could not be read/)
    expect(existsSync(join(run, 'db-abc123'))).toBe(false)
    expect(existsSync(join(run, 'ui-1280-trading.png'))).toBe(true)
    expect(leftoverUiCheckDatabases(context.uiCheckDir)).toEqual([])
    expect(leftoverUiCheckDatabases(join(dir, 'no-such-folder'))).toEqual([])
  }, TIMEOUT)

  it('prepares databases only outside the protected folder', async () => {
    developmentDatabase()
    const outcome = prepareDatabase(context, { ...pair('benchmark'), databasePath: context.protection.developmentDatabase })

    await expect(outcome).rejects.toThrow(/is the development database/)
    expect(readFileSync(context.protection.developmentDatabase, 'utf8')).toBe('development database bytes')
  })
})
