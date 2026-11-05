import { describe, expect, test } from 'bun:test'
import { type EndpointEnv, makeEndpoint } from './endpoint.ts'

// The environment is read once by the composition root and handed in; each
// test builds the endpoint over the values it sets.
const route = (href: string, env: EndpointEnv = {}) => makeEndpoint(env).route(new URL(href))

describe('route', () => {
  test('adds beta=true to /v1/messages URL string', () => {
    const url = route('https://api.anthropic.com/v1/messages')
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('preserves an explicit beta query parameter', () => {
    const url = route('https://api.anthropic.com/v1/messages?beta=false')
    expect(url.searchParams.get('beta')).toBe('false')
  })

  test('does not modify non-/v1/messages URLs', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const url = route(original)
    expect(url.searchParams.has('beta')).toBe(false)
    expect(url.href).toBe(original)
  })

  test('never changes the URL it is given', () => {
    const original = new URL('https://api.anthropic.com/v1/messages')
    makeEndpoint({}).route(original)
    expect(original.href).toBe('https://api.anthropic.com/v1/messages')
  })

  test('uses the exact configured custom origin and preserves the API path', () => {
    const endpoint = makeEndpoint({ baseUrl: 'http://localhost:8080/base' })
    const url = endpoint.route(new URL('https://api.anthropic.com/v1/messages?existing=yes'))
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
    expect(url.searchParams.get('existing')).toBe('yes')
    expect(url.searchParams.get('beta')).toBe('true')
    expect(endpoint.isTrusted(url)).toBe(true)
    expect(endpoint.isTrusted('http://localhost:8081/v1/messages')).toBe(false)
  })

  test.each([
    'not-a-url',
    'file:///etc/passwd',
    'http://user:pass@localhost:8080',
    'http://proxy.example.test',
  ])('ignores invalid custom endpoint %s', (configured) => {
    const url = route('https://api.anthropic.com/v1/messages', { baseUrl: configured })
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://proxy.example.test',
  ])('accepts a secure or loopback custom endpoint %s', (configured) => {
    const endpoint = makeEndpoint({ baseUrl: configured })
    const url = endpoint.route(new URL('https://api.anthropic.com/v1/messages'))
    expect(url.origin).toBe(new URL(configured).origin)
    expect(endpoint.isTrusted(url)).toBe(true)
  })
})

describe('isTrusted', () => {
  const isTrustedAnthropicUrl = (url: string) => makeEndpoint({}).isTrusted(url)

  test('accepts only the official HTTPS Anthropic API origin', () => {
    expect(isTrustedAnthropicUrl('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isTrustedAnthropicUrl('https://api.anthropic.com:443/v1/messages')).toBe(true)
  })

  test.each([
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com.evil.test/v1/messages',
    'https://localhost/v1/messages',
    'http://127.0.0.1/v1/messages',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]/v1/messages',
    'https://user:pass@api.anthropic.com/v1/messages',
    'not-a-url',
  ])('rejects untrusted URL %s', (url) => {
    expect(isTrustedAnthropicUrl(url)).toBe(false)
  })
})

describe('insecure', () => {
  test('requires both a custom endpoint and an explicit supported value', () => {
    expect(makeEndpoint({ insecure: '1' }).insecure).toBe(false)
    expect(makeEndpoint({ baseUrl: 'https://proxy.local', insecure: '1' }).insecure).toBe(true)
    expect(makeEndpoint({ baseUrl: 'https://proxy.local', insecure: 'yes' }).insecure).toBe(false)
  })
})

describe('apiUrl', () => {
  test('puts a path on the custom origin, else the official one', () => {
    expect(makeEndpoint({}).apiUrl('/api/oauth/usage').href).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(makeEndpoint({ baseUrl: 'http://localhost:8080/base' }).apiUrl('/api/oauth/usage').href).toBe(
      'http://localhost:8080/api/oauth/usage',
    )
  })
})
