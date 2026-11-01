import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_DATABASE_PATH, loadConfig } from '../src/config.ts'

describe('configuration', () => {
  it('uses defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      host: 'localhost',
      port: 5299,
      docsEnabled: true,
      logLevel: 'info',
      databasePath: DEFAULT_DATABASE_PATH,
      symbolMaxLength: 64,
    })
  })

  it('places the default database in server/data, whatever the working directory', () => {
    expect(DEFAULT_DATABASE_PATH).toBe(join(import.meta.dirname, '..', 'data', 'trade-blotter.db'))
  })

  it('reads DATABASE_PATH, resolving a relative path against the working directory', () => {
    expect(loadConfig({ DATABASE_PATH: 'some/trades.db' }).databasePath).toBe(resolve('some/trades.db'))
    expect(loadConfig({ DATABASE_PATH: resolve('/tmp/trades.db') }).databasePath).toBe(resolve('/tmp/trades.db'))
    expect(loadConfig({ DATABASE_PATH: ' ' }).databasePath).toBe(DEFAULT_DATABASE_PATH)
  })

  it('refuses an in-memory database', () => {
    expect(() => loadConfig({ DATABASE_PATH: ':memory:' })).toThrow(/DATABASE_PATH must be a file/)
  })

  it('reads SYMBOL_MAX_LENGTH from 1 to 255', () => {
    expect(loadConfig({ SYMBOL_MAX_LENGTH: '1' }).symbolMaxLength).toBe(1)
    expect(loadConfig({ SYMBOL_MAX_LENGTH: '255' }).symbolMaxLength).toBe(255)
  })

  it.each(['0', '256', '-1', '1.5', '1e2', 'abc'])('refuses SYMBOL_MAX_LENGTH=%s', (value) => {
    expect(() => loadConfig({ SYMBOL_MAX_LENGTH: value })).toThrow(/SYMBOL_MAX_LENGTH must be an integer from 1 to 255/)
  })

  it.each(['-1', '65536', 'abc', '1.5'])('refuses PORT=%s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT must be an integer/)
  })
})
