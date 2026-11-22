import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { CHECK_ALL_PORTS, messageOf, ownedStillRunning, stackOf, STEP_DEADLINES_MS, writeFileAtomic, type CheckAllSummary, type Mode, type UnexpectedError } from './check-all.ts'
import { sha256, WORKER_FILES, type WorkerConfig, type WorkerFatal, type WorkerState } from './check-all-worker.ts'
import { readState, REPOSITORY_ROOT, terminateOwned } from './lifecycle.ts'
import { processesMentioning, type MentioningProcess } from './process-probe.ts'
import { EXIT, Report, reviewContext, type Status } from './review-context.ts'
import { newRunId, STEP_IDS, type StepId } from './review-run.ts'
import { stepStop, type StepDependencies } from './review-steps.ts'
import { STEPS } from './review.ts'
import type { Protection } from './trade-data.ts'

/**
 * The check:all supervisor: npm run check:all runs this (check-all-main.ts), and it runs nothing of
 * the verification itself. It makes the run's folder, starts the worker (check-all-worker.ts) and
 * watches it:
 *
 * - The worker ends with exit code 0, 1 or 3, and the summary in the run's folder is this worker's
 *   and complete (judgeWorkerOutcome): that is the run's result, output and exit code, unchanged;
 *   the supervisor adds nothing.
 * - Anything else (an uncaught exception, which ends the worker as Node.js always does; the worker
 *   killed or ending without a summary it can vouch for; a phase past its hard deadline; Ctrl+C or
 *   SIGTERM): the run has FAILED. The supervisor, whose own process ran none of the failing code,
 *   makes sure the worker has exited (stopping it, if need be, through its own handle, never by a
 *   process id), then stops this run's applications with step 07's stepStop (each confirmed by its
 *   record, its token, as the only listener on its port, and by its identity; bounded waits; ports
 *   checked released), lists what is still running, keeps every file, and writes a FAILED summary
 *   that keeps apart what finished, what was running, what never ran, the unexpected errors, the
 *   clean-up and what is left. Exit code 1.
 *
 * Hard deadlines: each phase the worker reports may take its own limit (a step's deadline in
 * STEP_DEADLINES_MS, after which the worker itself fails the step and moves on; for other phases
 * PHASE_LIMITS_MS) plus GRACE_MS. Only a worker that cannot act on its own deadline, because its
 * event loop is blocked or it is stuck outside one, reaches the hard deadline.
 */

export const GRACE_MS = 5 * 60_000
/** How long the worker has to be confirmed gone after it is told to stop. */
export const WORKER_STOP_MS = 15_000
/** How long the clean-up after a crash may take: step 07's own deadline. */
export const CLEANUP_DEADLINE_MS = STEP_DEADLINES_MS['07']
/** A phase the worker reports with no limit the supervisor knows may take at most this. */
const LONGEST_OTHER_PHASE_MS = 30 * 60_000
const POLL_MS = 1_000

export type CrashReason = 'fatal exception' | 'exited without a summary it can vouch for' | 'killed' | 'hard deadline' | 'interrupted' | 'could not start'

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface SuperviseOptions {
  readonly mode?: Mode
  readonly verbose?: boolean
  readonly baseDir?: string
  readonly runId?: string
  readonly ports?: WorkerConfig['ports']
  readonly counts?: WorkerConfig['counts']
  readonly protection?: Protection
  readonly stepDeadlinesMs?: Partial<Record<StepId, number>>
  readonly graceMs?: number
  readonly pollMs?: number
  readonly cleanupDeadlineMs?: number
  /** The worker's script and any extra arguments: check-all-worker.ts by default (tests pass a stand-in). */
  readonly worker?: { readonly script: string; readonly args?: readonly string[] }
  /** The worker's standard output: the terminal (inherited, so a normal run's output is the worker's own), or a function. */
  readonly output?: 'inherit' | ((text: string) => void)
  /** The supervisor's own lines (the crash summary): standard output by default. */
  readonly print?: (line: string) => void
  /** The worker's standard error, as it arrives (it is also kept in worker-stderr.log): standard error by default. */
  readonly printError?: (text: string) => void
  readonly signals?: SignalSource
  /** Ends the supervisor at once, at a second Ctrl+C: process.exit by default. */
  readonly exitNow?: (code: number) => void
  /** Stops the worker through its handle and confirms it has gone; terminateOwned by default. */
  readonly terminateWorker?: (child: ChildProcess) => Promise<{ readonly confirmed: boolean; readonly detail: string }>
  /** Step 07's dependencies for the clean-up after a crash (tests replace the identity check, as review.test.ts does). */
  readonly stopDependencies?: StepDependencies
  /** Where failure detection makes its copies: server/ by default. */
  /** Where failure detection makes its copies: server/ and client/ (M6 Phase 2) by default. */
  readonly buildCopiesRoots?: readonly string[]
  /** Writes a summary file whole or not at all: writeFileAtomic by default. */
  readonly writeFile?: (path: string, text: string) => void
  /** Processes whose command line mentions one of the texts: processesMentioning by default. */
  readonly findProcesses?: (texts: readonly string[]) => MentioningProcess[] | undefined
  /** Told the worker's handle once it has started (tests use it to clean up after a stand-in). */
  readonly onWorker?: (child: ChildProcess) => void
  readonly now?: () => Date
}

