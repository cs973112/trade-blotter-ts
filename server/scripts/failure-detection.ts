import { spawn } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { REPOSITORY_ROOT } from './lifecycle.ts'

/**
 * Failure detection: evidence that the tests catch a broken rule. Each check copies the server, or
 * for a client check (M6 Phase 2) the frontend, into a temporary folder,
 * server/.test-build-check-<run>-<check>/ or client/.test-build-check-<run>-<check>/ (ignored by Git
 * and ESLint; inside its workspace so the copy finds the installed packages), and works only on that
 * copy:
 *
 *   1. control: the chosen test files pass on the unmodified copy;
 *   2. the change: one exact piece of text in one file, found exactly once, is replaced;
 *   3. it compiles: the copy's sources and the chosen tests type-check (tsc for the server,
 *      vue-tsc for the client, which checks the Vue templates too);
 *   4. detection: the same tests run again, and a named test fails on an assertion.
 *
 * Only then is the check a PASS. A control that fails, a change that cannot be applied, a type
 * error, a test file that cannot be collected, a crash, a timeout, or failures that are not
 * assertion failures are each a FAIL, never a detection. The copy is removed afterwards; its logs
 * and results stay in the evidence folder. Production files are only ever read.
 */

export interface FailureCheck {
  readonly id: string
  /** The rule the change breaks, as the documentation states it. */
  readonly rule: string
  /** The workspace the change is made in: server/ (the default) or client/. */
  readonly workspace?: 'server' | 'client'
  /** Relative to the workspace's folder. */
  readonly file: string
  readonly find: string
  readonly replace: string
  /** Test files relative to the workspace's folder, run for the control and after the change. */
  readonly tests: readonly string[]
  /** A test whose full name matches must fail on an assertion. */
  readonly expectFailing: RegExp
}

