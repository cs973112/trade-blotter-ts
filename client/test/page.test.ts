import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = join(import.meta.dirname, '..')

describe('page', () => {
  it('declares an icon that is served from the client, so the browser does not ask for a missing /favicon.ico', () => {
    const html = readFileSync(join(CLIENT_ROOT, 'index.html'), 'utf8')
    const icons = [...html.matchAll(/<link\s+rel="icon"[^>]*\shref="([^"]+)"/g)].map((match) => match[1] ?? '')

    expect(icons).toEqual(['/favicon.svg'])
    expect(existsSync(join(CLIENT_ROOT, 'public', 'favicon.svg'))).toBe(true)
    expect(readFileSync(join(CLIENT_ROOT, 'public', 'favicon.svg'), 'utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  })
})
