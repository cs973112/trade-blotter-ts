import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { argv } from 'node:process'

import { buildApp, type AppServices } from '../src/api/app.ts'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TRADE_SORT_FIELDS } from '../src/domain/trade-query.ts'
import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS, NET_QUANTITY_LIMIT } from '../src/domain/decimal.ts'
import { TRADE_SIDES } from '../src/domain/trade.ts'
import { SUPPORTED_NODE_VERSIONS, SUPPORTED_NPM_VERSION, SUPPORTED_SQLITE_VERSION } from '../src/platform.ts'
import { REPOSITORY_ROOT } from './lifecycle.ts'
import { BENCHMARK_COUNT, SCRATCH_COUNT } from './review-context.ts'
import { VERIFIED_NODE_VERSIONS } from './review-steps.ts'
import { DATASET_VERSION } from './seed-data.ts'

/**
 * Documentation consistency (npm run check:docs, and a category of check:all): README.md,
 * docs/setup.md and docs/architecture.md against the code they describe. Every check reads files
 * and builds the API in memory (no database, nothing listens); nothing is written.
 *
 * - API endpoints: each one documented is registered, and each registered one is in README's table.
 * - OpenAPI and the frontend's contracts (client/src/api/contracts.ts) name the same fields.
 * - Every `npm run <script>` in the documents exists, in the workspace named.
 * - UI labels the documents quote are on the page.
 * - Business rules the documents state match the constants that enforce them.
 * - Every linked file and screenshot exists.
 * - Test counts match this run's (when check:all ran the tests) or are dated.
 * - The benchmark figures name the application source they were measured on, and it is this one.
 */

export type DocStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED'

export interface DocCheck {
  readonly status: DocStatus
  readonly name: string
  readonly detail?: string
}

export const DOCUMENTS = ['README.md', 'docs/setup.md', 'docs/architecture.md'] as const

export interface DocsOptions {
  readonly root?: string
  /** Document text by path, instead of reading the files (tests). */
  readonly documents?: Readonly<Record<string, string>>
  /** This run's test totals, when the tests ran; otherwise counts are only checked for a date. */
  readonly testTotals?: { readonly server?: number; readonly client?: number }
  /** The UI labels to look for; tests pass their own. */
  readonly uiLabels?: readonly string[]
}

/** Labels the documents quote and the page must show. */
export const UI_LABELS = [
  'Trading', 'Positions & Trade Details', 'Trade History', 'Positions', 'Columns', 'Show all columns', 'Restore default columns',
  'Exact values', 'Previous', 'Next', 'Apply', 'Clear', 'No trades match these filters.',
] as const

/** Whitespace collapsed, so a sentence wrapped across lines still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export async function documentationChecks(options: DocsOptions = {}): Promise<DocCheck[]> {
  const root = options.root ?? REPOSITORY_ROOT
  const documents: Record<string, string> = {}
  const checks: DocCheck[] = []
  for (const path of DOCUMENTS) {
    const text = options.documents?.[path] ?? (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined)
    if (text === undefined) checks.push({ status: 'FAIL', name: `Document ${path}`, detail: 'missing' })
    else documents[path] = text
  }
  const readme = documents['README.md'] ?? ''

  for (const check of [
    () => endpointChecks(documents, readme),
    () => contractChecks(root),
    () => [commandCheck(root, documents)],
    () => [labelCheck(root, readme, options.uiLabels ?? UI_LABELS)],
    () => ruleChecks(documents),
    () => [linkCheck(root, documents)],
    () => testCountChecks(documents, options.testTotals),
    () => [benchmarkCheck(root, readme)],
  ]) {
    try {
      checks.push(...await check())
    } catch (error) {
      checks.push({ status: 'FAIL', name: 'Documentation check could not run', detail: message(error) })
    }
  }
  return checks
}

// ---------------------------------------------------------------------------------------------
// The API: routes and contracts

interface OpenApi {
  readonly paths: Record<string, Record<string, { readonly parameters?: readonly { readonly name: string; readonly in: string }[] }>>
  readonly components: { readonly schemas: Record<string, { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] }> }
}

/** The OpenAPI document of the application as composed, without services, a database or a port. */
async function openApi(): Promise<{ readonly document: OpenApi; readonly hasRoute: (method: string, url: string) => boolean; readonly close: () => Promise<void> }> {
  const app = await buildApp({ logger: false, docs: true, services: {} as unknown as AppServices })
  await app.ready()
  const response = await app.inject({ method: 'GET', url: '/documentation/json' })
  return {
    document: response.json<OpenApi>(),
    // Documents write paths as OpenAPI does (/trades/{id}/audit); Fastify registers them as /trades/:id/audit.
    hasRoute: (method, url) => app.hasRoute({ method, url: url.replace(/\{(\w+)\}/g, ':$1') }),
    close: () => app.close(),
  }
}

