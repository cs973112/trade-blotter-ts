import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applicationFingerprint, documentationChecks, interfaceMembers, RULES, ruleChecks, testCountChecks, testCountStatements, type DocCheck,
} from '../../scripts/docs-check.ts'
import { REPOSITORY_ROOT } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * The documentation checks (server/scripts/docs-check.ts) on documents written for each test, in a
 * temporary folder holding copies of the package manifests and the frontend's contracts: each kind
 * of drift is reported, and documents that agree with the code pass. check:all runs the same
 * checks on the real documents.
 */

let root = ''

beforeEach(() => {
  root = createTempDir()
  for (const file of ['package.json', 'server/package.json', 'client/package.json', 'client/src/api/contracts.ts']) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    cpSync(join(REPOSITORY_ROOT, file), join(root, file))
  }
  mkdirSync(join(root, 'client/src/components'), { recursive: true })
  writeFileSync(join(root, 'client/src/components/Page.vue'), '<template><button>Apply</button><h2>Positions &amp; Trade Details</h2></template>\n')
  mkdirSync(join(root, 'docs/screenshots'), { recursive: true })
  writeFileSync(join(root, 'docs/screenshots/page.png'), '')
})

afterEach(() => {
  removeTempDir(root)
})

const API_TABLE = '## API\n\n| Endpoint | What |\n| --- | --- |\n| `POST /trades` | Book |\n| `GET /trades` | List |\n| `GET /trades/page` | Page |\n' +
  '| `POST /trades/{id}/execution` | Execute |\n| `POST /trades/{id}/cancellation` | Cancel |\n| `GET /trades/{id}/audit` | Audit |\n| `GET /positions` | Positions |\n\n## Next\n'
const named = (checks: DocCheck[], pattern: RegExp): DocCheck | undefined => checks.find((check) => pattern.test(check.name))

async function check(readme: string, extra: { setup?: string; architecture?: string; totals?: { server?: number; client?: number } } = {}): Promise<DocCheck[]> {
  return documentationChecks({
    root,
    documents: { 'README.md': readme, 'docs/setup.md': extra.setup ?? '', 'docs/architecture.md': extra.architecture ?? '' },
    uiLabels: ['Apply', 'Positions & Trade Details'],
    ...(extra.totals === undefined ? {} : { testTotals: extra.totals }),
  })
}

describe('documentation checks: the API', () => {
  it('passes when README documents exactly the registered routes, and the contracts match OpenAPI', async () => {
    const checks = await check(`${API_TABLE}Apply, Positions & Trade Details.`)

    expect(named(checks, /^API endpoints: all 7 documented/)?.status).toBe('PASS')
    expect(named(checks, /^API endpoints: all 7 registered/)?.status).toBe('PASS')
    for (const contract of ['CreateTradeRequest', 'Trade', 'Position', 'TradePage', 'CancellationRequest', 'Cancellation', 'AuditTradeSnapshot', 'AuditEntry', 'AuditPage']) expect(named(checks, new RegExp(`^Contract ${contract} matches`))?.status, contract).toBe('PASS')
    expect(named(checks, /^Query parameters of GET \/trades:/)?.status).toBe('PASS')
    expect(named(checks, /^Query parameters of GET \/trades\/page:/)?.status).toBe('PASS')
  })

  it('reports an endpoint documented but not registered, and a route missing from the table', async () => {
    const checks = await check(API_TABLE.replace('| `GET /positions` | Positions |\n', '| `DELETE /trades/{id}` | Cancel |\n'))

    expect(named(checks, /documented but not registered/)).toMatchObject({ status: 'FAIL', detail: 'DELETE /trades/{id} (README.md)' })
    expect(named(checks, /missing from README/)).toMatchObject({ status: 'FAIL', detail: 'GET /positions' })
  })

  it('reports a frontend contract that no longer matches OpenAPI', async () => {
    const path = join(root, 'client/src/api/contracts.ts')
    writeFileSync(path, readFileSync(path, 'utf8').replace('  readonly notional: DecimalText\n', '  readonly notional?: DecimalText\n  readonly lastTraded: string\n'))

    const failed = named(await check(API_TABLE), /^Contract Trade differs/)

    expect(failed?.status).toBe('FAIL')
    expect(failed?.detail).toBe('lastTraded: in the frontend\'s contract, not in OpenAPI\nnotional: optional in the frontend\'s contract, required in OpenAPI')
  })

  it('reads the members of each exported interface, and which are optional', () => {
    const members = interfaceMembers('export interface A {\n  readonly x: string\n  /** y */\n  readonly y?: number\n}\nexport interface B extends A {\n  readonly z: boolean\n}\n')

    expect([...(members.get('A') ?? [])]).toEqual([['x', false], ['y', true]])
    expect([...(members.get('B') ?? [])]).toEqual([['z', false]])
  })
})