export const FAILURE_CHECKS: readonly FailureCheck[] = [
  {
    id: 'average-cost-on-reduce',
    rule: 'Reducing a position leaves its average cost unchanged',
    file: 'src/domain/position.ts',
    find: '  } else {\n    averageCost = position.averageCost\n  }',
    replace: '  } else {\n    averageCost = trade.price\n  }',
    tests: ['test/domain/position.test.ts'],
    expectFailing: /^domain: /,
  },
  {
    id: 'position-limit-boundary',
    rule: 'A trade that takes the net quantity to 10^30 or beyond is refused',
    file: 'src/domain/position.ts',
    find: 'if (next.abs().gte(LIMIT))',
    replace: 'if (next.abs().gt(LIMIT))',
    tests: ['test/domain/position.test.ts'],
    expectFailing: /position limit error when the net quantity reaches 10\^30/,
  },
  {
    id: 'decimal-places',
    rule: 'Quantity and price have at most 10 decimal places',
    file: 'src/domain/decimal.ts',
    find: 'value.decimalPlaces() > MAX_DECIMAL_PLACES',
    replace: 'value.decimalPlaces() > MAX_DECIMAL_PLACES + 1',
    tests: ['test/domain/decimal-input.test.ts'],
    expectFailing: /^domain: decimal input/,
  },
  {
    id: 'page-size-maximum',
    rule: 'pageSize is from 1 to 100',
    file: 'src/domain/trade-query.ts',
    // The page of trades only (validateTradePageQuery), not the audit history's page, which reads the same.
    find: "checkWholeNumber(request.pageSize, 'pageSize', MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)\n  if (value === undefined",
    replace: "checkWholeNumber(request.pageSize, 'pageSize', MAX_PAGE_SIZE + 1, DEFAULT_PAGE_SIZE)\n  if (value === undefined",
    tests: ['test/domain/trade-query.test.ts'],
    expectFailing: /^domain: trade page query validation/,
  },
  {
    id: 'exact-symbol-match',
    rule: 'symbolMatch=exact matches the whole symbol only (MS, not MSFT)',
    file: 'src/domain/trade-query.ts',
    find: "if (symbolMatch.value === 'exact') filter.symbolEquals = symbol.value",
    replace: "if (symbolMatch.value === 'exact') filter.symbolContains = symbol.value",
    tests: ['test/api/symbol-match.test.ts'],
    expectFailing: /only the whole symbol with exact/,
  },
  {
    id: 'cancelled-trades-ignored',
    rule: 'A cancelled original counts for nothing in positions',
    file: 'src/domain/position-summary.ts',
    find: "if (trade.status === 'Pending' && trade.originalTradeId === null) pending.set",
    replace: "if (trade.status !== 'Executed' && trade.originalTradeId === null) pending.set",
    tests: ['test/domain/position-summary.test.ts'],
    expectFailing: /ignores a cancelled original and its cancellation row entirely/,
  },
  {
    id: 'cancellation-row-not-in-positions',
    rule: 'A cancellation row never counts towards positions, whatever its status',
    file: 'src/domain/position-summary.ts',
    find: "if (trade.status === 'Pending' && trade.originalTradeId === null) pending.set",
    replace: "if (trade.status === 'Pending') pending.set",
    tests: ['test/domain/position-summary.test.ts'],
    expectFailing: /never counts a cancellation row/,
  },
  {
    id: 'average-cost-executed-only',
    rule: 'Average cost comes from Executed trades only; Pending trades never change it',
    file: 'src/domain/position-summary.ts',
    find: 'averageCost: position.averageCost,',
    replace: 'averageCost: pending.has(symbol) ? flatPosition(symbol).averageCost : position.averageCost,',
    tests: ['test/domain/position-summary.test.ts'],
    expectFailing: /average cost from Executed trades only/,
  },
  {
    id: 'pending-has-no-execution-time',
    rule: 'A booking is Pending, with no execution time',
    file: 'src/domain/trade-status.ts',
    find: 'executedAt: null, createdAt: assigned.now,',
    replace: 'executedAt: assigned.now, createdAt: assigned.now,',
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /books a Pending trade with no execution time/,
  },
  {
    id: 'booking-pending-only',
    rule: 'A trade cannot be booked as Executed',
    file: 'src/domain/trade-status.ts',
    find: "if (text === 'executed') return { ok: false, message: 'A trade cannot be booked as Executed: it is booked as Pending, then executed (POST /trades/{id}/execution).' }",
    replace: "if (text === 'executed') return { ok: true, value: BOOKING_STATUS }",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /refuses Executed and Cancelled/,
  },
  {
    id: 'booking-refuses-execution-time',
    rule: 'A booking that gives an execution time is refused',
    file: 'src/domain/trade.ts',
    find: 'request.executedAt === undefined || request.executedAt === null ? valid(undefined) : invalid(BOOKING_EXECUTED_AT_MESSAGE)',
    replace: 'valid(undefined)',
    tests: ['test/domain/trade.test.ts'],
    expectFailing: /refuses every execution time/,
  },
  {
    id: 'execute-pending-only',
    rule: 'A trade is executed once: an Executed trade is refused',
    file: 'src/domain/trade-status.ts',
    find: "if (trade.status === 'Executed') return { ok: false, problem: 'already-executed'",
    replace: "if (trade.status === 'Executed' && trade.id === '') return { ok: false, problem: 'already-executed'",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /refuses a trade already Executed/,
  },
  {
    id: 'executed-not-cancellable',
    rule: 'Only a Pending trade can be cancelled; an Executed trade is refused',
    file: 'src/domain/trade-status.ts',
    find: "if (trade.status !== 'Pending') return { ok: false, problem: 'not-pending'",
    replace: "if (trade.status !== 'Pending' && trade.status !== 'Executed') return { ok: false, problem: 'not-pending'",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /only a Pending original: an Executed trade is refused/,
  },
  {
    id: 'cancellation-row-not-cancellable',
    rule: 'A cancellation row cannot itself be cancelled',
    file: 'src/domain/trade-status.ts',
    find: "if (isCancellationRecord(trade)) return { ok: false, problem: 'cancellation-record', message: `${trade.id} records a cancellation; it cannot itself be cancelled.` }",
    replace: "if (isCancellationRecord(trade) && trade.id === '') return { ok: false, problem: 'cancellation-record', message: `${trade.id} records a cancellation; it cannot itself be cancelled.` }",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /a cancellation row is refused/,
  },
  {
    id: 'cancel-once',
    rule: 'A trade is cancelled once: an already Cancelled original is refused',
    file: 'src/domain/trade-status.ts',
    find: "if (trade.status === 'Cancelled') return { ok: false, problem: 'already-cancelled', message: `Trade ${trade.id} is already cancelled.` }",
    replace: "if (trade.status === 'Cancelled' && trade.id === '') return { ok: false, problem: 'already-cancelled', message: `Trade ${trade.id} is already cancelled.` }",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /a second cancellation of the same original is refused/,
  },
  {
    id: 'cancellation-by-admin',
    rule: 'A cancellation changes the original as Admin, never as User',
    file: 'src/domain/trade-status.ts',
    find: "original: Object.freeze({ ...trade, status: 'Cancelled', updatedBy: CANCELLATION_ACTOR",
    replace: "original: Object.freeze({ ...trade, status: 'Cancelled', updatedBy: BOOKING_ACTOR",
    tests: ['test/domain/trade-status.test.ts'],
    expectFailing: /updates the original|actor from the operation/,
  },  {
    id: 'audit-update-recorded-as-update',
    rule: 'An update of a trade is audited as Updated, with the row after the change',
    file: 'drizzle/20261120220032_trade_lifecycle_audit/migration.sql',
    find: "VALUES ('Updated', ",
    replace: "VALUES ('Inserted', ",
    tests: ['test/infrastructure/trade-audit.test.ts'],
    expectFailing: /records an update/,
  },
  {
    id: 'audit-append-only',
    rule: 'An audit entry cannot be changed',
    file: 'drizzle/20261120220032_trade_lifecycle_audit/migration.sql',
    find: "SELECT RAISE(ABORT, 'trade_audit is append-only: an entry cannot be changed');",
    replace: 'SELECT 1;',
    tests: ['test/infrastructure/trade-audit.test.ts'],
    expectFailing: /refuses to change or remove an entry/,
  },
  {
    id: 'migration-keeps-sequence-high-water-mark',
    rule: 'The lifecycle migration keeps the booking sequence high-water mark',
    file: 'drizzle/20261120220032_trade_lifecycle_audit/migration.sql',
    find: 'SET `seq` = max(`seq`, (SELECT `seq` FROM `__trades_sequence`))',
    replace: 'SET `seq` = min(`seq`, (SELECT `seq` FROM `__trades_sequence`))',
    tests: ['test/infrastructure/lifecycle-migration.test.ts'],
    expectFailing: /high-water mark/,
  },
  {
    id: 'pending-limit-in-repository',
    rule: 'A Pending booking is refused when the final projected position reaches the limit',
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: 'pendingPositionAfterTrade(history, trade)',
    replace: 'void pendingPositionAfterTrade',
    tests: ['test/infrastructure/lifecycle-repository.test.ts'],
    expectFailing: /refuses a Pending booking whose final projected position reaches the limit/,
  },
  {
    id: 'execution-limit-in-repository',
    rule: 'An execution is refused when it would take the Executed position to the limit',
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: 'executedPositionAfterExecution(history, { ...executed, executedAt })',
    replace: 'void executedPositionAfterExecution',
    tests: ['test/infrastructure/lifecycle-repository.test.ts'],
    expectFailing: /refuses an execution that takes the Executed position to the limit/,
  },
  {
    id: 'existing-reads-executed-only',
    rule: 'The existing API lists and calculates from Executed trades only',
    file: 'src/infrastructure/drizzle-trade-repository.ts',
    find: "const EXECUTED = sql`${trades.status} = 'Executed'`",
    replace: "const EXECUTED = sql`1 = 1`",
    tests: ['test/infrastructure/lifecycle-repository.test.ts'],
    expectFailing: /lists and calculates from Executed trades only/,
  },
  {
    id: 'cancellation-records-not-listed',
    rule: 'Trade lists show each logical trade once, never a cancellation record',
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: 'const LOGICAL = sql`${trades.originalTradeId} is null`',
    replace: 'const LOGICAL = sql`1 = 1`',
    tests: ['test/api/lifecycle.test.ts'],
    expectFailing: /lists each logical trade once/,
  },
  {
    id: 'status-filter',
    rule: 'status=Pending lists only Pending trades',
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: "Pending: sql`${trades.originalTradeId} is null and ${trades.status} = 'Pending'`",
    replace: "Pending: sql`${trades.originalTradeId} is null and ${trades.status} <> 'Cancelled'`",
    tests: ['test/api/lifecycle.test.ts'],
    expectFailing: /filters by status/,
  },
  {
    id: 'positions-count-pending',
    rule: 'Positions count Pending trades in the Pending and Projected Net, and list Pending-only symbols',
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: '}).from(trades).where(or(OF_STATUS.Executed, OF_STATUS.Pending)).all()',
    replace: '}).from(trades).where(or(OF_STATUS.Executed)).all()',
    tests: ['test/api/lifecycle.test.ts'],
    expectFailing: /gives Executed, Pending and Projected Net/,
  },
  {
    id: 'audit-logical-scope',
    rule: 'A logical trade\'s audit history holds the original\'s entries and its cancellation record\'s, from either id',
    // The logical scope read as the trade scope: the original's entries only, the cancellation record left out.
    file: 'src/infrastructure/drizzle-lifecycle-repository.ts',
    find: "        if (scope === 'logical') {",
    replace: '        if (scope !== scope) {',
    tests: ['test/api/lifecycle.test.ts'],
    expectFailing: /lists a logical trade's history, the original and its cancellation record/,
  },
  {
    id: 'logical-lists-use-partial-indexes',
    rule: 'Trade-list pages walk the logical-trade partial indexes, not the unique index and a sort of every trade',
    // The unique index on original_trade_id over every row again, NULLs included: SQLite then
    // serves `original_trade_id is null` from it and sorts every trade for each page.
    file: 'drizzle/20261121003941_cancellation_unique_index/migration.sql',
    find: ' WHERE "trades"."original_trade_id" is not null;',
    replace: ';',
    tests: ['test/infrastructure/executed-indexes.test.ts'],
    expectFailing: /reads each page through a logical-trade index/,
  },
  {
    id: 'logical-index-condition',
    rule: 'Each logical-trade index holds the logical trades, so a page sorted by symbol walks it',
    // The symbol order's index made to hold only cancellation rows: a page by symbol then walks the
    // full symbol index and reads each row it steps over to test the condition.
    file: 'drizzle/20261121043510_logical_trade_indexes/migration.sql',
    find: '(`symbol`,`executed_at`,`booking_sequence`) WHERE "trades"."original_trade_id" is null;',
    replace: '(`symbol`,`executed_at`,`booking_sequence`) WHERE "trades"."original_trade_id" is not null;',
    tests: ['test/infrastructure/executed-indexes.test.ts'],
    expectFailing: /reads each page through a logical-trade index/,
  },
  {
    id: 'eperm-is-not-exit',
    rule: 'Process clean-up never takes EPERM as proof that a process has exited',
    file: 'scripts/lifecycle.ts',
    find: "if (code === 'EPERM') return 'no-permission'",
    replace: "if (code === 'EPERM') return 'exited'",
    tests: ['test/scripts/process-termination.test.ts'],
    expectFailing: /EPERM/,
  },
  {
    id: 'eperm-is-not-gone',
    rule: 'Process clean-up waits for confirmation while a process answers EPERM, and fails if it never goes',
    file: 'scripts/lifecycle.ts',
    find: "if (probe === 'exited') return { kind: 'gone', reused: false, reason: 'no process has its id (ESRCH)' }",
    replace: "if (probe !== 'alive') return { kind: 'gone', reused: false, reason: 'no process has its id (ESRCH)' }",
    tests: ['test/scripts/process-termination.test.ts'],
    expectFailing: /exits during clean-up|cannot be terminated|cannot be identified/,
  },
  {
    id: 'reused-id-never-signalled',
    rule: 'Process clean-up never signals a process whose command line lacks its token',
    file: 'scripts/lifecycle.ts',
    find: 'return description.commandLine.includes(target.token)',
    replace: 'return description.commandLine.length > 0',
    tests: ['test/scripts/process-termination.test.ts'],
    expectFailing: /never signals a process whose id was reused/,
  },
  // Client checks (M6 Phase 2): the frontend's own tests, on a copy of client/.
  {
    id: 'client-booking-sends-no-status',
    rule: 'The page books every trade Pending: it never sends a status, so it can never ask to book as Executed',
    workspace: 'client',
    file: 'src/components/TradeForm.vue',
    find: "  return { symbol: form.symbol.trim(), side: form.side, quantity: quantity.text, price: price.text }",
    replace: "  return { symbol: form.symbol.trim(), side: form.side, quantity: quantity.text, price: price.text, status: 'Executed' as 'Pending' }",
    tests: ['test/TradeForm.test.ts', 'test/lifecycle.test.ts'],
    expectFailing: /sends no status and no execution time|books Pending, sending no status and no execution time/,
  },
  {
    id: 'client-execution-refreshes',
    rule: 'A successful execution reloads the trades, the positions and the Trade Details',
    workspace: 'client',
    file: 'src/stores/blotter.ts',
    find: 'await refreshAfterChange(result.symbol)',
    replace: 'void result.symbol',
    tests: ['test/lifecycle.test.ts'],
    expectFailing: /asks for confirmation in an accessible dialog|executes from a row of the details grid|executing it \(changed\)/,
  },
  {
    id: 'client-execute-only-pending',
    rule: 'Execute is offered only on Pending trades, never on an Executed or Cancelled one',
    workspace: 'client',
    file: 'src/lib/cancellation.ts',
    find: "export function isExecutable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {\n  return trade.status === 'Pending' && trade.originalTradeId === null",
    replace: "export function isExecutable(trade: Pick<Trade, 'status' | 'originalTradeId'>): boolean {\n  return trade.status !== 'Pending' || trade.originalTradeId === null",
    tests: ['test/lifecycle.test.ts'],
    expectFailing: /Execute and Cancel only on Pending trades/,
  },
  {
    id: 'client-actual-position-executed-only',
    rule: 'The Positions grids show the Executed net as the actual position, never counting Pending trades',
    workspace: 'client',
    file: 'src/components/PositionsPanel.vue',
    find: `<td v-else-if="column.key === 'netQuantity'" class="numeric net-quantity" :title="formatDecimal(position.executedNetQuantity)">\n                  {{ formatDecimal(position.executedNetQuantity) }}`,
    replace: `<td v-else-if="column.key === 'netQuantity'" class="numeric net-quantity" :title="formatDecimal(position.projectedNetQuantity)">\n                  {{ formatDecimal(position.projectedNetQuantity) }}`,
    tests: ['test/lifecycle.test.ts'],
    expectFailing: /actual position/,
  },
  {
    id: 'client-cancellation-refreshes',
    rule: 'A successful cancellation reloads the trades, the positions and the Trade Details',
    workspace: 'client',
    file: 'src/stores/blotter.ts',
    find: 'await refreshAfterChange(result.trade.symbol)',
    replace: 'void result.trade.symbol',
    tests: ['test/lifecycle.test.ts'],
    expectFailing: /sends only the reason, then refreshes the trades and positions/,
  },
  {
    id: 'client-deferred-exposure-hidden',
    rule: 'The deferred Pending and Projected net are never offered: not in the grids, nor in Columns',
    workspace: 'client',
    file: 'src/components/PositionsPanel.vue',
    find: "  { key: 'averageCost', label: 'Average cost', minWidth: 136, maxWidth: 800, numeric: true },\n]",
    replace: "  { key: 'averageCost', label: 'Average cost', minWidth: 136, maxWidth: 800, numeric: true },\n  { key: 'pendingNet', label: 'Pending net', minWidth: 128, maxWidth: 800, numeric: true, hiddenByDefault: true },\n]",
    tests: ['test/column-chooser.test.ts', 'test/lifecycle.test.ts'],
    expectFailing: /opens a labelled list of the grid's columns|no Pending or Projected net anywhere/,
  },
]

