import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isolatedEnv, runNode, SERVER_ROOT, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir, tempDirPrefix } from '../support/temp-dir.ts'

/**
 * S4: the production build (tsc, with .ts import extensions rewritten to .js) runs as plain
 * JavaScript under Node: it migrates its database at startup, serves the API and the OpenAPI
 * document, keeps trades across a restart, and refuses to start when a migration fails or a
 * required runtime feature is missing. Every database is a temporary file.
 *
 * The test compiles its own copy into `server/.test-build-*` rather than rewriting `server/dist/`,
 * which a developer may be running and another test run may be reading. The copy sits inside
 * `server/` so it resolves the same packages, with the migrations beside it as in a real build.
 */
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

/** Compiles `src/` into `<root>/dist` and copies the migrations to `<root>/drizzle`. Returns the entry point. */
function compileInto(root: string, unusedDatabase: string): string {
  const compiled = runNode([tsc, '-p', 'tsconfig.build.json', '--outDir', join(root, 'dist')], isolatedEnv({ DATABASE_PATH: unusedDatabase }), 60_000)
  if (compiled.status !== 0) throw new Error(`The build failed:\n${compiled.stdout}${compiled.stderr}`)
  cpSync(join(SERVER_ROOT, 'drizzle'), join(root, 'drizzle'), { recursive: true })
  return join(root, 'dist', 'main.js')
}

interface Started {
  readonly child: ReturnType<typeof startNode>
  readonly baseUrl: string
}

/** Starts the compiled server on a port the OS picks; resolves once it is listening. */
function startCompiledServer(main: string, databasePath: string): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = startNode([main], isolatedEnv({ DATABASE_PATH: databasePath, LOG_LEVEL: 'info', DOCS_ENABLED: 'true' }))
    let output = ''
    const onExit = (code: number | null) => {
      clearTimeout(timer)
      reject(new Error(`Server exited with ${String(code)}:\n${output}`))
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      void stopChild(child).then(() => {
        reject(new Error(`Server did not start:\n${output}`))
      })
    }, 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        child.off('exit', onExit)
        resolve({ child, baseUrl: match[1] })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
  })
}

function runToExit(main: string, settings: { DATABASE_PATH: string; SYMBOL_MAX_LENGTH?: string }, execArgv: string[] = []) {
  const result = runNode([...execArgv, main], isolatedEnv(settings))
  expect(result.timedOut, `The server should have refused to start, but was still running at the deadline.\n${result.stderr}`).toBe(false)
  return result
}

describe('platform: compiled server', () => {
  let build: string | undefined
  let dir: string | undefined
  let main: string
  let databasePath: string
  let server: Started | undefined

  beforeAll(async () => {
    dir = createTempDir()
    databasePath = join(dir, 'trade-blotter.db')
    build = mkdtempSync(join(SERVER_ROOT, `.test-build-${tempDirPrefix()}`))
    main = compileInto(build, join(dir, 'unused.db'))
    expect(existsSync(main)).toBe(true)
    server = await startCompiledServer(main, databasePath)
  }, 60_000)

  // Runs even when beforeAll failed part way, and cleans up only what this file created.
  afterAll(async () => {
    if (server !== undefined) await stopChild(server.child)
    if (dir !== undefined) removeTempDir(dir)
    if (build !== undefined) removeTempDir(build)
  })

  function running(): Started {
    if (server === undefined) throw new Error('The compiled server is not running.')
    return server
  }

  function inTempDir(name: string): string {
    if (dir === undefined) throw new Error('The temporary folder was not created.')
    return join(dir, name)
  }

  it('listens on a port the OS picked, not the development port', () => {
    expect(new URL(running().baseUrl).port).not.toBe('5299')
  })

  it('answers an unknown route with a 404 problem body', async () => {
    const response = await fetch(`${running().baseUrl}/no-such-route`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    expect(await response.json()).toMatchObject({ status: 404, title: 'Not Found' })
  })

  it('serves the generated OpenAPI document', async () => {
    const response = await fetch(`${running().baseUrl}/documentation/json`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: '3.1.0' })
  })

  it('books a trade over HTTP into the migrated database, exactly, and keeps it across a restart', async () => {
    const created = await fetch(`${running().baseUrl}/trades`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"symbol":"msft","side":"buy","quantity":123456789012345.1234567891,"price":"0.0000000001"}',
    })
    expect(created.status).toBe(201)
    expect(await created.text()).toContain('"quantity":123456789012345.1234567891,"price":0.0000000001')

    await stopChild(running().child)
    server = undefined
    server = await startCompiledServer(main, databasePath)

    const listed = await fetch(`${running().baseUrl}/trades`)
    expect(await listed.text()).toContain('"symbol":"MSFT","side":"Buy","quantity":123456789012345.1234567891')
  }, 30_000)

  it('refuses to start, with the migration error, when the database cannot be migrated', () => {
    const conflicting = inTempDir('conflicting.db')
    const existing = new DatabaseSync(conflicting)
    existing.exec(`create table trades (note text); insert into trades values ('keep me')`)
    existing.close()

    const result = runToExit(main, { DATABASE_PATH: conflicting })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Trade Blotter could not start. Database migration failed; no migration was applied.')
    const check = new DatabaseSync(conflicting)
    expect(check.prepare('select note from trades').all()).toEqual([{ note: 'keep me' }])
    check.close()
  })

  it('refuses to start, with a clear message, when the configuration is invalid', () => {
    const result = runToExit(main, { DATABASE_PATH: inTempDir('unused.db'), SYMBOL_MAX_LENGTH: '0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Trade Blotter could not start. SYMBOL_MAX_LENGTH must be an integer from 1 to 255')
  })

  it('refuses to start, with a clear message, when a required runtime feature is missing', () => {
    const result = runToExit(main, { DATABASE_PATH: inTempDir('unused.db') }, ['--import', 'data:text/javascript,delete JSON.rawJSON'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('JSON.rawJSON is not available.')
    expect(result.stderr).toContain('Use Node.js ^22.23.1.')
  })
})