export interface SupervisedRun {
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
  /** The worker's own result was accepted. */
  readonly accepted: boolean
  readonly crash?: CrashSummary
  /**
   * Something the supervisor started may still be running (clean-up past its deadline) or the
   * worker was not confirmed gone: the process must end once the summary is written.
   */
  readonly endNow: boolean
}

interface Line { readonly status: Status; readonly name: string; readonly detail?: string }

/** The summary of a run the worker did not finish: never a PASS for anything that did not finish. */
export interface CrashSummary {
  readonly tool: 'check:all'
  readonly version: 1
  readonly runId: string
  readonly mode: Mode
  readonly startedAt: string
  readonly finishedAt: string
  readonly runDir: string
  readonly result: 'FAILED'
  readonly exitCode: 1
  readonly worker: {
    readonly completed: false
    readonly reason: CrashReason
    readonly detail: string
    readonly pid?: number
    readonly exitCode: number | null
    readonly signal: string | null
    /** Confirmed gone before any clean-up began. */
    readonly confirmedStopped: boolean
    readonly fatalError?: Pick<WorkerFatal, 'origin' | 'phase' | 'message' | 'at'>
    /** Why the worker's own summary, when it wrote one, was not accepted. */
    readonly summaryProblems: readonly string[]
    /** The result the worker's own summary gave, when it wrote one (not accepted). */
    readonly workerResult?: string
  }
  readonly phases: {
    /** Parts that finished, with their own results (their counts are theirs). */
    readonly completed: readonly { readonly name: string; readonly exitCode: number; readonly counts?: Record<'PASS' | 'FAIL' | 'WARN' | 'SKIPPED', number>; readonly log?: string }[]
    /** The part running when the worker stopped: its partial results, if any, are only in its log. */
    readonly interrupted?: { readonly name: string; readonly startedAt: string; readonly detail?: string }
    readonly notRun: readonly string[]
  }
  readonly unexpectedErrors: readonly UnexpectedError[]
  readonly cleanup: {
    readonly ran: boolean
    readonly finished: boolean
    readonly lines: readonly Line[]
    readonly log?: string
  }
  readonly remaining: {
    /** This run's applications still running, each with how to stop it. */
    readonly applications: readonly string[]
    /** Other processes mentioning this run (not started with a token, so never stopped here). */
    readonly processes: readonly MentioningProcess[]
    /** Whether the processes could be listed. */
    readonly processesListed: boolean
    /** Temporary folders of this run, kept. */
    readonly temporaryFolders: readonly string[]
  }
  readonly instructions: readonly string[]
  readonly evidence: readonly string[]
}

const RESULT_EXIT: Readonly<Record<CheckAllSummary['result'], number>> = { 'PASSED': 0, 'QUICK PASSED': 0, 'FAILED': 1, 'INCOMPLETE': 3 }

/**
 * Whether the worker's run can stand as the result: it exited by itself with 0, 1 or 3; it recorded
 * no fatal error; its state is finished and names this run, this worker's token and process; the
 * summary is the one it finished with (same SHA-256), names this run, and agrees with its exit code.
 */
