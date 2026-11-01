import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'

import { loadConfig } from '../../src/config.ts'
import { createServer } from '../../src/server.ts'
import { createTestServer } from '../support/app.ts'
import { postTrade } from '../support/http.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

let dir: string
/** Apps a test created, closed after it whether it passed or failed, so the folder can be removed. */
const opened: FastifyInstance[] = []

beforeEach(() => {
  dir = createTempDir()
})

afterEach(async () => {
  for (const app of opened.splice(0)) await app.close()
  removeTempDir(dir)
})

const tables = (path: string): unknown[] => {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all()
  } finally {
    db.close()
  }
}

describe('startup and shutdown', () => {
  it('migrates an empty database before serving requests', async () => {
    const path = join(dir, 'new', 'trade-blotter.db')

    const app = await createServer(loadConfig({ DATABASE_PATH: path }), { logger: false })
    opened.push(app)

    expect(tables(path)).toEqual([{ name: '__drizzle_migrations' }, { name: 'trades' }])
    expect((await app.inject({ method: 'GET', url: '/trades' })).body).toBe('[]')
    await app.close()
  })

  it('refuses to start when a migration fails, leaving the database untouched and serving nothing', async () => {
    const path = join(dir, 'conflicting.db')
    const existing = new DatabaseSync(path)
    existing.exec(`create table trades (note text); insert into trades values ('keep me')`)
    existing.close()

    await expect(createServer(loadConfig({ DATABASE_PATH: path }), { logger: false }))
      .rejects.toThrow('Database migration failed; no migration was applied. table `trades` already exists')

    const check = new DatabaseSync(path)
    expect(check.prepare('select note from trades').all()).toEqual([{ note: 'keep me' }])
    check.close()
    // The failed startup closed its connection: the file is not held open.
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  it('keeps trades across a restart and continues the booking sequence', async () => {
    const server = await createTestServer()
    onTestFinished(() => server.dispose())
    await postTrade(server.app, '{"symbol":"A","side":"Buy","quantity":0.1,"price":"0.0000000001"}')
    const before = (await server.app.inject({ method: 'GET', url: '/trades' })).body

    const app = await server.restart()

    expect((await app.inject({ method: 'GET', url: '/trades' })).body).toBe(before)
    expect((await postTrade(app, '{"symbol":"A","side":"Buy","quantity":1,"price":1}')).json()).toMatchObject({ bookingSequence: 2 })
  })

  it('closes the database when the app closes', async () => {
    const path = join(dir, 'trade-blotter.db')
    const app = await createServer(loadConfig({ DATABASE_PATH: path }), { logger: false })
    opened.push(app)
    await postTrade(app, '{"symbol":"A","side":"Buy","quantity":1,"price":1}')
    expect(existsSync(`${path}-wal`)).toBe(true)

    await app.close()

    // SQLite checkpoints and removes the write-ahead log when the last connection closes.
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect((await new Promise<number>((resolve) => {
      const db = new DatabaseSync(path)
      resolve((db.prepare('select count(*) as count from trades').get() as { count: number }).count)
      db.close()
    }))).toBe(1)
  })

  it('finishes a request already in progress before closing the database', async () => {
    const path = join(dir, 'trade-blotter.db')
    const app = await createServer(loadConfig({ DATABASE_PATH: path }), { logger: false })
    opened.push(app)
    // Hold the request inside the server until shutdown has begun.
    let entered = (): void => undefined
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    app.addHook('preHandler', async () => {
      entered()
      await gate
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })

    const request = fetch(`${address}/trades`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: '{"symbol":"A","side":"Buy","quantity":1,"price":1}',
    })
    await inside
    const closing = app.close()
    release()

    expect((await request).status).toBe(201)
    await closing
    expect(existsSync(`${path}-wal`)).toBe(false)
    const db = new DatabaseSync(path)
    expect(db.prepare('select count(*) as count from trades').get()).toEqual({ count: 1 })
    db.close()
  })

  it('applies the configured maximum symbol length', async () => {
    const server = await createTestServer({ SYMBOL_MAX_LENGTH: '3' })
    onTestFinished(() => server.dispose())

    const response = await postTrade(server.app, '{"symbol":"ABCD","side":"Buy","quantity":1,"price":1}')

    expect(response.json()).toMatchObject({ errors: { symbol: ['Symbol must be at most 3 characters.'] } })
  })
})
