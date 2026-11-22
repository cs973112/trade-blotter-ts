import { join } from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { REPOSITORY_ROOT } from '../support/child-process.ts'

/**
 * The repository's ESLint configuration (eslint.config.js) ignores the files the tools generate,
 * and only those: `.run/` at the root, and `server/.test-build-*` and `client/.test-build-*` copies. Code and tests next to
 * them, and folders whose names only look alike, are still linted, and an error in them is still
 * reported. Nothing is written: ESLint is asked about paths, and given source text directly.
 */

let eslint: ESLint

/**
 * Loading the configuration (typescript-eslint, the Vue plugin) takes seconds, and much longer
 * while the rest of the suite loads every core; it is done once here, with time for that, so no
 * test below is measured against it.
 */
const LOAD_MS = 120_000

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPOSITORY_ROOT })
  await eslint.calculateConfigForFile(join(REPOSITORY_ROOT, 'server/src/main.ts'))
  await eslint.lintText('', { filePath: join(REPOSITORY_ROOT, 'server/src/lint-probe.js') })
}, LOAD_MS)

const ignored = (path: string): Promise<boolean> => eslint.isPathIgnored(join(REPOSITORY_ROOT, path))

describe('eslint.config.js: generated files are ignored', () => {
  it('ignores the run folder and the temporary server and client copies, at any depth inside them', async () => {
    for (const path of [
      '.run/m0a/20261120T132511Z/scripts/sqlite-trigger-check.mjs',
      '.run/check-all/20261120T000000.000Z-abcdef/failure-detection/probe.ts',
      '.run/review/logs/anything.js',
      'server/.test-build-trade-blotter-1a2b3c4d-x/src/domain/position.ts',
      'server/.test-build-check-20261120/test/domain/position.test.ts',
      'client/.test-build-check-20261122/src/components/PositionsPanel.vue',
      'client/.test-build-check-20261122/test/lifecycle.test.ts',
    ]) {
      expect(await ignored(path), path).toBe(true)
    }
  })

  it('still lints application code, tests, tools and look-alike folders', async () => {
    for (const path of [
      'server/src/domain/position.ts',
      'server/test/domain/position.test.ts',
      'server/scripts/check-all.ts',
      'client/src/App.vue',
      'eslint.config.js',
      // Look alike, but are not the generated folders: no leading dot, another parent, another name.
      'server/test-build-x/a.ts',
      'client/test-build-x/a.ts',
      'client/src/.test-build-x/a.ts',
      'server/src/.run/a.ts',
      '.running/a.ts',
    ]) {
      expect(await ignored(path), path).toBe(false)
    }
  })

  it('reports an error in application code, and none for the same text in a generated folder', async () => {
    const text = 'debugger\n'
    const [source] = await eslint.lintText(text, { filePath: join(REPOSITORY_ROOT, 'server/src/lint-probe.js') })
    const [generated] = await eslint.lintText(text, { filePath: join(REPOSITORY_ROOT, '.run/lint-probe.js'), warnIgnored: true })

    expect(source?.messages.map((message) => message.ruleId)).toContain('no-debugger')
    expect(source?.errorCount).toBeGreaterThan(0)
    expect(generated?.errorCount).toBe(0)
    expect(generated?.messages.map((message) => message.message)).toEqual([expect.stringMatching(/ignored/i)])
  })
})
