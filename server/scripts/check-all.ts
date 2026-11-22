import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { arch, cpus, platform, release, totalmem } from 'node:os'

import { lookUpBrowser } from './browser.ts'
import { applicationFingerprint, documentationChecks, type DocCheck, type DocsOptions } from './docs-check.ts'
import { FAILURE_COMMAND_TIMEOUT_MS, runFailureDetection, readVitestResults, type CheckResult, type FailureDetectionOptions, type VitestResults } from './failure-detection.ts'
import { processStatuses, readState, REPOSITORY_ROOT, statePath } from './lifecycle.ts'
import { runLogged } from './review-apps.ts'
import { EXIT, reviewContext, type Report, type ReviewContext, type Status } from './review-context.ts'
import { finishStep, newRunId, readRun, type StepId } from './review-run.ts'
import { stepCheck, stepPerformance, stepSeed, stepSetup, stepStart, stepStop, stepTests, testResultsFile, type StepDependencies } from './review-steps.ts'
import { runReviewStep, StepDeadlineError, STEPS } from './review.ts'
import type { Protection } from './trade-data.ts'

/**
 * npm run check:all [-- --quick] [-- --verbose]: every verification in one command, in a run
 * folder of its own, .run/check-all/<run id>/ (ignored by Git), never mixed with another run's.
 *
 * It is the reviewer workflow (review:01 to review:07, run through runReviewStep, so every check
 * and assertion of each step is the same) on reviewer databases and ports of its own, followed by
 * the failure-detection checks (failure-detection.ts) and the documentation checks
 * (docs-check.ts). The steps run in the order 01, 05, 02, 03, 04, 06, 07: the tests and the build
 * (05) come before the applications start (03), so step 03 finds the build current and nothing is
 * built twice. Each test runs once.
 *
 * --quick leaves out the benchmarks (step 06) and says so; a quick run is never reported as complete
 * verification. --verbose prints every check's detail, every command, and every test.
 *
 * Exit codes: 0 passed (a quick run that passed: QUICK PASSED, not complete); 1 something failed;
 * 3 a required part could not run (no browser, or a step left out after another failed); 2 usage.
 *
 * The command runs in two processes. Its entry point, check-all-main.ts, runs the supervisor
 * (check-all-supervisor.ts), which starts check-all-worker.ts, the worker, and the worker runs
 * checkAll below. This module starts nothing when it is imported or run: it is the verification
 * itself, imported by the worker, the supervisor and the tests. A run that ends
 * normally is the worker's, unchanged: its output, summary and exit code. When the worker does not
 * end normally (an uncaught exception, which ends it as Node.js always does; killed; still running
 * past a hard deadline; interrupted), the supervisor, which has run none of the failing code,
 * stops this run's applications and writes a FAILED summary itself.
 *
 * Within the worker, a step that throws is a FAIL of that step (runReviewStep). An unhandled
 * rejection (a promise rejected that nothing awaited, such as a browser connection closing under a
 * benchmark) does not unwind any code, so it is recorded instead of ending the process: a FAIL of
 * whatever was running (its full stack in unexpected-errors.log and the step's log), which counts
 * as failed, and the run's result is FAILED. Nothing is concluded about the state it left; only that
 * the run failed. Each step has a deadline (STEP_DEADLINES_MS): a step still running then is a FAIL
 * and is no longer waited for. An error in check:all's own bookkeeping is a FAIL too. In each of
 * these cases the run goes on: the steps that need the failed one are left out and named, step 07
 * always runs and stops only the applications this run started (each confirmed by its token and its
 * port, with bounded waits; stepStop), and failure detection, the documentation checks and the
 * summary follow. When step 07 did not pass, the pairs' records are read again and any of the run's
 * applications still running is a FAIL that names it and how to stop it. Any of these failures
 * makes the result FAILED, exit code 1. An uncaught exception is never handled here: it ends the
 * worker, and the supervisor takes over.
 */

export const CHECK_ALL_PORTS = { benchmark: [5491, 4291], scratch: [5492, 4292] } as const

const MINUTE = 60_000
/**
 * How long check:all waits for each step: several times the longest seen on the reviewer's machine
 * (review:05 about 5 minutes, review:06 about 3, the others under 30 seconds), so only a step that
 * is stuck reaches it.
 */
export const STEP_DEADLINES_MS: Readonly<Record<StepId, number>> = {
  '01': 10 * MINUTE, '02': 15 * MINUTE, '03': 15 * MINUTE, '04': 15 * MINUTE, '05': 45 * MINUTE, '06': 45 * MINUTE, '07': 10 * MINUTE,
}

/**
 * How long the worker's other phases may take before the supervisor ends it, beyond its grace
 * period (each step has its own deadline, STEP_DEADLINES_MS; each failure-detection command is
 * stopped by failure detection itself at FAILURE_COMMAND_TIMEOUT_MS). Several times what they take.
 */
export const PHASE_LIMITS_MS = {
  startup: 10 * MINUTE,
  cleanUpCheck: 5 * MINUTE,
  failureDetectionCommand: FAILURE_COMMAND_TIMEOUT_MS,
  documentation: 10 * MINUTE,
  summary: 5 * MINUTE,
} as const

/** Where unhandled rejections are heard: the process, or a stand-in in tests. */
export interface ProcessEvents {
  on(event: 'unhandledRejection', listener: (error: unknown) => void): unknown
  off(event: 'unhandledRejection', listener: (error: unknown) => void): unknown
}

