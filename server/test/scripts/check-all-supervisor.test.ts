import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CheckAllSummary } from '../../scripts/check-all.ts'
import { sha256, type WorkerState } from '../../scripts/check-all-worker.ts'
import { judgeWorkerOutcome, superviseCheckAll, type CrashSummary, type SupervisedRun, type SuperviseOptions } from '../../scripts/check-all-supervisor.ts'
import { ensureTerminated, isAlive, portAnswers, processStatus, readState, stopApps, type OwnedProcess, type ProcessStatus } from '../../scripts/lifecycle.ts'
import { stopPair } from '../../scripts/review-apps.ts'
import { isolatedEnv, startNode, stopChild, type ChildProcess } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * The check:all supervisor with a real worker process: the real runWorker and checkAll, with
 * stand-in steps (test/support/check-all-stand-in-worker.ts) that start stand-in applications through
 * the process manager on ports the system picks. The supervisor is the real one; its clean-up is
 * step 07's real stepStop and stopPair (only the Trade Blotter identity check, which a stand-in
 * cannot pass, is replaced, as in review.test.ts). Ctrl+C and SIGTERM come from a stand-in signal
 * source: Windows cannot send Ctrl+C to one process, and the test process must not receive them.
 * Every process a test starts is stopped by its handle or its token, never by a bare id.
 */

const STAND_IN = join(import.meta.dirname, '../support/check-all-stand-in-worker.ts')
const TIMEOUT = 180_000
const trusted = { identity: () => Promise.resolve([]) }

let dir = ''
let ports: { benchmark: [number, number]; scratch: [number, number] }
let worker: ChildProcess | undefined
let runDir = ''
let others: OwnedProcess[] = []

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
  worker = undefined
  runDir = ''
  others = []
  const [a, b, c, d] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
  ports = { benchmark: [a, b], scratch: [c, d] }
})

afterEach(async () => {
  try {
    // The worker by its handle; the applications through app:stop's checks; anything else by its token.
    if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) await ensureTerminated([{ label: 'worker', pid: worker.pid ?? 0, handle: worker }], { timeoutMs: 20_000 })
    if (runDir !== '') for (const pair of ['benchmark', 'scratch']) await stopApps(join(runDir, 'review', 'run', pair)).catch(() => undefined)
    await ensureTerminated([...apps().map((app) => ({ label: 'stand-in app', pid: app.pid, token: app.token, ports: [{ port: app.port, host: '127.0.0.1' }] })), ...others], { timeoutMs: 20_000 })
  } finally {
    removeTempDir(dir)
  }
}, TIMEOUT)

interface Supervised {
  readonly run: SupervisedRun
  readonly printed: string
  readonly output: string
  readonly errors: string
}

async function supervise(scenario: string, overrides: Partial<SuperviseOptions> = {}, extra: readonly string[] = []): Promise<Supervised> {
  const printed: string[] = []
  const output: string[] = []
  const errors: string[] = []
  const run = await superviseCheckAll({
    baseDir: join(dir, 'check-all'),
    ports,
    protection: { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'app-run') },
    worker: { script: STAND_IN, args: ['--scenario', scenario, ...extra] },
    output: (text) => { output.push(text) },
    print: (line) => { printed.push(line) },
    printError: (text) => { errors.push(text) },
    signals: new EventEmitter(),
    stopDependencies: { stopPair: (pair) => stopPair(pair, trusted) },
    buildCopiesRoots: [join(dir, 'server'), join(dir, 'client')],
    graceMs: 2_000,
    pollMs: 100,
    onWorker: (child) => { worker = child },
    ...overrides,
  })
  runDir = run.runDir
  return { run, printed: printed.join('\n'), output: output.join(''), errors: errors.join('') }
}

/** The stand-in applications the worker started, from the list it keeps. */
function apps(): { pid: number; token: string; port: number }[] {
  const file = join(runDir, 'stand-in-apps.jsonl')
  if (runDir === '' || !existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { pid: number; token: string; port: number })
}

