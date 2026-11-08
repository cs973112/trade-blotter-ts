import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { EXIT, Report, reviewContext, type ReviewContext } from './review-context.ts'
import { stepCheck, stepPerformance, stepSeed, stepSetup, stepStart, stepStop, stepTests } from './review-steps.ts'

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
 * could not do all it should (performance without a browser). Its output is also saved in
 * .run/review/logs/.
 */

const STEPS: Readonly<Record<string, { readonly title: string; readonly run: (context: ReviewContext, report: Report) => Promise<void> }>> = {
  '01': { title: 'Setup', run: stepSetup },
  '02': { title: 'Seed', run: stepSeed },
  '03': { title: 'Start', run: stepStart },
  '04': { title: 'Functional checks', run: stepCheck },
  '05': { title: 'Automated tests', run: stepTests },
  '06': { title: 'Performance', run: stepPerformance },
  '07': { title: 'Stop', run: stepStop },
}

async function main(): Promise<number> {
  const id = process.argv[2] ?? ''
  const step = STEPS[id]
  if (step === undefined) {
    console.error(`Usage: node scripts/review.ts <step>, with step one of ${Object.keys(STEPS).join(', ')}; or npm run review:01 ... review:07`)
    return 2
  }
  const context = reviewContext()
  mkdirSync(context.logsDir, { recursive: true })
  const log = join(context.logsDir, `review-${id}.log`)
  writeFileSync(log, '')
  const print = (line: string): void => {
    console.log(line)
    appendFileSync(log, `${line}\n`)
  }
  print(`Review step ${id}: ${step.title}  (${new Date().toISOString()})`)
  const report = new Report(print)
  try {
    await step.run(context, report)
  } catch (error) {
    report.fail(`Step ${id} stopped by an unexpected error`, error instanceof Error ? (error.stack ?? error.message) : String(error))
  }
  print('')
  print(report.summary())
  print(`Log: ${log}`)
  return report.exitCode
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error)
    return EXIT.failed
  })
}
