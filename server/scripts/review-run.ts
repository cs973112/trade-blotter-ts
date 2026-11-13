import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isAlive } from './lifecycle.ts'
import { EXIT, type ReviewContext } from './review-context.ts'

/**
 * Which reviewer run a log belongs to. `.run/review/logs/` holds the current run only: its
 * run.json (the run's id, and each step's status, times, process and exit code) and the logs its
 * steps wrote. Step 01 starts a new run: everything already in logs/ (the previous run's run.json
 * and logs, or logs from before runs were recorded) is moved, never deleted, into
 * logs/history/<that run's id>/, with any step still marked running recorded as interrupted.
 * Steps 02 to 07 belong to the current run (one is started when there is none). Nothing here
 * touches a database, a backup or a fingerprint: only files in logs/.
 */

export const STEP_IDS = ['01', '02', '03', '04', '05', '06', '07'] as const
export type StepId = (typeof STEP_IDS)[number]

export type StepStatus = 'PASSED' | 'FAILED' | 'INCOMPLETE' | 'RUNNING' | 'INTERRUPTED' | 'NOT RUN'

export interface StepRecord {
  readonly status: 'running' | 'finished'
  readonly startedAt: string
  readonly pid: number
  readonly finishedAt?: string
  readonly exitCode?: number
  /** The step's log, relative to the run's folder. */
  readonly log: string
}

export interface RunRecord {
  readonly version: 1
  readonly id: string
  readonly startedAt: string
  /** The step that started the run: 01, or another when there was no run yet. */
  readonly startedBy: StepId
  readonly steps: Partial<Record<StepId, StepRecord>>
  /** Steps in the order they started in this run, repeats included. */
  readonly order: readonly StepId[]
  /** Set when the run was moved to the history: steps still running then never finished. */
  readonly archivedAt?: string
}

export const HISTORY = 'history'
const RUN_FILE = 'run.json'

export const runFile = (context: ReviewContext): string => join(context.logsDir, RUN_FILE)
export const historyDir = (context: ReviewContext): string => join(context.logsDir, HISTORY)

/** A run's id, usable as a folder name on Windows and Linux: 20261113T060102.512Z-3f9a1c. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, '')}-${randomBytes(3).toString('hex')}`
}

export function readRun(context: ReviewContext): RunRecord | undefined {
  const path = runFile(context)
  if (!existsSync(path)) return undefined
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunRecord> | null
    return record?.version === 1 && typeof record.id === 'string' && typeof record.steps === 'object' ? record as RunRecord : undefined
  } catch {
    return undefined
  }
}

function writeRun(context: ReviewContext, record: RunRecord): void {
  writeFileSync(runFile(context), `${JSON.stringify(record, null, 2)}\n`)
}

/** What a step of a run is now: a step marked running whose process has gone was interrupted. */
export function stepStatus(record: RunRecord | undefined, id: StepId, alive: (pid: number) => boolean = isAlive): StepStatus {
  const step = record?.steps[id]
  if (step === undefined) return 'NOT RUN'
  if (step.status === 'running') return record?.archivedAt === undefined && alive(step.pid) ? 'RUNNING' : 'INTERRUPTED'
  if (step.exitCode === EXIT.passed) return 'PASSED'
  if (step.exitCode === EXIT.incomplete) return 'INCOMPLETE'
  return 'FAILED'
}

/** One line per step of the run, from its record only: what has not run in it says so. */
export function runSummary(record: RunRecord, alive: (pid: number) => boolean = isAlive): string {
  const steps = STEP_IDS.map((id) => `${id} ${stepStatus(record, id, alive)}`).join(', ')
  return `Run ${record.id} (started ${record.startedAt} by step ${record.startedBy}): ${steps}`
}

/** A folder name in the history not yet taken: the run's id, or for logs from before runs were recorded, their time. */
function historyFolder(context: ReviewContext, name: string): string {
  let folder = join(historyDir(context), name)
  for (let attempt = 2; existsSync(folder); attempt++) folder = join(historyDir(context), `${name}-${String(attempt)}`)
  return folder
}

/**
 * Moves everything in logs/ except the history into the history: the previous run, under its id
 * (any step still marked running recorded as interrupted), or, without a run.json, logs from
 * before runs were recorded, under the time of the newest. Returns the folder, or undefined when
 * logs/ held nothing.
 */
export function archiveLogs(context: ReviewContext, now = new Date()): string | undefined {
  if (!existsSync(context.logsDir)) return undefined
  const entries = readdirSync(context.logsDir).filter((name) => name !== HISTORY)
  if (entries.length === 0) return undefined
  const previous = readRun(context)
  const newest = Math.max(...entries.map((name) => statSync(join(context.logsDir, name)).mtimeMs))
  const folder = historyFolder(context, previous?.id ?? `before-runs-${new Date(newest).toISOString().replace(/[-:]/g, '')}`)
  mkdirSync(folder, { recursive: true })
  if (previous !== undefined) writeRun(context, { ...previous, archivedAt: now.toISOString() })
  for (const name of entries) renameSync(join(context.logsDir, name), join(folder, name))
  return folder
}

/** Step 01: the previous run's logs go to the history, and a new run starts with an empty logs/. */
export function startRun(context: ReviewContext, by: StepId, now = new Date()): { readonly run: RunRecord; readonly archived?: string } {
  mkdirSync(context.logsDir, { recursive: true })
  const archived = archiveLogs(context, now)
  const run: RunRecord = { version: 1, id: newRunId(now), startedAt: now.toISOString(), startedBy: by, steps: {}, order: [] }
  writeRun(context, run)
  return archived === undefined ? { run } : { run, archived }
}

/**
 * A step begins: in a new run for step 01, else in the current run (a new one when there is none
 * yet). A step already run in this run keeps its earlier log as review-0N.attempt-<n>.log.
 * Returns the run and the path of the log this step writes.
 */
export function beginStep(context: ReviewContext, id: StepId, now = new Date()): { readonly run: RunRecord; readonly log: string; readonly archived?: string } {
  let started: { run: RunRecord; archived?: string } | undefined
  if (id === '01' || readRun(context) === undefined) started = startRun(context, id, now)
  const run = started?.run ?? readRun(context)
  if (run === undefined) throw new Error(`The run record ${runFile(context)} could not be written.`)
  const name = `review-${id}.log`
  const path = join(context.logsDir, name)
  if (existsSync(path)) {
    let attempt = 1
    while (existsSync(join(context.logsDir, `review-${id}.attempt-${String(attempt)}.log`))) attempt++
    renameSync(path, join(context.logsDir, `review-${id}.attempt-${String(attempt)}.log`))
  }
  writeFileSync(path, '')
  const record: RunRecord = {
    ...run,
    steps: { ...run.steps, [id]: { status: 'running', startedAt: now.toISOString(), pid: process.pid, log: name } },
    order: [...run.order, id],
  }
  writeRun(context, record)
  return { run: record, log: path, ...(started?.archived === undefined ? {} : { archived: started.archived }) }
}

/** A step ends, with its exit code, in the run it began in. */
export function finishStep(context: ReviewContext, runId: string, id: StepId, exitCode: number, now = new Date()): RunRecord | undefined {
  const run = readRun(context)
  const step = run?.steps[id]
  // Another run started meanwhile (step 01 ran while this step did): this step's record went to the history with its run.
  if (run === undefined || run.id !== runId || step === undefined) return undefined
  const record: RunRecord = { ...run, steps: { ...run.steps, [id]: { ...step, status: 'finished', finishedAt: now.toISOString(), exitCode } } }
  writeRun(context, record)
  return record
}
