import { writeFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeState, type AppRecord } from '../../scripts/lifecycle.ts'
import {
  BenchmarkError, findManagedApi, readSnapshot, responseDifference, runBenchmark, SCENARIOS, scenarioPath, statistics, type ManagedApi, type Scenario,
} from '../../scripts/perf-api.ts'
import { listenersOnPort, processMemory } from '../../scripts/process-probe.ts'
import { seedDatabase, type Protection } from '../../scripts/trade-data.ts'
import { loadConfig } from '../../src/config.ts'
import { createServer } from '../../src/server.ts'
import { isolatedEnv, startNode, stopChild } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * perf:api: what it measures and checks, on a real API in this process, and what it refuses.
 * No latency is asserted: the numbers depend on the machine.
 */

let dir = ''
let protection: Protection = { developmentDatabase: '', protectedFolder: '', runDir: '' }
let database = ''
let server: FastifyInstance | undefined
let api: ManagedApi = { databasePath: '', url: new URL('http://127.0.0.1'), pid: 0 }

beforeAll(async () => {
  dir = createTempDir()
  protection = { developmentDatabase: join(dir, 'data', 'trade-blotter.db'), protectedFolder: join(dir, 'data'), runDir: join(dir, 'run') }
  database = join(dir, 'perf.db')
  await seedDatabase({ path: database, count: 300, protection })
  server = await createServer(loadConfig({ DATABASE_PATH: database }), { logger: false })
  await server.listen({ host: '127.0.0.1', port: 0 })
  const { port } = server.server.address() as AddressInfo
  api = { databasePath: database, url: new URL(`http://127.0.0.1:${String(port)}`), pid: process.pid }
}, 60_000)

afterAll(async () => {
  await server?.close()
  removeTempDir(dir)
})

