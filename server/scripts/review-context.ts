import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_DATABASE_PATH } from '../src/config.ts'
import { canonicalPathOn, defaultRunDir, REPOSITORY_ROOT } from './lifecycle.ts'
import type { Protection } from './trade-data.ts'

/**
 * The reviewer workflow's shared parts: where it keeps everything (.run/review/, ignored by Git),
 * its two applications and their databases, the results it reports, and the development
 * database's fingerprint. Nothing here starts, stops or writes a database.
 */

/** One reviewer application pair: an API and a frontend on their own database and ports. */
export interface ReviewPair {
  readonly name: 'benchmark' | 'scratch'
  readonly label: string
  readonly databasePath: string
  /** Run state and logs of this pair only, as app:start keeps them. */
  readonly runDir: string
  readonly apiPort: number
  readonly webPort: number
  /** The deterministic dataset the database is seeded with (db:seed's generator). */
  readonly seed: string
  readonly count: number
  /** Whether trades booked after seeding are expected (scratch) or a sign of other use (benchmark). */
  readonly bookingsAllowed: boolean
}

export interface ReviewContext {
  readonly repositoryRoot: string
  /** .run/review/: every database, log and result of the workflow. */
  readonly root: string
  readonly logsDir: string
  readonly perfDir: string
  /** Throwaway databases for the booking checks, each removed after use. */
  readonly disposableDir: string
  /** The UI checks' screenshots, and their throwaway database while they run. */
  readonly uiCheckDir: string
  /** Databases preserved by step 01 before it replaced them, each in a folder of its own with a backup.json. */
  readonly backupsDir: string
  /** The development database's fingerprint, recorded by step 01 and compared by step 07. */
  readonly baselineFile: string
  readonly host: string
  readonly pairs: readonly [ReviewPair, ReviewPair]
  /**
   * The development database and server/data, never opened; and the run folder of app:start, whose
   * applications must not be using a reviewer database.
   */
  readonly protection: Protection
}

export const BENCHMARK_COUNT = 25_000
export const SCRATCH_COUNT = 120
export const BENCHMARK_SEED = 'trade-blotter'
export const SCRATCH_SEED = 'trade-blotter-scratch'

/** The workflow as the npm scripts run it; tests pass another root, ports and counts. */
export function reviewContext(overrides: {
  readonly root?: string
  readonly ports?: { readonly benchmark: readonly [number, number]; readonly scratch: readonly [number, number] }
  readonly counts?: { readonly benchmark: number; readonly scratch: number }
  readonly protection?: Protection
} = {}): ReviewContext {
  const root = overrides.root ?? join(REPOSITORY_ROOT, '.run', 'review')
  const ports = overrides.ports ?? { benchmark: [5391, 4191], scratch: [5392, 4192] }
  const counts = overrides.counts ?? { benchmark: BENCHMARK_COUNT, scratch: SCRATCH_COUNT }
  const pair = (name: ReviewPair['name'], label: string, seed: string, bookingsAllowed: boolean): ReviewPair => ({
    name, label, databasePath: join(root, `${name}.db`), runDir: join(root, 'run', name),
    apiPort: ports[name][0], webPort: ports[name][1], seed, count: counts[name], bookingsAllowed,
  })
  return {
    repositoryRoot: REPOSITORY_ROOT,
    root,
    logsDir: join(root, 'logs'),
    perfDir: join(root, 'perf'),
    disposableDir: join(root, 'disposable'),
    uiCheckDir: join(root, 'ui-check'),
    backupsDir: join(root, 'backups'),
    baselineFile: join(root, 'development-database.json'),
    host: 'localhost',
    pairs: [pair('benchmark', 'Benchmark', BENCHMARK_SEED, false), pair('scratch', 'Scratch', SCRATCH_SEED, true)],
    protection: overrides.protection ?? { developmentDatabase: DEFAULT_DATABASE_PATH, protectedFolder: dirname(DEFAULT_DATABASE_PATH), runDir: defaultRunDir() },
  }
}

// ---------------------------------------------------------------------------------------------
// Results

export type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED' | 'INFO'

/** 0 when nothing failed (warnings allowed), 1 when something failed, 3 when a required part could not run. */
export const EXIT = { passed: 0, failed: 1, incomplete: 3 } as const

/**
 * The lines a step prints, one per check, and its outcome. A step that could not do part of its
 * work (marked incomplete) never ends as PASS.
 */
export class Report {
  readonly lines: { readonly status: Status; readonly name: string; readonly detail?: string }[] = []
  #incomplete: string | undefined
  readonly #print: (line: string) => void

