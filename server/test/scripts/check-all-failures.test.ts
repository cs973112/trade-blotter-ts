import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkAll, type CheckAllOptions, type CheckAllSummary } from '../../scripts/check-all.ts'
import { ensureTerminated, isAlive, portAnswers, processStatus, readState, startApps, stopApps, writeState, type AppLaunch, type OwnedProcess, type ProcessStatus } from '../../scripts/lifecycle.ts'
import { BenchmarkError } from '../../scripts/perf-api.ts'
import { stopPair } from '../../scripts/review-apps.ts'
import type { Report, ReviewContext, ReviewPair } from '../../scripts/review-context.ts'
import type { RunRecord, StepId } from '../../scripts/review-run.ts'
import { stepStop } from '../../scripts/review-steps.ts'
import { isolatedEnv, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * check:all (in the worker) when something goes wrong: a step that throws, a benchmark that throws, a
 * rejection nothing awaited (a browser connection closing), a step past its deadline, failures before and after the
 * applications start, clean-up that succeeds or fails, another program on a reviewer port, and
 * check:all's own bookkeeping failing. The applications are stand-ins (test/support/fake-app.ts)
 * started through the process manager on ports the system picks; step 07 is the real stepStop and
 * stopPair, which confirm each process by its token and its port before stopping it (only the
 * Trade Blotter identity check, which a stand-in cannot pass, is replaced, as in review.test.ts).
 * Every other step is a stand-in that reports as the real one would. No other process is stopped.
 */

const FAKE_APP = join(import.meta.dirname, '../support/fake-app.ts')
const TIMEOUT = 120_000
const trusted = { identity: () => Promise.resolve([]) }

let dir = ''
/** The context check:all made, as step 01 saw it. */
let context: ReviewContext | undefined
let children: OwnedProcess[] = []
let ports: { benchmark: [number, number]; scratch: [number, number] }

type StepFunction = (context: ReviewContext, report: Report) => Promise<void>

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

beforeEach(async () => {
  dir = createTempDir()
  context = undefined
  children = []
  const [a, b, c, d] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
  ports = { benchmark: [a, b], scratch: [c, d] }
})

afterEach(async () => {
  try {
    for (const pair of context?.pairs ?? []) await stopApps(pair.runDir).catch(() => undefined)
    // Every process a test started, identified by its token or handle, never by a bare id.
    await ensureTerminated(children, { timeoutMs: 20_000 })
  } finally {
    removeTempDir(dir)
  }
}, TIMEOUT)

function fakeLaunches(pair: ReviewPair): AppLaunch[] {
  return [['api', pair.apiPort], ['web', pair.webPort]].map(([name, port]) => {
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

/** Starts a pair's stand-in applications as review:03 would, through the process manager. */
async function startFakes(pair: ReviewPair): Promise<void> {
  const result = await startApps({ runDir: pair.runDir, databasePath: pair.databasePath, launches: fakeLaunches(pair), readyTimeoutMs: 30_000 })
  children.push(...result.state.apps.map((app) => ({ label: app.label, pid: app.pid, token: app.token, ports: [{ port: app.port, host: app.host }] })))
}

const started = (): { pid: number; token: string; port: number }[] => children.flatMap((child) => (child.token === undefined ? [] : [{ pid: child.pid, token: child.token, port: child.ports?.[0]?.port ?? 0 }]))

/**
 * The stand-in's status by its token, as the process manager judges it: running only while a
 * process with its id still has its token in its command line. A bare id is no proof either way
 * (Windows reports a process being torn down as alive, and reuses ids), so "unverified" (a process
 * with the id whose command line cannot be read) is checked again for a bounded time.
 */
async function ownedStatus(app: { pid: number; token: string }): Promise<ProcessStatus> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const status = processStatus(app)
    if (status !== 'unverified' || Date.now() >= deadline) return status
    await sleep(250)
  }
}

/** Every stand-in application this test started is no longer running, by its token, and its port is free again. */
async function expectStopped(): Promise<void> {
  expect(started()).toHaveLength(4)
  for (const app of started()) {
    // "stopped": no process has the id; "reused": the id now belongs to another program. Either way ours has gone.
    expect(['stopped', 'reused'], `process ${String(app.pid)}`).toContain(await ownedStatus(app))
    expect(await portAnswers(app.port, '127.0.0.1'), `port ${String(app.port)}`).toBe(false)
  }
}

const pass = (name: string): StepFunction => (_c, report) => { report.pass(name); return Promise.resolve() }

const steps = (overrides: Partial<Record<StepId, StepFunction>> = {}): Partial<Record<StepId, StepFunction>> => ({
  '01': (c, report) => { context = c; report.pass('Node.js v22.21.0 (verified)'); report.pass('npm 10.9.4'); return Promise.resolve() },
  '05': (_c, report) => {
    for (const name of ['Lint (ESLint)', 'Server tests (vitest)', 'Client tests (vitest)', 'Schema check (migrations match the schema)', 'UI: the page loads']) report.pass(name)
    return Promise.resolve()
  },
  '02': pass('Seeded'),
  '03': async (c, report) => {
    for (const pair of c.pairs) await startFakes(pair)
    report.pass('Benchmark and scratch applications started')
  },
  '04': pass('Booking checks'),
  '06': pass('UI benchmark'),
  // The real clean-up: ownership confirmed by token and port, bounded waits, ports checked released.
  '07': (c, report) => stepStop(c, report, { stopPair: (pair) => stopPair(pair, trusted) }),
  ...overrides,
})

async function run(overrides: Partial<CheckAllOptions> = {}): Promise<{ summary: CheckAllSummary; printed: string }> {
  const printed: string[] = []
  const summary = await checkAll({
    baseDir: join(dir, 'check-all'),
    ports,
    protection: { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'app-run') },
    print: (line) => { printed.push(line) },
    steps: steps(),
    failureDetection: () => Promise.resolve([]),
    documentation: () => Promise.resolve([{ status: 'PASS', name: 'API endpoints match' }]),
    environment: () => ({ node: 'v22.21.0', npm: '10.9.4', sqlite: '3.50.4', platform: 'win32', arch: 'x64' }),
    processEvents: new EventEmitter(),
    ...overrides,
  })
  return { summary, printed: printed.join('\n') }
}

const row = (summary: CheckAllSummary, id: string) => summary.categories.find((category) => category.id === id)
const failures = (summary: CheckAllSummary, id: string) => row(summary, id)?.lines.filter((line) => line.status === 'FAIL') ?? []
const stepCodes = (summary: CheckAllSummary) => summary.steps.map((entry) => [entry.id, entry.exitCode])
const runRecord = (summary: CheckAllSummary): RunRecord => JSON.parse(readFileSync(join(summary.runDir, 'review', 'logs', 'run.json'), 'utf8')) as RunRecord

/** What every failed run must leave: exit code 1, FAILED, the summary files and the logs. */
function expectFailedRun(summary: CheckAllSummary, printed: string): void {
  expect(summary).toMatchObject({ result: 'FAILED', exitCode: 1 })
  for (const file of ['summary.json', 'summary.txt', 'check-all.log', 'environment.json', 'review/logs/run.json', 'review/logs/review-01.log', 'review/logs/review-07.log']) {
    expect(existsSync(join(summary.runDir, file)), file).toBe(true)
  }
  const saved = JSON.parse(readFileSync(join(summary.runDir, 'summary.json'), 'utf8')) as CheckAllSummary
  expect(saved).toMatchObject({ result: 'FAILED', exitCode: 1, totals: summary.totals })
  expect(readFileSync(join(summary.runDir, 'summary.txt'), 'utf8')).toMatch(/RESULT: FAILED \(exit code 1\)\n$/)
  expect(printed).toMatch(/RESULT: FAILED \(exit code 1\)$/)
  expect(printed).not.toContain('PASSED: complete verification passed')
}

describe('check:all: a normal run with applications', () => {
  it('starts them in review:03, stops them in review:07 after confirming them, and passes', async () => {
    const { summary } = await run()

    expect(summary).toMatchObject({ result: 'PASSED', exitCode: 0, skipped: [], unexpectedErrors: [], abandoned: [] })
    expect(summary.totals).toEqual({ PASS: 14, FAIL: 0, WARN: 1, SKIPPED: 0 })
    expect(row(summary, 'stop')?.lines.filter((line) => line.status === 'PASS').map((line) => line.name)).toEqual([
      'Benchmark applications stopped after their identity was confirmed; ports released', 'Scratch applications stopped after their identity was confirmed; ports released'])
    await expectStopped()
    expect(existsSync(join(summary.runDir, 'unexpected-errors.log'))).toBe(false)
  }, TIMEOUT)
})

describe('check:all: a step that fails unexpectedly', () => {
  it('a reviewer step that throws after starting the applications: FAIL with its message, what needs it left out, the applications stopped', async () => {
    const { summary, printed } = await run({ steps: steps({ '03': async (c, report) => {
      for (const pair of c.pairs) await startFakes(pair)
      report.pass('Benchmark and scratch applications started')
      throw new Error('the frontend answered with an unreadable page')
    } }) })

    expectFailedRun(summary, printed)
    expect(failures(summary, 'data')).toMatchObject([{ name: 'Step 03 stopped by an unexpected error' }])
    expect(failures(summary, 'data')[0]?.detail).toMatch(/^Error: the frontend answered with an unreadable page\n/)
    expect(summary.skipped).toEqual(['review:04 Functional checks: not run: review:03 failed or did not run', 'review:06 Performance: not run: review:03 failed or did not run'])
    expect(stepCodes(summary)).toEqual([['01', 0], ['05', 0], ['02', 0], ['03', 1], ['04', 'not run'], ['06', 'not run'], ['07', 0]])
    expect(summary.totals).toEqual({ PASS: 12, FAIL: 1, WARN: 1, SKIPPED: 2 })
    expect(printed).toMatch(/Failures:\n {2}Seed and start \(review:02, 03\): Step 03 stopped by an unexpected error\n {6}Error: the frontend answered with an unreadable page\n {6}Log: \S+review-02\.log/)
    expect(printed).toMatch(/Not run:\n {2}review:04 Functional checks: not run: review:03 failed or did not run\n {2}review:06 Performance: not run/)
    expect(readFileSync(join(summary.runDir, 'review', 'logs', 'review-03.log'), 'utf8')).toContain('the frontend answered with an unreadable page')
    await expectStopped()
  }, TIMEOUT)

  it('a benchmark that throws: a FAIL of review:06 with the message, and review:07 still stops the applications', async () => {
    const { summary, printed } = await run({ steps: steps({ '06': () => Promise.reject(new BenchmarkError('No header button for Price (column 4)')) }) })

    expectFailedRun(summary, printed)
    expect(failures(summary, 'performance')).toMatchObject([{ name: 'Step 06 stopped by an unexpected error' }])
    expect(failures(summary, 'performance')[0]?.detail).toContain('No header button for Price (column 4)')
    expect(summary.totals).toEqual({ PASS: 13, FAIL: 1, WARN: 1, SKIPPED: 0 })
    expect(summary.skipped).toEqual([])
    expect(stepCodes(summary).at(-1)).toEqual(['07', 0])
    await expectStopped()
  }, TIMEOUT)

  it('a browser connection closing under a benchmark (a rejection nothing caught): recorded against review:06, which fails, and the run goes on to the clean-up and the summary', async () => {
    const events = new EventEmitter()
    const { summary, printed } = await run({ processEvents: events, steps: steps({ '06': async (_c, report) => {
      // As Chrome's socket closing did in M5: a promise rejected in an event handler, awaited by nothing.
      setImmediate(() => events.emit('unhandledRejection', new BenchmarkError('The connection to Chrome closed (Chrome exited or crashed).')))
      await sleep(50)
      report.pass('UI benchmark: every scenario measured')
    } }) })

    expectFailedRun(summary, printed)
    expect(summary.unexpectedErrors).toMatchObject([{ kind: 'unhandled rejection', during: 'review:06', message: 'BenchmarkError: The connection to Chrome closed (Chrome exited or crashed).' }])
    expect(failures(summary, 'performance').map((line) => line.name)).toEqual(['Unexpected error while review:06 ran (unhandled rejection): BenchmarkError: The connection to Chrome closed (Chrome exited or crashed).'])
    expect(summary.totals).toEqual({ PASS: 14, FAIL: 1, WARN: 1, SKIPPED: 0 })
    // The step's own result, its record and its log say it failed, though it reported no failure itself.
    expect(stepCodes(summary)).toContainEqual(['06', 1])
    expect(runRecord(summary).steps['06']).toMatchObject({ status: 'finished', exitCode: 1 })
    expect(readFileSync(join(summary.runDir, 'review', 'logs', 'review-06.log'), 'utf8')).toMatch(/UNEXPECTED unhandled rejection while this step ran \(nothing caught it\): .*The connection to Chrome closed/)
    expect(readFileSync(join(summary.runDir, 'unexpected-errors.log'), 'utf8')).toMatch(/unhandled rejection while review:06 ran\n.*The connection to Chrome closed/)
    expect(printed).toMatch(/Unexpected errors \(each also a failure above; full stacks in \S+unexpected-errors\.log\):\n {2}unhandled rejection while review:06 ran: BenchmarkError: The connection to Chrome closed/)
    expect(printed).toMatch(/FAILED {3}review:06 Performance: 1 PASS, 0 FAIL, 0 WARN, 0 SKIPPED, and 1 unexpected error/)
    // The listeners are removed when check:all returns.
    expect(events.listenerCount('unhandledRejection') + events.listenerCount('uncaughtException')).toBe(0)
    await expectStopped()
  }, TIMEOUT)

  it('a step past its deadline: a FAIL, no longer waited for, what it records later dropped, and the rest of the run goes on', async () => {
    const { summary, printed } = await run({ stepDeadlinesMs: { '04': 300 }, steps: steps({ '04': (_c, report) => {
      setTimeout(() => { report.pass('a check finished too late') }, 600)
      return new Promise<void>(() => undefined)
    } }) })
    await sleep(800)

    expectFailedRun(summary, printed)
    expect(summary.abandoned).toEqual(['04'])
    expect(failures(summary, 'functional')).toMatchObject([{ name: 'Step 04 stopped at its deadline' }])
    expect(failures(summary, 'functional')[0]?.detail).toMatch(/^review:04 did not finish within 0\.3 s, its deadline in check:all/)
    expect(stepCodes(summary)).toEqual([['01', 0], ['05', 0], ['02', 0], ['03', 0], ['04', 1], ['06', 0], ['07', 0]])
    expect(row(summary, 'functional')?.lines.map((line) => line.name)).not.toContain('a check finished too late')
    expect(readFileSync(join(summary.runDir, 'review', 'logs', 'review-04.log'), 'utf8')).not.toContain('a check finished too late')
    expect(printed).toContain('review:04 was still running at its deadline and is no longer waited for')
    await expectStopped()
  }, TIMEOUT)

  it('a failure before the applications start: what needs it is left out and named, and review:07 finds nothing to stop', async () => {
    const { summary, printed } = await run({ steps: steps({ '02': () => Promise.reject(new Error('the dataset could not be generated')) }) })

    expectFailedRun(summary, printed)
    expect(failures(summary, 'data')).toMatchObject([{ name: 'Step 02 stopped by an unexpected error' }])
    expect(summary.skipped).toEqual([
      'review:03 Start: not run: review:02 failed or did not run',
      'review:04 Functional checks: not run: review:02 and review:03 failed or did not run',
      'review:06 Performance: not run: review:02 and review:03 failed or did not run',
    ])
    expect(row(summary, 'stop')?.lines.filter((line) => line.status === 'SKIPPED').map((line) => line.name)).toEqual(['Benchmark applications: none recorded', 'Scratch applications: none recorded'])
    expect(summary.totals).toEqual({ PASS: 8, FAIL: 1, WARN: 1, SKIPPED: 4 })
    expect(children).toEqual([])
  }, TIMEOUT)

  it('an error in check:all\'s own bookkeeping: a FAIL of that step, and the clean-up, the checks after it and the summary still happen', async () => {
    const printed: string[] = []
    const { summary } = await run({ print: (line) => {
      if (line.startsWith('PASSED   review:04')) throw new Error('the terminal went away')
      printed.push(line)
    } })

    expectFailedRun(summary, printed.join('\n'))
    expect(failures(summary, 'functional')).toMatchObject([{ name: 'check:all could not finish review:04: Error: the terminal went away' }])
    expect(stepCodes(summary)).toEqual([['01', 0], ['05', 0], ['02', 0], ['03', 0], ['04', 1], ['06', 0], ['07', 0]])
    await expectStopped()
  }, TIMEOUT)

  it('failure detection or the documentation checks throwing: a FAIL each, and the summary is still written', async () => {
    const { summary, printed } = await run({
      failureDetection: () => Promise.reject(new Error('the temporary copy could not be made')),
      documentation: () => Promise.reject(new Error('README.md could not be read')),
    })

    expectFailedRun(summary, printed)
    expect(failures(summary, 'failure-detection').map((line) => line.name)).toEqual(['Failure detection stopped by an unexpected error: Error: the temporary copy could not be made'])
    expect(failures(summary, 'documentation').map((line) => line.name)).toEqual(['The documentation checks stopped by an unexpected error: Error: README.md could not be read'])
    await expectStopped()
  }, TIMEOUT)
})

describe('check:all: clean-up', () => {
  it('a rejection nothing awaited during review:07 does not interrupt the clean-up', async () => {
    const events = new EventEmitter()
    const { summary, printed } = await run({ processEvents: events, steps: steps({ '07': async (c, report) => {
      events.emit('unhandledRejection', new Error('a late request from an earlier step was rejected'))
      await stepStop(c, report, { stopPair: (pair) => stopPair(pair, trusted) })
    } }) })

    expectFailedRun(summary, printed)
    expect(summary.unexpectedErrors).toMatchObject([{ kind: 'unhandled rejection', during: 'review:07' }])
    expect(failures(summary, 'stop').map((line) => line.name)).toContain('Unexpected error while review:07 ran (unhandled rejection): Error: a late request from an earlier step was rejected')
    await expectStopped()
  }, TIMEOUT)

  it('an uncaught exception is not listened for in check:all: it is left to end the worker (see check-all-supervisor.test.ts)', async () => {
    const events = new EventEmitter()
    const listeners: number[] = []
    await run({ processEvents: events, steps: steps({ '04': (_c, report) => {
      listeners.push(events.listenerCount('uncaughtException'), events.listenerCount('unhandledRejection'))
      report.pass('Booking checks')
      return Promise.resolve()
    } }) })

    expect(listeners).toEqual([0, 1])
    await expectStopped()
  }, TIMEOUT)

  it('clean-up that fails: a FAIL, every application of the run still running named with how to stop it, exit code 1', async () => {
    const { summary, printed } = await run({ steps: steps({ '07': (c, report) => stepStop(c, report, {
      stopPair: () => Promise.resolve({ kind: 'refused', problems: ['API process 1234: still-running'] }),
    }) }) })

    expectFailedRun(summary, printed)
    expect(failures(summary, 'stop').map((line) => line.name)).toEqual([
      'Benchmark: not stopped, left running', 'Scratch: not stopped, left running', 'Applications this run started are still running after review:07 (4)'])
    const left = failures(summary, 'stop').at(-1)?.detail ?? ''
    for (const app of started()) expect(left).toContain(`process ${String(app.pid)}, port ${String(app.port)} (running, its token confirmed)`)
    expect(left).toContain(`stop it with npm run app:stop with TRADE_BLOTTER_RUN_DIR set to ${context?.pairs[0]?.runDir ?? '?'}`)
    expect(printed).toMatch(/FAILED {3}Clean-up: 4 of this run's applications still running/)
    // Nothing was stopped by check:all: the test's own clean-up stops them through app:stop's checks.
    for (const app of started()) expect(processStatus(app), `process ${String(app.pid)}`).toBe('running')
  }, TIMEOUT)

  it('clean-up past its deadline: a FAIL, and the applications still running are named', async () => {
    const { summary, printed } = await run({ stepDeadlinesMs: { '07': 300 }, steps: steps({ '07': () => new Promise<void>(() => undefined) }) })

    expectFailedRun(summary, printed)
    expect(summary.abandoned).toEqual(['07'])
    expect(failures(summary, 'stop').map((line) => line.name)).toEqual(['Step 07 stopped at its deadline', 'Applications this run started are still running after review:07 (4)'])
  }, TIMEOUT)

  it('another program on a reviewer port: nothing is started on it, nothing stops it, and it keeps its port', async () => {
    const holder = startNode(['-e', `require('node:net').createServer().listen(${String(ports.benchmark[0])}, '127.0.0.1', () => console.log('listening'))`], isolatedEnv({ DATABASE_PATH: join(dir, 'other.db') }))
    children.push({ label: 'another program', pid: holder.pid ?? 0, handle: holder })
    await new Promise<void>((resolve) => holder.stdout?.once('data', () => { resolve() }))
    try {
      const { summary, printed } = await run({ steps: steps({
        '03': async (c) => {
          // A record in the scratch pair's folder naming that program's id, with a token it does not have.
          const [benchmark, scratch] = c.pairs
          mkdirSync(scratch.runDir, { recursive: true })
          writeState(scratch.runDir, {
            version: 1, startedAt: '2026-11-21T00:00:00.000Z', phase: 'ready', databasePath: scratch.databasePath,
            apps: [{ name: 'api', label: 'API', pid: holder.pid ?? 0, token: 'eeeeeeee-0000-4000-8000-000000000000', host: '127.0.0.1', port: scratch.apiPort, url: '', log: '' },
              { name: 'web', label: 'Frontend', pid: holder.pid ?? 0, token: 'ffffffff-0000-4000-8000-000000000000', host: '127.0.0.1', port: scratch.webPort, url: '', log: '' }],
          })
          // Then the benchmark pair, on the port the other program holds.
          await startFakes(benchmark)
        },
      }) })

      expectFailedRun(summary, printed)
      expect(failures(summary, 'data')[0]?.detail).toMatch(/already in use by another process/)
      expect(failures(summary, 'stop').map((line) => line.name)).toEqual(['Scratch: not stopped, left running'])
      expect(failures(summary, 'stop')[0]?.detail).toMatch(/its id now belongs to another program/)
      // The program is alive and still holds its port; its record is kept, untouched.
      expect(isAlive(holder.pid ?? 0)).toBe(true)
      expect(await portAnswers(ports.benchmark[0], '127.0.0.1')).toBe(true)
      expect(readState(context?.pairs[1]?.runDir ?? '')?.apps[0]?.pid).toBe(holder.pid)
    } finally {
      await stopChild(holder)
    }
  }, TIMEOUT)
})
