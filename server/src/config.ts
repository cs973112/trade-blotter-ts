import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SYMBOL_MAX_LENGTH, SYMBOL_MAX_LENGTH_RANGE } from './domain/symbol.ts'

export interface Config {
  readonly host: string
  readonly port: number
  readonly docsEnabled: boolean
  readonly logLevel: string
  /** Absolute path of the SQLite database file. */
  readonly databasePath: string
  /** Maximum symbol length in characters (code points). */
  readonly symbolMaxLength: number
}

/**
 * `server/data/trade-blotter.db`. Resolved from this module, which sits one folder below `server/`
 * both as source (`src/`) and as the build (`dist/`), so the default does not depend on the working
 * directory.
 */
export const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../data/trade-blotter.db', import.meta.url))

/**
 * Reads configuration from the environment. The defaults suit local development: the frontend's
 * dev server forwards API requests to localhost:5299. A relative DATABASE_PATH is resolved against
 * the working directory.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env['HOST'] ?? 'localhost',
    port: parsePort(env['PORT'] ?? '5299'),
    docsEnabled: env['DOCS_ENABLED'] !== 'false',
    logLevel: env['LOG_LEVEL'] ?? 'info',
    databasePath: parseDatabasePath(env['DATABASE_PATH']),
    symbolMaxLength: parseSymbolMaxLength(env['SYMBOL_MAX_LENGTH']),
  }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got "${value}".`)
  }
  return port
}

function parseDatabasePath(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return DEFAULT_DATABASE_PATH
  if (value === ':memory:') throw new Error('DATABASE_PATH must be a file; an in-memory database would lose every trade on restart.')
  return resolve(value)
}

function parseSymbolMaxLength(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_SYMBOL_MAX_LENGTH
  const length = Number(value)
  const { min, max } = SYMBOL_MAX_LENGTH_RANGE
  if (!/^[0-9]+$/.test(value.trim()) || length < min || length > max) {
    throw new Error(`SYMBOL_MAX_LENGTH must be an integer from ${String(min)} to ${String(max)}, got "${value}".`)
  }
  return length
}
