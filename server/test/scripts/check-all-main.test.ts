import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHECK_ALL_PORTS } from '../../scripts/check-all.ts'
import { ensureTerminated, portAnswers, processStatus, stopApps } from '../../scripts/lifecycle.ts'
import { finished, npmCommand, REPOSITORY_ROOT, runCommand, startNode, type ChildProcess, type Finished } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * The command npm run check:all runs, in processes of its own. The configured entry point (the
 * package.json script, and npm itself) must load the whole command, answer a usage error and exit:
 * an import cycle that leaves a module waiting for itself makes Node.js end with exit code 13 and
 * "unsettled top-level await", which the supervisor tests, calling superviseCheckAll in the test
 * process, cannot see. check-all.ts itself must start nothing. Then the launcher's own code
 * (check-all-main.ts's runCheckAllCommand, in test/support/check-all-launcher.ts) runs the real
 * supervisor with the stand-in worker, and the worker's result must come out as the exit code.
 */

const SCRIPT = (JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['check:all'] ?? ''
const LAUNCHER = join(import.meta.dirname, '../support/check-all-launcher.ts')
const RUNS = join(REPOSITORY_ROOT, '.run', 'check-all')
const REVIEWER_PORTS = [...CHECK_ALL_PORTS.benchmark, ...CHECK_ALL_PORTS.scratch]
const TIMEOUT = 180_000
// A usage error takes about a second; under the full suite, with every core busy, npm and Node.js
// starting can take several (the 5 s default was exceeded once), so these tests allow a minute and
// the command itself 45 s.
const LAUNCH_TIMEOUT = 60_000
const COMMAND_DEADLINE = 45_000
const USAGE = 'Unknown argument --bogus. Usage: npm run check:all [-- --quick] [-- --verbose]'

const runFolders = (): string[] => (existsSync(RUNS) ? readdirSync(RUNS).sort() : [])

async function reviewerPortsAnswering(): Promise<number[]> {
  const answering: number[] = []
  for (const port of REVIEWER_PORTS) if (await portAnswers(port, '127.0.0.1')) answering.push(port)
  return answering
}

/** Runs a command in the repository, at most COMMAND_DEADLINE; one still running then is killed through its handle. */
const run = (command: string, args: readonly string[]): Finished => runCommand(command, args, { cwd: REPOSITORY_ROOT, env: process.env, deadlineMs: COMMAND_DEADLINE })

/** The usage error, and nothing else: exits 2 on its own, no exit code 13, no run folder, no reviewer application. */
async function expectUsageOnly(ended: Finished, runsBefore: readonly string[]): Promise<void> {
  expect(ended.timedOut, 'still running at the deadline').toBe(false)
  expect(ended.stderr).not.toContain('unsettled top-level await')
  expect(ended.status).not.toBe(13)
  expect(ended.status, ended.stderr).toBe(2)
  expect(ended.stderr).toContain(USAGE)
  expect(ended.stdout).not.toContain('review:')
  expect(runFolders()).toEqual(runsBefore)
  expect(await reviewerPortsAnswering()).toEqual([])
}

describe('npm run check:all: the configured entry point', () => {
  let runsBefore: string[] = []

  beforeEach(async () => {
    runsBefore = runFolders()
    // The usage test proves no reviewer application starts; it can do so only if none is running already.
    expect(await reviewerPortsAnswering(), 'a reviewer port is already in use').toEqual([])
  })

  it('is check-all-main.ts, run with node', () => {
    expect(SCRIPT).toBe('node --disable-warning=ExperimentalWarning server/scripts/check-all-main.ts')
  })

  it('loads the whole command and exits with the usage error (the script as configured)', async () => {
    const [command, ...args] = SCRIPT.split(' ')
    expect(command).toBe('node')
    await expectUsageOnly(run(process.execPath, [...args, '--bogus']), runsBefore)
  }, LAUNCH_TIMEOUT)

  it('does the same through npm', async () => {
    const npm = npmCommand()
    await expectUsageOnly(run(npm.command, [...npm.args, 'run', '--silent', 'check:all', '--', '--bogus']), runsBefore)
  }, LAUNCH_TIMEOUT)

  it('check-all.ts starts nothing when run or imported: it is not the entry point', () => {
    const ended = run(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/scripts/check-all.ts', '--bogus'])
    expect(ended).toMatchObject({ status: 0, stdout: '', stderr: '', timedOut: false })
    expect(runFolders()).toEqual(runsBefore)
  }, LAUNCH_TIMEOUT)
})

describe('the launcher runs the supervisor and passes on the result', () => {
  let dir = ''
  let launcher: ChildProcess | undefined

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

  /** The run's folder: the only one under the test's check-all folder. */
  const runDir = (): string => {
    const base = join(dir, 'check-all')
    const folders = existsSync(base) ? readdirSync(base) : []
    return folders.length === 1 ? join(base, folders[0] ?? '') : ''
  }

  const apps = (): { pid: number; token: string; port: number }[] => {
    const file = join(runDir(), 'stand-in-apps.jsonl')
    if (runDir() === '' || !existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { pid: number; token: string; port: number })
  }

  beforeEach(() => {
    dir = createTempDir()
    launcher = undefined
  })

  afterEach(async () => {
    try {
      // The launcher by its handle; the applications through app:stop's checks, then by their tokens.
      if (launcher !== undefined && launcher.exitCode === null && launcher.signalCode === null) await ensureTerminated([{ label: 'launcher', pid: launcher.pid ?? 0, handle: launcher }], { timeoutMs: 20_000 })
      if (runDir() !== '') for (const pair of ['benchmark', 'scratch']) await stopApps(join(runDir(), 'review', 'run', pair)).catch(() => undefined)
      await ensureTerminated(apps().map((app) => ({ label: 'stand-in app', pid: app.pid, token: app.token, ports: [{ port: app.port, host: '127.0.0.1' }] })), { timeoutMs: 20_000 })
    } finally {
      removeTempDir(dir)
    }
  }, TIMEOUT)

  async function launch(scenario: string, args: readonly string[]): Promise<Finished> {
    const [a, b, c, d] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
    const ports = { benchmark: [a, b], scratch: [c, d] }
    launcher = startNode([LAUNCHER, dir, JSON.stringify(ports), scenario, ...args], process.env, REPOSITORY_ROOT)
    return finished(launcher, TIMEOUT - 30_000)
  }

  /** Every stand-in application the run started has gone, by its token, and its port is free. */
  async function expectAppsStopped(): Promise<void> {
    expect(apps()).toHaveLength(4)
    for (const app of apps()) {
      expect(['stopped', 'reused'], `process ${String(app.pid)}`).toContain(processStatus(app))
      expect(await portAnswers(app.port, '127.0.0.1'), `port ${String(app.port)}`).toBe(false)
    }
  }

  it.each([
    { scenario: 'pass', args: [], code: 0, result: 'PASSED', verdict: 'RESULT: PASSED: complete verification passed (exit code 0)' },
    { scenario: 'pass', args: ['--quick', '--verbose'], code: 0, result: 'QUICK PASSED', verdict: 'RESULT: QUICK PASSED' },
    { scenario: 'fail', args: [], code: 1, result: 'FAILED', verdict: 'RESULT: FAILED (exit code 1)' },
    { scenario: 'incomplete', args: [], code: 3, result: 'INCOMPLETE', verdict: 'RESULT: INCOMPLETE' },
  ])('$scenario $args: exit code $code, the worker\'s own summary', async ({ scenario, args, code, result, verdict }) => {
    const ended = await launch(scenario, args)
    expect(ended.stderr).not.toContain('unsettled top-level await')
    expect(ended.status, ended.stderr).toBe(code)
    expect(ended.stdout).toContain(verdict)
    expect(ended.stdout).not.toContain('check:all did not complete')
    const summary = JSON.parse(readFileSync(join(runDir(), 'summary.json'), 'utf8')) as { result: string; exitCode: number; mode: string }
    expect(summary).toMatchObject({ result, exitCode: code, mode: args.includes('--quick') ? 'quick' : 'full' })
    await expectAppsStopped()
  }, TIMEOUT)

  it('a worker that ends by an uncaught exception: the supervisor\'s FAILED summary, exit code 1', async () => {
    const ended = await launch('fatal', [])
    expect(ended.status, ended.stderr).toBe(1)
    expect(ended.stdout).toMatch(/RESULT: FAILED: check:all did not complete \(exit code 1\)\s*$/)
    expect(JSON.parse(readFileSync(join(runDir(), 'summary.json'), 'utf8'))).toMatchObject({ result: 'FAILED', exitCode: 1, worker: { completed: false, reason: 'fatal exception' } })
    expect(existsSync(join(runDir(), 'stand-in-resumed'))).toBe(false)
    await expectAppsStopped()
  }, TIMEOUT)

  it('a usage error stops before the supervisor: exit code 2, no run folder', async () => {
    const ended = await launch('pass', ['--bogus'])
    expect(ended.status).toBe(2)
    expect(ended.stderr).toContain(USAGE)
    expect(existsSync(join(dir, 'check-all'))).toBe(false)
  }, TIMEOUT)
})