describe('perf:api: statistics', () => {
  it('gives the minimum, median, nearest-rank p95, maximum and mean', () => {
    expect(statistics([5, 1, 3])).toEqual({ min: 1, median: 3, p95: 5, max: 5, mean: 3 })
    expect(statistics([4, 1, 3, 2]).median).toBe(2.5)
    // Nearest rank: with 10 samples the 10th (the maximum), with 20 the 19th.
    expect(statistics([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p95).toBe(10)
    expect(statistics(Array.from({ length: 20 }, (_, index) => index + 1)).p95).toBe(19)
    expect(statistics([7])).toEqual({ min: 7, median: 7, p95: 7, max: 7, mean: 7 })
    expect(() => statistics([])).toThrow(RangeError)
  })
})

describe('perf:api: scenarios', () => {
  it('cover every search, filter and sort, and positions, with the offsets encoded', () => {
    const paths = SCENARIOS.map(scenarioPath)

    expect(paths).toHaveLength(15)
    expect(new Set(paths).size).toBe(15)
    expect(paths[0]).toBe('/trades')
    expect(paths).toContain('/trades?symbol=ms')
    expect(paths).toContain('/trades?side=Buy')
    expect(paths).toContain('/trades?side=Sell')
    expect(paths).toContain('/trades?executedFrom=2026-01-01T00%3A00%3A00.000-05%3A00&executedTo=2026-06-30T23%3A59%3A59.999-04%3A00')
    for (const field of ['executedAt', 'symbol', 'quantity', 'price']) {
      for (const direction of ['asc', 'desc']) expect(paths).toContain(`/trades?sortBy=${field}&sortDirection=${direction}`)
    }
    expect(paths.at(-1)).toBe('/positions')
  })
})

describe('perf:api: checking a response', () => {
  it('compares decimals by their exact JSON text, digits a JavaScript number would lose included', () => {
    const expected = [{ id: 'a', bookingSequence: 7, quantity: '0.12345678901234567890123', price: '100' }]

    expect(responseDifference('[{"id":"a","bookingSequence":7,"quantity":0.12345678901234567890123,"price":100}]', expected)).toBeUndefined()
    expect(responseDifference('[{"id":"a","bookingSequence":7,"quantity":0.12345678901234567890124,"price":100}]', expected))
      .toBe('row 1: quantity is "0.12345678901234567890124", expected "0.12345678901234567890123"')
    expect(responseDifference('[{"id":"a","bookingSequence":7,"quantity":0.12345678901234567890123,"price":100.0}]', expected))
      .toBe('row 1: price is "100.0", expected "100"')
    expect(responseDifference('[{"id":"a","bookingSequence":8,"quantity":0.12345678901234567890123,"price":100}]', expected)).toMatch(/bookingSequence is 8/)
    expect(responseDifference('[]', expected)).toBe('0 rows, expected 1')
    expect(responseDifference('{}', expected)).toBe('the body is not a JSON array')
    expect(responseDifference('[', expected)).toBe('the body is not JSON')
  })
})

describe('perf:api: measuring', () => {
  it('measures every scenario on the real API, checks each response against the database, and leaves the trades as they were', async () => {
    const before = await readSnapshot(database)
    const result = await runBenchmark(api, { warmup: 1, iterations: 2, memory: false })
    const matched = Object.fromEntries(result.scenarios.map((s) => [s.name, s.matchedRows]))

    expect(result.datasetTrades).toBe(300)
    expect(result.datasetUnchanged).toBe(true)
    expect(result.datasetFingerprint).toBe(before.fingerprint)
    expect((await readSnapshot(database)).fingerprint).toBe(before.fingerprint)
    expect(result.scenarios).toHaveLength(15)
    for (const scenario of result.scenarios) {
      expect(scenario.matchedRows, scenario.name).toBeGreaterThan(0)
      expect(scenario.responseBytes, scenario.name).toBeGreaterThan(0)
      expect([scenario.warmupIterations, scenario.measuredIterations]).toEqual([1, 2])
      expect(scenario.latencyMs.min).toBeLessThanOrEqual(scenario.latencyMs.max)
      expect(scenario.headersMs.median).toBeLessThanOrEqual(scenario.latencyMs.max)
      expect(scenario.serverMemoryAfter).toBeUndefined()
    }
    expect(matched['All trades (default order)']).toBe(300)
    expect((matched['Side Buy'] ?? 0) + (matched['Side Sell'] ?? 0)).toBe(300)
    expect(matched['Symbol search "ms"']).toBe(before.trades.filter((t) => ['MS', 'MSFT', 'MSTR'].includes(t.symbol)).length)
    expect(matched['"ms" + Sell + 2025-07-01 to 2026-06-30']).toBeLessThan(matched['Symbol search "ms"'] ?? 0)
  }, 60_000)

  it('refuses an API that serves other trades than the selected database holds', async () => {
    const other = join(dir, 'other.db')
    await seedDatabase({ path: other, count: 50, seed: 'other', protection })

    await expect(runBenchmark({ ...api, databasePath: other }, { warmup: 0, iterations: 1, memory: false }))
      .rejects.toThrow(/does not serve the trades in .*other\.db \(300 rows, expected 50\)\. Nothing was measured/)
  }, 30_000)

  it('stops, recording nothing, when a response is not the expected one', async () => {
    const wrong: Scenario = { kind: 'trades', name: 'Wrong expectation', query: { side: 'Buy' }, matches: (t) => t.side === 'Sell', sort: { field: 'executedAt', direction: 'desc' } }
    const recorded: string[] = []

    await expect(runBenchmark(api, { warmup: 0, iterations: 1, memory: false, scenarios: [SCENARIOS[1] as Scenario, wrong], onScenario: (s) => { recorded.push(s.name) } }))
      .rejects.toThrow(BenchmarkError)
    expect(recorded).toEqual(['Symbol search "ms"'])
  })

  it('stops when the trades change while it runs, rather than measure other data', async () => {
    const booking = async (): Promise<void> => {
      await server?.inject({ method: 'POST', url: '/trades', payload: { symbol: 'PERFTEST', side: 'Buy', quantity: '1', price: '1' } })
    }

    await expect(runBenchmark(api, { warmup: 1, iterations: 1, memory: false, scenarios: SCENARIOS.slice(0, 2), onScenario: () => { void booking() } }))
      .rejects.toThrow(/Symbol search "ms"|changed during the benchmark/)
    // Later tests in this file must not depend on the extra trade; none does.
  })
})

describe('perf:api: which API it measures', () => {
  const record = (overrides: Partial<AppRecord>): AppRecord => ({
    name: 'api', label: 'API', pid: 1, token: '00000000-0000-4000-8000-000000000000', host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1', log: join(dir, 'api.log'), ...overrides,
  })
  const recordState = (app: AppRecord, databasePath = database): void => {
    writeState(protection.runDir, { version: 1, startedAt: new Date().toISOString(), phase: 'ready', databasePath, apps: [app] })
  }
  const find = (apiUrl?: string): ManagedApi => findManagedApi({ databasePath: database, protection, ...(apiUrl === undefined ? {} : { apiUrl }) })

  /** A live process holding a token, as app:start starts it; listening on a port when asked. */
  const tokenProcess = async (token: string, listen: boolean): Promise<{ pid: number; port: number; stop: () => Promise<void> }> => {
    const script = listen
      ? "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port))"
      : "setInterval(() => {}, 1000); console.log(0)"
    const child = startNode(['-e', script, token], isolatedEnv({ DATABASE_PATH: database }))
    const port = await new Promise<number>((resolve) => { child.stdout?.once('data', (data: Buffer) => { resolve(Number(String(data).trim())) }) })
    return { pid: child.pid ?? 0, port, stop: () => stopChild(child) }
  }

  it('needs a database that is not the development database and exists', () => {
    expect(() => findManagedApi({ databasePath: undefined, protection })).toThrow('Name the database with --database <path>.')
    expect(() => findManagedApi({ databasePath: protection.developmentDatabase, protection })).toThrow(/is the development database/)
    expect(() => findManagedApi({ databasePath: join(protection.protectedFolder, 'backup.db'), protection })).toThrow(/holds the development database and its backups/)
    expect(() => findManagedApi({ databasePath: join(dir, 'missing.db'), protection })).toThrow(/does not exist/)
  })

  it('refuses when nothing was started, or the API was started on another database', () => {
    expect(() => find()).toThrow(/No application started with app:start is recorded/)
    const other = join(dir, 'other-db.db')
    writeFileSync(other, '')
    recordState(record({}), other)
    expect(() => find()).toThrow(/uses .*other-db\.db, not .*perf\.db\. Nothing was measured/)
  })

  it('refuses an API process that has exited, and a process id now used by another program', async () => {
    const exited = await tokenProcess('11111111-1111-4111-8111-111111111111', false)
    await exited.stop()
    recordState(record({ pid: exited.pid }))
    expect(() => find()).toThrow(/is not running\. Nothing was measured/)

    const stranger = await tokenProcess('not-the-recorded-token', false)
    try {
      recordState(record({ pid: stranger.pid }))
      expect(() => find()).toThrow(/its process id now belongs to another program/)
    } finally {
      await stranger.stop()
    }
  }, 30_000)

  it('measures the recorded API only when its own process is the one listening on its port', async () => {
    const token = '22222222-2222-4222-8222-222222222222'
    const listening = await tokenProcess(token, true)
    const idle = await tokenProcess('33333333-3333-4333-8333-333333333333', false)
    // A port this test process listens on, standing in for another program on the API's port.
    const impostor = createTcpServer()
    await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve))
    const impostorPort = (impostor.address() as AddressInfo).port
    try {
      const url = `http://127.0.0.1:${String(listening.port)}`
      recordState(record({ pid: listening.pid, token, port: listening.port, url }))
      expect(find()).toEqual({ databasePath: database, url: new URL(url), pid: listening.pid })
      expect(find(`http://localhost:${String(listening.port)}`).url.port).toBe(String(listening.port))
      expect(() => find('http://127.0.0.1:1')).toThrow(/is not the API started with app:start/)
      expect(() => find(`${url}/trades`)).toThrow(/must be only the API's http address/)

      recordState(record({ pid: idle.pid, token: '33333333-3333-4333-8333-333333333333', port: impostorPort, url: `http://127.0.0.1:${String(impostorPort)}` }))
      expect(() => find()).toThrow(/Another process also listens on port/)
    } finally {
      await Promise.all([listening.stop(), idle.stop(), new Promise((resolve) => impostor.close(resolve))])
    }
  }, 60_000)
})

describe('perf:api: process probes', () => {
  it('tell which process listens on a port, and how much memory a process holds', async () => {
    const listener = createTcpServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const { port } = listener.address() as AddressInfo
    try {
      expect(listenersOnPort(port, process.pid)).toBe('only')
      expect(listenersOnPort(port, process.pid + 1)).toBe('others')
    } finally {
      await new Promise((resolve) => listener.close(resolve))
    }
    expect(listenersOnPort(port, process.pid)).toBe('none')

    const memory = processMemory(process.pid)
    expect(memory?.residentBytes).toBeGreaterThan(10 * 2 ** 20)
    if (process.platform !== 'darwin') expect(memory?.peakResidentBytes).toBeGreaterThanOrEqual(memory?.residentBytes ?? 0)
  })
})