// ---------------------------------------------------------------------------------------------
// Reading vitest's JSON results

export interface VitestAssertion {
  readonly fullName: string
  readonly status: string
  readonly failureMessages: readonly string[]
}

export interface VitestFile {
  readonly name: string
  readonly status: string
  readonly message?: string
  readonly assertionResults: readonly VitestAssertion[]
}

export interface VitestResults {
  readonly numTotalTests: number
  readonly numPassedTests: number
  readonly numFailedTests: number
  readonly numPendingTests?: number
  readonly numTodoTests?: number
  readonly testResults: readonly VitestFile[]
}

export function readVitestResults(path: string): VitestResults | undefined {
  if (!existsSync(path)) return undefined
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as Partial<VitestResults> | null
    return typeof json?.numTotalTests === 'number' && Array.isArray(json.testResults) ? json as VitestResults : undefined
  } catch {
    return undefined
  }
}

/** A failure raised by expect (vitest's AssertionError), not an exception from the code or the harness. */
export const isAssertionFailure = (assertion: VitestAssertion): boolean =>
  assertion.status === 'failed' && assertion.failureMessages.some((text) => /^AssertionError\b|\bAssertionError:/.test(text))

const isTimeout = (assertion: VitestAssertion): boolean => assertion.failureMessages.some((text) => /Test timed out|Hook timed out/.test(text))

