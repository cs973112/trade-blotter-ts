import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { runNodeBounded, type CommandRun } from './failure-detection.ts'
import { REPOSITORY_ROOT } from './lifecycle.ts'
import { tail } from './review-apps.ts'

/**
 * npm run check:fast: development feedback in a few minutes. It runs the project's own npm scripts
 * (lint, typecheck, build, db:check, check:docs, and the tests), each a PASS or a FAIL with its log
 * in .run/check-fast/<run id>/, and never starts the reviewer's applications, benchmarks, the
 * browser or failure detection: npm run check:all remains the comprehensive acceptance.
 *
 * The checks run in groups, one group after another; a failed check fails the run (exit code 1)
 * and every later group is reported as not run. Only the first group's checks run at once, because
 * they share nothing they write and gain from it:
 *
 *   1. Lint, typecheck and build, the schema check and the documentation checks. Only build
 *      writes (server/dist/ and client/dist/), and none of the others reads either: ESLint ignores
 *      dist/, both type-checks emit nothing and read sources only, drizzle-kit reads the
 *      migrations, and the documentation checks read the documents and the sources. Measured:
 *      about 39 s at once against about 54 s one after another.
 *   2. The server's application tests (the Vitest project "app": domain, application,
 *      infrastructure, API, platform, scenarios, architecture, isolation and tooling configuration).
 *   3. The client's tests.
 *   4. The quick tooling tests (FAST_TOOLING_TESTS), after the application tests, as the server's
 *      Vitest configuration orders them, so the tests that hold a child process to a deadline never
 *      compete with tool tests for the CPU.
 *
 * The server and client tests could run at once (each Vitest run names its temporary folders and
 * databases by a run id of its own, the server binds ports the system picks, the client uses jsdom
 * with no network), but measured together they saved little (52 s against 29 s + 29 s run apart),
 * because both keep every core busy, and together each ran nearly twice as slowly. Run apart, the
 * server tests that hold a child process to a deadline never compete with the client's for the CPU.
 *
 * Left out, for check:all only: the check:all supervisor, launcher and failure-path suites, the
 * failure-detection mutations and their framework's real-copy tests, the benchmarks' tests, the
 * reviewer workflow's and the process manager's tests that start applications, the browser checks'
 * tests, and the reviewer workflow, benchmarks, browser checks and failure detection themselves.
 *
 * Each command is `node <npm-cli.js> run ...` under runNodeBounded: no shell, its output to its
 * log, and at its deadline it and its own children (found from its handle's id, while that handle
 * says it runs) are stopped. Nothing else is ever signalled.
 */

export interface FastCheck {
  readonly id: string
  readonly name: string
  /** Arguments to npm, such as ['run', 'lint']. */
  readonly npm: readonly string[]
}

export type FastGroup = readonly FastCheck[]

/** The tooling tests quick enough for development feedback, by file (server/test/scripts/). */
export const FAST_TOOLING_TESTS = [
  'test/scripts/app.test.ts',
  'test/scripts/browser.test.ts',
  'test/scripts/check-all.test.ts',
  'test/scripts/check-fast.test.ts',
  'test/scripts/docs-check.test.ts',
  'test/scripts/process-termination.test.ts',
  'test/scripts/review-run.test.ts',
  'test/scripts/seed-data.test.ts',
  'test/scripts/trade-data.test.ts',
] as const

/** The tooling tests left to check:all, each with why. */
export const CHECK_ALL_ONLY_TESTS: Readonly<Record<string, string>> = {
  'test/scripts/check-all-supervisor.test.ts': 'the check:all supervisor suite (real worker processes, deadlines)',
  'test/scripts/check-all-main.test.ts': 'the check:all launcher through npm and the supervisor',
  'test/scripts/check-all-failures.test.ts': 'check:all\'s failure paths with stand-in applications',
  'test/scripts/failure-detection.test.ts': 'failure detection on real copies of the server and the client',
  'test/scripts/perf-api.test.ts': 'the API benchmark',
  'test/scripts/perf-ui.test.ts': 'the UI benchmark',
  'test/scripts/review.test.ts': 'the reviewer workflow, starting and stopping applications',
  'test/scripts/lifecycle.test.ts': 'the process manager, starting and stopping applications',
  'test/scripts/ui-check.test.ts': 'the browser checks',
}

export const FAST_GROUPS: readonly FastGroup[] = [
  [
    { id: 'lint', name: 'Lint (ESLint)', npm: ['run', 'lint'] },
    { id: 'typecheck', name: 'Typecheck (tsc, vue-tsc)', npm: ['run', 'typecheck'] },
    { id: 'build', name: 'Build (server and client)', npm: ['run', 'build'] },
    { id: 'schema', name: 'Schema check (migrations match the schema)', npm: ['run', 'db:check', '-w', 'server'] },
    { id: 'docs', name: 'Documentation checks', npm: ['run', 'check:docs'] },
  ],
  [{ id: 'server-app-tests', name: 'Server application tests (Vitest project app)', npm: ['run', 'test', '-w', 'server', '--', '--project', 'app'] }],
  [{ id: 'client-tests', name: 'Client tests', npm: ['run', 'test', '-w', 'client'] }],
  [
    { id: 'server-tooling-tests', name: 'Quick tooling tests', npm: ['run', 'test', '-w', 'server', '--', '--project', 'scripts', ...FAST_TOOLING_TESTS] },
  ],
]

