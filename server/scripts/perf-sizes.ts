import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { launches, resolveSettings, SettingsError } from './app.ts'
import { appStatus, DatabaseInUseError, defaultRunDir, REPOSITORY_ROOT, startApps, StartError, stopApps } from './lifecycle.ts'
import {
  BenchmarkError, count, DEFAULT_ITERATIONS, DEFAULT_WARMUP, findManagedApi, formatResult, grouped, ms, readSnapshot, runBenchmark, table, writeJson,
  type BenchmarkResult,
} from './perf-api.ts'
import { findChrome, findManagedApplication, formatUiResult, runUiBenchmark, UI_OPTIONS, uiOptions, type UiBenchmarkResult } from './perf-ui.ts'
import { clearDatabase, refuseProtectedDatabase, seedDatabase, TargetError } from './trade-data.ts'

/**
 * npm run perf:api:sizes -- --database <path> [--sizes 100,1000,10000,25000] [--out <folder>]
 *                          [--warmup <n>] [--iterations <n>] [--api-port <n>] [--web-port <n>]
 * npm run perf:ui:sizes  -- the same, and perf:ui's --chrome, --timeout, --max-heap-mb and --scenarios
 *
 * A benchmark (perf:api or perf:ui) on several dataset sizes, one database file reused: for each
 * size, clear the file (db:clear), seed it (db:seed), start the applications on it (app:start),
 * confirm the trade count, measure, save the results, and stop the applications (app:stop). The
 * file is never deleted; the last size stays in it for trying the UI, with the applications
 * stopped. Refuses to begin while any application started with app:start is running: it starts
 * and stops only its own. An error or Ctrl+C stops what it started.
 *
 * Results go to --out, by default .run/perf/<api|ui>-<time>/ (ignored by Git): one JSON file per
 * size (for perf:ui rewritten after every scenario, so an interrupted size keeps what it finished),
 * and summary.txt with every table.
 */

const DEFAULT_SIZES = [100, 1_000, 10_000, 25_000]

function sizes(value: string | undefined): number[] {
  if (value === undefined) return DEFAULT_SIZES
  const list = value.split(',').map((item) => item.trim())
  if (list.some((item) => !/^[1-9][0-9]*$/.test(item))) throw new BenchmarkError(`--sizes must be trade counts separated by commas, such as 100,1000; got "${value}".`)
  return list.map(Number)
}

interface Measured {
  readonly trades: number
  readonly scenarios: readonly { readonly name: string; readonly median: number; readonly spread: string }[]
}

/** The median of each scenario, one column per dataset size, with min-max (UI) or p95 (API). */
export function comparison(results: readonly Measured[], spreadTitle: string): string {
  const names = results[0]?.scenarios.map((scenario) => scenario.name) ?? []
  return table(
    ['Scenario', ...results.flatMap((r) => [`${grouped(r.trades)} median`, spreadTitle])],
    names.map((name) => [name, ...results.flatMap((r) => {
      const scenario = r.scenarios.find((s) => s.name === name)
      return scenario === undefined ? ['-', '-'] : [ms(scenario.median), scenario.spread]
    })]),
  )
}

const fromApi = (r: BenchmarkResult): Measured => ({
  trades: r.datasetTrades, scenarios: r.scenarios.map((s) => ({ name: s.name, median: s.latencyMs.median, spread: ms(s.latencyMs.p95) })),
})
const fromUi = (r: UiBenchmarkResult): Measured => ({
  trades: r.datasetTrades, scenarios: r.scenarios.map((s) => ({ name: s.name, median: s.elapsedMs.median, spread: `${ms(s.elapsedMs.min)}-${ms(s.elapsedMs.max)}` })),
})