/** A test file that failed without its tests running: it could not be loaded, compiled or collected. */
const collectionErrors = (results: VitestResults): string[] => results.testResults
  .filter((file) => file.status === 'failed' && file.assertionResults.every((assertion) => assertion.status !== 'failed'))
  .map((file) => `${file.name}: ${firstLine(file.message ?? 'failed without a failing test')}`)

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''

export interface RunOutcome {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly results: VitestResults | undefined
}

/** The unmodified copy must pass: every chosen test ran and passed. */
export function judgeControl(run: RunOutcome): { readonly ok: boolean; readonly detail: string } {
  if (run.timedOut) return { ok: false, detail: 'the control run timed out' }
  if (run.results === undefined) return { ok: false, detail: `the control run wrote no results (exit code ${String(run.exitCode)})` }
  const collection = collectionErrors(run.results)
  if (collection.length > 0) return { ok: false, detail: `a test file could not be collected: ${collection.join('; ')}` }
  const { numPassedTests: passed, numFailedTests: failed } = run.results
  if (failed > 0 || run.exitCode !== 0) return { ok: false, detail: `the control failed: ${String(failed)} failed, ${String(passed)} passed (exit code ${String(run.exitCode)})` }
  if (passed === 0) return { ok: false, detail: 'the control ran no tests' }
  return { ok: true, detail: `${String(passed)} passed` }
}

