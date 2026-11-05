import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_DATABASE_PATH } from '../../src/config.ts'
import { API_ARGS, DEFAULT_WEB_PORT, launches, resolveSettings, SettingsError, urlHost } from '../../scripts/app.ts'
import { REPOSITORY_ROOT } from '../../scripts/lifecycle.ts'
import { isolatedEnv, runNode } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/** The app:start, app:stop and app:status command line: its settings, and that it mirrors the npm scripts. */

const json = (path: string): { scripts: Record<string, string> } =>
  JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { scripts: Record<string, string> }

describe('scripts: app settings', () => {
  it('defaults to the API on 5299, the built frontend on 4173, localhost and the default database', () => {
    const settings = resolveSettings([], {}, REPOSITORY_ROOT)

    expect(settings).toMatchObject({
      host: 'localhost', apiPort: 5299, webPort: 4173, databasePath: DEFAULT_DATABASE_PATH, docsEnabled: true,
      apiUrl: 'http://localhost:5299', webUrl: 'http://localhost:4173', apiTarget: 'http://localhost:5299',
    })
  })

  it('takes the environment, and the command line over it', () => {
    const env = { PORT: '5399', WEB_PORT: '4273', HOST: '127.0.0.1', DATABASE_PATH: '/data/env.db', DOCS_ENABLED: 'false' }

    expect(resolveSettings([], env, REPOSITORY_ROOT)).toMatchObject({ apiPort: 5399, webPort: 4273, host: '127.0.0.1', docsEnabled: false })
    expect(resolveSettings(['--api-port', '6000', '--web-port', '6001', '--host', '::1', '--database', '/data/arg.db'], env, REPOSITORY_ROOT))
      .toMatchObject({ apiPort: 6000, webPort: 6001, host: '::1', apiUrl: 'http://[::1]:6000', databasePath: resolve('/data/arg.db') })
  })

  it('resolves a relative database path against the folder the command was run from', () => {
    const cwd = join(REPOSITORY_ROOT, 'docs')

    expect(resolveSettings(['--database', 'review/trades.db'], {}, cwd).databasePath).toBe(join(cwd, 'review', 'trades.db'))
  })

  it.each([
    [['--api-port', '0'], '--api-port must be a port from 1 to 65535, got "0".'],
    [['--web-port', '70000'], '--web-port must be a port from 1 to 65535, got "70000".'],
    [['--api-port', '4173'], 'The API and the frontend need different ports; both are 4173.'],
    [['--database', ':memory:'], 'DATABASE_PATH must be a file'],
  ])('refuses %j before anything starts', (argv, message) => {
    expect(() => resolveSettings(argv, {}, REPOSITORY_ROOT)).toThrow(SettingsError)
    expect(() => resolveSettings(argv, {}, REPOSITORY_ROOT)).toThrow(message)
  })

  it('refuses an invalid SYMBOL_MAX_LENGTH the way the API would', () => {
    expect(() => resolveSettings([], { SYMBOL_MAX_LENGTH: '999' }, REPOSITORY_ROOT)).toThrow('SYMBOL_MAX_LENGTH must be an integer from 1 to 255')
  })

  it.each([['localhost', 'localhost'], ['0.0.0.0', 'localhost'], ['::', 'localhost'], ['::1', '[::1]'], ['127.0.0.1', '127.0.0.1']])(
    'opens host %s as %s', (host, expected) => {
      expect(urlHost(host)).toBe(expected)
    })
})

describe('scripts: what app:start launches', () => {
  const settings = resolveSettings(['--api-port', '5399', '--web-port', '4273', '--database', '/data/trades.db'], {}, REPOSITORY_ROOT)
  const [api, web] = launches(settings, { PATH: 'x', PORT: '1', HOST: 'elsewhere', DATABASE_PATH: '/other.db', API_TARGET: 'http://wrong', LOG_LEVEL: 'warn' })

  it('starts the API as npm start -w server does, with only the chosen address and database', () => {
    expect(json('server/package.json').scripts['start']).toBe(`node ${API_ARGS.join(' ')}`)
    expect(api?.args).toEqual(API_ARGS)
    expect(api?.cwd).toBe(join(REPOSITORY_ROOT, 'server'))
    expect(api?.env).toMatchObject({ PATH: 'x', LOG_LEVEL: 'warn', HOST: 'localhost', PORT: '5399', DATABASE_PATH: resolve('/data/trades.db') })
    expect(api?.env['API_TARGET']).toBeUndefined()
  })

  it('starts the built frontend with vite preview on its port, forwarding to the API it started', () => {
    expect(json('client/package.json').scripts['preview']).toBe('vite preview')
    expect(readFileSync(join(REPOSITORY_ROOT, 'client', 'vite.config.ts'), 'utf8')).toContain(`preview: { port: ${String(DEFAULT_WEB_PORT)}, strictPort: true`)
    expect(web?.args.slice(1)).toEqual(['preview', '--port', '4273', '--strictPort', '--host', 'localhost'])
    expect(web?.args[0]).toMatch(/vite[\\/]bin[\\/]vite\.js$/)
    expect(web?.cwd).toBe(join(REPOSITORY_ROOT, 'client'))
    expect(web?.env).toMatchObject({ PATH: 'x', API_TARGET: 'http://localhost:5399' })
    expect(web?.env['PORT']).toBeUndefined()
  })

  it('is what the npm scripts run', () => {
    const scripts = json('package.json').scripts
    for (const command of ['start', 'stop', 'status']) {
      expect(scripts[`app:${command}`]).toBe(`node --disable-warning=ExperimentalWarning server/scripts/app.ts ${command}`)
    }
  })
})

describe('scripts: the command line', () => {
  let runDir: string

  beforeEach(() => {
    runDir = createTempDir()
  })

  afterEach(() => {
    removeTempDir(runDir)
  })

  const env = (): NodeJS.ProcessEnv => ({ ...isolatedEnv({ DATABASE_PATH: join(runDir, 'unused.db') }), TRADE_BLOTTER_RUN_DIR: runDir })

  it('reports both applications stopped when nothing was started', () => {
    const result = runNode(['scripts/app.ts', 'status', '--api-port', '1', '--web-port', '2'], env(), 30_000)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('API       stopped\nFrontend  stopped\n(Not started with npm run app:start.)')
  })

  it('finds nothing to stop, as often as it is asked', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = runNode(['scripts/app.ts', 'stop'], env(), 30_000)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Nothing to stop')
    }
  })

  it('explains invalid settings and unknown commands without starting anything', () => {
    const invalid = runNode(['scripts/app.ts', 'start', '--api-port', 'x'], env(), 30_000)
    const unknownOption = runNode(['scripts/app.ts', 'start', '--port', '1'], env(), 30_000)
    const unknownCommand = runNode(['scripts/app.ts', 'restart'], env(), 30_000)

    expect([invalid.status, invalid.stderr.trim()]).toEqual([1, '--api-port must be a port from 1 to 65535, got "x".'])
    expect(unknownOption.status).toBe(2)
    expect(unknownOption.stderr).toContain("Unknown option '--port'")
    expect(unknownCommand.status).toBe(2)
    expect(unknownCommand.stderr).toContain('Usage: node scripts/app.ts start|stop|status')
  })
})