  constructor(print: (line: string) => void = (line) => { console.log(line) }) {
    this.#print = print
  }

  add(status: Status, name: string, detail?: string): void {
    this.lines.push({ status, name, ...(detail === undefined ? {} : { detail }) })
    const text = detail === undefined || detail === '' ? '' : `\n${detail.split('\n').map((line) => `         ${line}`).join('\n')}`
    this.#print(`${status.padEnd(7)}  ${name}${text}`)
  }

  pass(name: string, detail?: string): void { this.add('PASS', name, detail) }
  fail(name: string, detail?: string): void { this.add('FAIL', name, detail) }
  warn(name: string, detail?: string): void { this.add('WARN', name, detail) }
  skip(name: string, detail?: string): void { this.add('SKIPPED', name, detail) }
  info(name: string, detail?: string): void { this.add('INFO', name, detail) }

  /** Records that the step could not do all it should; the result is INCOMPLETE unless something failed. */
  incomplete(reason: string): void {
    this.#incomplete = reason
  }

  count(status: Status): number {
    return this.lines.filter((line) => line.status === status).length
  }

  get failed(): boolean {
    return this.count('FAIL') > 0
  }

  get exitCode(): number {
    if (this.failed) return EXIT.failed
    return this.#incomplete === undefined ? EXIT.passed : EXIT.incomplete
  }

  /** The closing lines: the counts and the result. */
  summary(): string {
    const counts = (['PASS', 'FAIL', 'WARN', 'SKIPPED'] as const).map((status) => `${String(this.count(status))} ${status}`).join(', ')
    const result = this.failed ? 'FAILED' : this.#incomplete === undefined ? 'PASSED' : `INCOMPLETE: ${this.#incomplete}`
    return `${counts}\nRESULT: ${result} (exit code ${String(this.exitCode)})`
  }
}

// ---------------------------------------------------------------------------------------------
// The development database: fingerprinted as plain files, never opened as a database

/** SHA-256 of each of the database's files that exists: the file itself, -wal and -shm. Undefined for a file that is absent. */
export interface FileFingerprint {
  readonly path: string
  readonly exists: boolean
  readonly files: Readonly<Record<string, string | undefined>>
}

const SQLITE_FILES = ['', '-wal', '-shm'] as const

export function fingerprintFiles(path: string): FileFingerprint {
  const files: Record<string, string | undefined> = {}
  for (const suffix of SQLITE_FILES) {
    const file = `${path}${suffix}`
    // Read as bytes; never opened with SQLite, so nothing about it can change.
    files[file] = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined
  }
  return { path, exists: files[path] !== undefined, files }
}

export function writeBaseline(context: ReviewContext, fingerprint: FileFingerprint): void {
  mkdirSync(dirname(context.baselineFile), { recursive: true })
  writeFileSync(context.baselineFile, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...fingerprint }, null, 2)}\n`)
}

export function readBaseline(context: ReviewContext): (FileFingerprint & { readonly recordedAt: string }) | undefined {
  if (!existsSync(context.baselineFile)) return undefined
  try {
    return JSON.parse(readFileSync(context.baselineFile, 'utf8')) as FileFingerprint & { recordedAt: string }
  } catch {
    return undefined
  }
}

/**
 * The files whose presence or content differs between two fingerprints of the same database.
 * Files are matched by canonicalPath, so two spellings of one file are one file: on Windows the
 * fingerprint of C:\data\trades.db matches that of c:\data\trades.db (a shell can report either
 * drive letter), while on Linux and macOS a path that differs in case is another file. Each file is
 * named as the later fingerprint spells it.
 */
export function fingerprintChanges(before: FileFingerprint, after: FileFingerprint, platform: NodeJS.Platform = process.platform): string[] {
  const byFile = (fingerprint: FileFingerprint): Map<string, { readonly name: string; readonly hash: string | undefined }> =>
    new Map(Object.entries(fingerprint.files).map(([name, hash]) => [canonicalPathOn(name, platform), { name, hash }]))
  const [was, is] = [byFile(before), byFile(after)]
  return [...new Set([...was.keys(), ...is.keys()])].flatMap((file) => {
    const [then, now] = [was.get(file)?.hash, is.get(file)?.hash]
    if (then === now) return []
    const name = is.get(file)?.name ?? was.get(file)?.name ?? file
    return [`${name}: ${then === undefined ? 'absent' : 'present'} -> ${now === undefined ? 'absent' : then === undefined ? 'present' : 'changed'}`]
  })
}