/** The text of a level-two section, from its heading to the next one; empty when there is none. */
export function section(markdown: string, title: string): string {
  const start = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(markdown)
  if (start === null) return ''
  const rest = markdown.slice(start.index + start[0].length)
  const end = /^## /m.exec(rest)
  return `${start[0]}${end === null ? rest : rest.slice(0, end.index)}`
}

const ENDPOINT = /`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s?]*)`/g

async function endpointChecks(documents: Record<string, string>, readme: string): Promise<DocCheck[]> {
  const api = await openApi()
  try {
    const registered = Object.entries(api.document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    const documented = new Map<string, string[]>()
    for (const [path, text] of Object.entries(documents)) {
      for (const [, method = '', url = ''] of text.matchAll(ENDPOINT)) documented.set(`${method} ${url}`, [...(documented.get(`${method} ${url}`) ?? []), path])
    }
    const unknown = [...documented.entries()].filter(([endpoint]) => {
      const [method = '', url = ''] = endpoint.split(' ')
      return !api.hasRoute(method, url)
    })
    const table = section(readme, 'API')
    const undocumented = registered.filter((endpoint) => !table.includes(`\`${endpoint}\``))
    return [
      unknown.length === 0
        ? { status: 'PASS', name: `API endpoints: all ${String(documented.size)} documented endpoints are registered routes`, detail: [...documented.keys()].join(', ') }
        : { status: 'FAIL', name: 'API endpoints documented but not registered', detail: unknown.map(([endpoint, paths]) => `${endpoint} (${[...new Set(paths)].join(', ')})`).join('\n') },
      undocumented.length === 0
        ? { status: 'PASS', name: `API endpoints: all ${String(registered.length)} registered routes are in README's API table`, detail: registered.join(', ') }
        : { status: 'FAIL', name: 'API routes missing from README\'s API table', detail: undocumented.join('\n') },
    ]
  } finally {
    await api.close()
  }
}

/** The members of each exported interface in a TypeScript file, with whether each is optional. */
export function interfaceMembers(source: string): Map<string, Map<string, boolean>> {
  const interfaces = new Map<string, Map<string, boolean>>()
  for (const [, name = '', body = ''] of source.matchAll(/export interface (\w+)(?: extends [\w, ]+)? \{([\s\S]*?)\n\}/g)) {
    const members = new Map<string, boolean>()
    for (const [, member = '', optional] of body.matchAll(/^\s*readonly (\w+)(\?)?:/gm)) members.set(member, optional === '?')
    interfaces.set(name, members)
  }
  return interfaces
}

/** Frontend interface, OpenAPI schema. */
const CONTRACTS = [
  ['CreateTradeRequest', 'CreateTradeRequest'], ['Trade', 'Trade'], ['Position', 'Position'], ['TradePage', 'TradePage'],
  ['CancellationRequest', 'CancellationRequest'], ['Cancellation', 'Cancellation'], ['AuditTradeSnapshot', 'AuditTradeSnapshot'],
  ['AuditEntry', 'AuditEntry'], ['AuditPage', 'AuditPage'],
] as const

async function contractChecks(root: string): Promise<DocCheck[]> {
  const path = join(root, 'client/src/api/contracts.ts')
  const source = readFileSync(path, 'utf8')
  const interfaces = interfaceMembers(source)
  const api = await openApi()
  try {
    const checks: DocCheck[] = []
    for (const [client, schemaName] of CONTRACTS) {
      const members = interfaces.get(client)
      const schema = api.document.components.schemas[schemaName]
      if (members === undefined || schema?.properties === undefined) {
        checks.push({ status: 'FAIL', name: `Contract ${client} / OpenAPI ${schemaName}`, detail: `${members === undefined ? `no interface ${client} in ${path}` : ''} ${schema === undefined ? `no schema ${schemaName} in the OpenAPI document` : ''}`.trim() })
        continue
      }
      const fields = Object.keys(schema.properties)
      const required = new Set(schema.required ?? [])
      const problems = [
        ...fields.filter((field) => !members.has(field)).map((field) => `${field}: in OpenAPI, not in the frontend's contract`),
        ...[...members.keys()].filter((field) => !fields.includes(field)).map((field) => `${field}: in the frontend's contract, not in OpenAPI`),
        ...[...members.entries()].filter(([field, optional]) => fields.includes(field) && optional === required.has(field))
          .map(([field, optional]) => `${field}: ${optional ? 'optional' : 'required'} in the frontend's contract, ${required.has(field) ? 'required' : 'optional'} in OpenAPI`),
      ]
      checks.push(problems.length === 0
        ? { status: 'PASS', name: `Contract ${client} matches OpenAPI ${schemaName}: ${String(fields.length)} fields, the same ones required` }
        : { status: 'FAIL', name: `Contract ${client} differs from OpenAPI ${schemaName}`, detail: problems.join('\n') })
    }
    for (const [constant, route] of [['TRADE_QUERY_PARAMETERS', '/trades'], ['TRADE_PAGE_QUERY_PARAMETERS', '/trades/page']] as const) {
      const listed = new RegExp(`export const ${constant} = \\[([^\\]]*)\\]`).exec(source)?.[1]
      const own = [...(listed ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1] ?? '')
      const spread = (listed ?? '').includes('...TRADE_QUERY_PARAMETERS') ? [...(/export const TRADE_QUERY_PARAMETERS = \[([^\]]*)\]/.exec(source)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1] ?? '') : []
      const client = [...spread, ...own]
      const server = (api.document.paths[route]?.['get']?.parameters ?? []).filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name)
      checks.push(client.join(',') === server.join(',')
        ? { status: 'PASS', name: `Query parameters of GET ${route}: the frontend's ${constant} lists OpenAPI's ${String(server.length)}, in order` }
        : { status: 'FAIL', name: `Query parameters of GET ${route} differ`, detail: `frontend ${client.join(', ')}\nOpenAPI ${server.join(', ')}` })
    }
    return checks
  } finally {
    await api.close()
  }
}

