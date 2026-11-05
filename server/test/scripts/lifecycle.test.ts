import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_DATABASE_PATH } from '../../src/config.ts'
import {
  appStatus,
  appUsingDatabase,
  canonicalPath,
  commandLinesOf,
  DatabaseInUseError,
  isAlive,
  isDevelopmentDatabase,
  portAnswers,
  processStatus,
  processStatuses,
  readState,
  refuseIfDatabaseInUse,
  startApps,
  StartError,
  statePath,
  stopApps,
  writeState,
  type AppLaunch,
  type AppState,
} from '../../scripts/lifecycle.ts'
import { isolatedEnv, runNode, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * The background process manager behind app:start, app:stop and app:status, driven with a
 * stand-in application (test/support/fake-app.ts) on ports the operating system picks, with the
 * run state in a temporary folder. The real API and frontend are checked by hand; see README.md.
 */

const FAKE_APP = join(import.meta.dirname, '../support/fake-app.ts')
const TIMEOUT = 90_000

let runDir: string
let started: number[] = []

beforeEach(() => {
  runDir = createTempDir()
  started = []
})

afterEach(async () => {
  // Whatever a failed test left running: stop it through the manager, then any stray child.
  await stopApps(runDir).catch(() => undefined)
  // Only ids this test recorded for processes it started, and only while they are alive.
  for (const pid of started) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
  removeTempDir(runDir)
}, TIMEOUT)

/** A port the operating system says is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0) })
    })
  })
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer().listen(port, '127.0.0.1', () => { resolve(server) })
  })
}

async function fakeLaunch(name: string, mode: 'serve' | 'fail' | 'hang' = 'serve', withChild = false): Promise<AppLaunch> {
  const port = await freePort()
  const url = `http://127.0.0.1:${String(port)}`
  const childPidFile = join(runDir, `${name}.child-pid`)
  return {
    name, label: `Fake ${name}`, args: [FAKE_APP, String(port), mode, ...(withChild ? [childPidFile] : [])],
    cwd: import.meta.dirname, env: process.env, host: '127.0.0.1', port, url,
    ready: async () => {
      try {
        return (await (await fetch(url, { signal: AbortSignal.timeout(1_000) })).text()) === 'fake app'
      } catch {
        return false
      }
    },
  }
}

const DATABASE = (): string => join(runDir, 'trades.db')

async function startFakes(...launches: AppLaunch[]) {
  const result = await startApps({ runDir, databasePath: DATABASE(), launches, readyTimeoutMs: 20_000 })
  started.push(...result.state.apps.map((app) => app.pid))
  return result
}

/** A process id that no longer belongs to any process: one that has just exited. */
function exitedPid(): number {
  const { pid } = runNode(['-e', ''], isolatedEnv({ DATABASE_PATH: DATABASE() }))
  if (pid === undefined) throw new Error('could not start a process')
  return pid
}

const record = (pid: number, overrides: Partial<AppState['apps'][number]> = {}): AppState['apps'][number] => ({
  name: 'api', label: 'API', pid, token: 'aaaaaaaa-0000-4000-8000-000000000000', host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1',
  log: join(runDir, 'api.log'), ...overrides,
})

const stateWith = (apps: AppState['apps']): AppState => ({
  version: 1, startedAt: '2026-11-04T12:00:00.000Z', phase: 'ready', databasePath: DATABASE(), apps,
})

describe('scripts: starting in the background', () => {
  it('starts each application in order, waits until it answers, and records its id, token and log', async () => {
    const result = await startFakes(await fakeLaunch('api'), await fakeLaunch('web'))

    expect(result.kind).toBe('started')
    const state = readState(runDir)
    expect(state?.phase).toBe('ready')
    expect(state?.databasePath).toBe(DATABASE())
    expect(state?.apps.map((app) => app.name)).toEqual(['api', 'web'])
    // One query for both: on Windows each query starts PowerShell, which takes seconds.
    const apps = state?.apps ?? []
    expect(processStatuses(apps)).toEqual(['running', 'running'])
    const commandLines = commandLinesOf(apps.map((app) => app.pid))
    for (const app of apps) {
      expect(commandLines.get(app.pid)).toContain(app.token)
      expect(await portAnswers(app.port, app.host)).toBe(true)
      expect(readFileSync(app.log, 'utf8')).toContain('fake app listening')
    }
  }, TIMEOUT)

  it('starts nothing more when the applications are already running', async () => {
    const first = await startFakes(await fakeLaunch('api'), await fakeLaunch('web'))

    const second = await startApps({ runDir, databasePath: DATABASE(), launches: [await fakeLaunch('api'), await fakeLaunch('web')] })

    expect(second.kind).toBe('already-running')
    expect(second.state.apps.map((app) => app.pid)).toEqual(first.state.apps.map((app) => app.pid))
    expect(second.kind === 'already-running' ? second.statuses : []).toEqual(['running', 'running'])
  }, TIMEOUT)

  it('refuses a port another program uses, starts nothing, and leaves that program alone', async () => {
    const api = await fakeLaunch('api')
    const web = await fakeLaunch('web')
    const unrelated = await listen(web.port)
    try {
      await expect(startApps({ runDir, databasePath: DATABASE(), launches: [api, web], portHint: () => 'Choose another.' }))
        .rejects.toThrow(`Port ${String(web.port)} for the Fake web is already in use by another process. Nothing was started. Choose another.`)

      expect(existsSync(statePath(runDir))).toBe(false)
      expect(await portAnswers(api.port, api.host)).toBe(false)
      expect(unrelated.listening).toBe(true)
    } finally {
      unrelated.close()
    }
  }, TIMEOUT)

  it('reports why an application failed to start, with the end of its log, and stops the ones already started', async () => {
    const api = await fakeLaunch('api')

    const failure = await startApps({ runDir, databasePath: DATABASE(), launches: [api, await fakeLaunch('web', 'fail')] })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(StartError)
    expect(String(failure)).toContain('The Fake web exited with code 3. Nothing is left running.')
    expect(String(failure)).toContain('fake app: cannot start')
    expect(existsSync(statePath(runDir))).toBe(false)
    expect(await portAnswers(api.port, api.host)).toBe(false)
  }, TIMEOUT)

  it('gives up on an application that never answers, and stops it', async () => {
    const hanging = await fakeLaunch('api', 'hang')

    const failure = await startApps({ runDir, databasePath: DATABASE(), launches: [hanging], readyTimeoutMs: 2_000 }).catch((error: unknown) => error)

    expect(String(failure)).toContain(`did not answer at ${hanging.url} within 2 seconds`)
    expect(existsSync(statePath(runDir))).toBe(false)
  }, TIMEOUT)
})

describe('scripts: stopping', () => {
  it('stops every application and its child processes, releases the ports, and removes the record', async () => {
    const { state } = await startFakes(await fakeLaunch('api', 'serve', true), await fakeLaunch('web', 'serve', true))
    const children = ['api', 'web'].map((name) => Number(readFileSync(join(runDir, `${name}.child-pid`), 'utf8')))
    started.push(...children)
    expect(children.every(isAlive)).toBe(true)

    const result = await stopApps(runDir)

    expect(result.kind).toBe('stopped')
    const reports = result.kind === 'stopped' ? result.reports : []
    expect(reports.map((report) => [report.record.name, report.outcome, report.portReleased]))
      .toEqual(['api', 'web'].map((name) => [name, process.platform === 'win32' ? 'terminated' : 'stopped', true]))
    expect(state.apps.every((app) => !isAlive(app.pid))).toBe(true)
    expect(children.some(isAlive)).toBe(false)
    expect(existsSync(statePath(runDir))).toBe(false)
    expect(existsSync(state.apps[0]?.log ?? '')).toBe(true)
  }, TIMEOUT)

  it('is safe to repeat: the second stop finds nothing to stop', async () => {
    await startFakes(await fakeLaunch('api'))
    await stopApps(runDir)

    expect(await stopApps(runDir)).toEqual({ kind: 'nothing-to-stop' })
    expect(await stopApps(runDir)).toEqual({ kind: 'nothing-to-stop' })
  }, TIMEOUT)

  it('treats a record whose processes have exited as stale: nothing to stop, and start replaces it', async () => {
    writeState(runDir, stateWith([record(exitedPid()), record(exitedPid(), { name: 'web', label: 'Frontend' })]))

    expect(appStatus(runDir).statuses).toEqual(['stopped', 'stopped'])
    expect(appUsingDatabase(DATABASE(), runDir)).toBeUndefined()
    const result = await startFakes(await fakeLaunch('api'))

    expect(result).toMatchObject({ kind: 'started', removedStale: true })
  }, TIMEOUT)

  it('never stops a live process whose id was reused by another program', async () => {
    // A program unrelated to app:start, holding an id that a stale record names.
    const unrelated = startNode(['-e', 'setInterval(() => {}, 1000)'], isolatedEnv({ DATABASE_PATH: DATABASE() }))
    try {
      const pid = unrelated.pid ?? 0
      writeState(runDir, stateWith([record(pid)]))

      expect(processStatus(record(pid))).toBe('reused')
      const result = await stopApps(runDir)

      expect(result.kind === 'stopped' ? result.reports.map((report) => report.outcome) : []).toEqual(['pid-reused'])
      expect(isAlive(pid)).toBe(true)
      expect(existsSync(statePath(runDir))).toBe(false)
    } finally {
      await stopChild(unrelated)
    }
  }, TIMEOUT)
})

describe('scripts: guarding the database', () => {
  it('refuses changes to the database a running application uses, under any spelling of its path, until it stops', async () => {
    await startFakes(await fakeLaunch('api'))
    // Other spellings of the path are the same file to the guard; each refusal check costs a process query.
    const spellings = [join(runDir, '.', 'sub', '..', 'trades.db'), ...(process.platform === 'win32' ? [DATABASE().toUpperCase()] : [])]
    expect(spellings.map(canonicalPath)).toEqual(spellings.map(() => canonicalPath(DATABASE())))

    expect(() => { refuseIfDatabaseInUse(spellings[0] ?? '', runDir) }).toThrow(DatabaseInUseError)
    expect(() => { refuseIfDatabaseInUse(DATABASE(), runDir) }).toThrow('Stop it first with: npm run app:stop')
    expect(() => { refuseIfDatabaseInUse(join(runDir, 'other.db'), runDir) }).not.toThrow()

    await stopApps(runDir)

    expect(() => { refuseIfDatabaseInUse(DATABASE(), runDir) }).not.toThrow()
  }, TIMEOUT)

  it('allows changes when nothing was started, or the record is stale', () => {
    expect(() => { refuseIfDatabaseInUse(DATABASE(), runDir) }).not.toThrow()
    writeState(runDir, stateWith([record(exitedPid())]))
    expect(() => { refuseIfDatabaseInUse(DATABASE(), runDir) }).not.toThrow()
  })

  it('recognises the default development database, so other tools can refuse it', () => {
    expect(isDevelopmentDatabase(DEFAULT_DATABASE_PATH)).toBe(true)
    expect(isDevelopmentDatabase(join(DEFAULT_DATABASE_PATH, '..', 'trade-blotter.db'))).toBe(true)
    expect(isDevelopmentDatabase(DATABASE())).toBe(false)
  })

  it('refuses to guess from a run state it cannot read', () => {
    writeFileSync(statePath(runDir), '{"version":1,"apps":[{"pid":"x"}]}')

    expect(() => readState(runDir)).toThrow('is not readable. If no application started by app:start is running, delete the file.')
  })
})
