import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The only way tests start Node processes. A child never inherits the application's settings from
 * the developer's shell, always uses a database under the OS temp folder and outside the
 * repository, and binds a port the OS picks, so a test can never reach the development database
 * or a server on the development port. Children are stopped through their own handle, never by
 * port or process name.
 */

export const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The repository checkout. Test databases never go inside it, even when it is in the temp folder. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The variables `loadConfig` reads. A child gets only the values a test sets explicitly. */
export const APP_SETTINGS = ['HOST', 'PORT', 'DATABASE_PATH', 'LOG_LEVEL', 'DOCS_ENABLED', 'SYMBOL_MAX_LENGTH'] as const

type AppSetting = (typeof APP_SETTINGS)[number]
export type ChildSettings = { readonly DATABASE_PATH: string } & Partial<Record<Exclude<AppSetting, 'DATABASE_PATH'>, string>>

/** Where test databases may go (`tempDir`) and where they never may (`repositoryRoot`). */
export interface DatabaseLocations {
  readonly tempDir: string
  readonly repositoryRoot: string
}

const DATABASE_LOCATIONS: DatabaseLocations = { tempDir: tmpdir(), repositoryRoot: REPOSITORY_ROOT }

/**
 * The absolute form of `path` with `..` removed and its existing part replaced by the real path
 * (links, junctions and Windows short names resolved), so two spellings of one folder compare
 * equal. The part that does not exist yet is kept as written.
 */
function realPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync.native(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(realPath(parent), basename(absolute))
}

/**
 * `path` relative to `folder`, or undefined when it is not inside or equal to it. Compares whole
 * segments, so a sibling such as `Temp-old` is not inside `Temp`; on Windows `relative` also
 * ignores case, as the file system does, and a path on another drive comes back absolute.
 */
function pathInside(folder: string, path: string): string | undefined {
  const inside = relative(realPath(folder), realPath(path))
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : inside
}

/**
 * Why `path` may not hold a test database, or undefined when it may. It must be inside the temp
 * folder and outside the repository; both are checked because the repository itself may be in
 * the temp folder, as in a fresh source copy or a build environment that works under /tmp.
 */
export function databasePathProblem(path: string, locations: DatabaseLocations = DATABASE_LOCATIONS): string | undefined {
  if (pathInside(locations.repositoryRoot, path) !== undefined) {
    return `Test databases must be outside the repository (${locations.repositoryRoot}), got ${path}.`
  }
  const inTemp = pathInside(locations.tempDir, path)
  if (inTemp === undefined || inTemp === '') return `Test databases must be under the OS temp folder, got ${path}.`
  return undefined
}

/**
 * The environment for a child process: the parent's, minus every application setting (matched
 * without regard to case, as Windows does), plus `settings`. Refuses a database outside the OS
 * temp folder or inside the repository, and any port other than 0.
 */
export function isolatedEnv(settings: ChildSettings, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const problem = databasePathProblem(settings.DATABASE_PATH)
  if (problem !== undefined) throw new Error(problem)
  const port = settings.PORT ?? '0'
  if (port !== '0') throw new Error(`Test servers must let the OS pick the port (PORT=0), got PORT=${port}.`)

  const appSettings = new Set<string>(APP_SETTINGS)
  const inherited = Object.entries(parent).filter(([name]) => !appSettings.has(name.toUpperCase()))
  return { ...Object.fromEntries(inherited), HOST: '127.0.0.1', ...settings, PORT: port }
}

export interface Finished {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** True when the child was still running at the deadline and was killed. */
  readonly timedOut: boolean
  readonly pid: number | undefined
}

/**
 * Runs `node <args>` in `server/` and waits for it to exit. A child still running at the deadline
 * is killed, so a hung child can neither block the test run nor outlive it. The default deadline is
 * Vitest's default test timeout, the budget these tests already have.
 */
export function runNode(args: readonly string[], env: NodeJS.ProcessEnv, deadlineMs = 5_000): Finished {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: SERVER_ROOT,
    env,
    encoding: 'utf8',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
  })
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  if (result.error !== undefined && !timedOut) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, timedOut, pid: result.pid }
}

/** Starts `node <args>` in `server/` without waiting. Stop it with `stopChild`. */
export function startNode(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Stops a child this test started, through its own handle, and waits until it has exited. */
export function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => {
      resolve()
    })
    child.kill()
  })
}

/** True while a process with this id exists. Signal 0 only checks; it does not affect the process. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