// ---------------------------------------------------------------------------------------------
// Commands, labels, rules, links

function commandCheck(root: string, documents: Record<string, string>): DocCheck {
  const scripts = (path: string): Set<string> => new Set(Object.keys((JSON.parse(readFileSync(join(root, path), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}))
  const byWorkspace: Record<string, Set<string>> = { '': scripts('package.json'), server: scripts('server/package.json'), client: scripts('client/package.json') }
  const found = new Set<string>()
  const missing: string[] = []
  for (const [path, text] of Object.entries(documents)) {
    for (const [, script = '', workspace = ''] of flat(text).matchAll(/npm run ([a-z0-9][\w:.-]*)(?: (?:-w|--workspace)[ =](server|client))?/g)) {
      const command = `npm run ${script}${workspace === '' ? '' : ` -w ${workspace}`}`
      found.add(command)
      if (!(byWorkspace[workspace]?.has(script) ?? false)) missing.push(`${command} (${path})`)
    }
  }
  return missing.length === 0
    ? { status: 'PASS', name: `Commands: all ${String(found.size)} npm scripts the documents name exist`, detail: [...found].sort().join(', ') }
    : { status: 'FAIL', name: 'Commands documented but not defined in package.json', detail: [...new Set(missing)].join('\n') }
}

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path, extensions)
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
}

