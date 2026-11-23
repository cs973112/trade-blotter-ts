import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkAll, parseArguments, type CheckAllOptions, type CheckAllSummary } from '../../scripts/check-all.ts'
import type { DocCheck } from '../../scripts/docs-check.ts'
import type { CheckResult } from '../../scripts/failure-detection.ts'
import type { Report, ReviewContext } from '../../scripts/review-context.ts'
import type { StepId } from '../../scripts/review-run.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * npm run check:all (server/scripts/check-all.ts) with stand-ins for the seven reviewer steps, the
 * failure-detection checks and the documentation checks, in a temporary folder: the order, the
 * categories and their counts, quick and verbose output, what is left out after a failure, the exit
 * codes, and one folder per run. Each stand-in step reports as the real one would; the real steps
 * are tested in review.test.ts, and check:all itself is run in full by hand (see README.md).
 */

let dir = ''
let ran: StepId[] = []

beforeEach(() => {
  dir = createTempDir()
  ran = []
})

afterEach(() => {
  removeTempDir(dir)
})

type StepFunction = (context: ReviewContext, report: Report) => Promise<void>

const step = (id: StepId, body: (report: Report, context: ReviewContext) => void = (report) => { report.pass(`step ${id} check`) }): StepFunction =>
  (context, report) => {
    ran.push(id)
    body(report, context)
    return Promise.resolve()
  }

/** vitest's JSON results, as step 05 asks vitest to write them in check:all. */
function writeTests(context: ReviewContext, workspace: 'server' | 'client', passed: number, skipped = 0): void {
  const folder = join(context.root, '..', 'tests')
  mkdirSync(folder, { recursive: true })
  const tests = [...Array<string>(passed).fill('passed'), ...Array<string>(skipped).fill('skipped')].map((status, index) => ({ fullName: `${workspace} test ${String(index)}`, status, failureMessages: [] }))
  writeFileSync(join(folder, `${workspace}-tests.json`), JSON.stringify({
    numTotalTests: tests.length, numPassedTests: passed, numFailedTests: 0, numPendingTests: skipped,
    testResults: [{ name: join(dir, `${workspace}.test.ts`), status: 'passed', message: '', assertionResults: tests }],
  }))
}

const steps = (overrides: Partial<Record<StepId, StepFunction>> = {}): Partial<Record<StepId, StepFunction>> => ({
  '01': step('01', (report) => { report.pass('Node.js v22.21.0 (verified)'); report.pass('npm 10.9.4') }),
  '02': step('02'),
  '03': step('03'),
  '04': step('04', (report) => { report.pass('Benchmark API answers'); report.pass('Booking checks') }),
  '05': step('05', (report, context) => {
    for (const name of ['Lint (ESLint)', 'Typecheck (tsc and vue-tsc)', 'Build (API and frontend)']) report.pass(name)
    writeTests(context, 'server', 12, 1)
    writeTests(context, 'client', 5)
    report.pass('Server tests (vitest)')
    report.warn('Server tests (vitest): some tests were skipped, not run', 'Tests 12 passed | 1 skipped (13)')
    report.pass('Client tests (vitest)')
    report.pass('Schema check (migrations match the schema)')
    report.pass('UI: the page loads')
    report.pass('UI: no console errors')
  }),
  '06': step('06', (report) => { report.pass('API benchmark: 57 scenarios'); report.pass('UI benchmark: 12 scenarios') }),
  '07': step('07', (report) => { report.pass('Benchmark applications stopped'); report.pass('Development database unchanged') }),
  ...overrides,
})

const detection = (status: 'PASS' | 'FAIL' = 'PASS') => (): Promise<CheckResult[]> => Promise.resolve([{
  check: { id: 'average-cost-on-reduce', rule: 'Reducing keeps the average cost', file: 'src/domain/position.ts', find: 'a', replace: 'b', tests: [], expectFailing: /x/ },
  status, detail: status === 'PASS' ? 'detected' : 'Not detected: every test passed (3)', evidence: join(dir, 'evidence'), milliseconds: 5,
}])
const documentation = (checks: DocCheck[] = [{ status: 'PASS', name: 'API endpoints match' }]) => (options: { testTotals?: { server?: number; client?: number } }): Promise<DocCheck[]> =>
  Promise.resolve([...checks, { status: 'PASS', name: `totals ${String(options.testTotals?.server)}/${String(options.testTotals?.client)}` }])

async function run(overrides: Partial<CheckAllOptions> = {}): Promise<{ summary: CheckAllSummary; printed: string[] }> {
  const printed: string[] = []
  const summary = await checkAll({
    baseDir: join(dir, 'check-all'),
    ports: { benchmark: [1, 2], scratch: [3, 4] },
    protection: { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'app-run') },
    print: (line) => { printed.push(line) },
    steps: steps(),
    failureDetection: detection(),
    documentation: documentation(),
    environment: () => ({ node: 'v22.21.0', npm: '10.9.4', sqlite: '3.50.4', platform: 'win32', arch: 'x64' }),
    ...overrides,
  })
  return { summary, printed }
}

