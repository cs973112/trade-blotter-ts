import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyChange, FAILURE_CHECKS, judgeChange, judgeControl, runFailureDetection,
  type FailureCheck, type RunOutcome, type VitestAssertion, type VitestResults,
} from '../../scripts/failure-detection.ts'
import { SERVER_ROOT } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Failure detection (server/scripts/failure-detection.ts): what counts as a test catching a broken
 * rule. Judged on vitest's JSON results: only an assertion failure in a named test is detection; a
 * pass, a timeout, a crash, a test file that cannot be collected, or an error from the code is not.
 * The last tests make real copies of the server, where a change that does not compile, text that is
 * not there, or a run past its deadline must each fail the check.
 * Real copies of the client (M6 Phase 2) are type-checked with vue-tsc: a change detected by the
 * client's tests passes, a template that no longer type-checks fails, and neither touches client/src.
 */

const assertion = (fullName: string, status: string, failureMessages: string[] = []): VitestAssertion => ({ fullName, status, failureMessages })
const results = (tests: VitestAssertion[], file: Partial<{ status: string; message: string }> = {}): VitestResults => ({
  numTotalTests: tests.length,
  numPassedTests: tests.filter((test) => test.status === 'passed').length,
  numFailedTests: tests.filter((test) => test.status === 'failed').length,
  testResults: [{ name: '/x/test/domain/position.test.ts', status: file.status ?? (tests.some((test) => test.status === 'failed') ? 'failed' : 'passed'), message: file.message ?? '', assertionResults: tests }],
})
const run = (outcome: Partial<RunOutcome> & { results?: VitestResults | undefined }): RunOutcome => ({ exitCode: 1, timedOut: false, ...outcome, results: outcome.results })

const ASSERTION = 'AssertionError: expected \'101.25\' to be \'100\' // Object.is equality\n    at test/domain/position.test.ts:90:7'
const RULE = /^domain: applying one trade/

describe('failure detection: the control', () => {
  it('passes only when every test ran and passed', () => {
    expect(judgeControl(run({ exitCode: 0, results: results([assertion('a', 'passed'), assertion('b', 'passed')]) }))).toEqual({ ok: true, detail: '2 passed' })
    expect(judgeControl(run({ exitCode: 1, results: results([assertion('a', 'passed'), assertion('b', 'failed', [ASSERTION])]) })).detail).toMatch(/^the control failed: 1 failed, 1 passed/)
    expect(judgeControl(run({ exitCode: 0, results: results([]) })).detail).toBe('the control ran no tests')
    expect(judgeControl(run({ exitCode: 1, results: undefined })).detail).toBe('the control run wrote no results (exit code 1)')
    expect(judgeControl(run({ timedOut: true, results: undefined })).detail).toBe('the control run timed out')
    expect(judgeControl(run({ results: results([], { status: 'failed', message: 'SyntaxError: Unexpected token' }) })).detail).toMatch(/could not be collected: .*SyntaxError/)
  })
})