function labelCheck(root: string, readme: string, labels: readonly string[]): DocCheck {
  const ui = sourceFiles(join(root, 'client/src'), ['.vue', '.ts']).map((path) => readFileSync(path, 'utf8')).join('\n').replaceAll('&amp;', '&')
  const text = flat(readme)
  const notDocumented = labels.filter((label) => !text.includes(label))
  const notOnPage = labels.filter((label) => !ui.includes(label))
  if (notDocumented.length === 0 && notOnPage.length === 0) return { status: 'PASS', name: `UI labels: all ${String(labels.length)} quoted in README are in the frontend`, detail: labels.join(', ') }
  return { status: 'FAIL', name: 'UI labels out of date', detail: [
    ...notOnPage.map((label) => `"${label}": in README, but not in client/src`),
    ...notDocumented.map((label) => `"${label}": no longer in README; update UI_LABELS in server/scripts/docs-check.ts`),
  ].join('\n') }
}

interface Rule {
  readonly name: string
  readonly document: (typeof DOCUMENTS)[number]
  readonly pattern: RegExp
  /** What the captured groups must read, joined with commas. */
  readonly expected: string
}

export const RULES: readonly Rule[] = [
  { name: 'Quantity and price below 10^15', document: 'README.md', pattern: /less than 10\^(\d+)/, expected: String(MAX_INTEGER_DIGITS) },
  { name: 'At most 10 decimal places', document: 'README.md', pattern: /with at most (\d+) decimal places/, expected: String(MAX_DECIMAL_PLACES) },
  { name: 'Input range in the architecture', document: 'docs/architecture.md', pattern: /\| Input range \| Greater than 0 and less than 10\^(\d+) \|/, expected: String(MAX_INTEGER_DIGITS) },
  { name: 'Input scale in the architecture', document: 'docs/architecture.md', pattern: /\| Input scale \| At most (\d+) decimal places/, expected: String(MAX_DECIMAL_PLACES) },
  { name: 'Position limit 10^30', document: 'README.md', pattern: /position to 10\^(\d+) or beyond/, expected: String(Math.log10(Number(NET_QUANTITY_LIMIT))) },
  { name: 'Net quantity limit in the architecture', document: 'docs/architecture.md', pattern: /\| Net quantity limit \| Magnitude below 10\^(\d+) \|/, expected: String(Math.log10(Number(NET_QUANTITY_LIMIT))) },
  { name: 'Page size range and default', document: 'README.md', pattern: /`pageSize` \(1 to (\d+), default (\d+)\)/, expected: `${String(MAX_PAGE_SIZE)},${String(DEFAULT_PAGE_SIZE)}` },
  { name: 'Page size in the API contract', document: 'docs/architecture.md', pattern: /\| `pageSize` \| 1 to (\d+) \| `(\d+)` \|/, expected: `${String(MAX_PAGE_SIZE)},${String(DEFAULT_PAGE_SIZE)}` },
  { name: 'Sort fields', document: 'README.md', pattern: /`sortBy` \(`(\w+)`, `(\w+)`, `(\w+)` or `(\w+)`\)/, expected: TRADE_SORT_FIELDS.join(',') },
  { name: 'Sides', document: 'README.md', pattern: /`side` \(`(\w+)` or `(\w+)`, any case\)/, expected: TRADE_SIDES.join(',') },
  { name: 'Reviewer datasets', document: 'README.md', pattern: /Seeds ([\d,]+) benchmark trades and ([\d,]+) scratch trades \(dataset version (\d+)\)/,
    expected: `${BENCHMARK_COUNT.toLocaleString('en-US')},${SCRATCH_COUNT.toLocaleString('en-US')},${String(DATASET_VERSION)}` },
  { name: 'Supported environment', document: 'README.md', pattern: /\| Runtime \| Node\.js ([\d.]+) exactly, with npm ([\d.]+) and SQLite ([\d.]+) \|/,
    expected: `${SUPPORTED_NODE_VERSIONS},${SUPPORTED_NPM_VERSION},${SUPPORTED_SQLITE_VERSION}` },
  { name: 'Verified Node.js version', document: 'README.md', pattern: /\*\*Supported and verified: Node\.js ([\d.]+) only\*\*/, expected: VERIFIED_NODE_VERSIONS.map((version) => version.slice(1)).join(',') },
  { name: 'Supported Node.js version in setup', document: 'docs/setup.md', pattern: /`engines` is `([^`]+)` everywhere/, expected: SUPPORTED_NODE_VERSIONS },
  { name: 'Supported environment in the architecture', document: 'docs/architecture.md', pattern: /\| Runtime \| Node\.js ([\d.]+) exactly \(npm ([\d.]+), SQLite ([\d.]+)[;)]/,
    expected: `${SUPPORTED_NODE_VERSIONS},${SUPPORTED_NPM_VERSION},${SUPPORTED_SQLITE_VERSION}` },
]

export function ruleChecks(documents: Readonly<Record<string, string>>, rules: readonly Rule[] = RULES): DocCheck[] {
  const failures: string[] = []
  for (const rule of rules) {
    const text = documents[rule.document]
    const match = text === undefined ? null : rule.pattern.exec(flat(text))
    if (match === null) {
      failures.push(`${rule.name}: the statement was not found in ${rule.document} (${String(rule.pattern)})`)
      continue
    }
    const stated = match.slice(1).join(',')
    if (stated !== rule.expected) failures.push(`${rule.name}: ${rule.document} says ${stated}, the code enforces ${rule.expected}`)
  }
  return [failures.length === 0
    ? { status: 'PASS', name: `Business rules: all ${String(rules.length)} stated values match the code`, detail: rules.map((rule) => `${rule.name}: ${rule.expected}`).join('\n') }
    : { status: 'FAIL', name: 'Business rules stated differently from the code', detail: failures.join('\n') }]
}

function linkCheck(root: string, documents: Record<string, string>): DocCheck {
  let count = 0
  const missing: string[] = []
  for (const [path, text] of Object.entries(documents)) {
    // Markdown links and images to a path: not a URL, an anchor, or text that only looks like a link.
    for (const [, target = ''] of text.matchAll(/\]\(([\w./%-]+(?:#[\w-]*)?)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue
      const file = decodeURIComponent(target.split('#')[0] ?? '')
      if (file === '') continue
      count++
      if (!existsSync(resolve(root, dirname(path), file))) missing.push(`${file} (linked from ${path})`)
    }
  }
  return missing.length === 0
    ? { status: 'PASS', name: `Links and screenshots: all ${String(count)} local files the documents link to exist` }
    : { status: 'FAIL', name: 'Links to files that do not exist', detail: missing.join('\n') }
}

// ---------------------------------------------------------------------------------------------
// Counts and measurements that go out of date

const DATE = /\b20\d\d-\d\d-\d\d\b/

/** Every count of server or client tests the documents state, with whether a date is beside it. */
export function testCountStatements(documents: Readonly<Record<string, string>>): { readonly document: string; readonly suite: 'server' | 'client'; readonly count: number; readonly dated: boolean; readonly text: string }[] {
  const statements: ReturnType<typeof testCountStatements> = []
  // "1,575 API and tool tests", or "API and tool tests (1,575 on 2026-11-20" and "frontend tests (406)".
  const patterns = [/(\d{1,3}(?:,\d{3})+|\d+) (API and tool|frontend) tests/g, /(API and tool|frontend) tests \((\d{1,3}(?:,\d{3})+|\d+)(?= on |\))/g]
  for (const [document, raw] of Object.entries(documents)) {
    // A count is dated by a date in its own paragraph, or its own row of a table.
    for (const unit of raw.split(/\n\s*\n/).flatMap((paragraph) => paragraph.trimStart().startsWith('|') ? paragraph.split('\n') : [paragraph])) {
      const text = flat(unit)
      for (const [index, pattern] of patterns.entries()) {
        for (const match of text.matchAll(pattern)) {
          const [count = '', kind = ''] = index === 0 ? [match[1], match[2]] : [match[2], match[1]]
          statements.push({ document, suite: kind === 'frontend' ? 'client' : 'server', count: Number(count.replaceAll(',', '')), dated: DATE.test(text), text: match[0] })
        }
      }
    }
  }
  return statements
}

export function testCountChecks(documents: Readonly<Record<string, string>>, totals: DocsOptions['testTotals']): DocCheck[] {
  const statements = testCountStatements(documents)
  if (statements.length === 0) return [{ status: 'WARN', name: 'Test counts: the documents state none' }]
  const stale: string[] = []
  const undated: string[] = []
  for (const statement of statements) {
    const current = totals?.[statement.suite]
    if (current === statement.count) continue
    const line = `${statement.document}: "${statement.text}"${current === undefined ? '' : `, this run has ${current.toLocaleString('en-US')}`}`
    if (statement.dated) stale.push(line)
    else undated.push(line)
  }
  const measured = totals?.server !== undefined || totals?.client !== undefined
  if (undated.length > 0) {
    return [{ status: 'FAIL', name: 'Test counts neither current nor dated', detail: `${undated.join('\n')}${stale.length > 0 ? `\nDated, not current:\n${stale.join('\n')}` : ''}` }]
  }
  if (stale.length > 0) {
    return [{ status: measured ? 'WARN' : 'PASS', name: measured ? 'Test counts are dated but differ from this run\'s' : `Test counts: all ${String(statements.length)} are dated (the tests did not run, so they were not compared)`, detail: stale.join('\n') }]
  }
  return [{ status: 'PASS', name: `Test counts: all ${String(statements.length)} match this run's` }]
}

