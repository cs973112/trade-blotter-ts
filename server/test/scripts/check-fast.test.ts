import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHECK_ALL_ONLY_TESTS, checkFast, FAST_GROUPS, FAST_TOOLING_TESTS, type FastCheck, type FastGroup } from '../../scripts/check-fast.ts'
import { runNodeBounded, type CommandRun } from '../../scripts/failure-detection.ts'
import { REPOSITORY_ROOT, SERVER_ROOT } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * npm run check:fast (server/scripts/check-fast.ts): what it runs, and how it reports. Its groups
 * run the project's own npm scripts, every server application test and every tooling test is
 * either in it or named as left to check:all, and the runner turns each command into a PASS or a
 * FAIL, runs a group's checks at once, stops after a failed group (the rest NOT RUN) and exits
 * nonzero. Stand-in commands run as real processes through the same bounded runner, so a failing
 * exit code, a deadline and a real npm failure are each seen as check:fast sees them.
 */

let dir = ''

beforeEach(() => {
  dir = createTempDir()
})

afterEach(() => {
  removeTempDir(dir)
})

const check = (id: string): FastCheck => ({ id, name: `Check ${id}`, npm: ['run', id] })

/** A stand-in run that waits `delays[id]` ms and exits with `codes[id]` (0 by default), recording when each ran. */
function standIn(delays: Record<string, number>, codes: Record<string, number> = {}) {
  const spans: Record<string, [number, number]> = {}
  const run = async (fast: FastCheck): Promise<CommandRun> => {
    const start = Date.now()
    await new Promise((resolve) => setTimeout(resolve, delays[fast.id] ?? 0))
    spans[fast.id] = [start, Date.now()]
    return { exitCode: codes[fast.id] ?? 0, timedOut: false, milliseconds: Date.now() - start }
  }
  return { run, spans }
}

