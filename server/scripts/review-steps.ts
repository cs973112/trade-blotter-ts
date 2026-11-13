import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { lookUpBrowser, type BrowserLookup } from './browser.ts'
import { canonicalPath, DatabaseInUseError, portAnswers, type AppState } from './lifecycle.ts'
import { findManagedApi, formatResult, readSnapshot, runBenchmark, type BenchmarkResult, type ManagedApi } from './perf-api.ts'
import { findManagedApplication, formatUiResult, runUiBenchmark, type ManagedApplication, type UiBenchmarkResult } from './perf-ui.ts'
import {
  buildStates, checkOwnership, runLogged, startPair, stopPair, storedTradeCount, tail, type OwnershipOptions,
} from './review-apps.ts'
import { bookingChecks, readOnlyChecks } from './review-checks.ts'
import {
  fingerprintChanges, fingerprintFiles, readBaseline, writeBaseline, type Report, type ReviewContext, type ReviewPair,
} from './review-context.ts'
import { inspectDataset, prepareDatabase, recoveryAdvice, seedPair, type DatasetState } from './review-data.ts'
import { DATASET_VERSION } from './seed-data.ts'
import { runUiChecks, type UiCheckRun } from './ui-check.ts'
import { refuseProtectedDatabase } from './trade-data.ts'

/**
 * The seven reviewer steps. Each reports one line per check (PASS, FAIL, WARN, SKIPPED) and
 * never hides an error. What depends on the machine (the browser, the benchmarks, process checks,
 * commands) can be replaced, so tests can drive every outcome without real browsers or unrelated
 * processes.
 */

export interface StepDependencies extends OwnershipOptions {
  readonly env?: NodeJS.ProcessEnv
  /** The browser, or why there is none (see browser.ts). */
  readonly findBrowser?: () => BrowserLookup
  readonly runCommand?: (command: string, args: readonly string[], cwd: string, log: string) => Promise<number>
  readonly apiBenchmark?: (api: ManagedApi) => Promise<BenchmarkResult>
  readonly uiBenchmark?: (app: ManagedApplication, chrome: string) => Promise<UiBenchmarkResult>
  /** The page's behaviour in a real browser (ui-check.ts), with screenshots in outDir. */
  readonly uiChecks?: (chrome: string, outDir: string) => Promise<UiCheckRun>
  /** Stops one pair's applications (review-apps.ts). */
  readonly stopPair?: typeof stopPair
}

export const SUPPORTED_NODE = 'v22.23.1'

const grouped = (value: number): string => value.toLocaleString('en-US')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function describe(state: DatasetState): string {
  switch (state.kind) {
    case 'missing': return 'missing'
    case 'empty': return 'a Trade Blotter database with no trades'
    case 'outdated': return `behind on migrations (${String(state.applied)} of ${String(state.expected)} applied)`
    case 'seeded': return `its dataset (version ${String(DATASET_VERSION)}) of ${grouped(state.trades - state.bookings)} trades${state.bookings > 0 ? `, and ${grouped(state.bookings)} booked since` : ''}`
    case 'unexpected': return `unexpected: ${state.reason}`
  }
}

export function defaultBrowser(): BrowserLookup {
  return lookUpBrowser()
}

const NO_BROWSER = 'No Chrome, Edge or Chromium found (CHROME_PATH, then the usual places)'

// ---------------------------------------------------------------------------------------------
// 01 Setup

/**
 * Every package named in the three package.json files, installed at the version package-lock.json
 * records. Nothing is installed: missing or different packages are listed.
 */
