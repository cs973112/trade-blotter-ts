import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { DEFAULT_DATABASE_PATH } from '../src/config.ts'

/**
 * A small process manager for running the API and the frontend in the background: one
 * implementation for Windows, Linux and macOS, on Node.js built-ins only.
 *
 * Every process it starts carries a random token in its command line (Node's --title option), and
 * the run state records each process id with its token. A process counts as one of ours only if
 * the id is alive and its command line still holds the token, so a stale record, or an id the
 * operating system has since given to another program, is never stopped. Nothing is ever stopped
 * because of the port it uses.
 *
 * The run state also names the database the API was started on, so tools that change trade
 * records can refuse a database that is in use (refuseIfDatabaseInUse).
 */

export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Run state and logs: `.run/` in the repository (ignored by Git), or TRADE_BLOTTER_RUN_DIR. */
export function defaultRunDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TRADE_BLOTTER_RUN_DIR']
  return configured === undefined || configured.trim() === '' ? join(REPOSITORY_ROOT, '.run') : resolve(configured)
}

/** How to launch one application and tell that it is ready. */
export interface AppLaunch {
  /** Short name used in file names: "api", "web". */
  readonly name: string
  /** Shown to the user: "API", "Frontend". */
  readonly label: string
  /** Arguments for node: its options, the script, and the script's arguments. */
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly host: string
  readonly port: number
  readonly url: string
  /** Extra facts for status reports, such as where the frontend forwards API requests. */
  readonly details?: Readonly<Record<string, string>>
  /** True once the application answers as itself; never throws. */
  readonly ready: () => Promise<boolean>
}

export interface AppRecord {
  readonly name: string
  readonly label: string
  readonly pid: number
  /** Part of the process's command line; proves a live process id is still this application. */
  readonly token: string
  readonly host: string
  readonly port: number
  readonly url: string
  readonly log: string
  readonly details?: Readonly<Record<string, string>>
}

export interface AppState {
  readonly version: 1
  readonly startedAt: string
  /** "starting" until every application has answered. */
  readonly phase: 'starting' | 'ready'
  /** Absolute path of the SQLite database the API uses. */
  readonly databasePath: string
  readonly links?: Readonly<Record<string, string>>
  readonly apps: readonly AppRecord[]
}

/**
 * - running: the process is alive and holds the token.
 * - stopped: no process has the id.
 * - reused: a process has the id but is not ours (no token); it is never stopped.
 * - unverified: a process has the id, but its command line could not be read.
 */
export type ProcessStatus = 'running' | 'stopped' | 'reused' | 'unverified'

const STATE_FILE = 'app.json'
const LOCK_FILE = 'start.lock'
const LOCK_STALE_MS = 5 * 60_000

export function statePath(runDir: string): string {
  return join(runDir, STATE_FILE)
}

/** The run state, or undefined when nothing was started. Throws for a file that cannot be read as one. */
export function readState(runDir: string): AppState | undefined {
  const path = statePath(runDir)
  if (!existsSync(path)) return undefined
  let state: unknown
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    state = undefined
  }
  if (!isState(state)) {
    throw new Error(`The run state ${path} is not readable. If no application started by app:start is running, delete the file.`)
  }
  return state
}

function isState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as { version?: unknown; databasePath?: unknown; apps?: unknown }
  return state.version === 1 && typeof state.databasePath === 'string' && Array.isArray(state.apps) &&
    state.apps.every((app: unknown) => {
      const { pid, token } = (typeof app === 'object' && app !== null ? app : {}) as { pid?: unknown; token?: unknown }
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof token === 'string' && token.length >= 16
    })
}

