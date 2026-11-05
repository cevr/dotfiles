import { describe, expect, test } from 'bun:test'
import { authorizationUrl, CLIENT_ID, CODE_CALLBACK_URL, OAUTH_SCOPES, stateFrom } from './oauth.ts'
import { pkceFrom } from './pkce.ts'

// The sign-in's first step as the old promise API shaped it: PKCE and state
// from fresh random bytes (Entropy, in the plugin), and the URL to open.
async function authorize(mode: 'max' | 'console') {
  const pkce = pkceFrom(crypto.getRandomValues(new Uint8Array(64)))
  const state = stateFrom(crypto.getRandomValues(new Uint8Array(16)))
  return {
    url: authorizationUrl(mode, pkce.challenge, state),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

describe('authorize', () => {
  test('returns the hosted callback URL for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toBe(CODE_CALLBACK_URL)
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('returns the hosted callback URL for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(result.state)
  })

  test('does not use localhost', async () => {
    const result = await authorize('max')
    expect(result.redirectUri).not.toContain('localhost')
    expect(result.url).not.toContain('localhost')
  })
})
