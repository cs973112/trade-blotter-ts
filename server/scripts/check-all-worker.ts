import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { checkAll, messageOf, PHASE_LIMITS_MS, stackOf, writeFileAtomic, type CheckAllOptions, type Mode, type ProgressEvent, type UnexpectedError } from './check-all.ts'
import { EXIT } from './review-context.ts'
import type { StepId } from './review-run.ts'
import type { Protection } from './trade-data.ts'

/**
 * The check:all worker: node check-all-worker.ts --config <run folder>/worker-config.json. Started
 * by the supervisor (check-all-supervisor.ts), never by hand. It runs checkAll in the run folder the
 * supervisor made, and keeps worker-state.json there: the phase running, with how long it may take,
 * and each finished part's outcome; at the end, the exit code and the summary's SHA-256, which is how
 * the supervisor knows the summary is this worker's and complete.
 *
 * An uncaught exception is not handled here: Node.js ends the process, as it always does. Before it
 * does, uncaughtExceptionMonitor (which observes without preventing the exit, and starts nothing)
 * writes what is known synchronously: worker-fatal.json, a file of its own written whole or not at
 * all, so it can never damage worker-state.json; and the stack in unexpected-errors.log. The
 * supervisor then stops this run's applications and reports the run as FAILED.
 */

export const WORKER_FILES = {
  config: 'worker-config.json',
  state: 'worker-state.json',
  fatal: 'worker-fatal.json',
  stderr: 'worker-stderr.log',
  progressErrors: 'worker-progress-errors.log',
} as const

/** What the supervisor tells the worker: written by the supervisor before the worker starts. */
export interface WorkerConfig {
  readonly runId: string
  /** Names this worker; the worker's state must carry it for its summary to be accepted. */
  readonly workerToken: string
  /** The folder holding every run's folder; the run's own is <baseDir>/<runId>. */
  readonly baseDir: string
  readonly mode: Mode
  readonly verbose: boolean
  readonly ports: { readonly benchmark: readonly [number, number]; readonly scratch: readonly [number, number] }
  readonly counts?: { readonly benchmark: number; readonly scratch: number }
  readonly protection?: Protection
  readonly stepDeadlinesMs?: Partial<Record<StepId, number>>
}

export interface WorkerPhase {
  readonly label: string
  readonly step?: StepId
  readonly limitMs: number
  readonly detail?: string
  readonly startedAt: string
}

export interface WorkerState {
  readonly tool: 'check:all worker'
  readonly version: 1
  readonly runId: string
  readonly workerToken: string
  readonly pid: number
  readonly startedAt: string
  state: 'running' | 'finished'
  phase: WorkerPhase
  readonly steps: Extract<ProgressEvent, { kind: 'step' }>[]
  readonly sections: Extract<ProgressEvent, { kind: 'section' }>[]
  readonly unexpectedErrors: UnexpectedError[]
  exitCode?: number
  summarySha256?: string
  finishedAt?: string
}

/** What uncaughtExceptionMonitor records just before the worker ends. */
export interface WorkerFatal {
  readonly runId: string
  readonly workerToken: string
  readonly pid: number
  readonly at: string
  /** 'uncaughtException', or 'unhandledRejection' for a rejection Node.js raised as an exception. */
  readonly origin: string
  /** The phase running then. */
  readonly phase: string
  readonly message: string
  readonly stack: string
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface WorkerOutcome {
  readonly exitCode: number
  /** A step was left running at its deadline: the process must end now that the summary is written. */
  readonly abandoned: boolean
}

/** Runs check:all as the supervisor configured it. Stand-ins for tests replace parts of checkAll's options. */
export async function runWorker(configPath: string, overrides: Partial<CheckAllOptions> = {}): Promise<WorkerOutcome> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig
  const runDir = join(config.baseDir, config.runId)
  const statePath = join(runDir, WORKER_FILES.state)
  const now = (): string => new Date().toISOString()
  const state: WorkerState = {
    tool: 'check:all worker', version: 1, runId: config.runId, workerToken: config.workerToken, pid: process.pid, startedAt: now(),
    state: 'running', phase: { label: 'check:all', limitMs: PHASE_LIMITS_MS.startup, startedAt: now() }, steps: [], sections: [], unexpectedErrors: [],
  }
  const save = (): void => {
    try {
      writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      // The supervisor then knows less about the run, never more: a run without its finished state is FAILED.
      try {
        appendFileSync(join(runDir, WORKER_FILES.progressErrors), `${now()} ${messageOf(error)}\n`)
      } catch {
        // Nothing more can be recorded.
      }
    }
  }