async function ownedStatus(app: { pid: number; token: string }): Promise<ProcessStatus> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const status = processStatus(app)
    if (status !== 'unverified' || Date.now() >= deadline) return status
    await sleep(250)
  }
}

/** Every stand-in application of the run has gone, by its token, and its port is free. */
async function expectStopped(count = 4): Promise<void> {
  expect(apps()).toHaveLength(count)
  for (const app of apps()) {
    expect(['stopped', 'reused'], `process ${String(app.pid)}`).toContain(await ownedStatus(app))
    expect(await portAnswers(app.port, '127.0.0.1'), `port ${String(app.port)}`).toBe(false)
  }
}

const file = (name: string): string => readFileSync(join(runDir, name), 'utf8')
const crashOf = (supervised: Supervised): CrashSummary => {
  expect(supervised.run.crash).toBeDefined()
  return supervised.run.crash as CrashSummary
}

/** What every run the worker did not finish must leave: FAILED, exit code 1, both summaries, the evidence, no PASS for anything unfinished. */
function expectCrashed(supervised: Supervised, options: { readonly workerPrintedPass?: boolean } = {}): CrashSummary {
  const crash = crashOf(supervised)
  expect(supervised.run).toMatchObject({ exitCode: 1, accepted: false })
  expect(crash).toMatchObject({ result: 'FAILED', exitCode: 1, worker: { completed: false } })
  expect(JSON.parse(file('summary.json'))).toEqual(crash)
  expect(file('summary.txt')).toMatch(/RESULT: FAILED: check:all did not complete \(exit code 1\)\n$/)
  expect(supervised.printed).toMatch(/RESULT: FAILED: check:all did not complete \(exit code 1\)$/)
  expect(supervised.printed).not.toContain('PASSED: complete verification passed')
  // Only a worker that finished its summary before it stopped has printed a result of its own.
  if (options.workerPrintedPass !== true) expect(supervised.output).not.toContain('PASSED: complete verification passed')
  for (const name of ['worker-crash.json', 'worker-state.json', 'worker-config.json', 'check-all.log']) expect(existsSync(join(runDir, name)), name).toBe(true)
  return crash
}

describe('check:all supervisor: a worker that finishes', () => {
  it.each([
    ['pass', 0, 'PASSED', /RESULT: PASSED: complete verification passed \(exit code 0\)/],
    ['fail', 1, 'FAILED', /RESULT: FAILED \(exit code 1\)/],
    ['incomplete', 3, 'INCOMPLETE', /RESULT: INCOMPLETE: a required part could not run .* \(exit code 3\)/],
  ] as const)('%s: its own summary, output and exit code (%i) stand, and the supervisor adds nothing', async (scenario, exitCode, result, verdict) => {
    const supervised = await supervise(scenario)

    expect(supervised.run).toMatchObject({ exitCode, accepted: true, endNow: false })
    expect(supervised.run.crash).toBeUndefined()
    expect(supervised.printed).toBe('')
    expect(supervised.output).toMatch(verdict)
    const summary = JSON.parse(file('summary.json')) as CheckAllSummary
    expect(summary).toMatchObject({ tool: 'check:all', runId: supervised.run.runId, result, exitCode })
    expect(existsSync(join(runDir, 'worker-crash.json'))).toBe(false)
    expect(JSON.parse(file('worker-state.json'))).toMatchObject({ state: 'finished', exitCode, pid: worker?.pid })
    await expectStopped()
  }, TIMEOUT)

  it('a slow step, within its deadline, is waited for however long past the grace period it takes', async () => {
    const supervised = await supervise('slow', { stepDeadlinesMs: { '04': 6_000 }, graceMs: 500 })

    expect(supervised.run).toMatchObject({ exitCode: 0, accepted: true })
    await expectStopped()
  }, TIMEOUT)

  it('an unhandled rejection is recorded in the worker, which goes on: its run FAILED, the applications stopped by step 07', async () => {
    const supervised = await supervise('rejection')

    expect(supervised.run).toMatchObject({ exitCode: 1, accepted: true })
    const summary = JSON.parse(file('summary.json')) as CheckAllSummary
    expect(summary.result).toBe('FAILED')
    expect(summary.unexpectedErrors).toMatchObject([{ kind: 'unhandled rejection', during: 'review:04', message: 'Error: The connection to Chrome closed (Chrome exited or crashed). [stand-in]' }])
    expect(summary.steps.map((step) => [step.id, step.exitCode])).toContainEqual(['07', 0])
    expect(file('unexpected-errors.log')).toMatch(/unhandled rejection while review:04 ran/)
    await expectStopped()
  }, TIMEOUT)
})

