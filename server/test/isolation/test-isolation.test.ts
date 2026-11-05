import { mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_DATABASE_PATH } from '../../src/config.ts'
import {
  databasePathProblem,
  isolatedEnv,
  isRunning,
  REPOSITORY_ROOT,
  runNode,
  SERVER_ROOT,
  startNode,
  stopChild,
  type DatabaseLocations,
} from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Tests must never reach a developer's own server or data: no development database, no
 * development port, no process the test did not start. These checks keep it that way.
 */
const TEST_ROOT = join(SERVER_ROOT, 'test')
const THIS_FILE = 'isolation/test-isolation.test.ts'

function testFiles(dir = TEST_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? testFiles(join(dir, entry.name)) : [relative(TEST_ROOT, join(dir, entry.name)).replaceAll('\\', '/')])
}

function filesMatching(pattern: RegExp): string[] {
  return testFiles().filter((file) => file !== THIS_FILE && pattern.test(readFileSync(join(TEST_ROOT, file), 'utf8')))
}

describe('test isolation: child process settings', () => {
  const tempDatabase = (): string => join(createTempDir(), 'trade-blotter.db')

  // These hold wherever the checkout is, including inside the temp folder.
  it('refuses the development database', () => {
    expect(() => isolatedEnv({ DATABASE_PATH: DEFAULT_DATABASE_PATH })).toThrow(/must be outside the repository/)
  })

  it('refuses any database inside the repository', () => {
    expect(() => isolatedEnv({ DATABASE_PATH: resolve('trade-blotter.db') })).toThrow(/must be outside the repository/)
    expect(() => isolatedEnv({ DATABASE_PATH: join(REPOSITORY_ROOT, 'trade-blotter.db') })).toThrow(/must be outside the repository/)
  })

  it('refuses a database outside the OS temp folder, including a sibling whose name starts the same', () => {
    expect(() => isolatedEnv({ DATABASE_PATH: join(`${tmpdir()}-other`, 't.db') })).toThrow(/must be under the OS temp folder/)
  })

  it('accepts a database in a folder of its own under the OS temp folder', () => {
    const database = tempDatabase()
    try {
      expect(isolatedEnv({ DATABASE_PATH: database }, {})['DATABASE_PATH']).toBe(database)
    } finally {
      removeTempDir(join(database, '..'))
    }
  })

  it('refuses any port other than one the OS picks', () => {
    const dir = createTempDir()
    try {
      expect(() => isolatedEnv({ DATABASE_PATH: join(dir, 't.db'), PORT: '5299' })).toThrow(/PORT=0/)
    } finally {
      removeTempDir(dir)
    }
  })

  it("drops the application's settings from the parent environment, whatever their case, and keeps the rest", () => {
    const database = tempDatabase()
    const parent = { PATH: '/bin', DATABASE_PATH: DEFAULT_DATABASE_PATH, Port: '5299', host: '0.0.0.0', SYMBOL_MAX_LENGTH: '0', LOG_LEVEL: 'silent' }
    try {
      expect(isolatedEnv({ DATABASE_PATH: database }, parent)).toEqual({ PATH: '/bin', HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: database })
    } finally {
      removeTempDir(join(database, '..'))
    }
  })
})

/**
 * A checkout inside the temp folder, as in a fresh source copy or a build environment that works
 * under /tmp. Real folders stand in for both: <base>/temp for the OS temp folder, <base>/temp/checkout
 * for the repository.
 */
