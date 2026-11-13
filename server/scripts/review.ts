import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { EXIT, Report, reviewContext, type ReviewContext } from './review-context.ts'
import { beginStep, finishStep, runSummary, STEP_IDS, type StepId } from './review-run.ts'
import { stepCheck, stepPerformance, stepSeed, stepSetup, stepStart, stepStop, stepTests } from './review-steps.ts'
import { refuseProtectedDatabase } from './trade-data.ts'

/**
 * npm run review:01 ... review:07 — the reviewer workflow, one step per command:
 *
 *   01 Setup        Node.js, npm, dependencies, SQLite, the browser and ports; the reviewer folder and
 *                   databases; the development database's fingerprint
 *   02 Seed         25,000 benchmark trades and 120 scratch trades, or recognise them already there
 *   03 Start        build if needed; start the benchmark and scratch applications
 *   04 Check        functional checks against the running applications
 *   05 Tests        lint, typecheck, build, every test, the schema check
 *   06 Performance  the API and UI benchmarks
 *   07 Stop         stop the reviewer's applications, and only them
 *
 * Everything stays in .run/review/ (ignored by Git). Each step prints PASS, FAIL, WARN or SKIPPED
 * for every check, a summary, and exits 0 when it passed, 1 when something failed and 3 when it
 * could not do all it should (performance without a browser).
 *
 * The steps belong to a run (review-run.ts). Step 01 starts one, moving the previous run's logs to
 * .run/review/logs/history/<its id>/; .run/review/logs/ then holds the current run's logs only, and
 * its run.json. Each step ends with the run's summary, built from that record alone, so a step not
 * yet run in this run shows NOT RUN, never an earlier run's result.
 */

type StepFunction = (context: ReviewContext, report: Report) => Promise<void>

export const STEPS: Readonly<Record<StepId, { readonly title: string; readonly run: StepFunction }>> = {
  '01': { title: 'Setup', run: stepSetup },
  '02': { title: 'Seed', run: stepSeed },
  '03': { title: 'Start', run: stepStart },
  '04': { title: 'Functional checks', run: stepCheck },
  '05': { title: 'Automated tests', run: stepTests },
  '06': { title: 'Performance', run: stepPerformance },
  '07': { title: 'Stop', run: stepStop },
}

const isStepId = (id: string): id is StepId => (STEP_IDS as readonly string[]).includes(id)

/** Runs one step in the current run (a new one for step 01): its log, its result, the run's summary. Returns the exit code. */
export async function runReviewStep(
  id: StepId,
  context: ReviewContext,
  options: { readonly steps?: Readonly<Record<StepId, { readonly title: string; readonly run: StepFunction }>>; readonly print?: (line: string) => void } = {},
): Promise<number> {
  const step = (options.steps ?? STEPS)[id]
  try {
    // Before logs/ is made: the reviewer folder must not be the development database's (step 01 checks it too).
    refuseProtectedDatabase(join(context.root, 'reviewer.db'), context.protection)
  } catch (error) {
    const report = new Report(options.print ?? console.log)
    report.fail(`Reviewer folder ${context.root}`, `${error instanceof Error ? error.message : String(error)}\nNothing was created there.`)
    ;(options.print ?? console.log)(report.summary())
    return report.exitCode
  }
  const { run, log, archived } = beginStep(context, id)
  const print = (line: string): void => {
    (options.print ?? console.log)(line)
    appendFileSync(log, `${line}\n`)
  }
  print(`Review step ${id}: ${step.title}  (${new Date().toISOString()})`)
  print(id === run.startedBy && run.order.length === 1
    ? `Run ${run.id} starts here.${archived === undefined ? '' : ` The previous run's logs are kept in ${archived}.`}`
    : `Run ${run.id}, started ${run.startedAt} by step ${run.startedBy}.`)
  const report = new Report(print)
  try {
    await step.run(context, report)
  } catch (error) {
    report.fail(`Step ${id} stopped by an unexpected error`, error instanceof Error ? (error.stack ?? error.message) : String(error))
  }
  const finished = finishStep(context, run.id, id, report.exitCode)
  print('')
  print(report.summary())
  print(finished === undefined ? `Run ${run.id} was replaced by a newer run while this step ran; see ${context.logsDir}.` : runSummary(finished))
  print(`Log: ${log}`)
  return report.exitCode
}

async function main(): Promise<number> {
  const id = process.argv[2] ?? ''
  if (!isStepId(id)) {
    console.error(`Usage: node scripts/review.ts <step>, with step one of ${STEP_IDS.join(', ')}; or npm run review:01 ... review:07`)
    return 2
  }
  return runReviewStep(id, reviewContext())
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error)
    return EXIT.failed
  })
}