describe('check:all supervisor: a worker that does not finish', () => {
  it('an uncaught exception ends the worker, which does not go on; the supervisor stops the applications by their tokens and reports FAILED', async () => {
    const supervised = await supervise('fatal')
    // Long after the step would have gone on, had the worker survived.
    await sleep(2_000)

    const crash = expectCrashed(supervised)
    expect(existsSync(join(runDir, 'stand-in-resumed'))).toBe(false)
    expect(worker?.exitCode).not.toBe(0)
    expect(crash.worker).toMatchObject({ reason: 'fatal exception', confirmedStopped: true, fatalError: { origin: 'uncaughtException', phase: 'review:04', message: 'Error: thrown from a timer during review:04 [stand-in]' } })
    // Nothing after the exception ran in the worker: no step 06 or 07 log, its state still at review:04.
    expect(existsSync(join(runDir, 'review', 'logs', 'review-06.log'))).toBe(false)
    expect(JSON.parse(file('worker-state.json'))).toMatchObject({ state: 'running', phase: { label: 'review:04' } })
    expect(JSON.parse(file('worker-fatal.json'))).toMatchObject({ origin: 'uncaughtException', phase: 'review:04', runId: supervised.run.runId })
    expect(file('worker-stderr.log')).toContain('thrown from a timer during review:04 [stand-in]')
    expect(file('unexpected-errors.log')).toMatch(/uncaught exception while review:04 ran; it ends the worker/)
    // What finished, what was running, what never ran: no PASS for anything unfinished.
    expect(crash.phases.completed.map((part) => [part.name, part.exitCode])).toEqual([['review:01 Setup', 0], ['review:05 Automated tests', 0], ['review:02 Seed', 0], ['review:03 Start', 0]])
    expect(crash.phases.interrupted).toMatchObject({ name: 'review:04' })
    expect(crash.phases.notRun).toEqual([
      'review:06 Performance: not run, the worker had stopped',
      'review:07 Stop: not run, the worker had stopped (the supervisor\'s clean-up above ran step 07\'s stepStop in its place)',
      'Failure detection: not run, the worker had stopped', 'Documentation consistency: not run, the worker had stopped'])
    expect(crash.cleanup).toMatchObject({ ran: true, finished: true })
    expect(crash.cleanup.lines.filter((line) => line.status === 'PASS').map((line) => line.name)).toEqual([
      'Benchmark applications stopped after their identity was confirmed; ports released', 'Scratch applications stopped after their identity was confirmed; ports released'])
    expect(crash.remaining).toMatchObject({ applications: [], temporaryFolders: [] })
    expect(supervised.printed).toMatch(/Running when it stopped \(a FAIL; its partial results are only in its log\):\n {2}FAILED {4}review:04/)
    await expectStopped()
  }, TIMEOUT)

  it('a worker killed from outside: FAILED, the applications stopped', async () => {
    const pending = supervise('wait')
    await waitFor(() => existsSync(join(findRunDir(), 'stand-in-waiting')))
    worker?.kill('SIGKILL')
    const supervised = await pending

    const crash = expectCrashed(supervised)
    expect(crash.worker.reason).toBe('killed')
    expect(crash.phases.interrupted).toMatchObject({ name: 'review:04' })
    await expectStopped()
  }, TIMEOUT)

  it('a worker whose event loop is blocked: stopped at the hard deadline (its step\'s deadline and the grace period), then the clean-up', async () => {
    const begun = Date.now()
    const supervised = await supervise('blocked', { stepDeadlinesMs: { '04': 300 }, graceMs: 1_500 })

    const crash = expectCrashed(supervised)
    expect(existsSync(join(runDir, 'stand-in-blocking'))).toBe(true)
    expect(crash.worker).toMatchObject({ reason: 'hard deadline', confirmedStopped: true })
    expect(crash.worker.detail).toMatch(/^review:04 was still running after \d+\.\d s: its limit is 0\.3 s and the grace period 1\.5 s; the supervisor stopped the worker$/)
    expect(Date.now() - begun).toBeLessThan(90_000)
    await expectStopped()
  }, TIMEOUT)

  it('a worker that cannot be confirmed stopped: reported, nothing is cleaned up under it, the applications are listed with how to stop them', async () => {
    const supervised = await supervise('blocked', {
      stepDeadlinesMs: { '04': 300 }, graceMs: 1_000,
      terminateWorker: () => Promise.resolve({ confirmed: false, detail: 'still-alive: refused [stand-in]' }),
    })

    const crash = expectCrashed(supervised)
    expect(supervised.run.endNow).toBe(true)
    expect(crash.worker).toMatchObject({ reason: 'hard deadline', confirmedStopped: false })
    expect(crash.worker.detail).toContain('the worker could not be confirmed stopped (still-alive: refused [stand-in])')
    expect(crash.cleanup).toMatchObject({ ran: false, lines: [{ status: 'FAIL', name: 'Clean-up not started: the worker could not be confirmed stopped' }] })
    expect(crash.remaining.applications).toHaveLength(4)
    for (const line of crash.remaining.applications) expect(line).toMatch(/running, its token confirmed\); stop it with npm run app:stop with TRADE_BLOTTER_RUN_DIR set to /)
    // Nothing was stopped: the worker and the applications still run (the test's clean-up stops them by handle and token).
    expect(worker?.exitCode).toBeNull()
    for (const app of apps()) expect(processStatus(app)).toBe('running')
  }, TIMEOUT)

  it('a worker that exits without a summary: FAILED, with why its run was not accepted', async () => {
    const supervised = await supervise('exit-without-summary')

    const crash = expectCrashed(supervised)
    expect(crash.worker).toMatchObject({ reason: 'exited without a summary it can vouch for', exitCode: 1 })
    expect(crash.worker.summaryProblems).toEqual(expect.arrayContaining(['there is no summary.json', 'the worker\'s state is running, not finished (last phase: review:04)']))
    await expectStopped()
  }, TIMEOUT)

  it('an uncaught exception after review:07: the clean-up finds nothing left to stop, and what finished keeps its results', async () => {
    const supervised = await supervise('fatal-after-07')

    const crash = expectCrashed(supervised)
    expect(existsSync(join(runDir, 'stand-in-resumed'))).toBe(false)
    expect(crash.worker.fatalError?.phase).toBe('the documentation checks')
    expect(crash.phases.completed.map((part) => part.name)).toEqual(['review:01 Setup', 'review:05 Automated tests', 'review:02 Seed', 'review:03 Start', 'review:04 Functional checks', 'review:06 Performance', 'review:07 Stop', 'Failure detection'])
    expect(crash.phases.interrupted).toMatchObject({ name: 'the documentation checks' })
    expect(crash.phases.notRun).toEqual([])
    expect(crash.cleanup.lines.filter((line) => line.status === 'FAIL')).toEqual([])
    expect(crash.remaining.applications).toEqual([])
    await expectStopped()
  }, TIMEOUT)

  it('an uncaught exception after the summary: the worker\'s summary is not accepted, and is kept', async () => {
    const supervised = await supervise('fatal-after-summary')

    const crash = expectCrashed(supervised, { workerPrintedPass: true })
    expect(crash.worker.workerResult).toBe('PASSED')
    expect(supervised.printed).toContain('The worker had already printed its own result (PASSED) above; it is not accepted, because the worker recorded a fatal error')
    expect(crash.worker.reason).toBe('fatal exception')
    expect(crash.worker.summaryProblems).toContain('the worker recorded a fatal error')
    expect(JSON.parse(file('worker-summary.json'))).toMatchObject({ result: 'PASSED', exitCode: 0 })
    expect(crash.phases.interrupted).toBeUndefined()
    expect(crash.phases.completed.map((part) => part.name)).toContain('Documentation consistency')
    await expectStopped()
  }, TIMEOUT)

  it('a crash during failure detection: this run\'s temporary copies, server and client, are kept and named, another run\'s is untouched, and a process still using one is listed, not stopped', async () => {
    const copies = join(dir, 'server')
    const clientCopies = join(dir, 'client')
    const supervised = await supervise('fatal-in-detection', {}, ['--copies', copies, '--client-copies', clientCopies])
    const left = JSON.parse(file('stand-in-leftover.json')) as { pid: number; token: string }
    others.push({ label: 'leftover', pid: left.pid, token: left.token })

    const crash = expectCrashed(supervised)
    const mine = join(copies, `.test-build-check-${supervised.run.runId.replace(/[^a-zA-Z0-9-]/g, '')}-audit-update-recorded-as-update`)
    const another = join(copies, '.test-build-check-20990101T000000.000Z-000000-audit-update-recorded-as-update')
    const mineClient = join(clientCopies, `.test-build-check-${supervised.run.runId.replace(/[^a-zA-Z0-9-]/g, '')}-client-actual-position-executed-only`)
    expect(crash.remaining.temporaryFolders).toEqual([mine, mineClient])
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(mineClient)).toBe(true)
    expect(existsSync(another)).toBe(true)
    expect(crash.remaining.processesListed).toBe(true)
    expect(crash.remaining.processes.map((entry) => entry.pid)).toContain(left.pid)
    expect(crash.instructions.join('\n')).toContain(`Kept, because a process of this run may still be using them: ${mine}`)
    expect(await ownedStatus(left)).toBe('running')
    await expectStopped()
  }, TIMEOUT)
})

