import { cpSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MIGRATIONS_FOLDER } from '../../src/infrastructure/database/migrate.ts'
import { isolatedEnv, runNode } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Fails when the Drizzle schema has changed without a migration. drizzle-kit generates against a
 * copy of the migrations folder: if the latest snapshot matches the schema, it writes nothing.
 * `drizzle-kit check` does not detect this; it checks the migrations folder only.
 */
const DRIZZLE_KIT = join(dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs')

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) removeTempDir(dir)
})

describe('infrastructure: schema and migrations agree', () => {
  it('has a migration for every schema change', () => {
    dir = createTempDir()
    const out = join(dir, 'drizzle')
    cpSync(MIGRATIONS_FOLDER, out, { recursive: true })

    // drizzle-kit opens no database; the setting is there because every test child gets a temporary one.
    const result = runNode(
      [DRIZZLE_KIT, 'generate', '--dialect', 'sqlite', '--schema', './src/infrastructure/database/schema.ts', '--out', out],
      isolatedEnv({ DATABASE_PATH: join(dir, 'unused.db') }),
      60_000,
    )

    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('No schema changes')
    expect(readdirSync(out)).toEqual(readdirSync(MIGRATIONS_FOLDER))
  }, 60_000)
})
