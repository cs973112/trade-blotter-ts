import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { detectPlatformFeatures, platformProblems, SUPPORTED_NODE_VERSIONS, unsupportedPlatformMessage } from '../../src/platform.ts'
import { REPOSITORY_ROOT } from '../support/child-process.ts'

describe('platform: startup guard', () => {
  it('detects every required feature on the current runtime', () => {
    expect(detectPlatformFeatures()).toEqual({ sqlite: true, rawJson: true, jsonSourceText: true })
  })

  it('names each missing feature and the supported Node versions', () => {
    const problems = platformProblems({ sqlite: false, rawJson: false, jsonSourceText: false })

    expect(problems).toEqual([
      'The built-in node:sqlite module is not available.',
      'JSON.rawJSON is not available.',
      'JSON.parse does not expose number source text.',
    ])
    expect(unsupportedPlatformMessage(problems)).toMatch(/Use Node\.js \^22\.23\.1\.$/)
  })

  it('reports no problems when everything is available', () => {
    expect(platformProblems({ sqlite: true, rawJson: true, jsonSourceText: true })).toEqual([])
  })
})

describe('platform: declared Node version', () => {
  interface Manifest { readonly engines?: { readonly node?: string } }
  const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
  const nodeRange = (path: string): string | undefined => (JSON.parse(read(path)) as Manifest).engines?.node

  it('is the same in every package.json, the lockfile, .nvmrc and the startup message', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, Manifest | undefined> }
    const declared = {
      root: nodeRange('package.json'),
      server: nodeRange('server/package.json'),
      client: nodeRange('client/package.json'),
      lockRoot: lock.packages['']?.engines?.node,
      lockServer: lock.packages['server']?.engines?.node,
      lockClient: lock.packages['client']?.engines?.node,
      nvmrc: `^${read('.nvmrc').trim()}`,
    }
    expect(declared).toEqual({
      root: SUPPORTED_NODE_VERSIONS,
      server: SUPPORTED_NODE_VERSIONS,
      client: SUPPORTED_NODE_VERSIONS,
      lockRoot: SUPPORTED_NODE_VERSIONS,
      lockServer: SUPPORTED_NODE_VERSIONS,
      lockClient: SUPPORTED_NODE_VERSIONS,
      nvmrc: SUPPORTED_NODE_VERSIONS,
    })
  })
})