describe('documentation checks: commands, labels, links', () => {
  it('reports an npm script that does not exist, or not in the workspace named', async () => {
    const checks = await check(`${API_TABLE}Run \`npm run review:01\`, \`npm run check:all -- --quick\`, \`npm run db:check -w server\`,\n\`npm run review:99\` and \`npm run db:check\`.`)

    expect(named(checks, /^Commands documented but not defined/)).toMatchObject({ status: 'FAIL', detail: 'npm run review:99 (README.md)\nnpm run db:check (README.md)' })
  })

  it('passes commands that exist', async () => {
    expect(named(await check(`${API_TABLE}\`npm run check:all\`, \`npm run check:docs\`, \`npm run test -w client\``), /^Commands/)?.status).toBe('PASS')
  })

  it('reports a UI label the page no longer shows, and one the documents no longer quote', async () => {
    writeFileSync(join(root, 'client/src/components/Page.vue'), '<template><button>Apply filters</button></template>\n')

    const failed = named(await check(`${API_TABLE}Choose Apply.`), /^UI labels out of date/)

    expect(failed?.detail).toBe('"Positions & Trade Details": in README, but not in client/src\n"Positions & Trade Details": no longer in README; update UI_LABELS in server/scripts/docs-check.ts')
  })

  it('reports a linked file or screenshot that does not exist, and ignores URLs and anchors', async () => {
    const readme = `${API_TABLE}![Page](docs/screenshots/page.png) ![Gone](docs/screenshots/gone.png) [setup](docs/setup.md#prerequisites) [web](https://example.com/x.png) [here](#api) [Z|±HH:MM](Z|±HH:MM)`
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/setup.md'), '')

    expect(named(await check(readme), /^Links/)).toMatchObject({ status: 'FAIL', detail: 'docs/screenshots/gone.png (linked from README.md)' })
  })
})

describe('documentation checks: business rules', () => {
  it('passes when each stated value matches the code, with statements wrapped across lines', () => {
    const documents = { 'README.md': '', 'docs/setup.md': '', 'docs/architecture.md': '' } as Record<string, string>
    // Each rule's statement, written as the real documents write it, from the values the code enforces.
    const real = Object.fromEntries(['README.md', 'docs/setup.md', 'docs/architecture.md'].map((path) => [path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8')]))

    expect(ruleChecks(real)[0]?.status).toBe('PASS')
    expect(ruleChecks(documents)[0]?.status).toBe('FAIL')
  })

  it('reports a value stated differently, and a statement no longer found', () => {
    const rules = RULES.filter((rule) => rule.name === 'Page size range and default' || rule.name === 'At most 10 decimal places')
    const [result] = ruleChecks({ 'README.md': '`pageSize` (1 to\n200, default 50)' }, rules)

    expect(result?.status).toBe('FAIL')
    expect(result?.detail).toMatch(/^At most 10 decimal places: the statement was not found in README\.md/)
    expect(result?.detail).toMatch(/Page size range and default: README\.md says 200,50, the code enforces 100,50$/)
  })
})

describe('documentation checks: counts and measurements that go out of date', () => {
  const documents = {
    'README.md': '| `npm test` | Every test (1,575 API and tool tests and 406 frontend tests, on 2026-11-20) |\n\nAll 1,575 API and tool tests passed.\n',
    'docs/setup.md': 'npm test -w server # API and tool tests (1,575 on 2026-11-20: 1,574 run)\nnpm test -w client # frontend tests (406)\n',
  }

  it('finds each count, and whether its paragraph or table row carries a date', () => {
    expect(testCountStatements(documents).map((statement) => [statement.document, statement.suite, statement.count, statement.dated])).toEqual([
      ['README.md', 'server', 1575, true], ['README.md', 'client', 406, true], ['README.md', 'server', 1575, false],
      ['docs/setup.md', 'server', 1575, true], ['docs/setup.md', 'client', 406, true],
    ])
  })

  it('passes counts that match this run, warns on dated ones that differ, and fails undated ones that differ', () => {
    expect(testCountChecks(documents, { server: 1575, client: 406 })).toEqual([{ status: 'PASS', name: 'Test counts: all 5 match this run\'s' }])
    expect(testCountChecks({ 'README.md': 'On 2026-11-20: 1,575 API and tool tests.' }, { server: 1600 })[0]?.status).toBe('WARN')
    expect(testCountChecks(documents, { server: 1600, client: 406 })[0]).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/^README\.md: "1,575 API and tool tests", this run has 1,600/) as unknown })
  })

  it('without this run\'s totals, accepts dated counts and fails undated ones', () => {
    expect(testCountChecks({ 'README.md': 'On 2026-11-20: 1,575 API and tool tests.' }, undefined)[0]?.status).toBe('PASS')
    expect(testCountChecks({ 'README.md': '1,575 API and tool tests.' }, undefined)[0]?.status).toBe('FAIL')
  })

  it('passes benchmark figures that name this application source, warns on another, fails on none', async () => {
    mkdirSync(join(root, 'server/src'), { recursive: true })
    writeFileSync(join(root, 'server/src/main.ts'), 'export {}\r\n')
    const fingerprint = applicationFingerprint(root)
    const performance = (text: string): string => `${API_TABLE}## Performance\n\n${text}\n\n## After\n`

    expect(named(await check(performance(`Measured on application source fingerprint \`${fingerprint}\`.`)), /^Benchmark/)?.status).toBe('PASS')
    expect(named(await check(performance('Measured on application source fingerprint `0123456789ab`.')), /^Benchmark/)).toMatchObject({ status: 'WARN', detail: expect.stringContaining(`the source is now ${fingerprint}`) as unknown })
    expect(named(await check(performance('Measured some time.')), /^Benchmark/)?.status).toBe('FAIL')
    // The same on every platform: line endings do not change it.
    writeFileSync(join(root, 'server/src/main.ts'), 'export {}\n')
    expect(applicationFingerprint(root)).toBe(fingerprint)
  })
})