describe('check:all supervisor: clean-up after a crash', () => {
  it('clean-up refused: a FAIL, each application still running named with how to stop it, exit code 1', async () => {
    const supervised = await supervise('fatal', { stopDependencies: { stopPair: () => Promise.resolve({ kind: 'refused', problems: ['API process 1234: still-running [stand-in]'] }) } })

    const crash = expectCrashed(supervised)
    expect(crash.cleanup.lines.filter((line) => line.status === 'FAIL').map((line) => line.name)).toEqual(['Benchmark: not stopped, left running', 'Scratch: not stopped, left running'])
    expect(crash.remaining.applications).toHaveLength(4)
    for (const app of apps()) expect(crash.remaining.applications.join('\n')).toContain(`process ${String(app.pid)}, port ${String(app.port)} (running, its token confirmed)`)
    expect(supervised.printed).toContain('4 of this run\'s applications still running')
    for (const app of apps()) expect(processStatus(app)).toBe('running')
  }, TIMEOUT)

  it('clean-up past its deadline: a FAIL, no longer waited for, what is still running named', async () => {
    const supervised = await supervise('fatal', { cleanupDeadlineMs: 500, stopDependencies: { stopPair: () => new Promise(() => undefined) } })

    const crash = expectCrashed(supervised)
    expect(supervised.run.endNow).toBe(true)
    expect(crash.cleanup).toMatchObject({ ran: true, finished: false })
    expect(crash.cleanup.lines.map((line) => line.name)).toContain('The clean-up did not finish within 0.5 s')
    expect(crash.remaining.applications).toHaveLength(4)
  }, TIMEOUT)

  it('another program named in a record: not stopped, and it keeps its port; this run\'s own applications are stopped', async () => {
    const holderPort = await freePort()
    const holder = startNode(['-e', `require('node:net').createServer().listen(${String(holderPort)}, '127.0.0.1', () => console.log('listening'))`], isolatedEnv({ DATABASE_PATH: join(dir, 'other.db') }))
    others.push({ label: 'another program', pid: holder.pid ?? 0, handle: holder })
    await new Promise<void>((resolve) => holder.stdout?.once('data', () => { resolve() }))
    try {
      const supervised = await supervise('foreign', {}, ['--holder', String(holder.pid)])

      const crash = expectCrashed(supervised)
      expect(crash.cleanup.lines.filter((line) => line.status === 'FAIL').map((line) => line.name)).toEqual(['Scratch: not stopped, left running'])
      expect(crash.cleanup.lines.find((line) => line.status === 'FAIL')?.detail).toMatch(/its id now belongs to another program/)
      expect(isAlive(holder.pid ?? 0)).toBe(true)
      expect(await portAnswers(holderPort, '127.0.0.1')).toBe(true)
      expect(readState(join(runDir, 'review', 'run', 'scratch'))?.apps[0]?.pid).toBe(holder.pid)
      await expectStopped(2)
    } finally {
      await stopChild(holder)
    }
  }, TIMEOUT)
})