/** The files whose behaviour the benchmarks measure; documentation and tests are left out. */
const APPLICATION_SOURCE = ['server/src', 'server/drizzle', 'client/src', 'client/index.html'] as const

/**
 * A fingerprint of the application source, the same on every platform: SHA-256 over each file's
 * path (with /) and content (with LF line endings), in path order. Twelve hex digits are shown.
 */
export function applicationFingerprint(root: string = REPOSITORY_ROOT): string {
  const files = APPLICATION_SOURCE.flatMap((entry) => {
    const path = join(root, entry)
    if (!existsSync(path)) return []
    return statSync(path).isDirectory() ? sourceFiles(path, ['']) : [path]
  }).map((path) => relative(root, path).replaceAll('\\', '/')).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file}\0${readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')}\0`)
  return hash.digest('hex').slice(0, 12)
}

export const BENCHMARK_PROVENANCE = /application source fingerprint `([0-9a-f]{12})`/

function benchmarkCheck(root: string, readme: string): DocCheck {
  const stated = BENCHMARK_PROVENANCE.exec(flat(section(readme, 'Performance')))?.[1]
  const current = applicationFingerprint(root)
  if (stated === undefined) {
    return { status: 'FAIL', name: 'Benchmark figures do not name the code they were measured on', detail: 'README\'s Performance section needs "application source fingerprint `<12 hex digits>`" (check:all prints it).' }
  }
  return stated === current
    ? { status: 'PASS', name: `Benchmark figures were measured on this application source (fingerprint ${current})` }
    : { status: 'WARN', name: 'Benchmark figures were measured on another version of the application source', detail: `README states ${stated}; the source is now ${current}. Run npm run check:all and update the figures.` }
}

/** npm run check:docs: the checks above, without test totals (counts are checked for a date only). Exit 1 on a FAIL. */
async function main(): Promise<number> {
  const checks = await documentationChecks()
  for (const check of checks) {
    console.log(`${check.status.padEnd(7)}  ${check.name}${check.detail === undefined || (check.status === 'PASS' && !argv.includes('--verbose')) ? '' : `\n         ${check.detail.replace(/\n/g, '\n         ')}`}`)
  }
  const count = (status: DocStatus): number => checks.filter((check) => check.status === status).length
  console.log(`${String(count('PASS'))} PASS, ${String(count('FAIL'))} FAIL, ${String(count('WARN'))} WARN, ${String(count('SKIPPED'))} SKIPPED`)
  console.log(`RESULT: ${count('FAIL') > 0 ? 'FAILED (exit code 1)' : 'PASSED (exit code 0)'}`)
  return count('FAIL') > 0 ? 1 : 0
}

if (argv[1] !== undefined && resolve(argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error)
    return 1
  })
}