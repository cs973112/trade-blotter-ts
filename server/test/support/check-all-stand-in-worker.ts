import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { CheckAllOptions } from '../../scripts/check-all.ts'
import { configArgument, runWorker, type WorkerConfig } from '../../scripts/check-all-worker.ts'
import { startApps, writeState, type AppLaunch } from '../../scripts/lifecycle.ts'
import { stopPair } from '../../scripts/review-apps.ts'
import type { Report, ReviewContext, ReviewPair } from '../../scripts/review-context.ts'
import type { StepId } from '../../scripts/review-run.ts'
import { stepStop } from '../../scripts/review-steps.ts'
import { startDetachedNode } from './child-process.ts'

/**
 * A check:all worker for the supervisor tests: node check-all-stand-in-worker.ts --scenario <name>
 * [--copies <folder>] [--holder <pid>] --config <file>. It is the real worker (runWorker: the real
 * checkAll, progress file and uncaughtExceptionMonitor) with stand-in steps. Step 03 starts stand-in
 * applications (fake-app.ts) through the process manager, on the configured ports, and lists them in
 * stand-in-apps.json; step 07 is the real stepStop, with only the Trade Blotter identity check, which
 * a stand-in cannot pass, replaced. A scenario changes one part:
 *
 * - pass, fail (review:04 reports a FAIL), incomplete (review:06 could not do all it should);
 * - fatal: review:04 throws from a timer (an uncaught exception), then would write stand-in-resumed
 *   if the worker went on;
 * - rejection: review:04 leaves a rejected promise that nothing awaits;
 * - blocked: review:04 blocks the event loop for good; wait: review:04 waits for good;
 * - slow: review:04 takes 2.5 s;
 * - exit-without-summary: review:04 ends the process with exit code 1;
 * - fatal-after-07: an uncaught exception during the documentation checks, after step 07;
 * - fatal-after-summary: an uncaught exception just after the summary is written;
 * - fatal-in-detection: failure detection makes two copies under --copies (one named for this run,
 *   one for another run), and one of this run under --client-copies when given, and starts a
 *   process that mentions this run's copy, then throws;
 * - foreign: step 03 also records, for the scratch pair, the id of another program (--holder) with
 *   tokens it does not have, then review:04 throws as in fatal.
 */

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const scenario = option('--scenario') ?? 'pass'
const configPath = configArgument(args) ?? ''
const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig
const runDir = join(config.baseDir, config.runId)
const FAKE_APP = join(import.meta.dirname, 'fake-app.ts')
const trusted = { identity: () => Promise.resolve([]) }
const mark = (name: string): void => { writeFileSync(join(runDir, `stand-in-${name}`), new Date().toISOString()) }

type StepFunction = (context: ReviewContext, report: Report) => Promise<void>

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

async function startFakes(pair: ReviewPair): Promise<void> {
  const result = await startApps({ runDir: pair.runDir, databasePath: pair.databasePath, launches: fakeLaunches(pair), readyTimeoutMs: 30_000 })
  for (const app of result.state.apps) appendFileSync(join(runDir, 'stand-in-apps.jsonl'), `${JSON.stringify({ pid: app.pid, token: app.token, port: app.port })}\n`)
}

const pass = (name: string): StepFunction => (_context, report) => { report.pass(name); return Promise.resolve() }
const throwLater = (message: string): void => { setTimeout(() => { throw new Error(`${message} [stand-in]`) }, 50) }

const fatalStep: StepFunction = async (_context, report) => {
  throwLater('thrown from a timer during review:04')
  await sleep(1_500)
  // Reached only if the worker went on after the uncaught exception.
  mark('resumed')
  report.pass('Booking checks')
}

const steps: Record<StepId, StepFunction> = {
  '01': pass('Node.js v22.21.0 (verified)'),
  '05': (_context, report) => {
    for (const name of ['Lint (ESLint)', 'Server tests (vitest)', 'Client tests (vitest)', 'Schema check (migrations match the schema)', 'UI: the page loads']) report.pass(name)
    return Promise.resolve()
  },
  '02': pass('Seeded'),
  '03': async (context, report) => {
    for (const pair of context.pairs) await startFakes(pair)
    report.pass('Benchmark and scratch applications started')
  },
  '04': pass('Booking checks'),
  '06': pass('UI benchmark'),
  '07': (context, report) => stepStop(context, report, { stopPair: (pair) => stopPair(pair, trusted) }),
}

const overrides: { -readonly [K in keyof CheckAllOptions]?: CheckAllOptions[K] } = {
  print: (line) => { process.stdout.write(`${line}\n`) },
  environment: () => ({ node: process.version, npm: '10.9.4', sqlite: '3.50.4', platform: process.platform, arch: process.arch }),
  failureDetection: () => Promise.resolve([]),
  documentation: () => Promise.resolve([{ status: 'PASS', name: 'API endpoints match' }]),
}