describe('check:all supervisor: the summary and interruptions', () => {
  it('summary.json cannot be written: the summary is in summary.txt and printed, exit code 1', async () => {
    const supervised = await supervise('exit-without-summary', { writeFile: (path, text) => {
      if (path.endsWith('summary.json')) throw new Error('disk full [stand-in]')
      writeFileSync(path, text)
    } })

    expect(supervised.run).toMatchObject({ exitCode: 1, accepted: false })
    expect(existsSync(join(runDir, 'summary.json'))).toBe(false)
    expect(file('summary.txt')).toMatch(/RESULT: FAILED: check:all did not complete \(exit code 1\)\n$/)
    expect(supervised.printed).toContain('summary.json could not be written (Error: disk full [stand-in])')
    await expectStopped()
  }, TIMEOUT)

  it('neither summary can be written: said on standard error, exit code 1', async () => {
    const supervised = await supervise('exit-without-summary', { writeFile: () => { throw new Error('disk full [stand-in]') } })

    expect(supervised.run).toMatchObject({ exitCode: 1, accepted: false })
    expect(supervised.errors).toContain('neither summary.json nor summary.txt could be written')
    expect(supervised.printed).toMatch(/RESULT: FAILED: check:all did not complete \(exit code 1\)$/)
    await expectStopped()
  }, TIMEOUT)

  it.each(['SIGINT', 'SIGTERM'] as const)('%s: the worker is stopped through its handle, the applications are stopped, and the run is FAILED (interrupted)', async (signal) => {
    const signals = new EventEmitter()
    const pending = supervise('wait', { signals })
    await waitFor(() => existsSync(join(findRunDir(), 'stand-in-waiting')))
    signals.emit(signal)
    const supervised = await pending

    const crash = expectCrashed(supervised)
    expect(crash.worker).toMatchObject({ reason: 'interrupted', confirmedStopped: true })
    expect(crash.worker.detail).toBe(`check:all was interrupted (${signal}); the worker was stopped by the supervisor`)
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0)
    await expectStopped()
  }, TIMEOUT)

  it('a second Ctrl+C ends the supervisor at once, saying what may be left and how to stop it', async () => {
    const signals = new EventEmitter()
    const exits: number[] = []
    const pending = supervise('wait', { signals, exitNow: (code) => { exits.push(code) } })
    await waitFor(() => existsSync(join(findRunDir(), 'stand-in-waiting')))
    signals.emit('SIGINT')
    signals.emit('SIGINT')
    const supervised = await pending

    expect(exits).toEqual([1])
    expect(supervised.errors).toMatch(/SIGINT again; stopping now, before the clean-up has finished\. This run's applications may still be running: stop each pair with npm run app:stop/)
    await expectStopped()
  }, TIMEOUT)
})

