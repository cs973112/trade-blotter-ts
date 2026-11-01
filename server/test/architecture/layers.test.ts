import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The dependency rules from docs/architecture.md ("Layers"), checked on the source text. ESLint
 * enforces the same rules while editing; this test keeps them enforced even if lint is skipped.
 */

const SOURCE_ROOT = join(import.meta.dirname, '../../src')

function sourceFiles(folder: string): string[] {
  return readdirSync(join(SOURCE_ROOT, folder), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(SOURCE_ROOT, folder, file))
}

/** Every module specifier in static imports, re-exports and dynamic imports. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '')
}

function violations(folder: string, allowed: (specifier: string) => boolean): string[] {
  return sourceFiles(folder).flatMap((file) =>
    importsOf(file).filter((specifier) => !allowed(specifier)).map((specifier) => `${relative(SOURCE_ROOT, file)}: ${specifier}`))
}

const FRAMEWORKS = /^(?:fastify|@fastify\/|drizzle-orm|drizzle-kit|node:sqlite|sqlite|better-sqlite3|vue|@vue\/|pinia)/

describe('architecture: layer dependencies', () => {
  it('finds the source of every layer', () => {
    expect(sourceFiles('domain').length).toBeGreaterThan(0)
    expect(sourceFiles('application').length).toBeGreaterThan(0)
    expect(sourceFiles('infrastructure').length).toBeGreaterThan(0)
    expect(sourceFiles('api').length).toBeGreaterThan(0)
  })

  it('keeps the domain pure: it imports only itself and decimal.js', () => {
    expect(violations('domain', (specifier) => specifier.startsWith('./') || specifier === 'decimal.js')).toEqual([])
  })

  it('keeps the application free of frameworks and outer layers: it imports only itself and the domain', () => {
    expect(violations('application', (specifier) => specifier.startsWith('./') || specifier.startsWith('../domain/'))).toEqual([])
  })

  it('keeps infrastructure off the HTTP layer and the UI', () => {
    expect(violations('infrastructure', (specifier) =>
      !/^(?:fastify|@fastify[/].*|vue|@vue[/].*|pinia)$/.test(specifier) && !/(?:^|[/])api[/]/.test(specifier))).toEqual([])
  })

  it('keeps the API off Drizzle, SQLite and infrastructure', () => {
    expect(violations('api', (specifier) =>
      !/^(?:drizzle-orm|drizzle-kit|node:sqlite)(?:[/]|$)/.test(specifier) && !/(?:^|[/])infrastructure[/]/.test(specifier))).toEqual([])
  })

  it('never lets the domain or application name a framework, database or UI library', () => {
    const named = [...sourceFiles('domain'), ...sourceFiles('application')].flatMap((file) =>
      importsOf(file).filter((specifier) => FRAMEWORKS.test(specifier)))

    expect(named).toEqual([])
  })

  it('recognises the import forms it checks', () => {
    const sample = `import a from 'x'\nimport type { B } from "y"\nexport { c } from 'z'\nconst d = await import('w')\nimport 'v'`
    const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g

    expect([...sample.matchAll(pattern)].map((match) => match[1])).toEqual(['x', 'y', 'z', 'w', 'v'])
  })
})