const row = (summary: CheckAllSummary, id: string) => summary.categories.find((category) => category.id === id)

describe('check:all: arguments', () => {
  it('accepts --quick and --verbose, in any order, and nothing else', () => {
    expect(parseArguments([])).toEqual({ mode: 'full', verbose: false })
    expect(parseArguments(['--verbose', '--quick'])).toEqual({ mode: 'quick', verbose: true })
    expect(parseArguments(['--fast'])).toEqual({ error: 'Unknown argument --fast. Usage: npm run check:all [-- --quick] [-- --verbose]' })
  })
})

describe('check:all: a full run', () => {
  it('runs the steps once each, tests and build before the applications start, then failure detection and the documentation', async () => {
    const { summary } = await run()

    expect(ran).toEqual(['01', '05', '02', '03', '04', '06', '07'])
    expect(summary).toMatchObject({ mode: 'full', result: 'PASSED', exitCode: 0, skipped: [] })
  })

  it('counts each category; the tests one by one, from vitest\'s results', async () => {
    const { summary } = await run()

    expect(row(summary, 'environment')?.counts).toEqual({ PASS: 2, FAIL: 0, WARN: 0, SKIPPED: 0 })
    expect(row(summary, 'static')?.counts).toEqual({ PASS: 3, FAIL: 0, WARN: 0, SKIPPED: 0 })
    expect(row(summary, 'server-tests')).toMatchObject({ unit: 'tests', counts: { PASS: 12, FAIL: 0, WARN: 1, SKIPPED: 1 } })
    expect(row(summary, 'client-tests')?.counts).toEqual({ PASS: 5, FAIL: 0, WARN: 0, SKIPPED: 0 })
    expect(row(summary, 'ui')?.counts.PASS).toBe(2)
    expect(row(summary, 'performance')?.counts.PASS).toBe(2)
    expect(row(summary, 'failure-detection')?.counts.PASS).toBe(1)
    // The documentation is compared with this run's totals.
    expect(row(summary, 'documentation')?.lines.map((line) => line.name)).toContain('totals 13/5')
    expect(summary.totals).toEqual({ PASS: 36, FAIL: 0, WARN: 1, SKIPPED: 1 })
  })

  it('prints a concise summary: each category, the duration, warnings, where the logs are, and the result', async () => {
    const { printed, summary } = await run()
    const text = printed.join('\n')

    expect(text).toMatch(/^check:all \(complete verification\)\nRun \S+, started /)
    expect(text).toMatch(/Environment \(review:01\) +2 +0 +0 +0 {2}checks/)
    expect(text).toMatch(/Server tests \(review:05\) +12 +0 +1 +1 {2}tests/)
    expect(text).toMatch(/Total +36 +0 +1 +1 {2}in \d/)
    expect(text).toContain('Warnings:\n  Server tests (review:05): Server tests (vitest): some tests were skipped, not run')
    expect(text).toContain(join(summary.runDir, 'check-all.log'))
    expect(text).toMatch(/RESULT: PASSED: complete verification passed \(exit code 0\)$/)
    // Concise: no check's detail, and no commands.
    expect(text).not.toContain('Tests 12 passed | 1 skipped (13)')
  })

  it('verbose prints every check with its detail, and every test', async () => {
    const { printed } = await run({ verbose: true })
    const text = printed.join('\n')

    expect(text).toContain('Tests 12 passed | 1 skipped (13)')
    expect(text).toContain('--- review:05 Automated tests')
    expect(text).toMatch(/PASS {5}average-cost-on-reduce: Reducing keeps the average cost/)
  })

  it('keeps each run in its own folder, with its summary, log, environment and results', async () => {
    const first = (await run()).summary
    const second = (await run()).summary

    expect(first.runDir).not.toBe(second.runDir)
    expect(readdirSync(join(dir, 'check-all')).sort()).toEqual([first.runId, second.runId].sort())
    for (const file of ['summary.json', 'summary.txt', 'check-all.log', 'environment.json', 'documentation.json', 'tests/server-tests.json', 'review/logs/review-05.log']) {
      expect(existsSync(join(second.runDir, file)), file).toBe(true)
    }
    const saved = JSON.parse(readFileSync(join(second.runDir, 'summary.json'), 'utf8')) as CheckAllSummary
    expect(saved.steps.map((entry) => [entry.id, entry.exitCode])).toEqual([['01', 0], ['05', 0], ['02', 0], ['03', 0], ['04', 0], ['06', 0], ['07', 0]])
    expect(saved.startedAt <= saved.finishedAt).toBe(true)
    await expect(run({ runId: first.runId })).rejects.toThrow(/already exists; every run needs a new one/)
  })
})

