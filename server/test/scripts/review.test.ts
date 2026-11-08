import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAlive, readState, startApps, StartError, statePath, stopApps, writeState, type AppLaunch } from '../../scripts/lifecycle.ts'
import { readSnapshot, type BenchmarkResult } from '../../scripts/perf-api.ts'
import { checkOwnership, startPair, stopPair } from '../../scripts/review-apps.ts'
import { bookingChecks, readOnlyChecks } from '../../scripts/review-checks.ts'
import { EXIT, fingerprintFiles, readBaseline, Report, reviewContext, type ReviewContext, type ReviewPair } from '../../scripts/review-context.ts'
import { inspectDataset, prepareDatabase } from '../../scripts/review-data.ts'
import { dependencyProblems, stepPerformance, stepSeed, stepSetup, stepStop, stepTests, testCounts } from '../../scripts/review-steps.ts'
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

    await stepSetup(context, report, { env: NPM, findBrowser: () => undefined })

    expect(report.failed).toBe(false)
    expect(lines(report)).toContain('PASS Benchmark database created and migrated')
    expect(lines(report)).toContain('PASS Scratch database created and migrated')
    expect(lines(report)).toContain('WARN No Chrome or Chromium found (CHROME_PATH, then the usual places)')
    for (const folder of ['logs', 'perf', 'disposable']) expect(existsSync(join(context.root, folder))).toBe(true)
    for (const target of context.pairs) expect(await inspectDataset(target)).toEqual({ kind: 'empty' })
    expect(readBaseline(context)).toMatchObject({ path: development, exists: true, files: { [development]: sha(development), [`${development}-wal`]: sha(`${development}-wal`) } })
    expect(report.exitCode).toBe(0)
  }, TIMEOUT)

  it('keeps existing databases exactly as they are when run again', async () => {
    await stepSetup(context, silent(), { env: NPM, findBrowser: () => '/chrome' })
    await stepSeed(context, silent())
    const before = context.pairs.map((target) => sha(target.databasePath))
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: () => '/chrome' })

    expect(context.pairs.map((target) => sha(target.databasePath))).toEqual(before)
    expect(lines(report)).toContain('PASS Benchmark database exists, kept as it is: its dataset of 300 trades')
    expect(lines(report)).toContain('PASS Browser for the UI benchmark: /chrome')
  }, TIMEOUT)

  it('reports an unexpected file without changing it, with how to recover', async () => {
    mkdirSync(context.root, { recursive: true })
    writeFileSync(pair('scratch').databasePath, 'not a database at all, but someone\'s file')
    const before = sha(pair('scratch').databasePath)
    const report = silent()

    await stepSetup(context, report, { env: NPM, findBrowser: () => undefined })

    expect(sha(pair('scratch').databasePath)).toBe(before)
    const line = report.lines.find((l) => l.name.startsWith('Scratch database is unexpected'))
    expect(line?.status).toBe('FAIL')
    expect(line?.detail).toContain('Nothing was changed')
    expect(line?.detail).toContain('db:clear')
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('refuses a reviewer folder that would put a database beside the development database', async () => {
    developmentDatabase()
    const inside = reviewContext({ root: join(dir, 'data'), counts: { benchmark: 10, scratch: 10 }, protection: context.protection })
    const report = silent()

    await stepSetup(inside, report, { env: NPM, findBrowser: () => undefined })

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
    await stepSetup(context, silent(), { env: NPM, findBrowser: () => undefined })
    const report = silent()

    await stepSeed(context, report)
    const seeded = context.pairs.map((target) => sha(target.databasePath))
    const again = silent()
    await stepSeed(context, again)

    expect(lines(report)).toHaveLength(2)
    expect(lines(report)[0]).toMatch(/^PASS Benchmark database seeded with its dataset of 300 trades in \d+\.\d s$/)
    expect(lines(report)[1]).toMatch(/^PASS Scratch database seeded with its dataset of 20 trades in \d+\.\d s$/)
    expect(lines(again)).toEqual([
      'PASS Benchmark database already holds its dataset of 300 trades; kept as it is',
      'PASS Scratch database already holds its dataset of 20 trades; kept as it is',
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
    expect(lines(report)).toContain('PASS Scratch database already holds its dataset of 20 trades, and 1 booked since; kept as it is')
  }, TIMEOUT)

  it('refuses a benchmark database with trades booked after seeding: it is only ever read', async () => {
    await stepSeed(context, silent())
    const db = openDatabase(pair('benchmark').databasePath)
    await createDrizzleTradeRepository(db).add(newTrade({ id: 'extra', symbol: 'ZZEXTRA' }))
    closeDatabase(db)
    const before = sha(pair('benchmark').databasePath)
    const report = silent()

    await stepSeed(context, report)

    expect(report.lines[0]).toMatchObject({ status: 'FAIL', name: expect.stringContaining('300 trades and 1 more') as string })
    expect(sha(pair('benchmark').databasePath)).toBe(before)
  }, TIMEOUT)

  it('refuses data that differs from the dataset, even with the right number of trades, and never reseeds it', async () => {
    await stepSeed(context, silent())
    const client = new DatabaseSync(pair('benchmark').databasePath)
    client.exec("update trades set price = '1.25' where booking_sequence = 7")
    client.close()
    const before = sha(pair('benchmark').databasePath)
    const report = silent()

    await stepSeed(context, report)

    expect(report.lines[0]?.status).toBe('FAIL')
    expect(report.lines[0]?.name).toMatch(/trade 7 in booking order differs from the dataset \(price is "1\.25"/)
    expect(report.lines[0]?.detail).toContain('Nothing was changed')
    expect(sha(pair('benchmark').databasePath)).toBe(before)
    expect(report.lines[1]?.status).toBe('PASS')
  }, TIMEOUT)

  it('never opens, migrates or changes the development database', async () => {
    const development = developmentDatabase()
    const before = fingerprintFiles(development)

    await stepSetup(context, silent(), { env: NPM, findBrowser: () => undefined })
    await stepSeed(context, silent())

    expect(fingerprintFiles(development)).toEqual(before)
    expect(readFileSync(development, 'utf8')).toBe('development database bytes')
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

    await stepPerformance(context, report, { ...trusted, findBrowser: () => undefined, apiBenchmark: () => Promise.resolve(fakeApiResult()) })

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

  it('fails, not incomplete, when a benchmark fails', async () => {
    await stepSeed(context, silent())
    await startFakes(pair('benchmark'))
    const report = silent()

    await stepPerformance(context, report, {
      ...trusted, findBrowser: () => '/chrome', apiBenchmark: () => Promise.resolve(fakeApiResult()),
      uiBenchmark: () => Promise.reject(new Error('the page shows 49 trades; expected 50')),
    })

    expect(lines(report)).toEqual(['PASS API benchmark: 1 scenarios on 300 trades, every response correct, data unchanged', 'FAIL UI benchmark'])
    expect(report.exitCode).toBe(1)
  }, TIMEOUT)

  it('measures nothing when the benchmark applications are not running as the reviewer\'s', async () => {
    const report = silent()

    await stepPerformance(context, report, { findBrowser: () => '/chrome', apiBenchmark: () => Promise.reject(new Error('must not run')) })

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
})

describe('review 07: the development database', () => {
  it('reports it unchanged, or what changed, compared with step 01\'s fingerprint', async () => {
    const development = developmentDatabase()
    await stepSetup(context, silent(), { env: NPM, findBrowser: () => undefined })

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

  it('prepares databases only outside the protected folder', async () => {
    developmentDatabase()
    const outcome = prepareDatabase(context, { ...pair('benchmark'), databasePath: context.protection.developmentDatabase })

    await expect(outcome).rejects.toThrow(/is the development database/)
    expect(readFileSync(context.protection.developmentDatabase, 'utf8')).toBe('development database bytes')
  })
})
