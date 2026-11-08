import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { launches, resolveSettings } from './app.ts'
import {
  canonicalPath, processStatuses, readState, startApps, stopApps, type AppState, type ProcessStatus, type StopReport,
} from './lifecycle.ts'
import { listenersOnPort, type Listeners } from './process-probe.ts'
import type { ReviewContext, ReviewPair } from './review-context.ts'

/**
 * Starting, recognising and stopping the reviewer's applications. Each pair keeps its own run
 * state (lifecycle.ts), which records every process with a random token in its command line. A
 * pair counts as the reviewer's only when every check below holds; anything else is reported and
 * left alone. Nothing is ever stopped because of the port it uses or the id it has alone.
 */

// ---------------------------------------------------------------------------------------------
// Commands with a log

/** Runs a command, its whole output going to a log file; resolves with its exit code. */
export function runLogged(command: string, args: readonly string[], cwd: string, log: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  mkdirSync(dirname(log), { recursive: true })
  return new Promise((resolveRun) => {
    const out = createWriteStream(log)
    out.once('open', () => {
      // npm is npm.cmd on Windows, which Node starts only through a shell; the arguments are fixed words.
      const child = spawn(command, [...args], { cwd, env, shell: process.platform === 'win32', stdio: ['ignore', out, out], windowsHide: true })
      child.once('error', (error) => { out.end(`\n${error.message}\n`, () => { resolveRun(127) }) })
      child.once('close', (code) => { out.end(() => { resolveRun(code ?? 1) }) })
    })
  })
}

/** Terminal colour codes (ESC [ ... m), which tools write even into a log. */
const COLOUR_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** The last lines of a file. */
export function tail(path: string, lines = 40): string {
  try {
    return readFileSync(path, 'utf8').replace(COLOUR_CODES, '').trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(no output was written)'
  }
}

// ---------------------------------------------------------------------------------------------
// Builds

/** The newest modification time of the files under these paths (folders searched, dist and node_modules skipped). */
function newest(paths: readonly string[]): number {
  let latest = 0
  const visit = (path: string): void => {
    if (!existsSync(path)) return
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) if (entry !== 'node_modules' && entry !== 'dist') visit(join(path, entry))
    } else {
      latest = Math.max(latest, stat.mtimeMs)
    }
  }
  for (const path of paths) visit(path)
  return latest
}

export interface BuildState {
  readonly name: 'API' | 'Frontend'
  readonly output: string
  readonly state: 'missing' | 'stale' | 'current'
}

/** Whether each build output exists and is newer than every file it is built from. */
export function buildStates(context: ReviewContext): BuildState[] {
  const server = join(context.repositoryRoot, 'server')
  const client = join(context.repositoryRoot, 'client')
  const targets = [
    { name: 'API', output: join(server, 'dist', 'main.js'),
      inputs: [join(server, 'src'), join(server, 'tsconfig.json'), join(server, 'tsconfig.build.json'), join(server, 'package.json'), join(context.repositoryRoot, 'tsconfig.base.json')] },
    { name: 'Frontend', output: join(client, 'dist', 'index.html'),
      inputs: [join(client, 'src'), join(client, 'public'), join(client, 'index.html'), join(client, 'vite.config.ts'), join(client, 'tsconfig.json'), join(client, 'package.json')] },
  ] as const
  return targets.map(({ name, output, inputs }) => ({
    name, output,
    state: !existsSync(output) ? 'missing' : statSync(output).mtimeMs < newest(inputs) ? 'stale' : 'current',
  }))
}

// ---------------------------------------------------------------------------------------------
// Recognising a pair

export type Ownership =
  | { readonly kind: 'not-started' }
  /** The run record cannot be read: nothing can be verified, so nothing is touched. */
  | { readonly kind: 'unreadable'; readonly problems: readonly string[] }
  /** Every recorded process has exited: only the stale record is left. */
  | { readonly kind: 'stopped'; readonly state: AppState }
  /** Every check holds for every recorded process that is still running. */
  | { readonly kind: 'running'; readonly state: AppState; readonly statuses: readonly ProcessStatus[]; readonly complete: boolean }
  /** Something does not hold: never adopted, never stopped. */
  | { readonly kind: 'not-ours'; readonly state: AppState; readonly problems: readonly string[] }