describe('check:all: --quick', () => {
  it('leaves out the benchmarks, says so, and never reports complete verification', async () => {
    const { summary, printed } = await run({ mode: 'quick' })
    const text = printed.join('\n')

    expect(ran).toEqual(['01', '05', '02', '03', '04', '07'])
    expect(summary).toMatchObject({ result: 'QUICK PASSED', exitCode: 0, skipped: ['review:06 Performance: left out by --quick'] })
    expect(row(summary, 'performance')).toMatchObject({ notRun: 'left out by --quick', counts: { PASS: 0, FAIL: 0, WARN: 0, SKIPPED: 1 } })
    expect(text).toMatch(/^check:all --quick \(the benchmarks are left out: NOT complete verification\)/)
    expect(text).toMatch(/Performance benchmarks \(review:06\) +0 +0 +0 +1 {2}checks {2}left out by --quick/)
    expect(text).toMatch(/RESULT: QUICK PASSED: every check run passed, but the benchmarks were left out; this is not complete verification/)
    expect(text).not.toContain('complete verification passed')
  })
})

describe('check:all: failures', () => {
  it('fails, with the message and the log, leaves out what depends on the failed step, and still stops the applications', async () => {
    const { summary, printed } = await run({ steps: steps({ '03': step('03', (report) => { report.fail('Benchmark applications not started', 'Port 5491 is already in use by another process.') }) }) })
    const text = printed.join('\n')

    expect(ran).toEqual(['01', '05', '02', '03', '07'])
    expect(summary).toMatchObject({ result: 'FAILED', exitCode: 1 })
    expect(summary.skipped).toEqual(['review:04 Functional checks: not run: review:03 failed or did not run', 'review:06 Performance: not run: review:03 failed or did not run'])
    expect(text).toMatch(/Failures:\n {2}Seed and start \(review:02, 03\): Benchmark applications not started\n {6}Port 5491 is already in use by another process\.\n {6}Log: \S+review-02\.log/)
    expect(text).toMatch(/RESULT: FAILED \(exit code 1\)$/)
  })

  it('fails when a change was not detected, or the documentation is out of date', async () => {
    expect((await run({ failureDetection: detection('FAIL') })).summary).toMatchObject({ result: 'FAILED', exitCode: 1 })
    const { summary, printed } = await run({ documentation: documentation([{ status: 'FAIL', name: 'Commands documented but not defined in package.json', detail: 'npm run review:99 (README.md)' }]) })

    expect(summary.exitCode).toBe(1)
    expect(printed.join('\n')).toMatch(/Documentation consistency: Commands documented but not defined in package\.json\n {6}npm run review:99 \(README\.md\)/)
  })

  it('names what review:05 did not reach after its first failure, instead of counting it as nothing', async () => {
    const { summary } = await run({ steps: steps({ '05': step('05', (report) => {
      report.pass('Lint (ESLint)')
      report.fail('Typecheck (tsc and vue-tsc): exit code 2', 'error TS2322')
      report.info('Stopped at the first failure; the commands after it were not run.')
    }) }) })

    expect(summary.exitCode).toBe(1)
    for (const id of ['server-tests', 'client-tests', 'schema', 'ui']) {
      expect(row(summary, id), id).toMatchObject({ notRun: 'not run: review:05 stopped at an earlier failure', counts: { PASS: 0, FAIL: 0, WARN: 0, SKIPPED: 1 } })
    }
    expect(row(summary, 'static')?.counts).toEqual({ PASS: 1, FAIL: 1, WARN: 0, SKIPPED: 0 })
    // The steps that do not depend on review:05 still ran.
    expect(ran).toEqual(['01', '05', '02', '03', '04', '06', '07'])
  })

  it('is incomplete, exit code 3, when a required part could not run', async () => {
    const { summary } = await run({ steps: steps({ '05': step('05', (report) => { report.pass('Lint (ESLint)'); report.skip('UI checks in a real browser', 'No browser'); report.incomplete('no browser') }) }) })

    expect(summary).toMatchObject({ result: 'INCOMPLETE', exitCode: 3 })
    expect(row(summary, 'ui')?.counts.SKIPPED).toBe(1)
  })

  it('stops after a failed step 01, except for stopping and the documentation', async () => {
    const { summary } = await run({ steps: steps({ '01': step('01', (report) => { report.fail('Node.js v20.19.0', 'Only Node.js 22 is supported.') }) }) })

    expect(ran).toEqual(['01', '07'])
    expect(summary.exitCode).toBe(1)
    expect(row(summary, 'failure-detection')?.notRun).toBe('not run: step 01 failed')
    expect(row(summary, 'documentation')?.counts.PASS).toBe(2)
  })
})