/** Writes the run state atomically: a reader sees the old file or the new one, never half of one. */
export function writeState(runDir: string, state: AppState): void {
  mkdirSync(runDir, { recursive: true })
  const temporary = join(runDir, `${STATE_FILE}.${String(process.pid)}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temporary, statePath(runDir))
}

function removeState(runDir: string): void {
  rmSync(statePath(runDir), { force: true })
}

/** True while some process has this id. Signal 0 only checks; it does not affect the process. */
export function isAlive(pid: number): boolean {
  return probeProcess(pid) !== 'exited'
}

/**
 * What signal 0 says about a process id, without affecting the process:
 * - alive: a process has the id, and this process may signal it;
 * - exited: no process has the id (ESRCH);
 * - no-permission: a process has the id but may not be signalled (EPERM). It is not ours to stop:
 *   another user's process, a protected one, or, on Windows, one still being torn down. It never
 *   counts as having exited.
 * Any other error is thrown.
 */
export type ProcessProbe = 'alive' | 'exited' | 'no-permission'

export function probeProcess(pid: number, signal: (pid: number, signal: number) => void = (id, value) => { process.kill(id, value) }): ProcessProbe {
  try {
    signal(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'exited'
    if (code === 'EPERM') return 'no-permission'
    throw error
  }
}

/**
 * The command lines of these processes, by id; a process that does not exist, or whose command
 * line cannot be read, is missing. Linux reads /proc, macOS asks ps, and Windows asks for all the
 * ids in one PowerShell query, because starting PowerShell takes seconds.
 */
export function commandLinesOf(pids: readonly number[]): Map<number, string> {
  const lines = new Map<number, string>()
  const valid = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  if (valid.length === 0) return lines
  if (process.platform === 'win32') {
    const filter = valid.map((pid) => `ProcessId = ${String(pid)}`).join(' OR ')
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    for (const line of result.status === 0 ? result.stdout.split(/\r?\n/) : []) {
      const tab = line.indexOf('\t')
      const commandLine = tab < 0 ? '' : line.slice(tab + 1).trim()
      if (commandLine !== '') lines.set(Number(line.slice(0, tab)), commandLine)
    }
    return lines
  }
  for (const pid of valid) {
    let commandLine: string | undefined
    if (process.platform === 'linux') {
      try {
        commandLine = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
      } catch {
        commandLine = undefined
      }
    } else {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
      commandLine = result.status === 0 ? result.stdout.trim() : undefined
    }
    if (commandLine !== undefined && commandLine !== '') lines.set(pid, commandLine)
  }
  return lines
}

/** A live process as the operating system describes it: its executable's name, and its command line when it can be read. */
export interface ProcessDescription {
  readonly name: string
  readonly commandLine?: string
}

/**
 * The name and command line of these processes, by id; a process that does not exist is missing.
 * Unlike commandLinesOf, a process whose command line cannot be read (another user's, or a
 * protected one) is still listed, with its name: Windows reports the name of every process, and
 * Linux and macOS report it as they do the command line.
 */
export function describeProcesses(pids: readonly number[]): Map<number, ProcessDescription> {
  const descriptions = new Map<number, ProcessDescription>()
  const valid = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  if (valid.length === 0) return descriptions
  const add = (pid: number, name: string, commandLine: string | undefined): void => {
    if (name === '') return
    descriptions.set(pid, commandLine === undefined || commandLine === '' ? { name } : { name, commandLine })
  }
  if (process.platform === 'win32') {
    const filter = valid.map((pid) => `ProcessId = ${String(pid)}`).join(' OR ')
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.Name + [char]9 + $_.CommandLine }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    for (const line of result.status === 0 ? result.stdout.split(/\r?\n/) : []) {
      const [pid = '', name = '', ...rest] = line.split('\t')
      add(Number(pid), name.trim(), rest.join('\t').trim())
    }
    return descriptions
  }
  for (const pid of valid) {
    if (process.platform === 'linux') {
      let name: string
      try {
        name = readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim()
      } catch {
        continue
      }
      let commandLine: string | undefined
      try {
        commandLine = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
      } catch {
        commandLine = undefined
      }
      add(pid, name, commandLine)
    } else {
      const name = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 10_000 })
      const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
      if (name.status === 0) add(pid, name.stdout.trim(), command.status === 0 ? command.stdout.trim() : undefined)
    }
  }
  return descriptions
}

/** The status of each recorded process, in order. */
export function processStatuses(records: readonly Pick<AppRecord, 'pid' | 'token'>[]): ProcessStatus[] {
  const alive = records.map((record) => isAlive(record.pid))
  const lines = alive.includes(true) ? commandLinesOf(records.filter((_, index) => alive[index]).map((record) => record.pid)) : new Map<number, string>()
  return records.map((record, index): ProcessStatus => {
    if (alive[index] !== true) return 'stopped'
    const commandLine = lines.get(record.pid)
    if (commandLine === undefined) return isAlive(record.pid) ? 'unverified' : 'stopped'
    return commandLine.includes(record.token) ? 'running' : 'reused'
  })
}

export function processStatus(record: Pick<AppRecord, 'pid' | 'token'>): ProcessStatus {
  return processStatuses([record])[0] ?? 'stopped'
}

const TCP_PROBE_MS = 750

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const socket = connect({ port, host })
    const finish = (result: boolean): void => {
      socket.destroy()
      resolveAnswer(result)
    }
    socket.setTimeout(TCP_PROBE_MS, () => { finish(false) })
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolveListen) => {
    const server = createServer()
    server.once('error', () => { resolveListen(false) })
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => { resolveListen(true) })
    })
  })
}

/** Whether anything accepts connections on the port, on the host or on either loopback address. */
export async function portAnswers(port: number, host: string): Promise<boolean> {
  const hosts = [...new Set([host, '127.0.0.1', '::1'])]
  const results = await Promise.all(hosts.map((candidate) => answers(port, candidate)))
  return results.includes(true)
}

/** Whether the port is free for an application to listen on the host. */
export async function portFree(port: number, host: string): Promise<boolean> {
  return !(await portAnswers(port, host)) && (await canListen(port, host))
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return true
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

/** The last lines of a log, for diagnostics. */
export function logTail(path: string, lines = 30): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(no log was written)'
  }
}

/** Refuses a second app:start while one is in progress; a lock left by a crashed one expires. */
function acquireStartLock(runDir: string): () => void {
  mkdirSync(runDir, { recursive: true })
  const path = join(runDir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(path, 'wx')
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(descriptor)
      return () => { rmSync(path, { force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: { pid?: unknown; at?: unknown } = {}
      try {
        holder = JSON.parse(readFileSync(path, 'utf8')) as typeof holder
      } catch {
        // An unreadable lock is treated as stale.
      }
      const fresh = typeof holder.at === 'number' && Date.now() - holder.at < LOCK_STALE_MS
      if (fresh && typeof holder.pid === 'number' && isAlive(holder.pid)) {
        throw new StartError(`Another app:start (process ${String(holder.pid)}) is in progress. Wait for it to finish.`, { cause: error })
      }
      rmSync(path, { force: true })
    }
  }
  throw new Error(`Could not take the start lock ${path}.`)
}

export class StartError extends Error {}

export type StartResult =
  | { readonly kind: 'started'; readonly state: AppState; readonly removedStale: boolean }
  | { readonly kind: 'already-running'; readonly state: AppState; readonly statuses: readonly ProcessStatus[] }

export interface StartOptions {
  readonly runDir: string
  readonly databasePath: string
  readonly launches: readonly AppLaunch[]
  readonly links?: Readonly<Record<string, string>>
  /** How long each application may take to answer. */
  readonly readyTimeoutMs?: number
  /** Explains how to choose another port, for the "port in use" message. */
  readonly portHint?: (launch: AppLaunch) => string
  /** Told as each application is launched. */
  readonly onLaunch?: (launch: AppLaunch) => void
}

/**
 * Starts the applications in order, in the background, each with its output in a log file in the
 * run folder, and waits until each answers. Refuses a port that is in use. If one fails to start,
 * the ones already started are stopped, and the error includes the end of its log. If the
 * applications are already running, starts nothing.
 */
export async function startApps(options: StartOptions): Promise<StartResult> {
  const release = acquireStartLock(options.runDir)
  try {
    const existing = readState(options.runDir)
    let removedStale = false
    if (existing !== undefined) {
      const statuses = processStatuses(existing.apps)
      if (statuses.some((status) => status === 'running' || status === 'unverified')) return { kind: 'already-running', state: existing, statuses }
      removeState(options.runDir)
      removedStale = true
    }

    for (const launch of options.launches) {
      if (!(await portFree(launch.port, launch.host))) {
        throw new StartError(`Port ${String(launch.port)} for the ${launch.label} is already in use by another process. ` +
          `Nothing was started.${options.portHint === undefined ? '' : ` ${options.portHint(launch)}`}`)
      }
    }

    const apps: AppRecord[] = []
    const base = { version: 1, startedAt: new Date().toISOString(), databasePath: options.databasePath, ...(options.links ? { links: options.links } : {}) } as const
    for (const launch of options.launches) {
      options.onLaunch?.(launch)
      const token = randomUUID()
      const log = join(options.runDir, `${launch.name}.log`)
      const output = openSync(log, 'w')
      let child: ChildProcess
      try {
        child = spawn(process.execPath, [`--title=trade-blotter-${launch.name}-${token}`, ...launch.args], {
          cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', output, output], windowsHide: true,
        })
      } finally {
        closeSync(output)
      }
      const exit = new Promise<string>((resolveExit) => {
        child.once('exit', (code, signal) => { resolveExit(signal === null ? `exited with code ${String(code)}` : `was stopped by ${signal}`) })
        child.once('error', (error) => { resolveExit(`could not be started: ${error.message}`) })
      })
      if (child.pid === undefined) {
        await stopRecords(apps)
        throw new StartError(`The ${launch.label} ${await exit}.`)
      }
      child.unref()
      apps.push({ name: launch.name, label: launch.label, pid: child.pid, token, host: launch.host, port: launch.port, url: launch.url, log,
        ...(launch.details ? { details: launch.details } : {}) })
      writeState(options.runDir, { ...base, phase: 'starting', apps })

      let exited: string | undefined
      void exit.then((reason) => { exited = reason })
      const ready = await waitUntil(async () => exited !== undefined || (await launch.ready()), options.readyTimeoutMs ?? 60_000, 250)
      if (!ready || exited !== undefined) {
        // Read before stopping, which ends this process too and would otherwise give its own exit as the reason.
        const reason = exited ?? `did not answer at ${launch.url} within ${String(Math.round((options.readyTimeoutMs ?? 60_000) / 1000))} seconds`
        await stopRecords(apps)
        removeState(options.runDir)
        throw new StartError(`The ${launch.label} ${reason}. Nothing is left running.\nLast lines of ${log}:\n${logTail(log)}`)
      }
    }
    const state: AppState = { ...base, phase: 'ready', apps }
    writeState(options.runDir, state)
    return { kind: 'started', state, removedStale }
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------------------------
// Confirmed termination

export interface OwnedPort {
  readonly port: number
  readonly host: string
}

/** The handle of a child this process started. It names that process only, never a later one given the same id. */
export interface ChildHandle {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
}

/**
 * A process this program started and may stop, with what proves it is still that process: the
 * handle of its own child, or the token in its command line (app:start's --title). A bare id is
 * never enough: once the process has gone, the operating system may give the id to any program.
 */
export interface OwnedProcess {
  readonly label: string
  readonly pid: number
  readonly token?: string
  readonly handle?: ChildHandle
  /** Ports it listened on, which must be free once it has gone. */
  readonly ports?: readonly OwnedPort[]
}

/** What the termination steps ask of the operating system; tests pass a stand-in. */
export interface TerminationSystem {
  readonly probe: (pid: number) => ProcessProbe
  /** SIGKILL by id. Throws as process.kill does (ESRCH, EPERM). Called only for a process just identified as ours. */
  readonly kill: (pid: number) => void
  readonly describe: (pids: readonly number[]) => Map<number, ProcessDescription>
  readonly portAnswers: (port: number, host: string) => Promise<boolean>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  /** The Node.js executable's file name: a process of another program cannot be one of ours. */
  readonly nodeName: string
}

export const systemTermination: TerminationSystem = {
  probe: (pid) => probeProcess(pid),
  kill: (pid) => { process.kill(pid, 'SIGKILL') },
  describe: describeProcesses,
  portAnswers,
  now: () => Date.now(),
  sleep: (ms) => sleep(ms),
  nodeName: basename(process.execPath),
}

/**
 * - already-exited: gone before anything was sent;
 * - pid-reused: gone; its id now belongs to another program, which was not touched;
 * - terminated: SIGKILL was accepted, and the process was then confirmed gone;
 * - exited-during-cleanup: SIGKILL found it already exiting (ESRCH, or EPERM while it was being
 *   torn down), and it was then confirmed gone;
 * - still-alive: SIGKILL was accepted, but it was still running at the deadline;
 * - cannot-terminate: SIGKILL was refused (EPERM or another error) and it was still running at the deadline;
 * - unidentified: a process holds the id but could not be identified as ours, so it was never
 *   signalled, and it had not gone by the deadline;
 * - port-in-use: gone, but a port it listened on still answered at the deadline.
 */
export type TerminationOutcome =
  | 'already-exited' | 'pid-reused' | 'terminated' | 'exited-during-cleanup'
  | 'still-alive' | 'cannot-terminate' | 'unidentified' | 'port-in-use'

export interface TerminationReport {
  readonly label: string
  readonly pid: number
  readonly outcome: TerminationOutcome
  /** Confirmed gone, and every port it listened on released. */
  readonly ok: boolean
  readonly elapsedMs: number
  /** What was checked and sent, in order, with the time since the start: the diagnostics. */
  readonly events: readonly string[]
}

type Identity =
  | { readonly kind: 'gone'; readonly reused: boolean; readonly reason: string }
  | { readonly kind: 'ours'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }

const executable = (name: string): string => name.toLowerCase().replace(/\.exe$/, '')

/**
 * Whether the process is still ours. A handle answers by itself. Otherwise signal 0 says whether
 * the id is taken, and, when it is (alive or EPERM), the command line says whose it is: with the
 * token it is ours; without, the id was reused. When the command line cannot be read, a program
 * other than Node.js cannot be ours; a Node.js process stays unknown, never assumed to have gone.
 */
function identify(target: OwnedProcess, system: TerminationSystem, describe: boolean): Identity {
  if (target.handle !== undefined) {
    const { exitCode, signalCode } = target.handle
    return exitCode !== null || signalCode !== null
      ? { kind: 'gone', reused: false, reason: `its handle reports it exited (${signalCode === null ? `code ${String(exitCode)}` : signalCode})` }
      : { kind: 'ours', reason: 'its handle reports it running' }
  }
  const probe = system.probe(target.pid)
  if (probe === 'exited') return { kind: 'gone', reused: false, reason: 'no process has its id (ESRCH)' }
  const held = probe === 'alive' ? 'a process has its id' : 'a process has its id but may not be signalled (EPERM)'
  if (target.token === undefined) return { kind: 'unknown', reason: `${held}; no token or handle identifies it` }
  if (!describe) return { kind: 'unknown', reason: held }
  const description = system.describe([target.pid]).get(target.pid)
  if (description === undefined) {
    return system.probe(target.pid) === 'exited'
      ? { kind: 'gone', reused: false, reason: 'no process has its id (ESRCH)' }
      : { kind: 'unknown', reason: `${held}, but the operating system does not list it` }
  }
  if (description.commandLine !== undefined) {
    return description.commandLine.includes(target.token)
      ? { kind: 'ours', reason: `${held}, and its command line holds the token` }
      : { kind: 'gone', reused: true, reason: `${held}, but its command line has no token: the id now belongs to ${description.name}` }
  }
  if (executable(description.name) !== executable(system.nodeName)) {
    return { kind: 'gone', reused: true, reason: `${held}: ${description.name}, another program, so the id was reused` }
  }
  return { kind: 'unknown', reason: `${held}: a ${description.name} process whose command line cannot be read, so it cannot be identified` }
}

/** How often the command line is read while waiting: on Windows each reading starts PowerShell. */
const IDENTIFY_EVERY_MS = 1_000

/**
 * Waits until the process is confirmed gone (by its handle, ESRCH, or its id now held by another
 * program), or the deadline passes. Returns the last identity seen. EPERM alone never confirms it.
 */
async function waitForExit(target: OwnedProcess, deadline: number, system: TerminationSystem, intervalMs: number, note: (text: string) => void): Promise<Identity> {
  let lastDescribed = -Infinity
  let last: Identity | undefined
  for (;;) {
    const describe = system.now() - lastDescribed >= IDENTIFY_EVERY_MS || system.now() >= deadline
    if (describe) lastDescribed = system.now()
    const identity = identify(target, system, describe)
    if (identity.kind === 'gone' || system.now() >= deadline) {
      note(identity.reason)
      return identity.kind === 'unknown' && last?.kind === 'ours' ? last : identity
    }
    if (describe || identity.kind !== 'unknown') last = identity
    await system.sleep(intervalMs)
  }
}

/**
 * Stops one process this program owns and confirms it has gone and released its ports, within a
 * bounded time. It is identified first, and signalled only while it is ours; an unrelated process
 * is never signalled. ESRCH and EPERM from SIGKILL are recorded, never taken as proof that it has
 * gone: that comes from its handle, ESRCH from signal 0, or its id now belonging to another program.
 */
export async function terminateOwned(
  target: OwnedProcess,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
  system: TerminationSystem = systemTermination,
): Promise<TerminationReport> {
  const started = system.now()
  const deadline = started + (options.timeoutMs ?? 10_000)
  const intervalMs = options.intervalMs ?? 100
  const events: string[] = []
  const note = (text: string): void => { events.push(`+${String(system.now() - started)} ms: ${text}`) }
  const report = (outcome: TerminationOutcome, ok: boolean): TerminationReport =>
    ({ label: target.label, pid: target.pid, outcome, ok, elapsedMs: system.now() - started, events })

  const released = async (outcome: TerminationOutcome): Promise<TerminationReport> => {
    for (const { port, host } of target.ports ?? []) {
      for (;;) {
        if (!(await system.portAnswers(port, host))) {
          note(`port ${String(port)} released`)
          break
        }
        if (system.now() >= deadline) {
          note(`port ${String(port)} still answers on ${host}`)
          return report('port-in-use', false)
        }
        await system.sleep(intervalMs)
      }
    }
    return report(outcome, true)
  }

  const first = identify(target, system, true)
  note(first.reason)
  if (first.kind === 'gone') return released(first.reused ? 'pid-reused' : 'already-exited')
  if (first.kind === 'unknown') {
    // Never signalled: it may be ours still being torn down, or another program; only its going is accepted.
    const after = await waitForExit(target, deadline, system, intervalMs, note)
    if (after.kind !== 'gone') return report('unidentified', false)
    return released(after.reused ? 'pid-reused' : 'already-exited')
  }

  let refused: string | undefined
  let exiting = false
  try {
    if (target.handle === undefined) system.kill(target.pid)
    else if (!target.handle.kill('SIGKILL')) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    note('SIGKILL sent')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      exiting = true
      note('SIGKILL: ESRCH, it was already exiting; waiting for confirmation')
    } else {
      refused = code ?? (error instanceof Error ? error.message : String(error))
      note(`SIGKILL refused: ${refused}${code === 'EPERM' ? ' (still being torn down, or not ours to stop); waiting for confirmation' : ''}`)
    }
  }

  const after = await waitForExit(target, deadline, system, intervalMs, note)
  if (after.kind === 'gone') return released(refused !== undefined || exiting ? 'exited-during-cleanup' : 'terminated')
  if (after.kind === 'unknown') return report('unidentified', false)
  return report(refused === undefined ? 'still-alive' : 'cannot-terminate', false)
}

/** One report as diagnostics: the process, the outcome and everything that was seen. */
export function formatTermination(report: TerminationReport): string {
  return [`${report.label} (process ${String(report.pid)}): ${report.outcome} after ${String(report.elapsedMs)} ms`,
    ...report.events.map((event) => `  ${event}`)].join('\n')
}

export class TerminationError extends Error {
  readonly reports: readonly TerminationReport[]

  constructor(reports: readonly TerminationReport[]) {
    const failed = reports.filter((report) => !report.ok)
    super(`${String(failed.length)} owned process(es) not confirmed stopped:\n${failed.map(formatTermination).join('\n')}`)
    this.name = 'TerminationError'
    this.reports = reports
  }
}

/**
 * Stops each owned process (terminateOwned), one at a time, and throws TerminationError, with
 * every report, unless all were confirmed gone with their ports released.
 */
export async function ensureTerminated(
  targets: readonly OwnedProcess[],
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
  system: TerminationSystem = systemTermination,
): Promise<TerminationReport[]> {
  const reports: TerminationReport[] = []
  for (const target of targets) reports.push(await terminateOwned(target, options, system))
  if (reports.some((report) => !report.ok)) throw new TerminationError(reports)
  return reports
}

export type StopOutcome = 'stopped' | 'terminated' | 'already-stopped' | 'pid-reused' | 'unverified' | 'still-running'

export interface StopReport {
  readonly record: AppRecord
  readonly outcome: StopOutcome
  readonly portReleased: boolean
}

/**
 * Stops one process and its children, given its status checked just before (processStatuses).
 * Linux and macOS: SIGTERM to its process group (each application is started as a group leader),
 * so it can shut down cleanly, then SIGKILL after the timeout. Windows has no stop request a
 * background process without a console can receive, so the process tree is terminated
 * (taskkill /T /F); SQLite keeps every committed transaction across that.
 */
async function stopRecord(record: AppRecord, status: ProcessStatus, timeoutMs: number): Promise<StopOutcome> {
  if (status === 'stopped') return 'already-stopped'
  if (status === 'reused') return 'pid-reused'
  if (status === 'unverified') return 'unverified'

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 })
    // Gone only when confirmed: ESRCH, or the id now held by another program. EPERM alone is not proof.
    const after = await waitForExit({ label: record.label, pid: record.pid, token: record.token }, Date.now() + timeoutMs, systemTermination, 200, () => undefined)
    return after.kind === 'gone' ? 'terminated' : after.kind === 'unknown' ? 'unverified' : 'still-running'
  }
  // ESRCH: no process is left in the group. EPERM means one is, so it does not count as gone.
  const groupAlive = (): boolean => probeProcess(-record.pid) !== 'exited'
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-record.pid, name)
    } catch {
      // The group has already gone.
    }
  }
  signal('SIGTERM')
  if (await waitUntil(() => !groupAlive(), timeoutMs)) return 'stopped'
  signal('SIGKILL')
  return (await waitUntil(() => !groupAlive(), 5_000)) ? 'terminated' : 'still-running'
}

async function stopRecords(records: readonly AppRecord[], timeoutMs = 10_000): Promise<StopReport[]> {
  const reports: StopReport[] = []
  // The reverse of start order: the frontend before the API it forwards to.
  // Checked together, just before stopping: on Windows each check starts PowerShell.
  const statuses = processStatuses(records)
  for (const [index, record] of [...records.entries()].reverse()) {
    const outcome = await stopRecord(record, statuses[index] ?? 'stopped', timeoutMs)
    const ours = outcome === 'stopped' || outcome === 'terminated' || outcome === 'already-stopped'
    const portReleased = ours ? await waitUntil(async () => !(await portAnswers(record.port, record.host)), timeoutMs, 250) : false
    reports.push({ record, outcome, portReleased })
  }
  return reports.reverse()
}

export type StopResult =
  | { readonly kind: 'nothing-to-stop' }
  | { readonly kind: 'stopped'; readonly reports: readonly StopReport[]; readonly recordRemoved: boolean }

/**
 * Stops every application in the run state. Running twice is safe: the second finds nothing to
 * stop. The record is removed once nothing it names is still ours and running; a process whose id
 * could not be checked keeps the record, so the next stop can try again.
 */
export async function stopApps(runDir: string, timeoutMs = 10_000): Promise<StopResult> {
  const state = readState(runDir)
  if (state === undefined) return { kind: 'nothing-to-stop' }
  const reports = await stopRecords(state.apps, timeoutMs)
  const recordRemoved = reports.every((report) => report.outcome !== 'unverified' && report.outcome !== 'still-running')
  if (recordRemoved) removeState(runDir)
  return { kind: 'stopped', reports, recordRemoved }
}

export interface StatusResult {
  readonly state: AppState | undefined
  readonly statuses: readonly ProcessStatus[]
}

export function appStatus(runDir: string): StatusResult {
  const state = readState(runDir)
  return { state, statuses: state === undefined ? [] : processStatuses(state.apps) }
}

/**
 * One spelling for one file, for comparing paths (never for opening or showing them): absolute,
 * links resolved where the file exists, and case-folded on Windows, whose file names (drive letter
 * included) ignore case. Elsewhere paths stay case-sensitive. One argument only, so it can be
 * passed to map.
 */
export function canonicalPath(path: string): string {
  return canonicalPathOn(path, process.platform)
}

/** canonicalPath with the case rule of the platform given, so tests can apply either rule anywhere. */
export function canonicalPathOn(path: string, platform: NodeJS.Platform): string {
  const absolute = resolve(path)
  let real = absolute
  try {
    real = realpathSync.native(absolute)
  } catch {
    // The file does not exist (yet); compare the path as written.
  }
  return platform === 'win32' ? real.toLowerCase() : real
}

/** Whether a path is the application's default database, `server/data/trade-blotter.db`. */
export function isDevelopmentDatabase(path: string): boolean {
  return canonicalPath(path) === canonicalPath(DEFAULT_DATABASE_PATH)
}

/**
 * The run state of applications started by app:start that use this database and may still be
 * running, or undefined when none does. A stale record (no process of ours alive) does not count.
 */
export function appUsingDatabase(databasePath: string, runDir: string = defaultRunDir()): AppState | undefined {
  const state = readState(runDir)
  if (state === undefined || canonicalPath(state.databasePath) !== canonicalPath(databasePath)) return undefined
  return processStatuses(state.apps).some((status) => status === 'running' || status === 'unverified') ? state : undefined
}

export class DatabaseInUseError extends Error {}

/**
 * For any tool that changes trade records (clearing, seeding): throws DatabaseInUseError while an
 * application started by app:start is using the database. Call it before opening the database.
 */
export function refuseIfDatabaseInUse(databasePath: string, runDir: string = defaultRunDir()): void {
  const state = appUsingDatabase(databasePath, runDir)
  if (state === undefined) return
  const pids = state.apps.map((app) => `${app.label} ${String(app.pid)}`).join(', ')
  throw new DatabaseInUseError(`The database ${state.databasePath} is in use by the application started with app:start (${pids}). ` +
    'Stop it first with: npm run app:stop')
}
