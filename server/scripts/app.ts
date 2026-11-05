import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { DEFAULT_DATABASE_PATH, loadConfig } from '../src/config.ts'
import {
  appStatus,
  defaultRunDir,
  isDevelopmentDatabase,
  portAnswers,
  REPOSITORY_ROOT,
  startApps,
  StartError,
  stopApps,
  type AppLaunch,
  type ProcessStatus,
  type StopOutcome,
} from './lifecycle.ts'

/**
 * npm run app:start | app:stop | app:status — the compiled API and the built frontend in the
 * background, started the same way as `npm start -w server` and `npm run preview -w client`.
 *
 *   --api-port <n>     API port (else PORT, else 5299)
 *   --web-port <n>     frontend port (else WEB_PORT, else 4173, the preview server's own default)
 *   --host <name>      interface for both (else HOST, else localhost)
 *   --database <path>  SQLite file (else DATABASE_PATH, else server/data/trade-blotter.db)
 *
 * LOG_LEVEL, DOCS_ENABLED and SYMBOL_MAX_LENGTH reach the API as usual.
 */

const SERVER_ROOT = join(REPOSITORY_ROOT, 'server')
const CLIENT_ROOT = join(REPOSITORY_ROOT, 'client')

/** The preview server's port in client/vite.config.ts. */
export const DEFAULT_WEB_PORT = 4173

/** `npm start -w server`, without npm: node with these arguments in server/. */
export const API_ARGS = ['--disable-warning=ExperimentalWarning', 'dist/main.js'] as const

/** Settings the API reads; a value from the shell reaches it only through the options above. */
const API_SETTINGS = ['HOST', 'PORT', 'DATABASE_PATH', 'API_TARGET', 'WEB_PORT']

const READINESS_QUERY = '/trades?sortBy=readiness-probe'

export interface Settings {
  readonly host: string
  readonly apiPort: number
  readonly webPort: number
  readonly databasePath: string
  readonly docsEnabled: boolean
  readonly apiUrl: string
  readonly webUrl: string
  /** Where the frontend forwards /trades, /positions and /documentation. */
  readonly apiTarget: string
}

export class SettingsError extends Error {}

/** A host as it appears in a URL that this machine can open. */
export function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return 'localhost'
  return host.includes(':') ? `[${host}]` : host
}

function port(value: string, name: string): number {
  const number = Number(value)
  if (!/^[0-9]+$/.test(value.trim()) || !Number.isInteger(number) || number < 1 || number > 65535) {
    throw new SettingsError(`${name} must be a port from 1 to 65535, got "${value}".`)
  }
  return number
}

/**
 * Settings from the command line, then the environment, then the defaults. Validated by the API's
 * own configuration loader, so a value the API would refuse is refused before anything starts. A
 * relative database path is resolved against the folder the command was run from.
 */
export function resolveSettings(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Settings {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      'api-port': { type: 'string' },
      'web-port': { type: 'string' },
      host: { type: 'string' },
      database: { type: 'string' },
    },
  })
  const host = values.host ?? env['HOST'] ?? 'localhost'
  const apiPort = port(values['api-port'] ?? env['PORT'] ?? '5299', values['api-port'] === undefined ? 'PORT' : '--api-port')
  const webPort = port(values['web-port'] ?? env['WEB_PORT'] ?? String(DEFAULT_WEB_PORT), values['web-port'] === undefined ? 'WEB_PORT' : '--web-port')
  if (apiPort === webPort) throw new SettingsError(`The API and the frontend need different ports; both are ${String(apiPort)}.`)
  const database = values.database ?? env['DATABASE_PATH']
  // :memory: is left as written, for the configuration loader to refuse.
  const databasePath = database === undefined || database.trim() === '' ? DEFAULT_DATABASE_PATH
    : database === ':memory:' ? database : resolve(cwd, database)

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig({ ...env, HOST: host, PORT: String(apiPort), DATABASE_PATH: databasePath })
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error))
  }
  const apiUrl = `http://${urlHost(host)}:${String(apiPort)}`
  return {
    host, apiPort, webPort, databasePath: config.databasePath, docsEnabled: config.docsEnabled,
    apiUrl, webUrl: `http://${urlHost(host)}:${String(webPort)}`, apiTarget: apiUrl,
  }
}

