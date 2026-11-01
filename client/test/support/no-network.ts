/**
 * Runs before every test file. Tests talk to a scripted fake API (`fakeApi`), never to a real
 * server, so the real fetch is replaced by one that refuses. A test that forgets the fake fails
 * here instead of reaching a developer's API on localhost. `vi.unstubAllGlobals()` restores this
 * guard, not the real fetch.
 */
export const NO_NETWORK_MESSAGE = 'Tests must not use the network. Use fakeApi() from test/support/fake-api.ts.'

globalThis.fetch = (): Promise<Response> => Promise.reject(new Error(NO_NETWORK_MESSAGE))
