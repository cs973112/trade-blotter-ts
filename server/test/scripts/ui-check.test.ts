import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UI_CHECK_WIDTHS, frontendServer } from '../../scripts/ui-check.ts'
import {
  UI_DETAIL_COUNTS, UI_OPEN_POSITIONS, uiBenchmarkPositionCount, uiCheckPositions, uiCheckTrades, uiDetailPositions, uiDetailTrades, writeBenchmarkDatabase,
  writeUiCheckDatabase, writeUiDetailDatabase,
} from '../../scripts/ui-check-data.ts'
import { readSnapshot } from '../../scripts/perf-api.ts'
import { notional } from '../../src/domain/trade.ts'
import { calculatePositions } from '../../src/domain/position.ts'
import { closeDatabase, openDatabase } from '../../src/infrastructure/database/connection.ts'
import { createDrizzleTradeRepository } from '../../src/infrastructure/drizzle-trade-repository.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/** The UI checks' own dataset, and the server that gives the browser the built frontend and the API. */

let dir = ''

beforeEach(() => {
  dir = createTempDir()
})

afterEach(() => {
  removeTempDir(dir)
})

describe('UI check dataset', () => {
  it('is the same on every run: fixed ids, times and values', () => {
    const first = uiCheckTrades()
    expect(uiCheckTrades()).toEqual(first)
    expect(new Set(first.map((trade) => trade.id)).size).toBe(first.length)
    expect(first.map((trade) => trade.executedAt)).toEqual([...first.map((trade) => trade.executedAt)].sort())
    expect(first[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000001', executedAt: '2026-01-05T14:30:00.000Z', createdAt: '2026-01-05T14:30:30.000Z' })
  })

  it('has more open positions than the grid shows at once, long and short, and leaves closed symbols out', () => {
    const positions = uiCheckPositions()
    expect(UI_OPEN_POSITIONS).toBeGreaterThanOrEqual(35)
    expect(positions).toHaveLength(UI_OPEN_POSITIONS)
    expect(positions.map((position) => position.symbol)).toEqual(Array.from({ length: 40 }, (_, index) => `POS${String(index + 1).padStart(2, '0')}`))
    const shorts = positions.filter((position) => position.netQuantity.isNegative()).length
    expect(shorts).toBeGreaterThan(5)
    expect(shorts).toBeLessThan(UI_OPEN_POSITIONS - 5)
    expect(uiCheckTrades().some((trade) => trade.symbol.startsWith('FLAT'))).toBe(true)
  })

  it('carries exact decimals a JavaScript number would change', () => {
    const [first, second] = uiCheckPositions()
    expect(first?.averageCost.toFixed()).toBe('1.6666666666666666666666666666666666666666666666667')
    expect(second?.netQuantity.toFixed()).toBe('123456789012375.1234567891')
  })

  it('is written to a new database, migrated, as the API reads it', async () => {
    const path = join(dir, 'ui.db')
    writeUiCheckDatabase(path)
    const db = openDatabase(path)
    try {
      const stored = await createDrizzleTradeRepository(db).listInTradeOrder()
      expect(stored).toHaveLength(uiCheckTrades().length)
      expect(calculatePositions(stored).map((position) => `${position.symbol} ${position.netQuantity.toFixed()} ${position.averageCost.toFixed()}`))
        .toEqual(uiCheckPositions().map((position) => `${position.symbol} ${position.netQuantity.toFixed()} ${position.averageCost.toFixed()}`))
    } finally {
      closeDatabase(db)
    }
  })

  it('covers the three widths the layout is checked at', () => {
    expect(UI_CHECK_WIDTHS).toEqual([1280, 768, 390])
  })
})

describe('Positions & Trade Details dataset', () => {
  it('is the same on every run, with ids and times of its own, apart from the 40-position dataset', () => {
    const first = uiDetailTrades()
    expect(uiDetailTrades()).toEqual(first)
    expect(new Set(first.map((trade) => trade.id)).size).toBe(first.length)
    const other = new Set(uiCheckTrades().map((trade) => trade.id))
    expect(first.some((trade) => other.has(trade.id))).toBe(false)
    expect(first.map((trade) => trade.executedAt)).toEqual([...first.map((trade) => trade.executedAt)].sort())
    // The 40-position dataset is as it was.
    expect(uiCheckTrades()).toHaveLength(203)
    expect(uiCheckPositions()).toHaveLength(40)
  })

  it('has symbols that contain one another, each open, and enough MS trades for three pages of 25', () => {
    const counts: Record<string, number> = {}
    for (const trade of uiDetailTrades()) counts[trade.symbol] = (counts[trade.symbol] ?? 0) + 1
    expect(counts).toEqual(UI_DETAIL_COUNTS)
    expect(UI_DETAIL_COUNTS['MS']).toBeGreaterThan(50)
    const symbols = uiDetailPositions().map((position) => position.symbol)
    expect(symbols).toEqual(['AMS', 'MS', 'MSFT', 'MSTR', 'MSXLONGSYMBOLNAMEFORLAYOUTCHECKS'])
    // A search for MS within symbols would list every one of them; only the exact match is MS alone.
    expect(symbols.filter((symbol) => symbol.includes('MS'))).toHaveLength(5)
    expect(uiDetailPositions().some((position) => position.netQuantity.isNegative())).toBe(true)
  })

  it('has prices and notionals whose 2 places depend on rounding half to even', () => {
    const ms = uiDetailTrades().filter((trade) => trade.symbol === 'MS')
    expect(ms.map((trade) => trade.price.toFixed())).toEqual(expect.arrayContaining(['90.125', '90.135']))
    expect(ms.map((trade) => notional(trade).toFixed())).toContain('270.405')
  })

  it('is written to a new database as the API reads it', async () => {
    const path = join(dir, 'detail.db')
    writeUiDetailDatabase(path)
    const db = openDatabase(path)
    try {
      const stored = await createDrizzleTradeRepository(db).listInTradeOrder()
      expect(stored).toHaveLength(uiDetailTrades().length)
      expect(calculatePositions(stored).map((position) => `${position.symbol} ${position.netQuantity.toFixed()} ${position.averageCost.toFixed()}`))
        .toEqual(uiDetailPositions().map((position) => `${position.symbol} ${position.netQuantity.toFixed()} ${position.averageCost.toFixed()}`))
    } finally {
      closeDatabase(db)
    }
  })
})

describe('the benchmark dataset, for the grids at its scale', () => {
  it('is written to a database of the checks\' own: exactly the reviewer\'s 25,000 trades (dataset version 2), with their 167 open positions', async () => {
    const path = join(dir, 'benchmark.db')
    writeBenchmarkDatabase(path)
    const snapshot = await readSnapshot(path)
    expect(snapshot.trades).toHaveLength(25_000)
    expect(snapshot.fingerprint).toBe('34f76ee8bb722c7f5e8af1645025b0cb28839b6d59269709aee5d349c6548885')
    expect(calculatePositions(snapshot.trades)).toHaveLength(uiBenchmarkPositionCount())
    expect(uiBenchmarkPositionCount()).toBe(167)
  }, 60_000)
})

describe('UI check frontend server', () => {
  let api: Server | undefined
  const seen: string[] = []

  afterEach(async () => {
    await new Promise<void>((resolveClose) => { if (api) api.close(() => { resolveClose() }); else resolveClose() })
    api = undefined
    seen.length = 0
  })

  async function serve(delayFor?: (url: URL) => number) {
    const dist = join(dir, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'secret.txt'), 'not served')
    api = createHttpServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        seen.push(`${request.method ?? ''} ${request.url ?? ''} ${request.headers['content-type'] ?? ''} ${body}`)
        response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"price":999999999999999.9999999999}')
      })
    })
    await new Promise<void>((resolveListen) => { api?.listen(0, '127.0.0.1', resolveListen) })
    const { port } = api.address() as AddressInfo
    return frontendServer(dist, `http://127.0.0.1:${String(port)}`, delayFor === undefined ? {} : { delayFor })
  }

  it('serves the built files, and index.html for any other path, never a file outside the build', async () => {
    const frontend = await serve()
    try {
      const page = await fetch(frontend.url)
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(await page.text()).toContain('<title>app</title>')
      const script = await fetch(new URL('assets/app.js', frontend.url))
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(await script.text()).toBe('console.log(1)')
      expect(await (await fetch(new URL('somewhere/else', frontend.url))).text()).toContain('<title>app</title>')
      expect(await (await fetch(new URL('/%2e%2e/secret.txt', frontend.url))).text()).not.toContain('not served')
    } finally {
      await frontend.close()
    }
  })

  it('holds back the API requests a check chooses, so their answers arrive after later ones', async () => {
    const frontend = await serve((url) => url.searchParams.get('symbol') === 'MSFT' ? 300 : 0)
    try {
      const order: string[] = []
      await Promise.all([
        fetch(new URL('/trades/page?symbol=MSFT&symbolMatch=exact&page=1&pageSize=25', frontend.url)).then(() => order.push('MSFT')),
        new Promise((resolveLater) => setTimeout(resolveLater, 20)).then(() => fetch(new URL('/trades/page?symbol=MS&symbolMatch=exact&page=1&pageSize=25', frontend.url)))
          .then(() => order.push('MS')),
      ])
      expect(order).toEqual(['MS', 'MSFT'])
    } finally {
      await frontend.close()
    }
  })

  it('forwards the API\'s paths with their query, method, content type and body, and returns its answer unchanged', async () => {
    const frontend = await serve()
    try {
      const listed = await fetch(new URL('/trades/page?symbol=ms&symbolMatch=exact&page=2', frontend.url))
      expect(listed.status).toBe(200)
      expect(await listed.text()).toBe('{"price":999999999999999.9999999999}')
      const booked = await fetch(new URL('/trades', frontend.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"symbol":"MS"}' })
      expect(booked.status).toBe(201)
      await fetch(new URL('/positions', frontend.url))
      expect(seen).toEqual([
        'GET /trades/page?symbol=ms&symbolMatch=exact&page=2  ',
        'POST /trades application/json {"symbol":"MS"}',
        'GET /positions  ',
      ])
    } finally {
      await frontend.close()
    }
  })
})
