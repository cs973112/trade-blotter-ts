import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '../src/api/client.ts'
import { fakeApi, json } from './support/fake-api.ts'
import { NO_NETWORK_MESSAGE } from './support/no-network.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('test isolation', () => {
  it('refuses a real request, even to the development API, when a test has no fake', async () => {
    await expect(fetch('http://localhost:5299/trades')).rejects.toThrow(NO_NETWORK_MESSAGE)
  })

  it('turns an unfaked call into a network error without reaching a server', async () => {
    await expect(api.listTrades()).rejects.toMatchObject({ kind: 'network' })
  })

  it('restores the guard, not the real fetch, after a fake is removed', async () => {
    fakeApi({ 'GET /trades': json('[]') })
    await expect(api.listTrades()).resolves.toEqual([])

    vi.unstubAllGlobals()

    await expect(fetch('/trades')).rejects.toThrow(NO_NETWORK_MESSAGE)
  })
})