export type Detection =
  | { readonly kind: 'detected'; readonly failing: readonly string[]; readonly others: readonly string[] }
  | { readonly kind: 'not-detected' | 'invalid'; readonly detail: string }

/**
 * After the change: detected only when a test named by expectFailing failed on an assertion, and
 * every test file was collected. A timeout, a crash, a missing result or failures of another kind
 * are invalid, never detection.
 */
export function judgeChange(run: RunOutcome, expectFailing: RegExp): Detection {
  if (run.timedOut) return { kind: 'invalid', detail: 'the run timed out' }
  if (run.results === undefined) return { kind: 'invalid', detail: `the run wrote no results (exit code ${String(run.exitCode)})` }
  const collection = collectionErrors(run.results)
  if (collection.length > 0) return { kind: 'invalid', detail: `a test file could not be collected: ${collection.join('; ')}` }
  const assertions = run.results.testResults.flatMap((file) => file.assertionResults)
  const failed = assertions.filter((assertion) => assertion.status === 'failed')
  const timedOut = failed.filter(isTimeout)
  if (timedOut.length > 0) return { kind: 'invalid', detail: `tests timed out: ${timedOut.map((test) => test.fullName).join('; ')}` }
  if (failed.length === 0) return { kind: 'not-detected', detail: `every test passed (${String(run.results.numPassedTests)}): the change went unnoticed` }
  const detecting = failed.filter((test) => isAssertionFailure(test) && expectFailing.test(test.fullName))
  if (detecting.length === 0) {
    const kinds = failed.map((test) => `${test.fullName}: ${firstLine(test.failureMessages[0] ?? '')}`)
    return { kind: 'invalid', detail: `no test matching ${String(expectFailing)} failed on an assertion; failures: ${kinds.join('; ')}` }
  }
  return { kind: 'detected', failing: detecting.map((test) => test.fullName), others: failed.filter((test) => !detecting.includes(test)).map((test) => test.fullName) }
}

