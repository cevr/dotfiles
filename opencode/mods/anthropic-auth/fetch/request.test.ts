import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { REQUIRED_BETAS } from '../betas.ts'
import { rewriteRequestBody as rewrite } from '../request-body.ts'
import { makeEndpoint } from '../endpoint.ts'
import { CLAUDE_CODE_VERSION } from '../version.ts'
import {
  CREDENTIAL_HEADER,
  mergeHeaders as mergeRequestHeaders,
  refusedResponse,
  routed,
  setOAuthHeaders as setHeaders,
  takeCredentialChoice,
} from './request.ts'

const rewriteRequestBody = (...args: Parameters<typeof rewrite>) => {
  const result = rewrite(...args)
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
// The hook always holds a Request; the old helper took fetch's (input, init).
const mergeHeaders = (input: string | URL | Request, init?: RequestInit) => mergeRequestHeaders(new Request(input, init))
// The version is resolved once per location and handed in; here, the bundled one.
const setOAuthHeaders = (headers: Headers, token: string) => setHeaders(headers, token, CLAUDE_CODE_VERSION)

describe('mergeHeaders', () => {
  test('copies headers from a Request object', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-custom': 'value' },
    })
    const headers = mergeHeaders(request)
    expect(headers.get('x-custom')).toBe('value')
  })

  test('copies headers from init Headers object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: new Headers({ 'x-init': 'from-headers' }),
    })
    expect(headers.get('x-init')).toBe('from-headers')
  })

  test('copies headers from init array', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: [['x-arr', 'from-array']],
    })
    expect(headers.get('x-arr')).toBe('from-array')
  })

  test('copies headers from init plain object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: { 'x-obj': 'from-object' },
    })
    expect(headers.get('x-obj')).toBe('from-object')
  })

  test('init headers override Request headers', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-key': 'from-request' },
    })
    const headers = mergeHeaders(request, {
      headers: { 'x-key': 'from-init' },
    })
    expect(headers.get('x-key')).toBe('from-init')
  })

  test('handles string input without init', () => {
    const headers = mergeHeaders('https://example.com')
    expect([...headers.entries()]).toHaveLength(0)
  })

  test('handles URL input', () => {
    const headers = mergeHeaders(new URL('https://example.com'))
    expect([...headers.entries()]).toHaveLength(0)
  })
})

describe('setOAuthHeaders', () => {
  test('sets authorization bearer token', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'my-token')
    expect(headers.get('authorization')).toBe('Bearer my-token')
  })

  test('sets user-agent', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`)
  })

  test('reports the version it is given', () => {
    const headers = setHeaders(new Headers(), 'token', '2.9.99')
    expect(headers.get('user-agent')).toBe('claude-cli/2.9.99 (external, cli)')
  })

  test('removes x-api-key', () => {
    const headers = new Headers({ 'x-api-key': 'sk-ant-xxx' })
    setOAuthHeaders(headers, 'token')
    expect(headers.get('x-api-key')).toBeNull()
  })

  test('sets anthropic-beta header', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('anthropic-beta')).toBeString()
    for (const beta of REQUIRED_BETAS) {
      expect(headers.get('anthropic-beta')).toContain(beta)
    }
  })
})

describe('routed', () => {
  const route = (request: Request) => routed(request, makeEndpoint({}).route(new URL(request.url)))

  test('adds beta=true to a /v1/messages Request', () => {
    const request = new Request('https://api.anthropic.com/v1/messages')
    const url = new URL(route(request).url)
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('returns original Request when no URL changes are needed', () => {
    const request = new Request('https://api.anthropic.com/v1/complete')
    expect(route(request)).toBe(request)
  })
})

describe('takeCredentialChoice', () => {
  // Bun keeps a request's headers when the init's Headers is empty, so these
  // requests carry a second header, as every Messages request does.
  test('strips the header and names the credential; an empty one names none', () => {
    const chosen = takeCredentialChoice(
      new Request('https://api.anthropic.com', { headers: { [CREDENTIAL_HEADER]: ' cred-a ', 'content-type': 'application/json' } }),
    )
    expect(chosen.credentialID).toBe('cred-a')
    expect(chosen.request.headers.has(CREDENTIAL_HEADER)).toBe(false)

    const empty = takeCredentialChoice(
      new Request('https://api.anthropic.com', { headers: { [CREDENTIAL_HEADER]: '', 'content-type': 'application/json' } }),
    )
    expect(empty.credentialID).toBeUndefined()
    expect(empty.request.headers.has(CREDENTIAL_HEADER)).toBe(false)

    const none = new Request('https://api.anthropic.com')
    expect(takeCredentialChoice(none)).toEqual({ request: none, credentialID: undefined })
  })
})

describe('refusedResponse', () => {
  test('answers as a retryable 429 after the given seconds', async () => {
    const response = refusedResponse(30)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(((await response.json()) as { type: string }).type).toBe('error')
  })
})

describe('reported Claude Code version', () => {
  test('uses the bundled version in both header and billing metadata', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toBe(
      `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    )
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello world test message' }],
    })
    const billingHeader = JSON.parse(rewriteRequestBody(body)).system[0].text
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('uses one explicit version in both header and billing metadata', () => {
    const version = '2.9.99'
    const headers = new Headers()
    setHeaders(headers, 'token', version)
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello world test message' }],
    })
    const billingHeader = JSON.parse(rewriteRequestBody(body, version))
      .system[0].text
    expect(headers.get('user-agent')).toBe(
      `claude-cli/${version} (external, cli)`,
    )
    expect(billingHeader).toContain(`cc_version=${version}.`)
  })
})
