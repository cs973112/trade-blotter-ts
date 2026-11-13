import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reviewContext, type Report, type ReviewContext } from '../../scripts/review-context.ts'
import {
  archiveLogs, beginStep, finishStep, historyDir, newRunId, readRun, runFile, runSummary, STEP_IDS, stepStatus, type RunRecord, type StepId,
} from '../../scripts/review-run.ts'
import { runReviewStep } from '../../scripts/review.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Which run a reviewer log belongs to: step 01 starts a run and moves the previous run's logs to
 * the history; every step records itself in the current run; the summary is built from the
 * current run only. Stand-in steps, so no database is seeded and no application is started.
 */

let dir = ''
let context: ReviewContext

beforeEach(() => {
  dir = createTempDir()
  context = reviewContext({
    root: join(dir, 'review'),
    protection: { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'app-run') },
  })
})

afterEach(() => {
  removeTempDir(dir)
})

type Outcome = 'pass' | 'fail' | 'incomplete'

/** Seven stand-in steps: each records that it ran, and passes, fails or is incomplete as asked. */
function standIns(outcomes: Partial<Record<StepId, Outcome>> = {}, ran: StepId[] = []) {
  const step = (id: StepId) => ({
    title: `Stand-in ${id}`,
    run: (_context: ReviewContext, report: Report): Promise<void> => {
      ran.push(id)
      const outcome = outcomes[id] ?? 'pass'
      if (outcome === 'fail') report.fail(`Stand-in ${id} failed`, 'on purpose')
      else if (outcome === 'incomplete') report.incomplete('no browser')
      else report.pass(`Stand-in ${id} passed`)
      return Promise.resolve()
    },
  })
  return Object.fromEntries(STEP_IDS.map((id) => [id, step(id)])) as Record<StepId, ReturnType<typeof step>>
}

async function step(id: StepId, outcomes: Partial<Record<StepId, Outcome>> = {}, ran: StepId[] = []): Promise<{ code: number; printed: string[] }> {
  const printed: string[] = []
  const code = await runReviewStep(id, context, { steps: standIns(outcomes, ran), print: (line) => { printed.push(line) } })
  return { code, printed }
}