export function judgeWorkerOutcome(input: {
  readonly runId: string
  readonly workerToken: string
  readonly pid: number | undefined
  readonly exitCode: number | null
  readonly signal: string | null
  readonly state: WorkerState | undefined
  readonly fatal: boolean
  readonly summaryText: string | undefined
}): { readonly ok: true; readonly exitCode: number } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = []
  if (input.fatal) problems.push('the worker recorded a fatal error')
  if (input.signal !== null) problems.push(`the worker was ended by ${input.signal}`)
  else if (input.exitCode === null || ![EXIT.passed, EXIT.failed, EXIT.incomplete].includes(input.exitCode as 0 | 1 | 3)) problems.push(`the worker's exit code ${String(input.exitCode)} is not one check:all ends with`)
  const state = input.state
  if (state === undefined) problems.push('the worker left no state')
  else {
    if (state.state !== 'finished') problems.push(`the worker's state is ${state.state}, not finished (last phase: ${state.phase.label})`)
    if (state.runId !== input.runId) problems.push(`the worker's state names run ${state.runId}`)
    if (state.workerToken !== input.workerToken) problems.push('the worker\'s state carries another worker\'s token')
    if (state.pid !== input.pid) problems.push(`the worker's state names process ${String(state.pid)}, not ${String(input.pid)}`)
    if (state.state === 'finished' && state.exitCode !== input.exitCode) problems.push(`the worker's state says exit code ${String(state.exitCode)}, but it exited with ${String(input.exitCode)}`)
  }
  if (input.summaryText === undefined) problems.push('there is no summary.json')
  else {
    if (state?.summarySha256 !== undefined && sha256(input.summaryText) !== state.summarySha256) problems.push('summary.json is not the one the worker finished with')
    let summary: Partial<CheckAllSummary> | undefined
    try {
      summary = JSON.parse(input.summaryText) as Partial<CheckAllSummary>
    } catch {
      problems.push('summary.json cannot be read as JSON')
    }
    if (summary !== undefined) {
      if (summary.tool !== 'check:all' || typeof summary.finishedAt !== 'string') problems.push('summary.json is not a finished check:all summary')
      if (summary.runId !== input.runId) problems.push(`summary.json names run ${String(summary.runId)}`)
      if (summary.exitCode !== input.exitCode) problems.push(`summary.json says exit code ${String(summary.exitCode)}, but the worker exited with ${String(input.exitCode)}`)
      if (summary.result === undefined || RESULT_EXIT[summary.result] !== summary.exitCode) problems.push(`summary.json's result ${String(summary.result)} does not match its exit code ${String(summary.exitCode)}`)
    }
  }
  return problems.length === 0 && input.exitCode !== null ? { ok: true, exitCode: input.exitCode } : { ok: false, problems }
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
const readJson = (path: string): unknown => {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const minutes = (ms: number): string => (ms >= 60_000 ? `${String(Math.round(ms / 60_000))} min` : `${(ms / 1000).toFixed(1)} s`)

/** Stops the worker through its own handle (SIGKILL; on Windows, TerminateProcess) and waits until its handle says it exited. */
async function terminateByHandle(child: ChildProcess): Promise<{ readonly confirmed: boolean; readonly detail: string }> {
  const report = await terminateOwned({ label: 'check:all worker', pid: child.pid ?? 0, handle: child }, { timeoutMs: WORKER_STOP_MS })
  return { confirmed: report.ok, detail: `${report.outcome}: ${report.events.join('; ')}` }
}

/** Runs check:all in a worker and returns its result, or reports the run the worker could not finish. */
export async function superviseCheckAll(options: SuperviseOptions = {}): Promise<SupervisedRun> {
  const now = options.now ?? (() => new Date())
  const started = now()
  const mode = options.mode ?? 'full'
  const runId = options.runId ?? newRunId(started)
  const baseDir = options.baseDir ?? join(REPOSITORY_ROOT, '.run', 'check-all')
  const runDir = join(baseDir, runId)
  if (existsSync(runDir)) throw new Error(`The run folder ${runDir} already exists; every run needs a new one.`)
  mkdirSync(runDir, { recursive: true })
  const config: WorkerConfig = {
    runId, workerToken: randomUUID(), baseDir, mode, verbose: options.verbose ?? false,
    ports: options.ports ?? { benchmark: [...CHECK_ALL_PORTS.benchmark], scratch: [...CHECK_ALL_PORTS.scratch] },
    ...(options.counts === undefined ? {} : { counts: options.counts }),
    ...(options.protection === undefined ? {} : { protection: options.protection }),
    ...(options.stepDeadlinesMs === undefined ? {} : { stepDeadlinesMs: options.stepDeadlinesMs }),
  }
  const configPath = join(runDir, WORKER_FILES.config)
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const print = options.print ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const printError = options.printError ?? ((text: string) => { process.stderr.write(text) })
  const signals: SignalSource = options.signals ?? process
  const graceMs = options.graceMs ?? GRACE_MS
  const deadlines: Record<StepId, number> = { ...STEP_DEADLINES_MS, ...options.stepDeadlinesMs }
  const stderrLog = join(runDir, WORKER_FILES.stderr)

  // The worker.
  const worker = options.worker ?? { script: join(import.meta.dirname, 'check-all-worker.ts') }
  const output = options.output ?? 'inherit'
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker.script, ...(worker.args ?? []), '--config', configPath], {
    cwd: REPOSITORY_ROOT, env: process.env, stdio: ['ignore', output === 'inherit' ? 'inherit' : 'pipe', 'pipe'], windowsHide: true,
  })
  options.onWorker?.(child)
  if (typeof output === 'function') child.stdout?.on('data', (chunk: Buffer) => { output(chunk.toString()) })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    try {
      appendFileSync(stderrLog, text)
    } catch {
      // Still shown below.
    }
    printError(text)
  })

  type Ending = { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null } | { readonly kind: 'error'; readonly error: Error }
    | { readonly kind: 'deadline'; readonly detail: string } | { readonly kind: 'signal'; readonly signal: string }
  let exited: { code: number | null; signal: string | null } | undefined
  const exit = new Promise<Ending>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      resolve({ kind: 'exit', code, signal })
    })
    child.once('error', (error) => { resolve({ kind: 'error', error }) })
  })

  // Ctrl+C and SIGTERM: the first means the run is interrupted (the worker, which on a terminal had
  // it too, is stopped if it has not ended); a second ends the supervisor at once, saying what may be left.
  let interruptedBy: string | undefined
  let releaseSignal: (ending: Ending) => void = () => undefined
  const signalled = new Promise<Ending>((resolve) => { releaseSignal = resolve })
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => (): void => {
    if (interruptedBy === undefined) {
      interruptedBy = signal
      releaseSignal({ kind: 'signal', signal })
      return
    }
    printError(`\ncheck:all: ${signal} again; stopping now, before the clean-up has finished. This run's applications may still be running: `
      + `stop each pair with npm run app:stop with TRADE_BLOTTER_RUN_DIR set to ${join(runDir, 'review', 'run', 'benchmark')} and then ${join(runDir, 'review', 'run', 'scratch')} `
      + `(app:stop checks each process's token first). Everything is kept in ${runDir}.\n`)
    ;(options.exitNow ?? ((code: number) => process.exit(code)))(EXIT.failed)
  }
  const onInterrupt = onSignal('SIGINT')
  const onTerminate = onSignal('SIGTERM')
  signals.on('SIGINT', onInterrupt)
  signals.on('SIGTERM', onTerminate)

  // Hard deadlines, from the phase the worker reports.
  const statePath = join(runDir, WORKER_FILES.state)
  let seen: { key: string; label: string; limitMs: number; since: number } = { key: '', label: 'starting the worker', limitMs: LONGEST_OTHER_PHASE_MS, since: Date.now() }
  let watch: NodeJS.Timeout | undefined
  const overdue = new Promise<Ending>((resolve) => {
    watch = setInterval(() => {
      const state = readJson(statePath) as WorkerState | undefined
      if (state !== undefined) {
        const key = `${state.phase.label}|${state.phase.startedAt}|${state.phase.detail ?? ''}`
        if (key !== seen.key) {
          const limitMs = state.phase.step !== undefined && (STEP_IDS as readonly string[]).includes(state.phase.step) ? deadlines[state.phase.step]
            : Math.min(state.phase.limitMs, LONGEST_OTHER_PHASE_MS)
          seen = { key, label: state.phase.label, limitMs, since: Date.now() }
        }
      }
      const elapsed = Date.now() - seen.since
      if (elapsed > seen.limitMs + graceMs) {
        resolve({ kind: 'deadline', detail: `${seen.label} was still running after ${minutes(elapsed)}: its limit is ${minutes(seen.limitMs)} and the grace period ${minutes(graceMs)}` })
      }
    }, options.pollMs ?? POLL_MS)
  })

  const ending = await Promise.race([exit, signalled, overdue])
  clearInterval(watch)

  // Ctrl+C reaches the worker too on a terminal: give it a moment to end by itself before stopping it.
  if (ending.kind === 'signal' && exited === undefined) await Promise.race([exit, sleep(2_000)])

  let confirmedStopped = exited !== undefined || ending.kind === 'error'
  const stoppedBySupervisor = !confirmedStopped
  let stopDetail = ''
  if (!confirmedStopped) {
    try {
      const stopped = await (options.terminateWorker ?? terminateByHandle)(child)
      confirmedStopped = stopped.confirmed
      stopDetail = stopped.detail
    } catch (error) {
      stopDetail = messageOf(error)
    }
    if (confirmedStopped && exited === undefined) await Promise.race([exit, sleep(2_000)])
  }
  // The worker's standard error: whatever is still in the pipe, then the pipe is closed (a process the
  // worker started may hold it open).
  await Promise.race([new Promise<void>((resolve) => { child.stderr?.once('close', () => { resolve() }) }), sleep(1_000)])
  child.stderr?.destroy()
  child.stdout?.destroy()

  const state = readJson(statePath) as WorkerState | undefined
  const fatal = readJson(join(runDir, WORKER_FILES.fatal)) as WorkerFatal | undefined
  const summaryPath = join(runDir, 'summary.json')

  const finish = (): void => {
    signals.off('SIGINT', onInterrupt)
    signals.off('SIGTERM', onTerminate)
  }

  if (ending.kind === 'exit' && interruptedBy === undefined) {
    const verdict = judgeWorkerOutcome({
      runId, workerToken: config.workerToken, pid: child.pid, exitCode: ending.code, signal: ending.signal, state,
      fatal: existsSync(join(runDir, WORKER_FILES.fatal)), summaryText: readText(summaryPath),
    })
    if (verdict.ok) {
      finish()
      return { runId, runDir, exitCode: verdict.exitCode, accepted: true, endNow: false }
    }
    return crash(verdict.problems)
  }
  return crash([])

  async function crash(summaryProblems: readonly string[]): Promise<SupervisedRun> {
    const reason: CrashReason = interruptedBy !== undefined ? 'interrupted'
      : ending.kind === 'deadline' ? 'hard deadline'
        : ending.kind === 'error' ? 'could not start'
          : fatal !== undefined ? 'fatal exception'
            : exited?.signal !== null && exited?.signal !== undefined ? 'killed'
              : 'exited without a summary it can vouch for'
    const detail = {
      'interrupted': `check:all was interrupted (${interruptedBy ?? ''}); the worker ${stoppedBySupervisor ? 'was stopped by the supervisor' : 'had ended'}`,
      'hard deadline': ending.kind === 'deadline' ? `${ending.detail}; the supervisor stopped the worker` : '',
      'could not start': ending.kind === 'error' ? `the worker could not be started: ${ending.error.message}` : '',
      'fatal exception': fatal === undefined ? '' : `${fatal.origin === 'uncaughtException' ? 'an uncaught exception' : `an ${fatal.origin} raised as an uncaught exception`} while ${fatal.phase} ran ended the worker: ${fatal.message}`,
      'killed': `the worker was ended by ${String(exited?.signal)}`,
      'exited without a summary it can vouch for': `the worker exited with code ${String(exited?.code)}: ${summaryProblems.join('; ')}`,
    }[reason] + (confirmedStopped ? '' : `; the worker could not be confirmed stopped (${stopDetail})`)

    // The worker's own summary, if it wrote one, is kept beside the supervisor's.
    const evidence: string[] = []
    let workerSummary: string | undefined
    const workerResult = (readJson(summaryPath) as Partial<CheckAllSummary> | undefined)?.result
    if (existsSync(summaryPath)) {
      workerSummary = join(runDir, 'worker-summary.json')
      try {
        renameSync(summaryPath, workerSummary)
        if (existsSync(join(runDir, 'summary.txt'))) renameSync(join(runDir, 'summary.txt'), join(runDir, 'worker-summary.txt'))
      } catch {
        workerSummary = summaryPath
      }
    }

    const crashRecord = {
      runId, reason, detail, pid: child.pid, exitCode: exited?.code ?? null, signal: exited?.signal ?? null, confirmedStopped, stopDetail,
      lastPhase: state?.phase, fatal, summaryProblems, recordedAt: now().toISOString(),
    }
    try {
      writeFileAtomic(join(runDir, 'worker-crash.json'), `${JSON.stringify(crashRecord, null, 2)}\n`)
    } catch {
      // The summary below carries the same.
    }

    // Clean-up, only once the worker is confirmed gone: step 07's stepStop, unchanged.
    const context = reviewContext({ root: join(runDir, 'review'), ports: config.ports, ...(config.counts === undefined ? {} : { counts: config.counts }), ...(config.protection === undefined ? {} : { protection: config.protection }) })
    const cleanupLog = join(runDir, 'supervisor-cleanup.log')
    const cleanup = { ran: false, finished: false, lines: [] as Line[] }
    let endNow = !confirmedStopped
    if (confirmedStopped) {
      cleanup.ran = true
      const report = new Report((line) => { try { appendFileSync(cleanupLog, `${line}\n`) } catch { /* the lines are kept below */ } })
      const deadlineMs = options.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS
      let timer: NodeJS.Timeout | undefined
      try {
        const outcome = await Promise.race([
          stepStop(context, report, options.stopDependencies ?? {}).then(() => 'finished' as const),
          new Promise<'deadline'>((resolve) => { timer = setTimeout(() => { resolve('deadline') }, deadlineMs) }),
        ])
        cleanup.finished = outcome === 'finished'
        if (!cleanup.finished) {
          endNow = true
          report.fail(`The clean-up did not finish within ${minutes(deadlineMs)}`, 'It is no longer waited for; what is still running is listed below.')
        }
      } catch (error) {
        report.fail(`The clean-up stopped by an unexpected error: ${messageOf(error)}`, stackOf(error))
      } finally {
        clearTimeout(timer)
      }
      cleanup.lines = [...report.lines]
    } else {
      cleanup.lines.push({ status: 'FAIL', name: 'Clean-up not started: the worker could not be confirmed stopped', detail: `${stopDetail}\nNothing was stopped, so that nothing is stopped under a worker that may still be using it.` })
    }

    let applications: string[]
    try {
      applications = ownedStillRunning(context)
    } catch (error) {
      applications = [`Whether this run's applications still run could not be checked: ${messageOf(error)}`]
    }

    // Other processes mentioning this run, and its temporary folders: listed, never stopped or removed.
    const copiesRoots = options.buildCopiesRoots ?? [join(REPOSITORY_ROOT, 'server'), join(REPOSITORY_ROOT, 'client')]
    const copyPrefix = `.test-build-check-${runId.replace(/[^a-zA-Z0-9-]/g, '')}-`
    const temporaryFolders = copiesRoots.flatMap((copiesRoot) => {
      try {
        return readdirSync(copiesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(copyPrefix)).map((entry) => join(copiesRoot, entry.name))
      } catch {
        return []
      }
    })
    const recorded = new Set<number>(context.pairs.flatMap((pair) => {
      try {
        return readState(pair.runDir)?.apps.map((app) => app.pid) ?? []
      } catch {
        return []
      }
    }))
    let processes: MentioningProcess[] | undefined
    try {
      processes = (options.findProcesses ?? processesMentioning)([runDir, ...copiesRoots.map((copiesRoot) => join(copiesRoot, copyPrefix)), 'trade-blotter-perf-ui-'])
        ?.filter((entry) => !recorded.has(entry.pid) && entry.pid !== child.pid)
    } catch {
      processes = undefined
    }

    const instructions: string[] = []
    if (applications.length > 0) instructions.push(...applications.map((line) => `Still running: ${line}`))
    if ((processes ?? []).length > 0) {
      instructions.push('Other processes mention this run (failure detection\'s tests, a browser, a command a step started). check:all only stops the applications it records with a token, '
        + 'so it did not touch these. Check each one\'s command line first; one that belongs to this run can then be ended with taskkill /PID <id> /T on Windows, or kill <id> on Linux and macOS.')
    }
    if (processes === undefined) instructions.push('The running processes could not be listed, so processes this run started outside its applications (failure detection\'s tests, a browser) may still be running; none was stopped.')
    if (temporaryFolders.length > 0) {
      instructions.push(`Kept, because a process of this run may still be using them: ${temporaryFolders.join(', ')}. Once no process listed here uses one, delete it (they are ignored by Git and ESLint, and failure detection only ever replaces folders of its own run).`)
    }
    instructions.push(`A browser profile the benchmarks or UI checks were using may be left in the system's temporary folder as trade-blotter-perf-ui-*; delete it once no browser uses it.`)

    // What finished, what was running, what never ran.
    const completed: CrashSummary['phases']['completed'][number][] = []
    const notRun: string[] = []
    for (const step of state?.steps ?? []) {
      if (step.exitCode === 'not run') notRun.push(`review:${step.id} ${step.title}: ${step.reason ?? 'not run'}`)
      else completed.push({ name: `review:${step.id} ${step.title}`, exitCode: step.exitCode, ...(step.counts === undefined ? {} : { counts: step.counts }), ...(step.log === undefined ? {} : { log: step.log }) })
    }
    for (const section of state?.sections ?? []) {
      if (section.notRun !== undefined) notRun.push(`${section.title}: ${section.notRun}`)
      else completed.push({ name: section.title, exitCode: section.counts.FAIL > 0 ? EXIT.failed : EXIT.passed, counts: section.counts })
    }
    const running = state?.state === 'running' ? state.phase : undefined
    const reported = new Set([...(state?.steps ?? []).map((step) => step.id as string), ...(state?.sections ?? []).map((section) => section.id as string)])
    for (const id of ['01', '05', '02', '03', '04', '06', '07'] as const) {
      if (reported.has(id) || running?.step === id) continue
      notRun.push(`review:${id} ${STEPS[id].title}: not run, the worker had stopped${id === '07' ? ' (the supervisor\'s clean-up above ran step 07\'s stepStop in its place)' : ''}`)
    }
    for (const [id, title] of [['failure-detection', 'Failure detection'], ['documentation', 'Documentation consistency']] as const) {
      if (!reported.has(id) && running?.label !== (id === 'failure-detection' ? 'failure detection' : 'the documentation checks')) notRun.push(`${title}: not run, the worker had stopped`)
    }
    if (workerSummary !== undefined) evidence.push(`${workerSummary} (the worker's own summary, not accepted: ${summaryProblems.join('; ') || reason})`)
    evidence.push(
      join(runDir, 'worker-crash.json'), join(runDir, WORKER_FILES.state), ...(fatal === undefined ? [] : [join(runDir, WORKER_FILES.fatal)]),
      ...(existsSync(stderrLog) ? [stderrLog] : []), ...(existsSync(join(runDir, 'unexpected-errors.log')) ? [join(runDir, 'unexpected-errors.log')] : []),
      join(runDir, 'check-all.log'), join(runDir, 'review', 'logs'), ...(cleanup.ran ? [cleanupLog] : []),
    )

    const crashSummary: CrashSummary = {
      tool: 'check:all', version: 1, runId, mode, startedAt: started.toISOString(), finishedAt: now().toISOString(), runDir, result: 'FAILED', exitCode: 1,
      worker: {
        completed: false, reason, detail, ...(child.pid === undefined ? {} : { pid: child.pid }), exitCode: exited?.code ?? null, signal: exited?.signal ?? null, confirmedStopped,
        ...(fatal === undefined ? {} : { fatalError: { origin: fatal.origin, phase: fatal.phase, message: fatal.message, at: fatal.at } }), summaryProblems,
        ...(workerResult === undefined ? {} : { workerResult }),
      },
      phases: { completed, ...(running === undefined ? {} : { interrupted: { name: running.label, startedAt: running.startedAt, ...(running.detail === undefined ? {} : { detail: running.detail }) } }), notRun },
      unexpectedErrors: state?.unexpectedErrors ?? [],
      cleanup: { ...cleanup, ...(cleanup.ran ? { log: cleanupLog } : {}) },
      remaining: { applications, processes: processes ?? [], processesListed: processes !== undefined, temporaryFolders },
      instructions, evidence,
    }

    const text = formatCrashSummary(crashSummary)
    const write = options.writeFile ?? writeFileAtomic
    try {
      write(join(runDir, 'summary.json'), `${JSON.stringify(crashSummary, null, 2)}\n`)
    } catch (error) {
      print(`check:all: summary.json could not be written (${messageOf(error)}); the summary below is also in summary.txt where possible.`)
    }
    try {
      write(join(runDir, 'summary.txt'), `${text}\n`)
    } catch (error) {
      try {
        write(join(runDir, 'summary.txt'), `RESULT: FAILED: check:all did not complete (${reason}: ${detail}). See ${runDir}. (exit code 1)\n`)
      } catch {
        printError(`check:all: neither summary.json nor summary.txt could be written in ${runDir} (${messageOf(error)}). RESULT: FAILED (exit code 1)\n`)
      }
    }
    print('')
    for (const line of text.split('\n')) print(line)
    finish()
    return { runId, runDir, exitCode: EXIT.failed, accepted: false, crash: crashSummary, endNow }
  }
}