describe('failure detection: after the change', () => {
  it('is detection when a named test fails on an assertion', () => {
    const verdict = judgeChange(run({ results: results([assertion('domain: applying one trade reduces', 'failed', [ASSERTION]), assertion('domain: other', 'passed')]) }), RULE)

    expect(verdict).toEqual({ kind: 'detected', failing: ['domain: applying one trade reduces'], others: [] })
  })

  it('is not detection when every test passes: the change went unnoticed', () => {
    expect(judgeChange(run({ exitCode: 0, results: results([assertion('domain: applying one trade reduces', 'passed')]) }), RULE))
      .toEqual({ kind: 'not-detected', detail: 'every test passed (1): the change went unnoticed' })
  })

  it('is not detection when the failure is an error from the code, not an assertion', () => {
    const verdict = judgeChange(run({ results: results([assertion('domain: applying one trade reduces', 'failed', ['TypeError: Cannot read properties of undefined (reading \'plus\')'])]) }), RULE)

    expect(verdict.kind).toBe('invalid')
    expect(verdict.kind !== 'detected' && verdict.detail).toMatch(/no test matching .* failed on an assertion; failures: .*TypeError/)
  })

  it('is not detection when only a test outside the rule fails', () => {
    expect(judgeChange(run({ results: results([assertion('domain: something else', 'failed', [ASSERTION])]) }), RULE).kind).toBe('invalid')
  })

  it('is not detection when a test timed out, even beside an assertion failure', () => {
    const verdict = judgeChange(run({ results: results([
      assertion('domain: applying one trade reduces', 'failed', [ASSERTION]),
      assertion('domain: applying one trade hangs', 'failed', ['Error: Test timed out in 5000ms.']),
    ]) }), RULE)

    expect(verdict).toEqual({ kind: 'invalid', detail: 'tests timed out: domain: applying one trade hangs' })
  })

  it('is not detection when a test file could not be collected (a compile or import error)', () => {
    const verdict = judgeChange(run({ results: results([], { status: 'failed', message: 'Error: Failed to load url ../../src/domain/position.ts' }) }), RULE)

    expect(verdict.kind).toBe('invalid')
    expect(verdict.kind !== 'detected' && verdict.detail).toMatch(/could not be collected: .*Failed to load url/)
  })

  it('is not detection when the run timed out or wrote no results', () => {
    expect(judgeChange(run({ timedOut: true, results: undefined }), RULE)).toEqual({ kind: 'invalid', detail: 'the run timed out' })
    expect(judgeChange(run({ exitCode: 134, results: undefined }), RULE)).toEqual({ kind: 'invalid', detail: 'the run wrote no results (exit code 134)' })
  })
})

describe('failure detection: the change itself', () => {
  it('is made only where the text occurs exactly once', () => {
    expect(applyChange('a\r\nb\nc', 'b\nc', 'B')).toEqual({ ok: true, text: 'a\nB' })
    expect(applyChange('abc', 'x', 'y')).toEqual({ ok: false, detail: 'the text to change was not found (the file has changed: update the check)' })
    expect(applyChange('a a', 'a', 'b')).toEqual({ ok: false, detail: 'the text to change occurs 2 times, not once' })
    // Replacement text is taken literally, never as a pattern.
    expect(applyChange('x', 'x', '$&$&')).toEqual({ ok: true, text: '$&$&' })
  })

  it('every check still applies to the current source: its text is there exactly once, and its tests exist', () => {
    for (const check of FAILURE_CHECKS) {
      const root = check.workspace === 'client' ? join(SERVER_ROOT, '..', 'client') : SERVER_ROOT
      expect(applyChange(readFileSync(join(root, check.file), 'utf8'), check.find, check.replace).ok, check.id).toBe(true)
      for (const test of check.tests) expect(() => readFileSync(join(root, test)), `${check.id}: ${test}`).not.toThrow()
    }
    expect(new Set(FAILURE_CHECKS.map((check) => check.id)).size).toBe(FAILURE_CHECKS.length)
  })
})

describe('failure detection: real copies of the server', () => {
  let evidence = ''

  beforeEach(() => {
    evidence = createTempDir()
  })

  afterEach(() => {
    removeTempDir(evidence)
  })

  const base: FailureCheck = {
    id: 'probe', rule: 'probe', file: 'src/domain/position.ts', find: 'averageCost = trade.price\n  } else if (current.isPositive() === signed.isPositive()) {',
    replace: '', tests: ['test/domain/position.test.ts'], expectFailing: /^domain: /,
  }
  const detect = async (check: FailureCheck, timeoutMs?: number) => {
    const [result] = await runFailureDetection({ runId: `test-${String(Date.now())}`, evidenceDir: evidence, checks: [check], ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    if (result === undefined) throw new Error('no result')
    return result
  }

  it('fails, without counting detection, when the changed code does not compile', async () => {
    const result = await detect({ ...base, id: 'type-error', replace: "averageCost = 'not a decimal'\n  } else if (current.isPositive() === signed.isPositive()) {" })

    expect(result.status).toBe('FAIL')
    expect(result.detail).toMatch(/^The changed code does not compile \(tsc exit code \d+\); not counted as detection/)
    expect(readFileSync(join(evidence, 'type-error', 'typecheck.log'), 'utf8')).toMatch(/error TS2322/)
    // The control ran first, on the unmodified copy, and passed.
    expect(JSON.parse(readFileSync(join(evidence, 'type-error', 'control.json'), 'utf8'))).toMatchObject({ numFailedTests: 0 })
  }, 180_000)

  it('fails when the text to change is not in the file', async () => {
    const result = await detect({ ...base, id: 'missing-text', find: 'text that is not in the file', replace: 'x' })

    expect(result).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/could not be applied to src\/domain\/position\.ts: the text to change was not found/) as unknown })
  }, 180_000)

  it('fails when the run exceeds its deadline', async () => {
    const result = await detect({ ...base, id: 'deadline' }, 1)

    expect(result).toMatchObject({ status: 'FAIL', detail: 'Control: the control run timed out. Nothing can be concluded from the change.' })
  }, 180_000)
})