/** Replaces the text when it occurs exactly once; otherwise says why the change cannot be made. */
export function applyChange(source: string, find: string, replace: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly detail: string } {
  const normalised = source.replace(/\r\n/g, '\n')
  const count = normalised.split(find).length - 1
  if (count !== 1) return { ok: false, detail: count === 0 ? 'the text to change was not found (the file has changed: update the check)' : `the text to change occurs ${String(count)} times, not once` }
  return { ok: true, text: normalised.replace(find, () => replace) }
}

// ---------------------------------------------------------------------------------------------
// Running the checks

export interface CheckResult {
  readonly check: FailureCheck
  readonly status: 'PASS' | 'FAIL'
  readonly detail: string
  readonly evidence: string
  readonly milliseconds: number
}

export interface CommandRun {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly milliseconds: number
}

/** Runs node with arguments, output to a log, stopped (with its children) at the deadline. */
export function runNodeBounded(args: readonly string[], cwd: string, log: string, timeoutMs: number): Promise<CommandRun> {
  mkdirSync(dirname(log), { recursive: true })
  const started = Date.now()
  return new Promise((resolveRun) => {
    const out = createWriteStream(log)
    out.once('open', () => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
        cwd, env: process.env, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32',
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        // Only this child and its own children: the tree under its id, while its handle says it runs.
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          else {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
        }
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        out.end(`\n${error.message}\n`, () => { resolveRun({ exitCode: 127, timedOut, milliseconds: Date.now() - started }) })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        out.end(() => { resolveRun({ exitCode: code ?? 1, timedOut, milliseconds: Date.now() - started }) })
      })
    })
  })
}