  process.on('uncaughtExceptionMonitor', (error: unknown, origin: string) => {
    // Synchronous, and nothing is started: Node.js ends the process when this returns.
    const at = now()
    const fatal: WorkerFatal = {
      runId: config.runId, workerToken: config.workerToken, pid: process.pid, at, origin, phase: state.phase.label, message: messageOf(error), stack: stackOf(error),
    }
    try {
      writeFileAtomic(join(runDir, WORKER_FILES.fatal), `${JSON.stringify(fatal, null, 2)}\n`)
    } catch {
      // Node.js still prints the stack to stderr, which the supervisor keeps in worker-stderr.log.
    }
    try {
      appendFileSync(join(runDir, 'unexpected-errors.log'), `${at} ${origin === 'uncaughtException' ? 'uncaught exception' : origin} while ${state.phase.label} ran; it ends the worker (the supervisor takes over)\n${fatal.stack}\n\n`)
    } catch {
      // As above.
    }
  })

  save()
  const summary = await checkAll({
    runId: config.runId, baseDir: config.baseDir, existingRunDir: true, mode: config.mode, verbose: config.verbose, ports: config.ports,
    ...(config.counts === undefined ? {} : { counts: config.counts }),
    ...(config.protection === undefined ? {} : { protection: config.protection }),
    ...(config.stepDeadlinesMs === undefined ? {} : { stepDeadlinesMs: config.stepDeadlinesMs }),
    onProgress: (event) => {
      if (event.kind === 'phase') state.phase = { ...event, startedAt: now() }
      else if (event.kind === 'step') state.steps.push(event)
      else if (event.kind === 'section') state.sections.push(event)
      else state.unexpectedErrors.push(event.error)
      save()
    },
    ...overrides,
  })
  // Last: the summary is written; its hash, with this worker's token and id, marks it as this worker's and whole.
  state.state = 'finished'
  state.exitCode = summary.exitCode
  state.summarySha256 = sha256(readFileSync(join(runDir, 'summary.json'), 'utf8'))
  state.finishedAt = now()
  state.phase = { label: 'finished', limitMs: PHASE_LIMITS_MS.summary, startedAt: state.finishedAt }
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
  return { exitCode: summary.exitCode, abandoned: summary.abandoned.length > 0 }
}

/** The value after --config. */
export function configArgument(args: readonly string[]): string | undefined {
  const index = args.indexOf('--config')
  return index === -1 ? undefined : args[index + 1]
}

async function main(): Promise<void> {
  const configPath = configArgument(process.argv.slice(2))
  if (configPath === undefined) {
    console.error('The check:all worker is started by npm run check:all (node check-all-worker.ts --config <file>).')
    process.exitCode = 2
    return
  }
  const outcome = await runWorker(configPath)
  // A step left at its deadline may still be running in this process: with the summary written, it
  // must neither keep the process alive nor end it later, so the process ends now.
  if (outcome.abandoned) process.exit(outcome.exitCode)
  process.exitCode = outcome.exitCode
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main()
  } catch (error) {
    // Caught where it was thrown (checkAll could not start, or the finished state could not be
    // written): no summary is accepted from this worker, and the supervisor reports the run FAILED.
    console.error(error)
    process.exitCode = EXIT.failed
  }
}