/** What a pair's applications must answer to be recognised; replaced in tests by a stand-in's checks. */
export type IdentityCheck = (pair: ReviewPair, state: AppState) => Promise<readonly string[]>

export interface OwnershipOptions {
  readonly identity?: IdentityCheck
  readonly listeners?: (port: number, pid: number) => Listeners
}

const LISTENER_WORDS: Record<Exclude<Listeners, 'only'>, string> = {
  others: 'another process also listens on its port, or it does not',
  none: 'nothing listens on its port',
  unknown: 'which process listens on its port could not be checked',
}

/**
 * Whether the pair's recorded applications are the reviewer's and are running, checking, in turn:
 * the record names the pair's database, applications and ports; each process id is alive and its
 * command line still holds the token it was started with (so a reused id is never taken for it);
 * each running process is the only listener on its port; and the applications answer as this
 * pair's API and frontend (identity).
 */
export async function checkOwnership(pair: ReviewPair, options: OwnershipOptions = {}): Promise<Ownership> {
  let state: AppState | undefined
  try {
    state = readState(pair.runDir)
  } catch (error) {
    return { kind: 'unreadable', problems: [error instanceof Error ? error.message : String(error)] }
  }
  if (state === undefined) return { kind: 'not-started' }

  const problems: string[] = []
  if (canonicalPath(state.databasePath) !== canonicalPath(pair.databasePath)) {
    problems.push(`the record names the database ${state.databasePath}, not ${pair.databasePath}`)
  }
  const expected = [['api', pair.apiPort], ['web', pair.webPort]] as const
  const recorded = state.apps.map((app) => [app.name, app.port] as const)
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
    problems.push(`the record names ${recorded.map(([name, port]) => `${name} on ${String(port)}`).join(', ') || 'no application'}, not api on ${String(pair.apiPort)} and web on ${String(pair.webPort)}`)
  }
  const statuses = processStatuses(state.apps)
  for (const [index, app] of state.apps.entries()) {
    const status = statuses[index]
    if (status === 'reused') problems.push(`${app.label} process ${String(app.pid)} has exited and its id now belongs to another program`)
    if (status === 'unverified') problems.push(`${app.label} process ${String(app.pid)} exists but its command line could not be read, so it cannot be confirmed as ours`)
  }
  if (problems.length > 0) return { kind: 'not-ours', state, problems }
  if (statuses.every((status) => status === 'stopped')) return { kind: 'stopped', state }

  const listeners = options.listeners ?? listenersOnPort
  for (const [index, app] of state.apps.entries()) {
    if (statuses[index] !== 'running') continue
    const found = listeners(app.port, app.pid)
    if (found !== 'only') problems.push(`${app.label} process ${String(app.pid)} is ours, but ${LISTENER_WORDS[found]} (port ${String(app.port)})`)
  }
  const complete = statuses.every((status) => status === 'running')
  if (problems.length === 0 && complete) problems.push(...await (options.identity ?? applicationIdentity)(pair, state))
  return problems.length > 0 ? { kind: 'not-ours', state, problems } : { kind: 'running', state, statuses, complete }
}

async function getText(url: string): Promise<{ status: number; body: string } | string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: await response.text() }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The number of trades in a database, read through a read-only connection. */
export function storedTradeCount(path: string): number {
  const client = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(client.prepare('select count(*) as n from trades').get()?.['n'] ?? -1)
  } finally {
    client.close()
  }
}

/**
 * The real identity checks: the API answers GET /trades/page with as many trades as the pair's
 * database holds; the frontend is the production build, records that it forwards to this API, and
 * through its proxy answers exactly as the API does.
 */