describe('test isolation: a checkout inside the temp folder', () => {
  let base = ''
  let locations: DatabaseLocations = { tempDir: '', repositoryRoot: '' }
  const problem = (path: string): string | undefined => databasePathProblem(path, locations)

  beforeAll(() => {
    base = createTempDir()
    const tempDir = join(base, 'temp')
    const repositoryRoot = join(tempDir, 'checkout')
    mkdirSync(join(repositoryRoot, 'server', 'data'), { recursive: true })
    locations = { tempDir, repositoryRoot }
  })

  afterAll(() => {
    removeTempDir(base)
  })

  it("refuses the checkout's development database", () => {
    expect(problem(join(locations.repositoryRoot, 'server', 'data', 'trade-blotter.db'))).toMatch(/must be outside the repository/)
  })

  it('refuses any other path inside the checkout, however it is written', () => {
    const { tempDir, repositoryRoot } = locations
    for (const path of [
      join(repositoryRoot, 'trade-blotter.db'),
      join(repositoryRoot, 'server', 'test', 'run', 't.db'),
      `${tempDir}/run/../checkout/t.db`,
      relative(process.cwd(), join(repositoryRoot, 't.db')),
    ]) {
      expect(problem(path), path).toMatch(/must be outside the repository/)
    }
  })

  it.runIf(process.platform === 'win32')('refuses a path inside the checkout written in another case', () => {
    expect(problem(join(locations.repositoryRoot.toUpperCase(), 't.db'))).toMatch(/must be outside the repository/)
  })

  it('refuses a path that reaches the checkout through a link', () => {
    const link = join(locations.tempDir, 'link-to-checkout')
    symlinkSync(locations.repositoryRoot, link, 'junction')
    try {
      expect(problem(join(link, 'server', 'data', 'trade-blotter.db'))).toMatch(/must be outside the repository/)
    } finally {
      unlinkSync(link)
    }
  })

  it('accepts a database in its own folder beside the checkout, even one whose name starts the same', () => {
    expect(problem(join(locations.tempDir, 'trade-blotter-run-1', 't.db'))).toBeUndefined()
    expect(problem(join(locations.tempDir, 'checkout-other', 't.db'))).toBeUndefined()
  })

  it('still refuses a database outside the temp folder', () => {
    expect(problem(join(base, 'elsewhere', 't.db'))).toMatch(/must be under the OS temp folder/)
    expect(problem(join(base, 'temp-old', 't.db'))).toMatch(/must be under the OS temp folder/)
    expect(problem(locations.tempDir)).toMatch(/must be under the OS temp folder/)
  })
})

describe('test isolation: child process lifetime', () => {
  it('stops a child that is still running at its deadline', () => {
    const dir = createTempDir()
    try {
      const result = runNode(['-e', 'setInterval(() => {}, 1000)'], isolatedEnv({ DATABASE_PATH: join(dir, 't.db') }), 500)

      expect(result.timedOut).toBe(true)
      expect(result.pid).toBeDefined()
      expect(isRunning(result.pid ?? 0)).toBe(false)
    } finally {
      removeTempDir(dir)
    }
  })

  it('stops a started child through its own handle and waits for it to exit', async () => {
    const dir = createTempDir()
    try {
      const child = startNode(['-e', 'setInterval(() => {}, 1000)'], isolatedEnv({ DATABASE_PATH: join(dir, 't.db') }))
      await new Promise((resolve) => child.once('spawn', resolve))
      const pid = child.pid ?? 0
      expect(isRunning(pid)).toBe(true)

      await stopChild(child)

      expect(isRunning(pid)).toBe(false)
      await stopChild(child) // stopping again is harmless
    } finally {
      removeTempDir(dir)
    }
  })
})

describe('test isolation: the test sources', () => {
  it('start processes only through the isolating helper', () => {
    // fake-app.ts is not a test: it is the stand-in application the app:start tests launch, and it
    // starts a child of its own so they can check that stopping it stops its children too.
    expect(filesMatching(/from 'node:child_process'/).sort()).toEqual(['support/child-process.ts', 'support/fake-app.ts'])
  })

  it('never stop processes by port or by name', () => {
    expect(filesMatching(/taskkill|Stop-Process|kill-port|\bfuser\b|\blsof\b|\bpkill\b|\bkillall\b/i)).toEqual([])
  })

  it('name the development port and database only to check the defaults or to avoid them', () => {
    // The app:start tests check its defaults, and that it recognises the development database; the
    // db:seed and db:clear tests check that the commands refuse it before opening anything.
    expect(filesMatching(/5299|DEFAULT_DATABASE_PATH|data[\\/]trade-blotter\.db/).sort()).toEqual([
      'config.test.ts', 'platform/compiled-server.test.ts', 'scripts/app.test.ts', 'scripts/lifecycle.test.ts', 'scripts/trade-data.test.ts',
    ])
  })

  it('leave the package scripts free of commands that stop processes', () => {
    const manifests = ['../package.json', 'package.json', '../client/package.json'].map((path) => readFileSync(join(SERVER_ROOT, path), 'utf8'))
    for (const manifest of manifests) {
      const { scripts = {} } = JSON.parse(manifest) as { scripts?: Record<string, string> }
      expect(Object.values(scripts).filter((script) => /taskkill|Stop-Process|kill-port|\bfuser\b|\bpkill\b|\bkillall\b|\bkill\b/i.test(script))).toEqual([])
    }
  })
})