export function dependencyProblems(repositoryRoot: string): { readonly checked: number; readonly problems: readonly string[] } {
  const lockPath = join(repositoryRoot, 'package-lock.json')
  if (!existsSync(lockPath)) return { checked: 0, problems: ['package-lock.json is missing'] }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: Record<string, { version?: string }> }
  const names = new Set<string>()
  for (const manifest of ['package.json', 'server/package.json', 'client/package.json']) {
    const json = JSON.parse(readFileSync(join(repositoryRoot, manifest), 'utf8')) as Record<string, Record<string, string> | undefined>
    for (const field of ['dependencies', 'devDependencies']) for (const name of Object.keys(json[field] ?? {})) names.add(name)
  }
  const problems: string[] = []
  for (const name of [...names].sort()) {
    const locations = [`node_modules/${name}`, `server/node_modules/${name}`, `client/node_modules/${name}`]
    const location = locations.find((candidate) => lock.packages?.[candidate] !== undefined)
    const wanted = location === undefined ? undefined : lock.packages?.[location]?.version
    if (location === undefined || wanted === undefined) {
      problems.push(`${name}: not in package-lock.json`)
      continue
    }
    const manifest = join(repositoryRoot, location, 'package.json')
    if (!existsSync(manifest)) {
      problems.push(`${name}: not installed`)
      continue
    }
    const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
    if (installed !== wanted) problems.push(`${name}: ${String(installed)} installed, package-lock.json records ${wanted}`)
  }
  return { checked: names.size, problems }
}