export const applicationIdentity: IdentityCheck = async (pair, state) => {
  const api = state.apps.find((app) => app.name === 'api')
  const web = state.apps.find((app) => app.name === 'web')
  if (api === undefined || web === undefined) return ['the record does not name an API and a frontend']
  const problems: string[] = []
  const direct = await getText(`${api.url}/trades/page?pageSize=1`)
  const total = typeof direct === 'string' || direct.status !== 200 ? undefined : /^\{"items":\[.*\],"page":1,"pageSize":1,"totalCount":(\d+),"totalPages":\d+\}$/s.exec(direct.body)?.[1]
  if (total === undefined) {
    problems.push(`the API at ${api.url} does not answer GET /trades/page as the Trade Blotter API does (${typeof direct === 'string' ? direct : `status ${String(direct.status)}`})`)
  } else {
    let stored: number | undefined
    try {
      stored = storedTradeCount(pair.databasePath)
    } catch (error) {
      problems.push(`${pair.databasePath} cannot be read (${error instanceof Error ? error.message : String(error)})`)
    }
    if (stored !== undefined && Number(total) !== stored) problems.push(`the API at ${api.url} reports ${total} trades, but ${pair.databasePath} holds ${String(stored)}: it is not using this database`)
  }
  const forwards = web.details?.['forwards API requests to']
  if (forwards === undefined || new URL(forwards).port !== String(pair.apiPort)) {
    problems.push(`the frontend is recorded as forwarding to ${forwards ?? 'nothing'}, not to port ${String(pair.apiPort)}`)
  }
  const page = await getText(`${web.url}/`)
  if (typeof page === 'string' || page.status !== 200 || !page.body.includes('<title>Trade Blotter</title>')) {
    problems.push(`${web.url} does not serve the Trade Blotter page`)
  } else if (page.body.includes('/@vite/client')) {
    problems.push(`${web.url} serves the development frontend, not the production build`)
  }
  const proxied = await getText(`${web.url}/trades/page?pageSize=1`)
  if (typeof direct !== 'string' && (typeof proxied === 'string' || proxied.body !== direct.body)) {
    problems.push(`the frontend at ${web.url} does not answer as the API at ${api.url} does: it does not forward to it`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// Starting and stopping

/**
 * Starts the pair's API and frontend with app:start's own launches, on the pair's database, ports
 * and run folder. Starts nothing when the record shows them running (the caller checks they are
 * ours) or when a port is in use (StartError; the process using it is left alone).
 */
export async function startPair(context: ReviewContext, pair: ReviewPair, env: NodeJS.ProcessEnv = process.env) {
  // Every setting is given here, so none from the shell applies; launches() leaves the shell's API settings out.
  const settings = resolveSettings(
    ['--database', pair.databasePath, '--api-port', String(pair.apiPort), '--web-port', String(pair.webPort), '--host', context.host],
    env, context.repositoryRoot,
  )
  return startApps({
    runDir: pair.runDir, databasePath: settings.databasePath, launches: launches(settings, env), readyTimeoutMs: 120_000,
    portHint: () => 'Reviewer ports are fixed; stop the program using it, or run the reviewer workflow when it has finished.',
  })
}

export type StopOutcome =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'already-stopped' }
  | { readonly kind: 'stopped'; readonly reports: readonly StopReport[] }
  /** Nothing was stopped, or not everything: the reasons. */
  | { readonly kind: 'refused'; readonly problems: readonly string[]; readonly reports?: readonly StopReport[] }

/**
 * Stops the pair only after checkOwnership confirms it is the reviewer's; stopApps then checks
 * every token again just before stopping. Already stopped: the stale record is removed. Anything
 * not confirmed is left running, with the record kept.
 */
export async function stopPair(pair: ReviewPair, options: OwnershipOptions = {}): Promise<StopOutcome> {
  const ownership = await checkOwnership(pair, options)
  if (ownership.kind === 'not-started') return { kind: 'not-started' }
  if (ownership.kind === 'unreadable' || ownership.kind === 'not-ours') return { kind: 'refused', problems: ownership.problems }
  const result = await stopApps(pair.runDir)
  if (result.kind === 'nothing-to-stop') return { kind: 'already-stopped' }
  if (ownership.kind === 'stopped') return { kind: 'already-stopped' }
  const problems = result.reports.flatMap((report) => {
    const ours = report.outcome === 'stopped' || report.outcome === 'terminated' || report.outcome === 'already-stopped'
    if (!ours) return [`${report.record.label} process ${String(report.record.pid)}: ${report.outcome}`]
    return report.portReleased ? [] : [`${report.record.label}: port ${String(report.record.port)} still answers`]
  })
  return problems.length === 0 ? { kind: 'stopped', reports: result.reports } : { kind: 'refused', problems, reports: result.reports }
}