const summaryOf = (printed: readonly string[]): string => printed.find((line) => line.startsWith('Run ') && line.includes(' (started ')) ?? ''
const logs = (): string[] => readdirSync(context.logsDir).sort()
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('reviewer runs: the current run\'s results only', () => {
  it('never shows a previous run\'s FAIL in a new run: its log goes to the history and the step is NOT RUN', async () => {
    for (const id of STEP_IDS) await step(id, { '06': 'fail' })
    const previous = readRun(context)
    expect(previous && runSummary(previous)).toContain('06 FAILED')

    const { printed } = await step('01')

    const summary = summaryOf(printed)
    expect(summary).toMatch(/^Run \S+ \(started \S+ by step 01\): 01 PASSED, 02 NOT RUN, 03 NOT RUN, 04 NOT RUN, 05 NOT RUN, 06 NOT RUN, 07 NOT RUN$/)
    expect(summary).not.toContain('FAILED')
    expect(logs()).toEqual(['history', 'review-01.log', 'run.json'])
    expect(readFileSync(join(context.logsDir, 'review-01.log'), 'utf8')).not.toContain('Stand-in 06 failed')
    expect(readRun(context)?.id).not.toBe(previous?.id)
  })

  it('shows every step not yet run in the current run as NOT RUN, and the steps run so far with their results', async () => {
    await step('01')
    await step('02')
    const { printed } = await step('03', { '03': 'fail' })

    expect(summaryOf(printed)).toMatch(/: 01 PASSED, 02 PASSED, 03 FAILED, 04 NOT RUN, 05 NOT RUN, 06 NOT RUN, 07 NOT RUN$/)
    const record = readRun(context)
    expect(record && stepStatus(record, '04')).toBe('NOT RUN')
    expect(record && stepStatus(record, '03')).toBe('FAILED')
  })

  it('runs the seven steps in order in one run, each recorded in it with its own log and exit code', async () => {
    const ran: StepId[] = []
    const codes: number[] = []
    for (const id of STEP_IDS) codes.push((await step(id, { '06': 'incomplete' }, ran)).code)

    expect(ran).toEqual([...STEP_IDS])
    expect(codes).toEqual([0, 0, 0, 0, 0, 3, 0])
    const record = readRun(context)
    expect(record?.order).toEqual([...STEP_IDS])
    expect(record?.startedBy).toBe('01')
    expect(STEP_IDS.map((id) => record?.steps[id]?.exitCode)).toEqual(codes)
    expect(record && runSummary(record)).toMatch(/: 01 PASSED, 02 PASSED, 03 PASSED, 04 PASSED, 05 PASSED, 06 INCOMPLETE, 07 PASSED$/)
    // Each step's log names the same run.
    for (const id of STEP_IDS) expect(readFileSync(join(context.logsDir, `review-${id}.log`), 'utf8')).toContain(`Run ${record?.id ?? ''}`)
    expect(logs()).toEqual(['review-01.log', 'review-02.log', 'review-03.log', 'review-04.log', 'review-05.log', 'review-06.log', 'review-07.log', 'run.json'])
  })

  it('starts a new run after a successful one, keeping the old run whole in the history', async () => {
    for (const id of STEP_IDS) await step(id)
    const first = readRun(context)

    const { printed } = await step('01')

    const folder = join(historyDir(context), first?.id ?? '')
    expect(printed[1]).toBe(`Run ${readRun(context)?.id ?? ''} starts here. The previous run's logs are kept in ${folder}.`)
    expect(readdirSync(folder).sort()).toEqual(['review-01.log', 'review-02.log', 'review-03.log', 'review-04.log', 'review-05.log', 'review-06.log', 'review-07.log', 'run.json'])
    const archived = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8')) as RunRecord
    expect(archived.id).toBe(first?.id)
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect(runSummary(archived)).toMatch(/: 01 PASSED, 02 PASSED, 03 PASSED, 04 PASSED, 05 PASSED, 06 PASSED, 07 PASSED$/)
    expect(readFileSync(join(folder, 'review-07.log'), 'utf8')).toContain('Stand-in 07 passed')
  })

  it('records an interrupted run as such in the history, and never reuses its results', async () => {
    await step('01')
    await step('02')
    // Step 03 began and its process ended before it finished: the record says running.
    const interrupted = beginStep(context, '03')
    expect(stepStatus(readRun(context), '03', () => false)).toBe('INTERRUPTED')
    expect(stepStatus(readRun(context), '03', () => true)).toBe('RUNNING')

    const { printed } = await step('01')

    expect(summaryOf(printed)).toMatch(/: 01 PASSED, 02 NOT RUN, 03 NOT RUN, 04 NOT RUN, 05 NOT RUN, 06 NOT RUN, 07 NOT RUN$/)
    const archived = JSON.parse(readFileSync(join(historyDir(context), interrupted.run.id, 'run.json'), 'utf8')) as RunRecord
    // Archived, a step still marked running is interrupted, whatever process now has its id.
    expect(runSummary(archived, () => true)).toMatch(/: 01 PASSED, 02 PASSED, 03 INTERRUPTED, 04 NOT RUN/)
    // A step that finishes after a newer run began does not write into the newer run.
    expect(finishStep(context, interrupted.run.id, '03', 0)).toBeUndefined()
    expect(stepStatus(readRun(context), '03')).toBe('NOT RUN')
  })

  it('keeps an earlier attempt\'s log when a step runs again in the same run', async () => {
    await step('01')
    await step('05', { '05': 'fail' })
    const { printed } = await step('05')

    expect(summaryOf(printed)).toMatch(/: 01 PASSED, 02 NOT RUN, 03 NOT RUN, 04 NOT RUN, 05 PASSED,/)
    expect(logs()).toEqual(['review-01.log', 'review-05.attempt-1.log', 'review-05.log', 'run.json'])
    expect(readFileSync(join(context.logsDir, 'review-05.attempt-1.log'), 'utf8')).toContain('Stand-in 05 failed')
    expect(readRun(context)?.order).toEqual(['01', '05', '05'])
  })

  it('starts a run at another step when there is none, and moves logs from before runs were recorded to the history', async () => {
    mkdirSync(context.logsDir, { recursive: true })
    writeFileSync(join(context.logsDir, 'review-06.log'), 'FAIL     Benchmark applications are not running as the reviewer\'s\n')
    writeFileSync(join(context.logsDir, '05-1-lint.log'), 'old lint output\n')

    const { printed } = await step('04')

    expect(summaryOf(printed)).toMatch(/by step 04\): 01 NOT RUN, 02 NOT RUN, 03 NOT RUN, 04 PASSED, 05 NOT RUN, 06 NOT RUN, 07 NOT RUN$/)
    expect(logs()).toEqual(['history', 'review-04.log', 'run.json'])
    const [legacy] = readdirSync(historyDir(context))
    expect(legacy).toMatch(/^before-runs-\d{8}T\d{6}\.\d{3}Z$/)
    expect(readFileSync(join(historyDir(context), legacy ?? '', 'review-06.log'), 'utf8')).toContain('FAIL')
  })

  it('moves only logs: databases, their -wal and -shm, backups and fingerprints stay exactly as they were', async () => {
    mkdirSync(join(context.backupsDir, 'benchmark-20261113T052029.585Z'), { recursive: true })
    const kept = [
      join(context.root, 'benchmark.db'), join(context.root, 'benchmark.db-wal'), join(context.root, 'benchmark.db-shm'), join(context.root, 'scratch.db'),
      join(context.backupsDir, 'benchmark-20261113T052029.585Z', 'benchmark.db'), join(context.backupsDir, 'benchmark-20261113T052029.585Z', 'backup.json'),
      context.baselineFile,
    ]
    for (const [index, path] of kept.entries()) writeFileSync(path, `bytes of file ${String(index)}`)
    const before = kept.map(sha)
    for (const id of STEP_IDS) await step(id)

    await step('01')
    await step('01')

    expect(kept.map(sha)).toEqual(before)
    expect(readdirSync(context.root).sort()).toEqual(['backups', 'benchmark.db', 'benchmark.db-shm', 'benchmark.db-wal', 'development-database.json', 'logs', 'scratch.db'])
    expect(readdirSync(historyDir(context))).toHaveLength(2)
  })

  it('names runs and history folders with characters valid on Windows and Linux, and builds every path with the platform\'s separator', async () => {
    const id = newRunId(new Date('2026-11-13T06:01:02.512Z'))
    expect(id).toMatch(/^20261113T060102\.512Z-[0-9a-f]{6}$/)
    expect(id).not.toMatch(/[<>:"/\\|?*]/)
    expect(newRunId()).not.toBe(newRunId())

    await step('01')
    await step('01')
    const [folder] = readdirSync(historyDir(context))
    expect(folder).not.toMatch(/[<>:"/\\|?*]/)
    expect(runFile(context)).toBe(join(context.root, 'logs', 'run.json'))
    expect(existsSync(join(historyDir(context), folder ?? '', 'run.json'))).toBe(true)
  })

  it('does nothing when there is nothing to move, and creates nothing for a reviewer folder beside the development database', async () => {
    expect(archiveLogs(context)).toBeUndefined()
    const inside = reviewContext({ root: join(dir, 'data'), protection: context.protection })
    mkdirSync(join(dir, 'data'))
    writeFileSync(context.protection.developmentDatabase, 'development database bytes')
    const printed: string[] = []

    const code = await runReviewStep('01', inside, { steps: standIns(), print: (line) => { printed.push(line) } })

    expect(code).toBe(1)
    expect(printed[0]).toMatch(/^FAIL {5}Reviewer folder /)
    expect(readdirSync(join(dir, 'data'))).toEqual(['trade-blotter.db'])
  })
})
