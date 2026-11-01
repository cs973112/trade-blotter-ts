import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The client depends on the server only through its HTTP API: no import of server code, Node
 * built-ins or server libraries. ESLint enforces the same rule while editing.
 */
const SOURCE_ROOT = join(import.meta.dirname, '../src')

const sourceFiles = (): string[] =>
  readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') || file.endsWith('.vue'))
    .map((file) => join(SOURCE_ROOT, file))

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

describe('client boundaries', () => {
  it('imports only its own modules and browser libraries', () => {
    const allowed = /^(?:\.\.?\/|vue$|pinia$)/
    const violations = sourceFiles().flatMap((file) =>
      importsOf(file).filter((specifier) => !allowed.test(specifier)).map((specifier) => `${relative(SOURCE_ROOT, file)}: ${specifier}`))

    expect(sourceFiles().length).toBeGreaterThan(5)
    expect(violations).toEqual([])
  })

  it('never reaches outside the client folder', () => {
    const escaping = sourceFiles().flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith('.'))
        .filter((specifier) => relative(SOURCE_ROOT, join(file, '..', specifier)).startsWith('..'))
        .map((specifier) => `${relative(SOURCE_ROOT, file)}: ${specifier}`))

    expect(escaping).toEqual([])
  })

  it('calls only the documented endpoints', () => {
    const client = readFileSync(join(SOURCE_ROOT, 'api', 'client.ts'), 'utf8')
    const paths = [...client.matchAll(/request\('([^']+)'/g)].map((match) => match[1])

    expect([...new Set(paths)].sort()).toEqual(['/positions', '/trades'])
  })
})