async function main(): Promise<number> {
  const runDir = defaultRunDir()
  const [tool, ...args] = process.argv.slice(2)
  let started = false
  let closeBrowser: (() => Promise<void>) | undefined
  const interrupted = (): void => {
    console.error('\nInterrupted: closing Chrome and stopping the applications this runner started...')
    void (async () => {
      await closeBrowser?.()
      if (started) await stopApps(runDir)
      process.exit(130)
    })()
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    if (tool !== 'api' && tool !== 'ui') throw new BenchmarkError('Usage: node scripts/perf-sizes.ts api|ui --database <path> [options]')
    const { values } = parseArgs({
      args,
      strict: true,
      options: {
        database: { type: 'string' }, sizes: { type: 'string' }, out: { type: 'string' }, warmup: { type: 'string' }, iterations: { type: 'string' },
        'api-port': { type: 'string' }, 'web-port': { type: 'string' },
        ...(tool === 'ui' ? { chrome: UI_OPTIONS.chrome, timeout: UI_OPTIONS.timeout, 'max-heap-mb': UI_OPTIONS['max-heap-mb'], scenarios: UI_OPTIONS.scenarios } : {}),
      },
    })
    const cwd = process.env['INIT_CWD'] ?? process.cwd()
    const path = refuseProtectedDatabase(values.database === undefined ? undefined : resolve(cwd, values.database))
    const counts = sizes(values.sizes)
    const apiOptions = { warmup: count(values.warmup, '--warmup', DEFAULT_WARMUP), iterations: count(values.iterations, '--iterations', DEFAULT_ITERATIONS) }
    const ui = tool === 'ui' ? uiOptions(values as Parameters<typeof uiOptions>[0]) : undefined
    if (ui !== undefined) console.log(`Chrome: ${findChrome(ui.chrome)}`)
    const { state, statuses } = appStatus(runDir)
    if (state !== undefined && statuses.some((status) => status === 'running' || status === 'unverified')) {
      throw new TargetError(`An application started with app:start is running (database ${state.databasePath}). ` +
        'This runner starts and stops only its own applications: stop it first with npm run app:stop')
    }
    const missing = [join(REPOSITORY_ROOT, 'server', 'dist', 'main.js'), join(REPOSITORY_ROOT, 'client', 'dist', 'index.html')].filter((file) => !existsSync(file))
    if (missing.length > 0) throw new TargetError(`Build the applications first (npm run build); missing:\n  ${missing.join('\n  ')}`)
    const ports = [
      ...(values['api-port'] === undefined ? [] : ['--api-port', values['api-port']]),
      ...(values['web-port'] === undefined ? [] : ['--web-port', values['web-port']]),
    ]
    const settings = resolveSettings(['--database', path, ...ports], process.env, cwd)
    const out = resolve(cwd, values.out ?? join(runDir, 'perf', `${tool}-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}`))

    const measured: Measured[] = []
    const report: string[] = []
    for (const size of counts) {
      console.log(`\n=== ${grouped(size)} trades ===`)
      if (existsSync(path) && statSync(path).size > 0) {
        const cleared = clearDatabase({ path, confirm: true })
        console.log(`Cleared ${grouped(cleared.removed)} trades.`)
      }
      const seeded = await seedDatabase({ path, count: size })
      console.log(`Seeded and verified ${grouped(seeded.summary.trades)} trades in ${(seeded.milliseconds.total / 1000).toFixed(2)} s.`)

      started = true
      const start = await startApps({
        runDir, databasePath: settings.databasePath, launches: launches(settings, process.env),
        onLaunch: (launch) => { console.log(`Starting the ${launch.label} on port ${String(launch.port)}...`) },
        portHint: (launch) => `Choose another with ${launch.name === 'api' ? '--api-port' : '--web-port'}, or stop the program using it.`,
      })
      if (start.kind !== 'started') throw new StartError('An application started with app:start appeared while this runner was working. Nothing more was done.')
      let failure: Error | undefined
      try {
        const stored = (await readSnapshot(path)).trades.length
        if (stored !== size) throw new BenchmarkError(`The database holds ${grouped(stored)} trades, expected ${grouped(size)}.`)
        console.log(`Confirmed: ${grouped(stored)} trades in ${path}.`)
        if (ui === undefined) {
          const result = await runBenchmark(findManagedApi({ databasePath: path }), {
            ...apiOptions, onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${ms(scenario.latencyMs.median)} ms`) },
          })
          measured.push(fromApi(result))
          report.push(formatResult(result))
          writeJson(join(out, `${tool}-${String(size)}.json`), result)
        } else {
          const result = await runUiBenchmark(findManagedApplication({ databasePath: path }), {
            ...ui,
            onBrowser: (browser) => { closeBrowser = browser === undefined ? undefined : () => browser.close() },
            onScenario: (scenario) => { console.log(`  ${scenario.name}: median ${ms(scenario.elapsedMs.median)} ms`) },
            onCheckpoint: (partial) => { writeJson(join(out, `${tool}-${String(size)}.json`), partial) },
          })
          measured.push(fromUi(result))
          report.push(formatUiResult(result))
          writeJson(join(out, `${tool}-${String(size)}.json`), result)
        }
        console.log(`\n${report.at(-1) ?? ''}`)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
      // Stopped whether or not the measurement succeeded, before anything else is reported.
      const stopped = await stopApps(runDir)
      started = false
      if (failure !== undefined) throw failure
      if (stopped.kind === 'stopped' && !stopped.recordRemoved) throw new StartError('The applications could not all be stopped; run npm run app:status.')
      console.log('Stopped the applications.')
    }

    const title = ui === undefined ? 'Median and p95 latency (ms) by dataset size' : 'Median and min-max (ms) of each UI scenario by dataset size'
    const summary = comparison(measured, ui === undefined ? 'p95' : 'min-max')
    writeFileSync(join(out, 'summary.txt'), `${[...report, `${title}:\n\n${summary}`].join('\n\n')}\n`)
    console.log(`\n${title}:\n\n${summary}`)
    console.log(`\nResults: ${out}`)
    console.log(`The database keeps the last ${grouped(counts.at(-1) ?? 0)} trades; the applications are stopped. Try them: npm run app:start -- --database "${path}"`)
    return 0
  } catch (error) {
    if (started) await stopApps(runDir)
    if (error instanceof TargetError || error instanceof BenchmarkError || error instanceof StartError || error instanceof SettingsError ||
      error instanceof DatabaseInUseError) {
      console.error(error.message)
      return 1
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(error.message)
      return 2
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main()
}