export async function stepSetup(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  const env = deps.env ?? process.env
  if (process.version === SUPPORTED_NODE) report.pass(`Node.js ${process.version}`)
  else if (process.version.startsWith('v22.')) report.warn(`Node.js ${process.version}`, `Supported is ${SUPPORTED_NODE} only; this Node 22 differs, so results are not guaranteed to match.`)
  else report.fail(`Node.js ${process.version}`, `Use Node.js ${SUPPORTED_NODE} (see .nvmrc).`)

  const npm = /npm\/(\S+)/.exec(env['npm_config_user_agent'] ?? '')?.[1]
  if (npm === undefined) report.warn('npm', 'Not run through npm, so its version was not checked. Use npm run review:01.')
  else report.pass(`npm ${npm}`)

  const dependencies = dependencyProblems(context.repositoryRoot)
  if (dependencies.problems.length === 0) report.pass(`Dependencies: all ${String(dependencies.checked)} packages installed as package-lock.json records`)
  else report.fail('Dependencies', `${dependencies.problems.join('\n')}\nInstall them with npm ci (it needs the npm registry); nothing was installed.`)

  try {
    const db = new DatabaseSync(':memory:')
    const version = String(db.prepare('select sqlite_version() as v').get()?.['v'])
    db.exec("create table t (a text, b text generated always as (a || 'x') virtual); create index t_b on t (b)")
    db.close()
    report.pass(`Built-in SQLite ${version} (node:sqlite), with generated columns and their indexes`)
  } catch (error) {
    report.fail('Built-in SQLite (node:sqlite)', message(error))
  }

  try {
    // Before any folder is made: the reviewer folder must not be the development database's.
    refuseProtectedDatabase(join(context.root, 'reviewer.db'), context.protection)
  } catch (error) {
    report.fail(`Reviewer folder ${context.root}`, `${message(error)}\nNothing was created there.`)
    return
  }
  for (const dir of [context.root, context.logsDir, context.perfDir, context.disposableDir]) mkdirSync(dir, { recursive: true })
  report.pass(`Reviewer folder ${context.root}`, 'Databases, run state, logs and results stay here; Git ignores it.')

  for (const pair of context.pairs) {
    try {
      const outcome = await prepareDatabase(context, pair)
      if (outcome.kind === 'created') report.pass(`${pair.label} database created and migrated`, pair.databasePath)
      else if (outcome.kind === 'migrated') report.pass(`${pair.label} database migrated from ${String(outcome.from)} to ${String(outcome.to)} migrations`, pair.databasePath)
      else if (outcome.kind === 'replaced') {
        const { backup } = outcome
        report.warn(`${pair.label} database held ${outcome.reason}: preserved in a verified backup, then replaced by a new, empty database for step 02`, [
          `Backup: ${backup.folder}`,
          `Kept: ${grouped(backup.trades)} trades (fingerprint ${backup.fingerprint.slice(0, 16)}...), checked by opening a second copy: integrity, count and every row`,
          ...backup.files.map((file) => `  ${file.name}  sha256 ${file.sha256}`),
          'To restore it, see backup.json in that folder.',
        ].join('\n'))
      } else if (outcome.state.kind === 'unexpected') report.fail(`${pair.label} database is ${describe(outcome.state)}`, `${pair.databasePath}\n${recoveryAdvice(pair, outcome.state)}`)
      else report.pass(`${pair.label} database exists, kept as it is: ${describe(outcome.state)}`, pair.databasePath)
    } catch (error) {
      report.fail(`${pair.label} database`, `${message(error)}${error instanceof DatabaseInUseError ? '' : `\n${pair.databasePath}`}`)
    }
  }

  const development = fingerprintFiles(context.protection.developmentDatabase)
  writeBaseline(context, development)
  report.pass(development.exists
    ? 'Development database fingerprinted (never opened): it is compared at step 07'
    : 'Development database absent; that is recorded, and checked again at step 07',
  Object.entries(development.files).map(([file, hash]) => `${file}: ${hash === undefined ? 'absent' : `sha256 ${hash.slice(0, 16)}...`}`).join('\n'))

  const browser = (deps.findBrowser ?? defaultBrowser)()
  if (browser.kind === 'missing') {
    report.warn(NO_BROWSER, `Step 05 will skip the UI checks and step 06 the UI benchmark, and both will report INCOMPLETE.\n${browser.diagnostics}`)
  } else if (browser.kind === 'invalid-setting') {
    report.fail('CHROME_PATH does not name a usable browser', `${browser.message}\nSteps 05 and 06 will fail their browser checks until it is corrected.`)
  } else {
    report.pass(`Browser for the UI checks and benchmark: ${browser.path}`, `Found as ${browser.description}.`)
  }

  for (const pair of context.pairs) {
    const ownership = await checkOwnership(pair, deps)
    for (const [label, port] of [[`${pair.label} API`, pair.apiPort], [`${pair.label} frontend`, pair.webPort]] as const) {
      if (!(await portAnswers(port, context.host))) report.pass(`Port ${String(port)} (${label}) is free`)
      else if (ownership.kind === 'running') report.pass(`Port ${String(port)} (${label}) is used by the reviewer's own application`)
      else report.warn(`Port ${String(port)} (${label}) is in use by another program`, 'Step 03 will not start this pair while it is; nothing will be stopped.')
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 02 Seed

export async function stepSeed(context: ReviewContext, report: Report): Promise<void> {
  for (const pair of context.pairs) {
    try {
      const state = await inspectDataset(pair)
      if (state.kind === 'seeded') {
        report.pass(`${pair.label} database already holds ${describe(state)}; kept as it is`, pair.databasePath)
        continue
      }
      if (state.kind === 'unexpected') {
        report.fail(`${pair.label} database is ${describe(state)}`, `${pair.databasePath}\n${recoveryAdvice(pair, state)}`)
        continue
      }
      if (state.kind === 'outdated') {
        report.fail(`${pair.label} database is ${describe(state)}`, 'Run npm run review:01 first.')
        continue
      }
      const seeded = await seedPair(context, pair)
      const after = await inspectDataset(pair)
      if (after.kind !== 'seeded') {
        report.fail(`${pair.label} database was seeded, but now holds ${describe(after)}`, pair.databasePath)
        continue
      }
      report.pass(`${pair.label} database seeded with its dataset of ${grouped(pair.count)} trades in ${(seeded.milliseconds / 1000).toFixed(1)} s`, pair.databasePath)
    } catch (error) {
      report.fail(`${pair.label} database`, message(error))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 03 Start

export async function stepStart(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  const env = deps.env ?? process.env
  const builds = buildStates(context)
  const needed = builds.filter((build) => build.state !== 'current')
  if (needed.length === 0) {
    report.pass('Builds are up to date', builds.map((build) => build.output).join('\n'))
  } else {
    const log = join(context.logsDir, '03-build.log')
    const code = await (deps.runCommand ?? runLogged)('npm', ['run', 'build'], context.repositoryRoot, log)
    const after = buildStates(context)
    if (code !== 0 || after.some((build) => build.state !== 'current')) {
      report.fail(`Build (${needed.map((build) => `${build.name} ${build.state}`).join(', ')})`, `exit code ${String(code)}; log ${log}\n${tail(log)}`)
      return
    }
    report.pass(`Built: ${needed.map((build) => `${build.name} (was ${build.state})`).join(', ')}`, `Log: ${log}`)
  }

  for (const pair of context.pairs) {
    const state = await inspectDataset(pair)
    if (state.kind !== 'seeded') {
      report.fail(`${pair.label} database is ${describe(state)}`, 'Run npm run review:01 and npm run review:02 first. Nothing was started.')
      continue
    }
    const before = await checkOwnership(pair, deps)
    if (before.kind === 'running' && before.complete) {
      report.pass(`${pair.label} applications already running and verified as the reviewer's`, describeRunning(pair, before.state))
      continue
    }
    if (before.kind === 'not-ours' || before.kind === 'unreadable') {
      report.fail(`${pair.label}: applications recorded but not verified as the reviewer's; nothing was started or stopped`, before.problems.join('\n'))
      continue
    }
    if (before.kind === 'running') {
      report.fail(`${pair.label}: only partly running; nothing was started`, 'Run npm run review:07, then npm run review:03.')
      continue
    }
    try {
      await startPair(context, pair, env)
      const after = await checkOwnership(pair, deps)
      if (after.kind === 'running' && after.complete) report.pass(`${pair.label} applications started and verified`, describeRunning(pair, after.state))
      else report.fail(`${pair.label} applications started but could not be verified`, after.kind === 'not-ours' || after.kind === 'unreadable' ? after.problems.join('\n') : after.kind)
    } catch (error) {
      report.fail(`${pair.label} applications not started`, message(error))
    }
  }
  const scratch = context.pairs.find((pair) => pair.name === 'scratch')
  if (scratch !== undefined && !report.failed) report.info(`Open the scratch frontend to book trades: http://${context.host}:${String(scratch.webPort)}`)
}

function describeRunning(pair: ReviewPair, state: AppState): string {
  return [
    ...state.apps.map((app) => `${app.label.padEnd(8)} process ${String(app.pid)}, ${app.url}${app.details?.['forwards API requests to'] === undefined ? '' : ` -> ${app.details['forwards API requests to']}`}`),
    `Database ${pair.databasePath}`, `Run state and logs ${pair.runDir}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// 04 Functional checks

export async function stepCheck(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  const urls = new Map<ReviewPair['name'], { api: string; web: string }>()
  for (const pair of context.pairs) {
    const ownership = await checkOwnership(pair, deps)
    if (ownership.kind !== 'running' || !ownership.complete) {
      report.fail(`${pair.label} applications are not running as the reviewer's`, ownership.kind === 'not-ours' || ownership.kind === 'unreadable'
        ? ownership.problems.join('\n') : 'Run npm run review:03 first.')
      continue
    }
    const api = ownership.state.apps.find((app) => app.name === 'api')?.url ?? ''
    const web = ownership.state.apps.find((app) => app.name === 'web')?.url ?? ''
    urls.set(pair.name, { api, web })
    report.pass(`${pair.label} applications verified as the reviewer's (${api}, ${web})`)
  }
  if (report.failed) return

  const benchmark = context.pairs.find((pair) => pair.name === 'benchmark')
  const scratch = context.pairs.find((pair) => pair.name === 'scratch')
  if (benchmark === undefined || scratch === undefined) throw new Error('The context needs a benchmark and a scratch pair.')
  const benchmarkBefore = await readSnapshot(benchmark.databasePath)
  const scratchBefore = await readSnapshot(scratch.databasePath)
  const dataset = await inspectDataset(benchmark)
  if (dataset.kind === 'seeded' && dataset.bookings === 0) report.pass(`Benchmark database holds exactly its dataset (${grouped(dataset.trades)} trades)`)
  else report.fail('Benchmark database does not hold exactly its dataset', describe(dataset))

  await readOnlyChecks(report, { label: 'Benchmark', apiUrl: urls.get('benchmark')?.api ?? '', webUrl: urls.get('benchmark')?.web ?? '', databasePath: benchmark.databasePath }, benchmarkBefore)

  // The scratch pair: its own data, through its own frontend, independent of the benchmark pair.
  const scratchUrls = urls.get('scratch') ?? { api: '', web: '' }
  const scratchTotal = storedTradeCount(scratch.databasePath)
  for (const [name, base] of [['API', scratchUrls.api], ['frontend', scratchUrls.web]] as const) {
    try {
      const response = await fetch(`${base}/trades/page?pageSize=1`, { signal: AbortSignal.timeout(30_000) })
      const total = /"totalCount":(\d+)/.exec(await response.text())?.[1]
      if (Number(total) === scratchTotal && scratchTotal !== benchmarkBefore.trades.length) report.pass(`Scratch ${name} answers with the scratch database's ${grouped(scratchTotal)} trades, not the benchmark's`)
      else report.fail(`Scratch ${name} does not answer with the scratch database`, `it reports ${String(total)} trades; the scratch database holds ${String(scratchTotal)}`)
    } catch (error) {
      report.fail(`Scratch ${name}`, message(error))
    }
  }

  await bookingChecks(report, { dir: context.disposableDir, seed: scratch.seed, count: scratch.count, protection: context.protection })

  const benchmarkAfter = await readSnapshot(benchmark.databasePath)
  if (benchmarkAfter.fingerprint === benchmarkBefore.fingerprint) report.pass('Benchmark database unchanged by the checks (every stored field compared)')
  else report.fail('Benchmark database changed during the checks', 'The checks only read it; something else wrote to it.')
  const scratchAfter = await readSnapshot(scratch.databasePath)
  if (scratchAfter.fingerprint === scratchBefore.fingerprint) report.pass('Scratch database unchanged by the checks')
  else report.warn('Scratch database changed during the checks', 'The checks only read it: a trade was probably booked in the browser meanwhile.')
}

// ---------------------------------------------------------------------------------------------
// 05 Automated tests

/** The vitest summary in a log: its Test Files and Tests lines. */
export function testCounts(log: string): string | undefined {
  const text = log.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
  const files = /Test Files\s+([^\n]+)/.exec(text)?.[1]?.trim()
  const tests = /\n\s+Tests\s+([^\n]+)/.exec(text)?.[1]?.trim()
  return files === undefined || tests === undefined ? undefined : `Test files: ${files}; tests: ${tests}`
}

export async function stepTests(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  const run = deps.runCommand ?? runLogged
  const commands = [
    ['Lint (ESLint)', ['run', 'lint']],
    ['Typecheck (tsc and vue-tsc)', ['run', 'typecheck']],
    ['Build (API and frontend)', ['run', 'build']],
    ['Server tests (vitest)', ['run', 'test', '-w', 'server']],
    ['Client tests (vitest)', ['run', 'test', '-w', 'client']],
    ['Schema check (migrations match the schema)', ['run', 'db:check', '-w', 'server']],
  ] as const
  for (const [index, [name, args]] of commands.entries()) {
    const log = join(context.logsDir, `05-${String(index + 1)}-${args.slice(1).join('-').replace(/[^a-z0-9-]/gi, '')}.log`)
    const started = Date.now()
    const code = await run('npm', args, context.repositoryRoot, log)
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    const counts = existsSync(log) ? testCounts(readFileSync(log, 'utf8')) : undefined
    const detail = [counts, `${seconds} s; log ${log}`].filter(Boolean).join('\n')
    if (code !== 0) {
      report.fail(`${name}: exit code ${String(code)}`, `${detail}\n${tail(log, 60)}`)
      report.info('Stopped at the first failure; the commands after it were not run.')
      return
    }
    report.pass(name, detail)
    if (counts !== undefined && /skipped/.test(counts)) report.warn(`${name}: some tests were skipped, not run`, counts)
  }
  await uiChecks(context, report, deps)
}

/**
 * The page in a real browser (npm run check:ui), on a throwaway database of its own with 40 open
 * positions. Without a browser the checks are SKIPPED and the step INCOMPLETE, never passed.
 */
async function uiChecks(context: ReviewContext, report: Report, deps: StepDependencies): Promise<void> {
  const browser = (deps.findBrowser ?? defaultBrowser)()
  if (browser.kind === 'missing') {
    report.skip('UI checks in a real browser', `${NO_BROWSER}. Nothing was installed.\n${browser.diagnostics}`)
    report.incomplete('the UI checks were skipped (no browser), so the page itself is not verified')
    return
  }
  if (browser.kind === 'invalid-setting') {
    report.fail('UI checks not run: CHROME_PATH does not name a usable browser', browser.message)
    return
  }
  const outDir = join(context.uiCheckDir, new Date().toISOString().replace(/[:.]/g, '-'))
  console.log(`UI checks in headless ${browser.path} (${browser.description}); a database of their own with 40 open positions...`)
  try {
    const run = await (deps.uiChecks ?? ((chrome, out) => runUiChecks({ chrome, outDir: out })))(browser.path, outDir)
    for (const result of run.results) {
      if (result.problem === undefined) report.pass(`UI: ${result.name}`)
      else report.fail(`UI: ${result.name}`, result.problem)
    }
    if (run.consoleErrors.length > 0) report.fail('UI: the page logged errors', run.consoleErrors.join('\n'))
    else report.pass('UI: no console errors')
    report.info(`UI checks ran in ${run.product}`, `Screenshots (1280, 768 and 390 px wide):\n${run.screenshots.join('\n')}`)
  } catch (error) {
    report.fail('UI checks', message(error))
  }
}

// ---------------------------------------------------------------------------------------------
// 06 Performance

export async function stepPerformance(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  const pair = context.pairs.find((candidate) => candidate.name === 'benchmark')
  if (pair === undefined) throw new Error('The context needs a benchmark pair.')
  const ownership = await checkOwnership(pair, deps)
  if (ownership.kind !== 'running' || !ownership.complete) {
    report.fail('Benchmark applications are not running as the reviewer\'s', ownership.kind === 'not-ours' || ownership.kind === 'unreadable'
      ? ownership.problems.join('\n') : 'Run npm run review:03 first.')
    return
  }
  const out = join(context.perfDir, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(out, { recursive: true })
  const protection = { ...context.protection, runDir: pair.runDir }

  try {
    const api = findManagedApi({ databasePath: pair.databasePath, protection })
    console.log('API benchmark: GET /trades, GET /trades/page and GET /positions; every response is checked against the database...')
    const result = await (deps.apiBenchmark ?? ((target) => runBenchmark(target, {
      onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${scenario.latencyMs.median.toFixed(1)} ms`) },
    })))(api)
    writeFileSync(join(out, 'api.json'), `${JSON.stringify(result, null, 2)}\n`)
    writeFileSync(join(out, 'api.txt'), `${formatResult(result)}\n`)
    const byEndpoint = ['GET /trades', 'GET /trades/page', 'GET /positions'].map((endpoint) => {
      const scenarios = result.scenarios.filter((s) => s.endpoint === endpoint)
      const medians = scenarios.map((s) => s.latencyMs.median)
      return `${endpoint}: ${String(scenarios.length)} scenarios, medians ${Math.min(...medians).toFixed(1)} to ${Math.max(...medians).toFixed(1)} ms`
    })
    report.pass(`API benchmark: ${String(result.scenarios.length)} scenarios on ${grouped(result.datasetTrades)} trades, every response correct, data unchanged`,
      `${byEndpoint.join('\n')}\nResults: ${join(out, 'api.txt')} and api.json`)
  } catch (error) {
    report.fail('API benchmark', message(error))
  }

  const browser = (deps.findBrowser ?? defaultBrowser)()
  if (browser.kind === 'missing') {
    report.skip('UI benchmark', `No Chrome, Edge or Chromium was found (CHROME_PATH, then the usual places). Nothing was installed.\n${browser.diagnostics}`)
    report.incomplete('the UI benchmark was skipped (no browser), so performance is only partly verified')
    return
  }
  if (browser.kind === 'invalid-setting') {
    report.fail('UI benchmark not run: CHROME_PATH does not name a usable browser', browser.message)
    return
  }
  const chrome = browser.path
  try {
    const app = findManagedApplication({ databasePath: pair.databasePath, protection })
    console.log(`UI benchmark in headless ${chrome}; every action's page is checked against the database...`)
    const result = await (deps.uiBenchmark ?? ((target, path) => runUiBenchmark(target, {
      chrome: path,
      onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${scenario.elapsedMs.median.toFixed(1)} ms`) },
      onCheckpoint: (partial) => { writeFileSync(join(out, 'ui.json'), `${JSON.stringify(partial, null, 2)}\n`) },
    })))(app, chrome)
    writeFileSync(join(out, 'ui.json'), `${JSON.stringify(result, null, 2)}\n`)
    writeFileSync(join(out, 'ui.txt'), `${formatUiResult(result)}\n`)
    const medians = result.scenarios.map((s) => `${s.name}: ${s.elapsedMs.median.toFixed(1)} ms`)
    report.pass(`UI benchmark: ${String(result.scenarios.length)} scenarios, every page shown correct, ${result.consoleErrors.length === 0 ? 'no console errors' : `${String(result.consoleErrors.length)} console errors`}`,
      `${medians.join('\n')}\nResults: ${join(out, 'ui.txt')} and ui.json`)
    if (result.consoleErrors.length > 0) report.fail('UI benchmark: the page logged errors', result.consoleErrors.join('\n'))
  } catch (error) {
    report.fail('UI benchmark', message(error))
  }
}

// ---------------------------------------------------------------------------------------------
// 07 Stop

export async function stepStop(context: ReviewContext, report: Report, deps: StepDependencies = {}): Promise<void> {
  // Each part runs whatever happened before it, in this step or an earlier one: a pair that cannot
  // be stopped, or an error, is reported and the rest of the clean-up still runs.
  const stop = deps.stopPair ?? stopPair
  for (const pair of context.pairs) {
    try {
      const outcome = await stop(pair, deps)
      if (outcome.kind === 'not-started') report.skip(`${pair.label} applications: none recorded`, 'Nothing to stop.')
      else if (outcome.kind === 'already-stopped') report.pass(`${pair.label} applications were not running; their stale record was removed`)
      else if (outcome.kind === 'stopped') {
        report.pass(`${pair.label} applications stopped after their identity was confirmed; ports released`,
          outcome.reports.map((r) => `${r.record.label.padEnd(8)} process ${String(r.record.pid)} ${r.outcome}, port ${String(r.record.port)} ${r.portReleased ? 'released' : 'STILL IN USE'}`).join('\n'))
      } else {
        report.fail(`${pair.label}: not stopped, left running`, `${outcome.problems.join('\n')}\nThe record ${join(pair.runDir, 'app.json')} is kept. Nothing else was touched.`)
      }
    } catch (error) {
      report.fail(`${pair.label}: stopping failed`, `${message(error)}\nThe record ${join(pair.runDir, 'app.json')} is kept; the rest of the clean-up continued.`)
    }
  }

  try {
    const leftovers = leftoverUiCheckDatabases(context.uiCheckDir)
    if (leftovers.length > 0) {
      for (const folder of leftovers) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      report.pass(`Removed ${String(leftovers.length)} UI check database folder(s) left by an interrupted step 05`, leftovers.join('\n'))
    }
  } catch (error) {
    report.fail('UI check databases left by step 05 could not be removed', message(error))
  }

  try {
    const baseline = readBaseline(context)
    const now = fingerprintFiles(context.protection.developmentDatabase)
    if (baseline === undefined) {
      report.warn('Development database: no fingerprint from step 01 to compare with', 'Run npm run review:01 at the start of a review.')
    } else if (canonicalPath(baseline.path) !== canonicalPath(now.path)) {
      report.warn('Development database: step 01 fingerprinted another path', `${baseline.path} then, ${now.path} now`)
    } else {
      const changes = fingerprintChanges(baseline, now)
      if (changes.length === 0) report.pass(`Development database unchanged since step 01 (${baseline.recordedAt})`, now.exists ? 'Same SHA-256 for every file.' : 'Still absent.')
      else report.warn('Development database differs from step 01\'s fingerprint', `${changes.join('\n')}\nThe reviewer workflow never opens it; your own application, if it ran meanwhile, would explain this.`)
    }
  } catch (error) {
    report.fail('Development database could not be compared with step 01\'s fingerprint', message(error))
  }
  report.info(`Kept: ${context.root}`, 'Both databases, logs and results stay for the next review.')
}

/**
 * The temporary databases (db-* folders) the UI checks make under each run's folder. The checks
 * remove theirs when they finish; any still there were left by a run that was stopped part way.
 */
export function leftoverUiCheckDatabases(uiCheckDir: string): string[] {
  if (!existsSync(uiCheckDir)) return []
  return readdirSync(uiCheckDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((run) => {
    const folder = join(uiCheckDir, run.name)
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('db-')).map((entry) => join(folder, entry.name))
  })
}