describe('failure detection: real copies of the client (M6 Phase 2)', () => {
  let evidence = ''
  const CLIENT_ROOT = join(SERVER_ROOT, '..', 'client')
  /** Every client source file's text, to show a check changed nothing outside its copy. */
  const clientSource = (): string => {
    const files = readdirSync(join(CLIENT_ROOT, 'src'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name)).sort()
    return files.map((path) => `${path}\n${readFileSync(path, 'utf8')}`).join('\n')
  }
  const copies = (): string[] => readdirSync(CLIENT_ROOT).filter((name) => name.startsWith('.test-build-check-'))

  beforeEach(() => {
    evidence = createTempDir()
  })

  afterEach(() => {
    removeTempDir(evidence)
  })

  const base: FailureCheck = {
    id: 'client-probe', rule: 'probe', workspace: 'client', file: 'src/lib/cancellation.ts',
    find: "export function isExecutable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {\n  return trade.status === 'Pending' && trade.originalTradeId === null",
    replace: "export function isExecutable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {\n  return trade.originalTradeId === null",
    tests: ['test/lifecycle.test.ts'], expectFailing: /Execute and Cancel only on Pending trades/,
  }
  const detect = async (check: FailureCheck) => {
    const [result] = await runFailureDetection({ runId: `test-${String(Date.now())}`, evidenceDir: evidence, checks: [check] })
    if (result === undefined) throw new Error('no result')
    return result
  }

  it('copies client/, runs the control, type-checks the change with vue-tsc and counts the named assertion failure, leaving the source as it was and removing the copy', async () => {
    const before = clientSource()
    const result = await detect(base)

    expect(result.status, result.detail).toBe('PASS')
    expect(result.detail).toMatch(/^Control \d+ passed; after the change \d+ test\(s\) failed on an assertion: .*Execute and Cancel only on Pending trades/)
    expect(JSON.parse(readFileSync(join(evidence, 'client-probe', 'control.json'), 'utf8'))).toMatchObject({ numFailedTests: 0 })
    expect(readFileSync(join(evidence, 'client-probe', 'change.txt'), 'utf8')).toContain('src/lib/cancellation.ts')
    expect(clientSource()).toBe(before)
    expect(copies()).toEqual([])
  }, 300_000)

  it('fails, without counting detection, when a Vue template no longer type-checks', async () => {
    const result = await detect({
      ...base, id: 'client-template-error', file: 'src/components/PositionsPanel.vue',
      find: '{{ formatDecimal(position.executedNetQuantity) }}', replace: '{{ formatDecimal(position.noSuchField) }}',
    })

    expect(result.status).toBe('FAIL')
    expect(result.detail).toMatch(/^The changed code does not compile \(vue-tsc exit code \d+\); not counted as detection/)
    expect(readFileSync(join(evidence, 'client-template-error', 'typecheck.log'), 'utf8')).toMatch(/noSuchField/)
    expect(copies()).toEqual([])
  }, 300_000)
})