/** The environment without the API's address settings, which the launches set explicitly. */
function inherited(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !API_SETTINGS.includes(name.toUpperCase())))
}

async function answersAsApi(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}${READINESS_QUERY}`, { signal: AbortSignal.timeout(3_000) })
    // A deliberately invalid sort, which this API refuses without reading the database.
    return response.status === 400 && (await response.text()).includes('urn:trade-blotter:problem:invalid-query')
  } catch {
    return false
  }
}

async function answersAsFrontend(base: string): Promise<boolean> {
  try {
    const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(3_000) })
    if (page.status !== 200 || !(await page.text()).includes('<title>Trade Blotter</title>')) return false
    // Through the frontend's proxy, so the frontend is known to reach this API.
    return await answersAsApi(base)
  } catch {
    return false
  }
}

/** The vite command line script, found the way Node finds the client's own dependency. */
function viteBin(): string {
  const require = createRequire(join(CLIENT_ROOT, 'package.json'))
  const manifestPath = require.resolve('vite/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['vite']
  if (bin === undefined) throw new Error('The vite package has no command line script.')
  return join(dirname(manifestPath), bin)
}

export function launches(settings: Settings, env: NodeJS.ProcessEnv): AppLaunch[] {
  return [
    {
      name: 'api', label: 'API', args: API_ARGS, cwd: SERVER_ROOT,
      env: { ...inherited(env), HOST: settings.host, PORT: String(settings.apiPort), DATABASE_PATH: settings.databasePath },
      host: settings.host, port: settings.apiPort, url: settings.apiUrl,
      ready: () => answersAsApi(settings.apiUrl),
    },
    {
      name: 'web', label: 'Frontend',
      args: [viteBin(), 'preview', '--port', String(settings.webPort), '--strictPort', '--host', settings.host],
      cwd: CLIENT_ROOT, env: { ...inherited(env), API_TARGET: settings.apiTarget },
      host: settings.host, port: settings.webPort, url: settings.webUrl, details: { 'forwards API requests to': settings.apiTarget },
      ready: () => answersAsFrontend(settings.webUrl),
    },
  ]
}

function describeDatabase(path: string): string {
  return isDevelopmentDatabase(path) ? `${path} (the default development database)` : path
}

const STATUS_WORDS: Record<ProcessStatus, string> = {
  running: 'running',
  stopped: 'stopped',
  reused: 'stopped (its process id now belongs to another program)',
  unverified: 'unknown (a process has its id, but its command line could not be read)',
}

const STOP_WORDS: Record<StopOutcome, string> = {
  stopped: 'stopped',
  terminated: process.platform === 'win32' ? 'stopped (terminated: Windows has no stop request for background processes)' : 'stopped (forced after the timeout)',
  'already-stopped': 'was not running',
  'pid-reused': 'was not running; its process id now belongs to another program, which was left alone',
  unverified: 'NOT stopped: its process id is in use but could not be checked; the record is kept',
  'still-running': 'NOT stopped: it was still running after the timeout; the record is kept',
}

async function start(argv: readonly string[]): Promise<number> {
  const settings = resolveSettings(argv, process.env, process.env['INIT_CWD'] ?? process.cwd())
  const missing = [join(SERVER_ROOT, 'dist', 'main.js'), join(CLIENT_ROOT, 'dist', 'index.html')].filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error(`Build the applications first (npm run build); missing:\n  ${missing.join('\n  ')}`)
    return 1
  }
  const runDir = defaultRunDir()
  const links = settings.docsEnabled ? { Swagger: `${settings.apiUrl}/documentation` } : undefined
  const result = await startApps({
    runDir, databasePath: settings.databasePath, launches: launches(settings, process.env), ...(links ? { links } : {}),
    onLaunch: (launch) => { console.log(`Starting the ${launch.label} on port ${String(launch.port)}...`) },
    portHint: (launch) => `Choose another with ${launch.name === 'api' ? '--api-port' : '--web-port'}, or stop the program using it.`,
  })
  if (result.kind === 'already-running') {
    const { state } = result
    const same = state.databasePath === settings.databasePath &&
      state.apps.map((app) => app.port).join() === [settings.apiPort, settings.webPort].join()
    const complete = result.statuses.every((status) => status === 'running')
    console.log(!complete ? 'Only partly running (see below); nothing was started. Run npm run app:stop, then npm run app:start.'
      : same ? 'Already running; nothing was started.'
        : 'Already running with other settings; nothing was started. Stop it first: npm run app:stop')
    printStatus(state, result.statuses)
    return complete && same ? 0 : 1
  }
  if (result.removedStale) console.log('(Removed the record of an earlier run whose processes had already exited.)')
  console.log('Ready.')
  printStatus(result.state, result.state.apps.map(() => 'running'))
  console.log('Stop with: npm run app:stop')
  return 0
}

function printStatus(state: NonNullable<ReturnType<typeof appStatus>['state']>, statuses: readonly ProcessStatus[]): void {
  for (const [index, app] of state.apps.entries()) {
    const status = statuses[index] ?? 'stopped'
    console.log(`  ${app.label.padEnd(9)} ${STATUS_WORDS[status]}, process ${String(app.pid)}, ${app.url}`)
    for (const [what, value] of Object.entries(app.details ?? {})) console.log(`  ${''.padEnd(9)} ${what} ${value}`)
  }
  for (const [label, url] of Object.entries(state.links ?? {})) console.log(`  ${label.padEnd(9)} ${url}`)
  console.log(`  ${'Database'.padEnd(9)} ${describeDatabase(state.databasePath)}`)
  console.log(`  ${'Logs'.padEnd(9)} ${state.apps.map((app) => app.log).join(', ')}`)
}

async function stop(): Promise<number> {
  const result = await stopApps(defaultRunDir())
  if (result.kind === 'nothing-to-stop') {
    console.log('Nothing to stop: no application started by app:start is recorded.')
    return 0
  }
  for (const { record, outcome, portReleased } of result.reports) {
    const port = portReleased ? `port ${String(record.port)} released` : `port ${String(record.port)} still answers (not by this application)`
    const ours = outcome === 'stopped' || outcome === 'terminated' || outcome === 'already-stopped'
    console.log(`  ${record.label.padEnd(9)} process ${String(record.pid)} ${STOP_WORDS[outcome]}${ours ? `; ${port}` : ''}`)
  }
  console.log(result.recordRemoved ? 'Stopped. The database was not changed.' : 'Some processes could not be stopped; see above.')
  return result.recordRemoved ? 0 : 1
}

async function status(argv: readonly string[]): Promise<number> {
  const { state, statuses } = appStatus(defaultRunDir())
  if (state === undefined) {
    const settings = resolveSettings(argv, process.env, process.env['INIT_CWD'] ?? process.cwd())
    console.log('API       stopped\nFrontend  stopped\n(Not started with npm run app:start.)')
    for (const [label, port] of [['API', settings.apiPort], ['Frontend', settings.webPort]] as const) {
      if (await portAnswers(port, settings.host)) console.log(`Note: port ${String(port)} (${label}) is in use by a program not started by app:start.`)
    }
    return 0
  }
  if (state.phase === 'starting') console.log('(app:start has not finished, or did not finish cleanly.)')
  printStatus(state, statuses)
  return 0
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'start') return await start(rest)
    if (command === 'stop') return await stop()
    if (command === 'status') return await status(rest)
    console.error('Usage: node scripts/app.ts start|stop|status [--api-port <n>] [--web-port <n>] [--host <name>] [--database <path>]')
    return 2
  } catch (error) {
    if (error instanceof StartError || error instanceof SettingsError) {
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