/** How long one check may run before it and its children are stopped. */
export const FAST_CHECK_TIMEOUT_MS = 15 * 60_000

export interface FastResult {
  readonly check: FastCheck
  readonly status: 'PASS' | 'FAIL' | 'NOT RUN'
  readonly exitCode?: number
  readonly timedOut?: boolean
  readonly milliseconds?: number
  readonly log?: string
}

export interface FastSummary {
  readonly tool: 'check:fast'
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly milliseconds: number
  readonly results: readonly FastResult[]
  readonly result: 'PASSED' | 'FAILED'
  readonly exitCode: 0 | 1
}

export interface FastOptions {
  readonly groups?: readonly FastGroup[]
  readonly runDir?: string
  readonly runId?: string
  readonly timeoutMs?: number
  /** Runs one check: npm under runNodeBounded by default; tests pass their own. */
  readonly run?: (check: FastCheck, log: string, timeoutMs: number) => Promise<CommandRun>
  readonly print?: (line: string) => void
  readonly now?: () => number
}

/** npm itself, as `node <npm-cli.js>`: the npm running this command, or the one beside this Node.js. */
export function npmCli(): string {
  const candidates = [
    process.env['npm_execpath'] ?? '',
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((path) => basename(path) === 'npm-cli.js' && existsSync(path))
  if (found === undefined) throw new Error(`npm-cli.js not found (looked for ${candidates.filter((path) => path !== '').join(', ')})`)
  return found
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

export async function checkFast(options: FastOptions = {}): Promise<FastSummary> {
  const now = options.now ?? Date.now
  const print = options.print ?? ((line: string) => { console.log(line) })
  const groups = options.groups ?? FAST_GROUPS
  const runId = options.runId ?? new Date(now()).toISOString().replace(/[-:.]/g, '')
  const runDir = options.runDir ?? join(REPOSITORY_ROOT, '.run', 'check-fast', runId)
  const timeoutMs = options.timeoutMs ?? FAST_CHECK_TIMEOUT_MS
  const run = options.run ?? ((check: FastCheck, log: string, limit: number) => runNodeBounded([npmCli(), ...check.npm], REPOSITORY_ROOT, log, limit))
  mkdirSync(runDir, { recursive: true })
  const started = now()
  print(`check:fast, run ${runId}: development feedback, not acceptance (npm run check:all is). Logs in ${runDir}`)

  const results: FastResult[] = []
  let failed = false
  for (const [index, group] of groups.entries()) {
    if (failed) {
      for (const check of group) {
        results.push({ check, status: 'NOT RUN' })
        print(`NOT RUN  ${check.name}: an earlier check failed`)
      }
      continue
    }
    print(`Group ${String(index + 1)} of ${String(groups.length)}: ${group.map((check) => check.name).join(', ')}`)
    const done = await Promise.all(group.map(async (check): Promise<FastResult> => {
      const log = join(runDir, `${check.id}.log`)
      const outcome = await run(check, log, timeoutMs)
      const pass = outcome.exitCode === 0 && !outcome.timedOut
      const result: FastResult = { check, status: pass ? 'PASS' : 'FAIL', exitCode: outcome.exitCode, timedOut: outcome.timedOut, milliseconds: outcome.milliseconds, log }
      print(`${result.status.padEnd(7)}  ${check.name} (${seconds(outcome.milliseconds)})${pass ? '' : `: ${outcome.timedOut ? `stopped at its ${seconds(timeoutMs)} deadline` : `exit code ${String(outcome.exitCode)}`}; log ${log}`}`)
      if (!pass) print(tail(log, 30).split('\n').map((line) => `         ${line}`).join('\n'))
      return result
    }))
    results.push(...done)
    failed = done.some((result) => result.status === 'FAIL')
  }

  const finished = now()
  const count = (status: FastResult['status']): number => results.filter((result) => result.status === status).length
  const summary: FastSummary = {
    tool: 'check:fast', runId, startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), milliseconds: finished - started,
    results, result: failed ? 'FAILED' : 'PASSED', exitCode: failed ? 1 : 0,
  }
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  print('')
  print(`Summary of run ${runId}: ${String(count('PASS'))} PASS, ${String(count('FAIL'))} FAIL, ${String(count('NOT RUN'))} NOT RUN in ${seconds(summary.milliseconds)}`)
  for (const result of results) print(`  ${result.status.padEnd(7)}  ${result.check.name}${result.milliseconds === undefined ? '' : `  ${seconds(result.milliseconds)}`}`)
  print(`RESULT: ${failed ? 'FAILED (exit code 1)' : 'PASSED (exit code 0)'}: development feedback only; npm run check:all is the acceptance`)
  return summary
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.error(`Unknown argument ${process.argv[2] ?? ''}. Usage: npm run check:fast`)
    return 2
  }
  return (await checkFast()).exitCode
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then((code) => { process.exitCode = code }, (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