describe('check:fast: what it runs', () => {
  const scripts = (JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const workspaceScripts = (workspace: string) => (JSON.parse(readFileSync(join(REPOSITORY_ROOT, workspace, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

  it('is the npm script check:fast, and runs only the project\'s own npm scripts, in four groups, only the static checks at once', () => {
    expect(scripts['check:fast']).toBe('node --disable-warning=ExperimentalWarning server/scripts/check-fast.ts')
    expect(FAST_GROUPS.map((group) => group.map((fast) => fast.id))).toEqual([
      ['lint', 'typecheck', 'build', 'schema', 'docs'], ['server-app-tests'], ['client-tests'], ['server-tooling-tests'],
    ])
    for (const fast of FAST_GROUPS.flat()) {
      expect(fast.npm[0], fast.id).toBe('run')
      const name = fast.npm[1] ?? ''
      const workspace = fast.npm.includes('-w') ? fast.npm[fast.npm.indexOf('-w') + 1] ?? '' : undefined
      expect(workspace === undefined ? scripts[name] : workspaceScripts(workspace)[name], fast.id).toBeDefined()
    }
  })

  it('runs every server application test: the whole Vitest project app, which leaves out test/scripts only', () => {
    expect(FAST_GROUPS.flat().find((fast) => fast.id === 'server-app-tests')?.npm).toEqual(['run', 'test', '-w', 'server', '--', '--project', 'app'])
    const config = readFileSync(join(SERVER_ROOT, 'vitest.config.ts'), 'utf8')
    expect(config).toContain("{ extends: true, test: { name: 'app', include: ['test/**/*.test.ts'], exclude: ['test/scripts/**'], sequence: { groupOrder: 0 } } }")
    // Every folder of application tests is under test/ and outside test/scripts, so the project holds it.
    const folders = readdirSync(join(SERVER_ROOT, 'test'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(folders.filter((name) => name !== 'scripts' && name !== 'support').sort()).toEqual(['api', 'application', 'architecture', 'domain', 'infrastructure', 'isolation', 'platform', 'scenarios', 'tooling'])
  })

  it('names every tooling test exactly once: in check:fast, or left to check:all with why', () => {
    const files = readdirSync(join(SERVER_ROOT, 'test', 'scripts')).filter((name) => name.endsWith('.test.ts')).map((name) => `test/scripts/${name}`).sort()
    const fast = [...FAST_TOOLING_TESTS]
    const left = Object.keys(CHECK_ALL_ONLY_TESTS)
    expect([...fast, ...left].sort()).toEqual(files)
    expect(fast.filter((file) => left.includes(file))).toEqual([])
    expect(left).toEqual(expect.arrayContaining(['test/scripts/check-all-supervisor.test.ts', 'test/scripts/failure-detection.test.ts', 'test/scripts/perf-api.test.ts', 'test/scripts/perf-ui.test.ts', 'test/scripts/review.test.ts', 'test/scripts/ui-check.test.ts']))
    expect(FAST_GROUPS.flat().find((fastCheck) => fastCheck.id === 'server-tooling-tests')?.npm).toEqual(['run', 'test', '-w', 'server', '--', '--project', 'scripts', ...FAST_TOOLING_TESTS])
  })

  it('never starts the reviewer\'s applications, a benchmark, the browser checks or failure detection', () => {
    const commands = FAST_GROUPS.flat().map((fast) => fast.npm.join(' '))
    for (const forbidden of ['review:', 'perf:', 'check:ui', 'check:failures', 'check:all', 'app:start']) {
      expect(commands.filter((command) => command.includes(forbidden)), forbidden).toEqual([])
    }
  })
})

describe('check:fast: how it runs and reports', () => {
  const groups: readonly FastGroup[] = [[check('a'), check('b')], [check('c')]]

  it('runs the groups in order and the checks of a group at once, each a PASS, exit code 0, with a summary', async () => {
    const { run, spans } = standIn({ a: 300, b: 300, c: 10 })
    const printed: string[] = []

    const summary = await checkFast({ groups, run, runDir: dir, runId: 'test-run', print: (line) => { printed.push(line) } })

    expect(summary).toMatchObject({ result: 'PASSED', exitCode: 0, results: [{ status: 'PASS' }, { status: 'PASS' }, { status: 'PASS' }] })
    const span = (id: string): [number, number] => spans[id] ?? [0, 0]
    const [a, b, c] = [span('a'), span('b'), span('c')]
    // a and b overlap; c starts only once both have finished.
    expect(Math.max(a[0], b[0])).toBeLessThan(Math.min(a[1], b[1]))
    expect(c[0]).toBeGreaterThanOrEqual(Math.max(a[1], b[1]))
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))).toMatchObject({ tool: 'check:fast', runId: 'test-run', result: 'PASSED', exitCode: 0 })
    expect(printed.at(-1)).toBe('RESULT: PASSED (exit code 0): development feedback only; npm run check:all is the acceptance')
    expect(printed).toContain('Summary of run test-run: 3 PASS, 0 FAIL, 0 NOT RUN in 0.3 s')
  })

  it('fails the run on a failed check, finishes its group, and reports every later check as not run', async () => {
    const { run, spans } = standIn({}, { b: 2 })
    const printed: string[] = []

    const summary = await checkFast({ groups, run, runDir: dir, print: (line) => { printed.push(line) } })

    expect(summary.exitCode).toBe(1)
    expect(summary.results.map((result) => [result.check.id, result.status])).toEqual([['a', 'PASS'], ['b', 'FAIL'], ['c', 'NOT RUN']])
    expect(spans['c']).toBeUndefined()
    expect(printed).toContain('NOT RUN  Check c: an earlier check failed')
    expect(printed.at(-1)).toBe('RESULT: FAILED (exit code 1): development feedback only; npm run check:all is the acceptance')
  })

  it('counts a check stopped at its deadline as a FAIL', async () => {
    const summary = await checkFast({ groups: [[check('slow')]], run: () => Promise.resolve({ exitCode: 1, timedOut: true, milliseconds: 5 }), runDir: dir, print: () => undefined })

    expect(summary.results[0]).toMatchObject({ status: 'FAIL', timedOut: true })
    expect(summary.exitCode).toBe(1)
  })
})

describe('check:fast: real processes through the bounded runner', () => {
  it('sees a real failing command, prints the end of its log, and stops a command still running at its deadline', async () => {
    const scripts: Record<string, string> = {
      ok: 'console.log("fine")',
      broken: 'console.log("expected 3 to be 4: a deliberate failure"); process.exit(1)',
      hangs: 'setInterval(() => {}, 1000)',
    }
    const printed: string[] = []
    const summary = await checkFast({
      groups: [[check('ok'), check('broken'), check('hangs')]],
      run: (fast, log, limit) => runNodeBounded(['-e', scripts[fast.id] ?? ''], dir, log, limit),
      timeoutMs: 2_000, runDir: dir, print: (line) => { printed.push(line) },
    })

    expect(summary.results.map((result) => [result.check.id, result.status, result.timedOut])).toEqual([['ok', 'PASS', false], ['broken', 'FAIL', false], ['hangs', 'FAIL', true]])
    expect(printed.join('\n')).toContain('expected 3 to be 4: a deliberate failure')
    expect(printed.join('\n')).toMatch(/Check hangs \(\d+\.\d s\): stopped at its 2\.0 s deadline/)
    expect(readFileSync(join(dir, 'ok.log'), 'utf8')).toContain('fine')
  }, 60_000)

  it('runs a real npm script through npm, and fails on one that fails', async () => {
    const summary = await checkFast({ groups: [[{ id: 'missing', name: 'An npm script that does not exist', npm: ['run', 'no-such-script-for-check-fast'] }]], runDir: dir, print: () => undefined })

    expect(summary.results[0]).toMatchObject({ status: 'FAIL', timedOut: false })
    expect(summary.results[0]?.exitCode).not.toBe(0)
    expect(readFileSync(join(dir, 'missing.log'), 'utf8')).toMatch(/Missing script|no-such-script-for-check-fast/)
    expect(existsSync(join(dir, 'summary.json'))).toBe(true)
  }, 120_000)
})