/**
 * What the worker tells the supervisor while it runs (check-all-worker.ts keeps it in
 * worker-state.json): each phase as it starts, with how long it may take, and each finished part's
 * outcome, so a run that does not finish can still be reported as far as it got.
 */
export type ProgressEvent =
  | { readonly kind: 'phase'; readonly label: string; readonly step?: StepId; readonly limitMs: number; readonly detail?: string }
  | { readonly kind: 'step'; readonly id: StepId; readonly title: string; readonly exitCode: number | 'not run'; readonly counts?: Category['counts']; readonly log?: string; readonly reason?: string }
  | { readonly kind: 'section'; readonly id: 'failure-detection' | 'documentation'; readonly title: string; readonly counts: Category['counts']; readonly notRun?: string }
  | { readonly kind: 'unexpected'; readonly error: UnexpectedError }

export interface UnexpectedError {
  readonly kind: 'unhandled rejection'
  /** What was running: review:06, failure detection, ... */
  readonly during: string
  readonly message: string
  readonly at: string
}

export type Mode = 'full' | 'quick'
type StepFunction = (context: ReviewContext, report: Report) => Promise<void>

interface Line { readonly status: Status; readonly name: string; readonly detail?: string }

export interface Category {
  readonly id: string
  readonly title: string
  /** What the counts count: checks, or individual tests. */
  readonly unit: 'checks' | 'tests'
  counts: Record<'PASS' | 'FAIL' | 'WARN' | 'SKIPPED', number>
  lines: Line[]
  logs: string[]
  /** Why it did not run, when it did not. */
  notRun?: string
  milliseconds: number
}

export interface CommandRecord {
  readonly command: string
  readonly cwd: string
  readonly log: string
  readonly exitCode: number
  readonly milliseconds: number
}

export interface CheckAllSummary {
  readonly tool: 'check:all'
  readonly version: 1
  readonly runId: string
  readonly mode: Mode
  readonly startedAt: string
  readonly finishedAt: string
  readonly milliseconds: number
  readonly runDir: string
  readonly environment: Record<string, unknown>
  readonly steps: readonly { readonly id: StepId; readonly title: string; readonly exitCode: number | 'not run'; readonly log?: string; readonly milliseconds: number; readonly reason?: string }[]
  readonly categories: readonly Category[]
  readonly commands: readonly CommandRecord[]
  readonly totals: Record<'PASS' | 'FAIL' | 'WARN' | 'SKIPPED', number>
  readonly result: 'PASSED' | 'QUICK PASSED' | 'FAILED' | 'INCOMPLETE'
  readonly exitCode: number
  readonly skipped: readonly string[]
  /** Errors nothing caught, each also a FAIL line of the category that was running. */
  readonly unexpectedErrors: readonly UnexpectedError[]
  /** Steps still running at their deadline, no longer waited for. */
  readonly abandoned: readonly StepId[]
}

export interface CheckAllOptions {
  readonly mode?: Mode
  readonly verbose?: boolean
  /** The folder that holds every run's folder: .run/check-all/ by default. */
  readonly baseDir?: string
  readonly runId?: string
  readonly ports?: { readonly benchmark: readonly [number, number]; readonly scratch: readonly [number, number] }
  readonly counts?: { readonly benchmark: number; readonly scratch: number }
  readonly protection?: Protection
  readonly print?: (line: string) => void
  /** Stand-ins for tests: the reviewer steps, failure detection, documentation and environment. */
  readonly steps?: Partial<Record<StepId, StepFunction>>
  readonly failureDetection?: (options: FailureDetectionOptions) => Promise<CheckResult[]>
  readonly documentation?: (options: DocsOptions) => Promise<DocCheck[]>
  readonly environment?: () => Record<string, unknown>
  readonly now?: () => Date
  /** Where unexpected errors are heard: the process by default. */
  readonly processEvents?: ProcessEvents
  /** Deadlines in place of STEP_DEADLINES_MS, for some steps. */
  readonly stepDeadlinesMs?: Partial<Record<StepId, number>>
  /** The run's applications still running after step 07: ownedStillRunning by default. */
  readonly stillRunning?: (context: ReviewContext) => string[]
  /** Told each phase as it starts and each part's outcome (the worker records them for the supervisor). */
  readonly onProgress?: (event: ProgressEvent) => void
  /**
   * The run folder was made by the supervisor, which keeps its own files there: it must exist and
   * hold nothing of check:all's yet. Otherwise the folder must not exist.
   */
  readonly existingRunDir?: boolean
}

const ORDER: readonly StepId[] = ['01', '05', '02', '03', '04', '06', '07']
/** A step that cannot be meaningful once another has failed. Step 07 always runs. */
const NEEDS: Partial<Record<StepId, readonly StepId[]>> = { '05': ['01'], '02': ['01'], '03': ['01', '02'], '04': ['01', '02', '03'], '06': ['01', '02', '03'] }

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
const duration = (ms: number): string => (ms >= MINUTE ? `${String(Math.round(ms / MINUTE))} min` : seconds(ms))
/** "BenchmarkError: The connection to Chrome closed ...": a subclass that keeps the name Error is named by its class. */
const messageOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const name = error.name === 'Error' && error.constructor.name !== '' ? error.constructor.name : error.name
  return `${name}: ${error.message}`
}
const stackOf = (error: unknown): string => (error instanceof Error ? (error.stack ?? messageOf(error)) : String(error))
export { messageOf, stackOf }