switch (scenario) {
  case 'pass': break
  case 'fail': steps['04'] = (_context, report) => { report.fail('Booking checks', 'a booking was refused [stand-in]'); return Promise.resolve() }; break
  case 'incomplete': steps['06'] = (_context, report) => { report.incomplete('UI benchmark: no browser [stand-in]'); return Promise.resolve() }; break
  case 'fatal': steps['04'] = fatalStep; break
  case 'rejection':
    steps['04'] = async (_context, report) => {
      void Promise.reject(new Error('The connection to Chrome closed (Chrome exited or crashed). [stand-in]'))
      await sleep(200)
      report.pass('Booking checks')
    }
    break
  case 'blocked':
    steps['04'] = () => {
      mark('blocking')
      const cell = new Int32Array(new SharedArrayBuffer(4))
      // The event loop never runs again: no timer, no deadline, no I/O.
      for (;;) Atomics.wait(cell, 0, 0, 1_000)
    }
    break
  case 'wait':
    steps['04'] = () => {
      mark('waiting')
      return new Promise<void>(() => { setInterval(() => undefined, 1_000) })
    }
    break
  case 'slow': steps['04'] = async (_context, report) => { await sleep(2_500); report.pass('Booking checks') }; break
  case 'exit-without-summary': steps['04'] = () => process.exit(1); break
  case 'fatal-after-07':
    overrides.documentation = async () => {
      throwLater('thrown from a timer during the documentation checks')
      await sleep(1_500)
      mark('resumed')
      return [{ status: 'PASS', name: 'API endpoints match' }]
    }
    break
  case 'fatal-after-summary':
    overrides.documentation = () => {
      setTimeout(() => { throw new Error('thrown from a timer after the summary [stand-in]') }, 500)
      return Promise.resolve([{ status: 'PASS', name: 'API endpoints match' }])
    }
    break
  case 'fatal-in-detection': {
    const copies = option('--copies') ?? ''
    const clientCopies = option('--client-copies')
    overrides.failureDetection = async (options) => {
      const mine = join(copies, `.test-build-check-${options.runId.replace(/[^a-zA-Z0-9-]/g, '')}-audit-update-recorded-as-update`)
      const another = join(copies, '.test-build-check-20990101T000000.000Z-000000-audit-update-recorded-as-update')
      for (const folder of [mine, another]) mkdirSync(join(folder, 'test'), { recursive: true })
      // A client check's copy of this run too (M6 Phase 2), under --client-copies.
      if (clientCopies !== undefined) mkdirSync(join(clientCopies, `.test-build-check-${options.runId.replace(/[^a-zA-Z0-9-]/g, '')}-client-actual-position-executed-only`, 'test'), { recursive: true })
      // As a copy's vitest left behind: a process whose command line names this run's copy, with a token to find it by.
      // Detached, so it outlives the worker as an orphan does on Linux and macOS (on Windows, Node.js ends a
      // child that is not detached together with its parent).
      const token = randomUUID()
      const pid = startDetachedNode(['-e', 'setInterval(() => {}, 1000)', join(mine, 'test'), `check-all-leftover-${token}`], { cwd: mine, env: process.env })
      writeFileSync(join(runDir, 'stand-in-leftover.json'), JSON.stringify({ pid, token }))
      throwLater('thrown from a timer during failure detection')
      await sleep(1_500)
      mark('resumed')
      return []
    }
    break
  }
  case 'foreign': {
    const holder = Number(option('--holder'))
    steps['03'] = async (context, report) => {
      const [benchmark, scratch] = context.pairs
      await startFakes(benchmark)
      mkdirSync(scratch.runDir, { recursive: true })
      writeState(scratch.runDir, {
        version: 1, startedAt: '2026-11-21T00:00:00.000Z', phase: 'ready', databasePath: scratch.databasePath,
        apps: [{ name: 'api', label: 'API', pid: holder, token: 'eeeeeeee-0000-4000-8000-000000000000', host: '127.0.0.1', port: scratch.apiPort, url: '', log: '' },
          { name: 'web', label: 'Frontend', pid: holder, token: 'ffffffff-0000-4000-8000-000000000000', host: '127.0.0.1', port: scratch.webPort, url: '', log: '' }],
      })
      report.pass('Benchmark applications started')
    }
    steps['04'] = fatalStep
    break
  }
  default: throw new Error(`Unknown scenario ${scenario}`)
}

if (existsSync(join(runDir, 'summary.json'))) throw new Error('The run folder already holds a summary.')
const outcome = await runWorker(configPath, { ...overrides, steps })
process.exitCode = outcome.exitCode