describe('check:all supervisor: whether a worker\'s summary stands', () => {
  const summaryText = `${JSON.stringify({ tool: 'check:all', runId: 'run-1', result: 'PASSED', exitCode: 0, finishedAt: '2026-11-21T00:00:00.000Z' })}\n`
  const state = (changes: Partial<WorkerState> = {}): WorkerState => ({
    tool: 'check:all worker', version: 1, runId: 'run-1', workerToken: 'token-1', pid: 42, startedAt: '', state: 'finished',
    phase: { label: 'finished', limitMs: 1, startedAt: '' }, steps: [], sections: [], unexpectedErrors: [], exitCode: 0, summarySha256: sha256(summaryText), ...changes,
  })
  const input = { runId: 'run-1', workerToken: 'token-1', pid: 42, exitCode: 0, signal: null, state: state(), fatal: false, summaryText }

  it('stands when everything agrees', () => {
    expect(judgeWorkerOutcome(input)).toEqual({ ok: true, exitCode: 0 })
  })

  it.each([
    ['a fatal error was recorded', { fatal: true }, 'the worker recorded a fatal error'],
    ['ended by a signal', { signal: 'SIGKILL', exitCode: null }, 'the worker was ended by SIGKILL'],
    ['an exit code check:all never uses', { exitCode: 7 }, 'the worker\'s exit code 7 is not one check:all ends with'],
    ['no state', { state: undefined }, 'the worker left no state'],
    ['still running', { state: state({ state: 'running' }) }, 'the worker\'s state is running, not finished (last phase: finished)'],
    ['another run\'s state', { state: state({ runId: 'run-2' }) }, 'the worker\'s state names run run-2'],
    ['another worker\'s token', { state: state({ workerToken: 'token-2' }) }, 'the worker\'s state carries another worker\'s token'],
    ['another process', { pid: 43 }, 'the worker\'s state names process 42, not 43'],
    ['state and exit code disagree', { state: state({ exitCode: 1 }) }, 'the worker\'s state says exit code 1, but it exited with 0'],
    ['no summary', { summaryText: undefined }, 'there is no summary.json'],
    ['another summary', { summaryText: summaryText.replace('PASSED', 'PASSED ') }, 'summary.json is not the one the worker finished with'],
    ['a half-written summary', { summaryText: summaryText.slice(0, 20), state: state({ summarySha256: sha256(summaryText.slice(0, 20)) }) }, 'summary.json cannot be read as JSON'],
    ['a summary of another run', { summaryText: summaryText.replace('run-1', 'run-9'), state: state({ summarySha256: sha256(summaryText.replace('run-1', 'run-9')) }) }, 'summary.json names run run-9'],
    ['a summary whose result and exit code disagree', { summaryText: summaryText.replace('PASSED', 'FAILED'), state: state({ summarySha256: sha256(summaryText.replace('PASSED', 'FAILED')) }) }, 'summary.json\'s result FAILED does not match its exit code 0'],
  ] as const)('does not stand when %s', (_name, change, problem) => {
    const verdict = judgeWorkerOutcome({ ...input, ...change })
    expect(verdict.ok).toBe(false)
    expect('problems' in verdict ? verdict.problems : []).toContain(problem)
  })
})

/** The run folder the supervisor made, before supervise() has returned. */
function findRunDir(): string {
  const base = join(dir, 'check-all')
  if (!existsSync(base)) return join(base, 'none')
  return join(base, readdirSync(base)[0] ?? 'none')
}

async function waitFor(condition: () => boolean, withinMs = 60_000): Promise<void> {
  const deadline = Date.now() + withinMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await sleep(100)
  }
}