/**
 * Writes a file whole or not at all: to a temporary file beside it, then renamed over it, so a
 * reader (or a process ending part way through the write) never sees half of it.
 */
export function writeFileAtomic(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, text)
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, path)
      return
    } catch (error) {
      // Windows refuses a rename briefly while another program (a virus scanner) has the file open.
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

/**
 * Runs a step with a deadline. At the deadline the step is no longer waited for (StepDeadlineError,
 * which runReviewStep reports as a FAIL); whatever it still records after that is dropped, so a
 * step that finishes late cannot change a result already reported.
 */
async function withDeadline(run: StepFunction, context: ReviewContext, report: Report, id: StepId, ms: number, onDeadline: () => void): Promise<void> {
  let abandoned = false
  const recording = new Set<PropertyKey>(['add', 'pass', 'fail', 'warn', 'skip', 'info', 'incomplete'])
  const guarded = new Proxy(report, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => (abandoned && recording.has(property) ? undefined : Reflect.apply(value as (...parts: unknown[]) => unknown, target, args))
    },
  })
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandoned = true
      onDeadline()
      reject(new StepDeadlineError(`review:${id} did not finish within ${duration(ms)}, its deadline in check:all; it is no longer waited for, and what it records after this is dropped.`))
    }, ms)
  })
  try {
    await Promise.race([run(context, guarded), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The run's applications still running, from each pair's record: a process whose id holds the
 * token it was started with (or whose command line could not be read, so it cannot be ruled out).
 * Nothing is stopped here.
 */
export function ownedStillRunning(context: ReviewContext): string[] {
  const left: string[] = []
  for (const pair of context.pairs) {
    let state
    try {
      state = readState(pair.runDir)
    } catch (error) {
      left.push(`${pair.label}: the record ${statePath(pair.runDir)} cannot be read (${messageOf(error)}), so whether its applications run is unknown`)
      continue
    }
    if (state === undefined) continue
    const statuses = processStatuses(state.apps)
    for (const [index, app] of state.apps.entries()) {
      const status = statuses[index]
      if (status === 'running' || status === 'unverified') {
        left.push(`${pair.label} ${app.label}: process ${String(app.pid)}, port ${String(app.port)} (${status === 'running' ? 'running, its token confirmed' : 'its command line could not be read'}); `
          + `stop it with npm run app:stop with TRADE_BLOTTER_RUN_DIR set to ${pair.runDir} (app:stop checks the token again first)`)
      }
    }
  }
  return left
}
const zero = (): Category['counts'] => ({ PASS: 0, FAIL: 0, WARN: 0, SKIPPED: 0 })
const stepCounts = (report: Report | undefined): Category['counts'] =>
  ({ PASS: report?.count('PASS') ?? 0, FAIL: report?.count('FAIL') ?? 0, WARN: report?.count('WARN') ?? 0, SKIPPED: report?.count('SKIPPED') ?? 0 })

function categoryList(): Category[] {
  const make = (id: string, title: string, unit: Category['unit'] = 'checks'): Category => ({ id, title, unit, counts: zero(), lines: [], logs: [], milliseconds: 0 })
  return [
    make('environment', 'Environment (review:01)'),
    make('static', 'Lint, typecheck, build (review:05)'),
    make('server-tests', 'Server tests (review:05)', 'tests'),
    make('client-tests', 'Client tests (review:05)', 'tests'),
    make('schema', 'Schema check (review:05)'),
    make('ui', 'UI checks in a browser (review:05)'),
    make('data', 'Seed and start (review:02, 03)'),
    make('functional', 'Functional checks (review:04)'),
    make('performance', 'Performance benchmarks (review:06)'),
    make('stop', 'Stop and data protection (review:07)'),
    make('failure-detection', 'Failure detection'),
    make('documentation', 'Documentation consistency'),
  ]
}

/** The category of one line of a step's report. */
function categoryOf(step: StepId, name: string): string {
  switch (step) {
    case '01': return 'environment'
    case '02': case '03': return 'data'
    case '04': return 'functional'
    case '06': return 'performance'
    case '07': return 'stop'
    case '05':
      if (/^(Lint|Typecheck|Build)\b/.test(name)) return 'static'
      if (name.startsWith('Server tests')) return 'server-tests'
      if (name.startsWith('Client tests')) return 'client-tests'
      if (name.startsWith('Schema check')) return 'schema'
      return 'ui'
  }
}

/** Parses the command line: --quick, --verbose; anything else is a usage error. */
export function parseArguments(args: readonly string[]): { readonly mode: Mode; readonly verbose: boolean } | { readonly error: string } {
  let mode: Mode = 'full'
  let verbose = false
  for (const arg of args) {
    if (arg === '--quick') mode = 'quick'
    else if (arg === '--verbose') verbose = true
    else return { error: `Unknown argument ${arg}. Usage: npm run check:all [-- --quick] [-- --verbose]` }
  }
  return { mode, verbose }
}

export function environmentFacts(): Record<string, unknown> {
  const run = (command: string, args: readonly string[]): string | undefined => {
    const result = spawnSync(command, [...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm', windowsHide: true, timeout: 30_000 })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  let sqlite: string | undefined
  try {
    const db = new DatabaseSync(':memory:')
    sqlite = String(db.prepare('select sqlite_version() as v').get()?.['v'])
    db.close()
  } catch {
    sqlite = undefined
  }
  const browser = lookUpBrowser()
  const status = run('git', ['status', '--porcelain'])
  return {
    node: process.version,
    npm: /npm\/(\S+)/.exec(process.env['npm_config_user_agent'] ?? '')?.[1] ?? run('npm', ['--version']),
    sqlite,
    platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCores: cpus().length, totalMemoryBytes: totalmem(),
    browser: browser.kind === 'found' ? `${browser.path} (${browser.description})` : browser.kind,
    gitCommit: run('git', ['rev-parse', 'HEAD']),
    gitChangedFiles: status === undefined ? undefined : status.split('\n').filter((line) => line.trim() !== '').length,
    applicationFingerprint: applicationFingerprint(),
  }
}

/** Runs everything; returns the summary (also written to the run folder). */
export async function checkAll(options: CheckAllOptions = {}): Promise<CheckAllSummary> {
  const now = options.now ?? (() => new Date())
  const mode = options.mode ?? 'full'
  const verbose = options.verbose ?? false
  const started = now()
  const runId = options.runId ?? newRunId(started)
  const runDir = join(options.baseDir ?? join(REPOSITORY_ROOT, '.run', 'check-all'), runId)
  const fullLog = join(runDir, 'check-all.log')
  if (options.existingRunDir === true) {
    if (!existsSync(runDir) || existsSync(fullLog) || existsSync(join(runDir, 'summary.json'))) throw new Error(`The run folder ${runDir} must exist and hold no earlier check:all run.`)
  } else {
    if (existsSync(runDir)) throw new Error(`The run folder ${runDir} already exists; every run needs a new one.`)
    mkdirSync(runDir, { recursive: true })
  }
  /** Progress for the supervisor; telling it can never stop the run. */
  const progress = (event: ProgressEvent): void => {
    try {
      options.onProgress?.(event)
    } catch {
      // The supervisor then knows less; the run itself is unaffected.
    }
  }
  const testsDir = join(runDir, 'tests')
  const out = options.print ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  /** Always to the log; to the terminal when verbose, or when `always`. */
  const say = (line: string, always = false): void => {
    appendFileSync(fullLog, `${line}\n`)
    if (always || verbose) out(line)
  }

  const context = reviewContext({
    root: join(runDir, 'review'),
    ports: options.ports ?? { benchmark: [...CHECK_ALL_PORTS.benchmark], scratch: [...CHECK_ALL_PORTS.scratch] },
    ...(options.counts === undefined ? {} : { counts: options.counts }),
    ...(options.protection === undefined ? {} : { protection: options.protection }),
  })
  const environment = (options.environment ?? environmentFacts)()
  writeFileSync(join(runDir, 'environment.json'), `${JSON.stringify({ runId, recordedAt: started.toISOString(), ...environment }, null, 2)}\n`)

  say(`check:all ${mode === 'quick' ? '--quick (the benchmarks are left out: NOT complete verification)' : '(complete verification)'}`, true)
  say(`Run ${runId}, started ${started.toISOString()}`, true)
  say(`Node.js ${String(environment['node'])}, npm ${String(environment['npm'])}, SQLite ${String(environment['sqlite'])}, ${String(environment['platform'])} ${String(environment['arch'])}`, true)
  const changed = typeof environment['gitChangedFiles'] === 'number' && environment['gitChangedFiles'] > 0 ? ` with ${String(environment['gitChangedFiles'])} changed files` : ''
  say(`Application source fingerprint ${String(environment['applicationFingerprint'])}; Git ${String(environment['gitCommit']).slice(0, 7)}${changed}`, true)
  say(`Results: ${runDir}`, true)
  say('', true)

  const categories = categoryList()
  const category = (id: string): Category => {
    const found = categories.find((candidate) => candidate.id === id)
    if (found === undefined) throw new Error(id)
    return found
  }
  const record = (target: Category, line: Line): void => {
    target.lines.push(line)
    if (line.status !== 'INFO') target.counts[line.status]++
  }
  const commands: CommandRecord[] = []
  const runCommand = async (command: string, args: readonly string[], cwd: string, log: string): Promise<number> => {
    const text = `${command} ${args.join(' ')}`
    say(`  $ ${text}   (in ${relative(REPOSITORY_ROOT, cwd) || '.'}; log ${log})`)
    const begun = Date.now()
    const code = await runLogged(command, args, cwd, log)
    commands.push({ command: text, cwd, log, exitCode: code, milliseconds: Date.now() - begun })
    say(`    exit code ${String(code)} after ${seconds(Date.now() - begun)}`)
    return code
  }
  const deps: StepDependencies = { runCommand, testResultsDir: testsDir }
  const stepFunctions: Record<StepId, StepFunction> = {
    '01': (c, r) => stepSetup(c, r, deps),
    '02': (c, r) => stepSeed(c, r),
    '03': (c, r) => stepStart(c, r, deps),
    '04': (c, r) => stepCheck(c, r, deps),
    '05': (c, r) => stepTests(c, r, deps),
    '06': (c, r) => stepPerformance(c, r, deps),
    '07': (c, r) => stepStop(c, r, deps),
    ...options.steps,
  }

  const outcomes = new Map<StepId, number>()
  const steps: CheckAllSummary['steps'][number][] = []
  const skipped: string[] = []
  const deadlines: Record<StepId, number> = { ...STEP_DEADLINES_MS, ...options.stepDeadlinesMs }
  const abandoned: StepId[] = []

  // Rejections nothing awaited: recorded against what is running, never ending the process. (An
  // uncaught exception is not listened for: it ends the worker, and the supervisor takes over.)
  const unexpectedLog = join(runDir, 'unexpected-errors.log')
  const unexpectedErrors: UnexpectedError[] = []
  const failedByUnexpected = new Set<StepId>()
  let phase: { readonly label: string; readonly category: string; readonly step?: StepId } = { label: 'check:all', category: 'environment' }
  const onUnexpected = (kind: UnexpectedError['kind']) => (error: unknown): void => {
    const at = new Date().toISOString()
    const message = messageOf(error)
    const entry: UnexpectedError = { kind, during: phase.label, message, at }
    unexpectedErrors.push(entry)
    if (phase.step !== undefined) failedByUnexpected.add(phase.step)
    progress({ kind: 'unexpected', error: entry })
    try {
      appendFileSync(unexpectedLog, `${at} ${kind} while ${phase.label} ran\n${stackOf(error)}\n\n`)
      if (phase.step !== undefined) appendFileSync(join(context.logsDir, `review-${phase.step}.log`), `UNEXPECTED ${kind} while this step ran (nothing caught it): ${stackOf(error)}\n`)
      record(category(phase.category), {
        status: 'FAIL', name: `Unexpected error while ${phase.label} ran (${kind}): ${message}`,
        detail: `Nothing awaited it; check:all recorded it as a failure and carried on.\nFull stack: ${unexpectedLog}\n${stackOf(error)}`,
      })
      say(`UNEXPECTED ${kind} while ${phase.label} ran: ${message} (a failure; the full stack is in ${unexpectedLog})`, true)
    } catch {
      // Recording must never throw from a process event; the error is in unexpectedErrors and fails the run.
    }
  }
  const events: ProcessEvents = options.processEvents ?? process
  const onRejection = onUnexpected('unhandled rejection')
  events.on('unhandledRejection', onRejection)
  try {

  for (const id of ORDER) {
    const title = STEPS[id].title
    const touched = new Set<Category>()
    try {
    // -1: the step did not run. A step whose prerequisite failed or did not run is left out, and says why.
    const blocked = (NEEDS[id] ?? []).filter((need) => outcomes.get(need) === EXIT.failed || outcomes.get(need) === -1)
    const reason = id === '06' && mode === 'quick' ? 'left out by --quick'
      : blocked.length > 0 ? `not run: review:${blocked.join(' and review:')} failed or did not run` : undefined
    if (reason !== undefined) {
      outcomes.set(id, -1)
      steps.push({ id, title, exitCode: 'not run', milliseconds: 0, reason })
      for (const target of id === '05' ? ['static', 'server-tests', 'client-tests', 'schema', 'ui'] : [categoryOf(id, '')]) {
        const entry = category(target)
        if (entry.lines.length === 0 && entry.notRun === undefined) {
          entry.notRun = reason
          record(entry, { status: 'SKIPPED', name: `${entry.title}: ${reason}` })
        }
      }
      skipped.push(`review:${id} ${title}: ${reason}`)
      say(`SKIPPED  review:${id} ${title}: ${reason}`, true)
      progress({ kind: 'step', id, title, exitCode: 'not run', reason })
      continue
    }
    phase = { label: `review:${id}`, category: categoryOf(id, ''), step: id }
    progress({ kind: 'phase', label: phase.label, step: id, limitMs: deadlines[id] })
    say(`--- review:${id} ${title}`)
    const begun = Date.now()
    let stepLog: string | undefined
    let stepReport: Report | undefined
    // The steps' own progress lines (benchmarks, UI checks) go to the log, and to the terminal when verbose.
    const original = console.log
    console.log = (...parts: unknown[]) => { say(`  ${parts.map(String).join(' ')}`) }
    let code: number
    try {
      code = await runReviewStep(id, context, {
        steps: { ...STEPS, [id]: { title, run: (c: ReviewContext, r: Report) => withDeadline(stepFunctions[id], c, r, id, deadlines[id], () => { abandoned.push(id) }) } },
        print: (line) => { say(`  ${line.replace(/\n/g, '\n  ')}`) },
        onFinished: (report, log) => { stepReport = report; stepLog = log },
      })
    } finally {
      console.log = original
    }
    if (failedByUnexpected.has(id) && code !== EXIT.failed) {
      // The step reported no failure itself, but an error nothing caught happened while it ran.
      code = EXIT.failed
      const run = readRun(context)
      if (run !== undefined) finishStep(context, run.id, id, code)
    }
    outcomes.set(id, code)
    const milliseconds = Date.now() - begun
    steps.push({ id, title, exitCode: code, milliseconds, ...(stepLog === undefined ? {} : { log: stepLog }) })
    for (const line of stepReport?.lines ?? []) {
      const target = category(categoryOf(id, line.name))
      touched.add(target)
      record(target, line)
    }
    if (stepReport === undefined) record(category(categoryOf(id, '')), { status: 'FAIL', name: `review:${id} reported nothing` })
    for (const target of touched) if (stepLog !== undefined) target.logs.push(stepLog)
    if (id === '05') {
      // Step 05's time, by what its commands took; the UI checks have the rest.
      const time = (pattern: RegExp): number => commands.filter((command) => pattern.test(command.command)).reduce((sum, command) => sum + command.milliseconds, 0)
      const parts: [string, number][] = [['static', time(/^npm run (lint|typecheck|build)\b/)], ['server-tests', time(/^npm run test -w server/)],
        ['client-tests', time(/^npm run test -w client/)], ['schema', time(/^npm run db:check/)]]
      for (const [target, ms] of parts) category(target).milliseconds += ms
      category('ui').milliseconds += Math.max(0, milliseconds - parts.reduce((sum, [, ms]) => sum + ms, 0))
      applyTestResults(categories, testsDir, commands)
      // review:05 stops at its first failure: what comes after it did not run, and says so.
      for (const target of ['static', 'server-tests', 'client-tests', 'schema', 'ui'].map(category)) {
        if (target.lines.some((line) => line.status !== 'INFO')) continue
        target.notRun = 'not run: review:05 stopped at an earlier failure'
        record(target, { status: 'SKIPPED', name: `${target.title}: ${target.notRun}` })
        skipped.push(`${target.title}: ${target.notRun}`)
      }
      if (verbose) {
        for (const target of [category('server-tests'), category('client-tests')]) {
          say(`  Every ${target.title.toLowerCase()} test, from vitest's results:`)
          for (const line of target.lines) say(`    ${line.status.padEnd(7)}  ${line.name}${line.detail === undefined ? '' : `\n             ${line.detail.split('\n').slice(0, 12).join('\n             ')}`}`)
        }
      }
    } else {
      category(categoryOf(id, '')).milliseconds += milliseconds
    }
    const counts = (['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const).map((status) => `${String(stepReport?.count(status) ?? 0)} ${status}`).join(', ')
    const unexpected = unexpectedErrors.filter((entry) => entry.during === `review:${id}`).length
    const extra = unexpected > 0 ? `, and ${String(unexpected)} unexpected ${unexpected === 1 ? 'error' : 'errors'}` : ''
    say(`${code === EXIT.passed ? 'PASSED ' : code === EXIT.incomplete ? 'INCOMPLETE' : 'FAILED '}  review:${id} ${title}: ${counts}${extra} (${seconds(milliseconds)})`, true)
    progress({ kind: 'step', id, title, exitCode: code, counts: stepCounts(stepReport), ...(stepLog === undefined ? {} : { log: stepLog }) })
    } catch (error) {
      // check:all itself failed around the step: a FAIL of the step, and the run goes on (step 07 among what follows).
      outcomes.set(id, EXIT.failed)
      const reason = `check:all could not finish it: ${messageOf(error)}`
      const index = steps.findIndex((entry) => entry.id === id)
      const entry = { ...(steps[index] ?? { id, title, milliseconds: 0 }), exitCode: EXIT.failed, reason }
      if (index === -1) steps.push(entry)
      else steps[index] = entry
      try {
        record(category(categoryOf(id, '')), { status: 'FAIL', name: `check:all could not finish review:${id}: ${messageOf(error)}`, detail: stackOf(error) })
        appendFileSync(unexpectedLog, `${new Date().toISOString()} check:all could not finish review:${id}\n${stackOf(error)}\n\n`)
        say(`FAILED   review:${id} ${title}: check:all could not finish it: ${messageOf(error)}`, true)
        progress({ kind: 'step', id, title, exitCode: EXIT.failed, reason })
      } catch {
        // The outcome above already fails the run.
      }
    } finally {
      phase = { label: `check:all after review:${id}`, category: categoryOf(id, '') }
    }
  }

  // Step 07 did not pass: are any of this run's applications still running? Each is named, with how to stop it.
  if (outcomes.get('07') !== EXIT.passed) {
    phase = { label: 'the clean-up check', category: 'stop' }
    progress({ kind: 'phase', label: phase.label, limitMs: PHASE_LIMITS_MS.cleanUpCheck })
    const stop = category('stop')
    try {
      const left = (options.stillRunning ?? ownedStillRunning)(context)
      if (left.length > 0) {
        record(stop, { status: 'FAIL', name: `Applications this run started are still running after review:07 (${String(left.length)})`, detail: left.join('\n') })
        say(`FAILED   Clean-up: ${String(left.length)} of this run's applications still running`, true)
      } else {
        say('Clean-up: none of this run\'s applications is running', true)
      }
    } catch (error) {
      record(stop, { status: 'FAIL', name: `Whether this run's applications still run could not be checked: ${messageOf(error)}`, detail: stackOf(error) })
    }
  }

  // Failure detection: after step 07, so it never competes with the applications for the CPU.
  const detection = category('failure-detection')
  if ((outcomes.get('01') ?? -1) === EXIT.failed) {
    detection.notRun = 'not run: step 01 failed'
    record(detection, { status: 'SKIPPED', name: `Failure detection: ${detection.notRun}` })
    skipped.push(`Failure detection: ${detection.notRun}`)
    say(`SKIPPED  Failure detection: ${detection.notRun}`, true)
    progress({ kind: 'section', id: 'failure-detection', title: detection.title, counts: { ...detection.counts }, notRun: detection.notRun })
  } else {
    phase = { label: 'failure detection', category: 'failure-detection' }
    progress({ kind: 'phase', label: phase.label, limitMs: PHASE_LIMITS_MS.failureDetectionCommand })
    say('--- Failure detection: each change on a temporary copy of the server, with a control')
    const begun = Date.now()
    const evidenceDir = join(runDir, 'failure-detection')
    try {
      mkdirSync(evidenceDir, { recursive: true })
      const results = await (options.failureDetection ?? runFailureDetection)({
        runId, evidenceDir,
        onCheck: (result) => { say(`    ${result.check.id}: ${result.status} after ${seconds(result.milliseconds)}`) },
        onCommand: (line) => {
          // Failure detection stops each command at its own timeout; the supervisor's limit restarts with each.
          progress({ kind: 'phase', label: 'failure detection', limitMs: PHASE_LIMITS_MS.failureDetectionCommand, detail: line })
          say(`    $ ${line}`)
        },
      })
      for (const result of results) {
        record(detection, { status: result.status, name: `${result.check.id}: ${result.check.rule}`, detail: `${result.detail}\nEvidence: ${result.evidence}` })
        say(`  ${result.status.padEnd(7)}  ${result.check.id}: ${result.check.rule} (${seconds(result.milliseconds)})\n           ${result.detail}\n           Evidence: ${result.evidence}`)
      }
      writeFileSync(join(evidenceDir, 'results.json'), `${JSON.stringify(results.map((result) => ({ ...result, check: { ...result.check, expectFailing: String(result.check.expectFailing) } })), null, 2)}\n`)
    } catch (error) {
      record(detection, { status: 'FAIL', name: `Failure detection stopped by an unexpected error: ${messageOf(error)}`, detail: `What it finished is above and in ${evidenceDir}.\n${stackOf(error)}` })
    }
    detection.logs.push(evidenceDir)
    detection.milliseconds = Date.now() - begun
    say(`${detection.counts.FAIL > 0 ? 'FAILED ' : 'PASSED '}  Failure detection: ${String(detection.counts.PASS)} of ${String(detection.counts.PASS + detection.counts.FAIL)} changes detected (${seconds(detection.milliseconds)})`, true)
    progress({ kind: 'section', id: 'failure-detection', title: detection.title, counts: { ...detection.counts } })
  }

  // Documentation, last: compared with this run's test totals.
  const docs = category('documentation')
  {
    phase = { label: 'the documentation checks', category: 'documentation' }
    progress({ kind: 'phase', label: phase.label, limitMs: PHASE_LIMITS_MS.documentation })
    say('--- Documentation consistency')
    const begun = Date.now()
    const file = join(runDir, 'documentation.json')
    try {
      const server = readVitestResults(testResultsFile(testsDir, 'server'))
      const client = readVitestResults(testResultsFile(testsDir, 'client'))
      const checks = await (options.documentation ?? documentationChecks)({
        testTotals: { ...(server === undefined ? {} : { server: server.numTotalTests }), ...(client === undefined ? {} : { client: client.numTotalTests }) },
      })
      for (const check of checks) {
        record(docs, check)
        say(`  ${check.status.padEnd(7)}  ${check.name}${check.detail === undefined ? '' : `\n           ${check.detail.replace(/\n/g, '\n           ')}`}`)
      }
      writeFileSync(file, `${JSON.stringify(checks, null, 2)}\n`)
    } catch (error) {
      record(docs, { status: 'FAIL', name: `The documentation checks stopped by an unexpected error: ${messageOf(error)}`, detail: stackOf(error) })
    }
    docs.logs.push(file)
    docs.milliseconds = Date.now() - begun
    say(`${docs.counts.FAIL > 0 ? 'FAILED ' : 'PASSED '}  Documentation: ${String(docs.counts.PASS)} PASS, ${String(docs.counts.FAIL)} FAIL, ${String(docs.counts.WARN)} WARN (${seconds(docs.milliseconds)})`, true)
    progress({ kind: 'section', id: 'documentation', title: docs.title, counts: { ...docs.counts } })
  }
  phase = { label: 'the summary', category: 'documentation' }
  progress({ kind: 'phase', label: phase.label, limitMs: PHASE_LIMITS_MS.summary })

  const finished = now()
  const totals = zero()
  for (const entry of categories) for (const status of ['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const) totals[status] += entry.counts[status]
  const failed = totals.FAIL > 0 || [...outcomes.values()].includes(EXIT.failed) || unexpectedErrors.length > 0 || abandoned.length > 0
  const incomplete = [...outcomes.entries()].some(([id, code]) => code === EXIT.incomplete || (code === -1 && !(id === '06' && mode === 'quick')))
  const result: CheckAllSummary['result'] = failed ? 'FAILED' : incomplete ? 'INCOMPLETE' : mode === 'quick' ? 'QUICK PASSED' : 'PASSED'
  const exitCode = failed ? EXIT.failed : incomplete ? EXIT.incomplete : EXIT.passed
  const summary: CheckAllSummary = {
    tool: 'check:all', version: 1, runId, mode, startedAt: started.toISOString(), finishedAt: finished.toISOString(),
    milliseconds: finished.getTime() - started.getTime(), runDir, environment, steps, categories, commands, totals, result, exitCode, skipped,
    unexpectedErrors: [...unexpectedErrors], abandoned: [...abandoned],
  }
  // Whole or not at all: the supervisor reads it to confirm the run finished.
  writeFileAtomic(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  const text = formatSummary(summary, verbose)
  writeFileSync(join(runDir, 'summary.txt'), `${formatSummary(summary, false)}\n`)
  say('', true)
  for (const line of text.split('\n')) say(line, true)
  return summary
  } finally {
    events.off('unhandledRejection', onRejection)
  }
}

/** Server and client tests counted one by one, from vitest's JSON results, in place of the step's single line. */
function applyTestResults(categories: Category[], testsDir: string, commands: readonly CommandRecord[]): void {
  for (const [id, workspace] of [['server-tests', 'server'], ['client-tests', 'client']] as const) {
    const target = categories.find((entry) => entry.id === id)
    const file = testResultsFile(testsDir, workspace)
    const results = readVitestResults(file)
    if (target === undefined || results === undefined) continue
    const warnings = target.lines.filter((line) => line.status === 'WARN')
    const failures = target.lines.filter((line) => line.status === 'FAIL')
    target.lines = [...failures, ...warnings, ...testLines(results)]
    target.counts = {
      PASS: results.numPassedTests,
      FAIL: Math.max(results.numFailedTests, failures.length),
      WARN: warnings.length,
      SKIPPED: (results.numPendingTests ?? 0) + (results.numTodoTests ?? 0),
    }
    target.logs.push(file, ...commands.filter((command) => command.command.includes(`test -w ${workspace}`)).map((command) => command.log))
  }
}

function testLines(results: VitestResults): Line[] {
  return results.testResults.flatMap((file) => file.assertionResults.map((test): Line => {
    const status: Status = test.status === 'passed' ? 'PASS' : test.status === 'failed' ? 'FAIL' : 'SKIPPED'
    const name = `${relative(REPOSITORY_ROOT, file.name).replaceAll('\\', '/')} > ${test.fullName}`
    return test.failureMessages.length > 0 ? { status, name, detail: test.failureMessages.join('\n') } : { status, name }
  }))
}

/** The closing summary: one row per category, then each failure with its message and log, then the result. */
export function formatSummary(summary: CheckAllSummary, verbose: boolean): string {
  const rows = summary.categories.map((entry) => {
    const counts = (['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const).map((status) => String(entry.counts[status]).padStart(6)).join('')
    return `${entry.title.padEnd(40)}${counts}  ${entry.unit === 'tests' ? 'tests ' : 'checks'}  ${entry.notRun === undefined ? seconds(entry.milliseconds) : entry.notRun}`
  })
  const lines = [
    `Summary of run ${summary.runId} (${summary.mode === 'quick' ? 'quick' : 'full'}), ${summary.startedAt} to ${summary.finishedAt}`,
    `${'Category'.padEnd(40)}${['PASS', 'FAIL', 'WARN', 'SKIP'].map((status) => status.padStart(6)).join('')}`,
    ...rows,
    `${'Total'.padEnd(40)}${(['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const).map((status) => String(summary.totals[status]).padStart(6)).join('')}  in ${seconds(summary.milliseconds)}`,
  ]
  const failures = summary.categories.flatMap((entry) => entry.lines.filter((line) => line.status === 'FAIL').map((line) => ({ entry, line })))
  if (failures.length > 0) {
    lines.push('', 'Failures:')
    for (const { entry, line } of failures) {
      // Concise: the message and the first lines of detail; the log has the rest.
      const detail = (line.detail ?? '').split('\n').filter((text) => !/^\s+at /.test(text) || verbose).slice(0, verbose ? undefined : 4)
      lines.push(`  ${entry.title}: ${line.name}`, ...detail.filter((text) => text.trim() !== '').map((text) => `      ${text}`))
      if (entry.logs.length > 0) lines.push(`      Log: ${entry.logs[0] ?? ''}`)
    }
  }
  const warnings = summary.categories.flatMap((entry) => entry.lines.filter((line) => line.status === 'WARN').map((line) => `  ${entry.title}: ${line.name}`))
  if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings)
  if (summary.unexpectedErrors.length > 0 || summary.abandoned.length > 0) {
    lines.push('', `Unexpected errors (each also a failure above; full stacks in ${join(summary.runDir, 'unexpected-errors.log')}):`,
      ...summary.unexpectedErrors.map((entry) => `  ${entry.kind} while ${entry.during} ran: ${entry.message}`),
      ...summary.abandoned.map((id) => `  review:${id} was still running at its deadline and is no longer waited for`))
  }
  if (summary.skipped.length > 0) lines.push('', 'Not run:', ...summary.skipped.map((text) => `  ${text}`))
  lines.push('', 'Logs and evidence:',
    `  ${join(summary.runDir, 'summary.txt')} (this summary) and summary.json`,
    `  ${join(summary.runDir, 'check-all.log')} (every check with its detail, and every command; individual tests are in tests/)`,
    `  ${join(summary.runDir, 'review', 'logs')} (each step's log and command logs)`,
    `  ${join(summary.runDir, 'tests')} (vitest results as JSON)`,
    `  ${join(summary.runDir, 'review', 'ui-check')} (screenshots)${summary.mode === 'quick' ? '' : `, ${join(summary.runDir, 'review', 'perf')} (benchmark results)`}`,
    `  ${join(summary.runDir, 'failure-detection')} and documentation.json`)
  const verdict = {
    'PASSED': 'PASSED: complete verification passed',
    'QUICK PASSED': 'QUICK PASSED: every check run passed, but the benchmarks were left out; this is not complete verification (run npm run check:all)',
    'FAILED': 'FAILED',
    'INCOMPLETE': 'INCOMPLETE: a required part could not run (see Not run, and INCOMPLETE steps above)',
  }[summary.result]
  lines.push('', `RESULT: ${verdict} (exit code ${String(summary.exitCode)})`)
  return lines.join('\n')
}