const countsText = (counts: Record<'PASS' | 'FAIL' | 'WARN' | 'SKIPPED', number> | undefined): string =>
  counts === undefined ? '' : `: ${(['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const).map((status) => `${String(counts[status])} ${status}`).join(', ')}`

/** The crash summary as text: what happened, what finished, what did not, the clean-up, what is left, what to do. */
export function formatCrashSummary(summary: CrashSummary): string {
  const lines = [
    `check:all did not complete: run ${summary.runId} (${summary.mode}), ${summary.startedAt} to ${summary.finishedAt}`,
    `The worker that runs the checks stopped (${summary.worker.reason}): ${summary.worker.detail}`,
  ]
  if (summary.worker.fatalError !== undefined) lines.push(`  Its stack is in ${join(summary.runDir, WORKER_FILES.fatal)}, unexpected-errors.log and worker-stderr.log. The worker did not continue after it.`)
  if (summary.worker.workerResult !== undefined) {
    lines.push(`  The worker had already printed its own result (${summary.worker.workerResult}) above; it is not accepted, because ${summary.worker.summaryProblems.join('; ') || summary.worker.reason}. Its summary is kept as worker-summary.json.`)
  }
  lines.push('', 'Finished before it stopped (their own results; nothing here is counted as complete verification):')
  if (summary.phases.completed.length === 0) lines.push('  nothing')
  for (const part of summary.phases.completed) {
    const verdict = part.exitCode === EXIT.passed ? 'PASSED   ' : part.exitCode === EXIT.incomplete ? 'INCOMPLETE' : 'FAILED   '
    lines.push(`  ${verdict} ${part.name}${countsText(part.counts)}`)
  }
  lines.push('', 'Running when it stopped (a FAIL; its partial results are only in its log):',
    summary.phases.interrupted === undefined ? '  nothing (it stopped between parts, or after the last)' : `  FAILED    ${summary.phases.interrupted.name}, since ${summary.phases.interrupted.startedAt}${summary.phases.interrupted.detail === undefined ? '' : ` (${summary.phases.interrupted.detail})`}`)
  if (summary.phases.notRun.length > 0) lines.push('', 'Not run:', ...summary.phases.notRun.map((text) => `  ${text}`))
  if (summary.unexpectedErrors.length > 0) lines.push('', 'Unexpected errors recorded before it stopped (each a failure):', ...summary.unexpectedErrors.map((entry) => `  ${entry.kind} while ${entry.during} ran: ${entry.message}`))
  lines.push('', summary.cleanup.ran ? 'Clean-up by the supervisor (step 07\'s stepStop: each application confirmed by its token, its port and its identity before it is stopped):' : 'Clean-up by the supervisor:')
  for (const line of summary.cleanup.lines) {
    if (line.status === 'INFO') continue
    lines.push(`  ${line.status.padEnd(7)}  ${line.name}`, ...(line.status === 'FAIL' && line.detail !== undefined ? line.detail.split('\n').slice(0, 6).map((text) => `           ${text}`) : []))
  }
  lines.push('', 'Left:')
  lines.push(summary.remaining.applications.length === 0 ? '  none of this run\'s applications is running' : `  ${String(summary.remaining.applications.length)} of this run's applications still running (listed below)`)
  if (!summary.remaining.processesListed) lines.push('  other processes: could not be listed')
  else if (summary.remaining.processes.length === 0) lines.push('  no other process mentions this run')
  for (const entry of summary.remaining.processes) lines.push(`  process ${String(entry.pid)} (${entry.name}), mentions ${entry.mentions}: ${entry.commandLine.slice(0, 300)}`)
  lines.push(summary.remaining.temporaryFolders.length === 0 ? '  no temporary build folder of this run' : `  temporary build folders, kept: ${summary.remaining.temporaryFolders.join(', ')}`)
  lines.push('', 'What to do:', ...summary.instructions.map((text) => `  ${text}`))
  lines.push('', 'Logs and evidence:', `  ${join(summary.runDir, 'summary.txt')} (this summary) and summary.json`, ...summary.evidence.map((path) => `  ${path}`))
  lines.push('', 'RESULT: FAILED: check:all did not complete (exit code 1)')
  return lines.join('\n')
}