/** How long each command of a check (vitest, tsc) may run before it is stopped with its children. */
export const FAILURE_COMMAND_TIMEOUT_MS = 300_000

const SERVER_ROOT = join(REPOSITORY_ROOT, 'server')
const CLIENT_ROOT = join(REPOSITORY_ROOT, 'client')
const VITEST = join(REPOSITORY_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const TSC = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
/** vue-tsc, installed with the client (npm may place it in client/node_modules or the root's). */
const VUE_TSC = [join(CLIENT_ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), join(REPOSITORY_ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')]
/** What a copy needs to type-check and run its tests, per workspace. */
const COPIED = ['src', 'test', 'scripts', 'drizzle', 'vitest.config.ts', 'drizzle.config.ts'] as const
const CLIENT_COPIED = ['src', 'test', 'public', 'index.html', 'vite.config.ts'] as const

export interface FailureDetectionOptions {
  readonly runId: string
  /** Logs, results and the change made, per check. */
  readonly evidenceDir: string
  readonly checks?: readonly FailureCheck[]
  readonly timeoutMs?: number
  readonly onCheck?: (result: CheckResult) => void
  /** Told each command as it starts, for verbose output. */
  readonly onCommand?: (line: string) => void
  /** Where server copies are made: server/ (the default) so they find its installed packages. */
  readonly serverRoot?: string
  /** Where client copies are made: client/ (the default), for the same reason. */
  readonly clientRoot?: string
}

export async function runFailureDetection(options: FailureDetectionOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of options.checks ?? FAILURE_CHECKS) {
    const result = await runOne(check, options)
    results.push(result)
    options.onCheck?.(result)
  }
  return results
}

async function runOne(check: FailureCheck, options: FailureDetectionOptions): Promise<CheckResult> {
  const started = Date.now()
  const client = check.workspace === 'client'
  const root = client ? options.clientRoot ?? CLIENT_ROOT : options.serverRoot ?? SERVER_ROOT
  const evidence = join(options.evidenceDir, check.id)
  mkdirSync(evidence, { recursive: true })
  const copy = join(root, `.test-build-check-${options.runId.replace(/[^a-zA-Z0-9-]/g, '')}-${check.id}`)
  const timeoutMs = options.timeoutMs ?? FAILURE_COMMAND_TIMEOUT_MS
  const finish = (status: 'PASS' | 'FAIL', detail: string): CheckResult => {
    const result = { check, status, detail, evidence, milliseconds: Date.now() - started }
    writeFileSync(join(evidence, 'result.json'), `${JSON.stringify({ ...result, check: { ...check, expectFailing: String(check.expectFailing) } }, null, 2)}\n`)
    return result
  }
  const vitest = async (name: string): Promise<RunOutcome> => {
    const json = join(evidence, `${name}.json`)
    rmSync(json, { force: true })
    const args = [VITEST, 'run', '--root', copy, ...check.tests, '--reporter=default', '--reporter=json', `--outputFile=${json}`]
    options.onCommand?.(`node ${args.map((arg) => relative(REPOSITORY_ROOT, arg) || arg).join(' ')}`)
    const run = await runNodeBounded(args, copy, join(evidence, `${name}.log`), timeoutMs)
    return { exitCode: run.exitCode, timedOut: run.timedOut, results: readVitestResults(json) }
  }

  try {
    rmSync(copy, { recursive: true, force: true })
    mkdirSync(copy, { recursive: true })
    for (const entry of client ? CLIENT_COPIED : COPIED) {
      if (existsSync(join(root, entry))) cpSync(join(root, entry), join(copy, entry), { recursive: true })
    }
    const missing = check.tests.filter((test) => !existsSync(join(copy, test)))
    if (missing.length > 0 || !existsSync(join(copy, check.file))) {
      return finish('FAIL', `missing in the copy: ${[...missing, ...(existsSync(join(copy, check.file)) ? [] : [check.file])].join(', ')}`)
    }
    // The server copy extends the repository's base settings; the client copy extends client/tsconfig.json
    // itself (one folder up), so it compiles with the frontend's own settings, Vue templates included.
    writeFileSync(join(copy, 'tsconfig.json'), `${JSON.stringify(client
      ? { extends: '../tsconfig.json', include: ['src/**/*.ts', 'src/**/*.vue', ...check.tests] }
      : { extends: '../../tsconfig.base.json', compilerOptions: { noEmit: true }, include: ['src/**/*.ts', ...check.tests] }, null, 2)}\n`)

    const control = judgeControl(await vitest('control'))
    if (!control.ok) return finish('FAIL', `Control: ${control.detail}. Nothing can be concluded from the change.`)

    const path = join(copy, check.file)
    const changed = applyChange(readFileSync(path, 'utf8'), check.find, check.replace)
    if (!changed.ok) return finish('FAIL', `The change could not be applied to ${check.file}: ${changed.detail}.`)
    writeFileSync(path, changed.text)
    writeFileSync(join(evidence, 'change.txt'), `${check.file}\n--- before\n${check.find}\n+++ after\n${check.replace}\n`)

    const checker = client ? VUE_TSC.find((path) => existsSync(path)) : TSC
    if (checker === undefined) return finish('FAIL', `vue-tsc is not installed (looked for ${VUE_TSC.join(', ')}); the client copy cannot be type-checked.`)
    const tscArgs = [checker, '--noEmit', '-p', join(copy, 'tsconfig.json')]
    options.onCommand?.(`node ${tscArgs.map((arg) => relative(REPOSITORY_ROOT, arg) || arg).join(' ')}`)
    const compiled = await runNodeBounded(tscArgs, copy, join(evidence, 'typecheck.log'), timeoutMs)
    if (compiled.timedOut || compiled.exitCode !== 0) {
      return finish('FAIL', `The changed code does not compile (${compiled.timedOut ? 'timed out' : `${client ? 'vue-tsc' : 'tsc'} exit code ${String(compiled.exitCode)}`}); not counted as detection. Log: ${join(evidence, 'typecheck.log')}`)
    }

    const verdict = judgeChange(await vitest('changed'), check.expectFailing)
    if (verdict.kind === 'detected') {
      return finish('PASS', `Control ${control.detail}; after the change ${String(verdict.failing.length)} test(s) failed on an assertion: ${verdict.failing.join('; ')}` +
        (verdict.others.length > 0 ? `; other failures: ${verdict.others.join('; ')}` : ''))
    }
    return finish('FAIL', `${verdict.kind === 'not-detected' ? 'Not detected' : 'Not a valid detection'}: ${verdict.detail}`)
  } catch (error) {
    return finish('FAIL', `The check could not run: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/**
 * npm run check:failures: the failure-detection checks alone, with their evidence in
 * .run/failure-detection/<run id>/. Exit 1 unless every change was detected.
 */
async function main(): Promise<number> {
  const runId = new Date().toISOString().replace(/[-:.]/g, '')
  const evidenceDir = join(REPOSITORY_ROOT, '.run', 'failure-detection', runId)
  console.log(`Failure detection, run ${runId}; evidence in ${evidenceDir}`)
  const results = await runFailureDetection({
    runId, evidenceDir,
    onCheck: (result) => { console.log(`${result.status.padEnd(7)}  ${result.check.id}: ${result.check.rule}\n         ${result.detail}`) },
  })
  const failed = results.filter((result) => result.status === 'FAIL').length
  console.log(`${String(results.length - failed)} PASS, ${String(failed)} FAIL\nRESULT: ${failed > 0 ? 'FAILED (exit code 1)' : 'PASSED (exit code 0)'}`)
  return failed > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error)
    return 1
  })
}