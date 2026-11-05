import { describe, expect, mock, spyOn, test } from 'bun:test'
import { Effect } from 'effect'
import { CLIENT_ID, CODE_CALLBACK_URL, exchangeCallback } from '../oauth.ts'
import { TokenEndpoint } from '../service.ts'
import { type Fetch, layer } from './token.ts'

// Each test sets the fetch the endpoint calls; the endpoint is built over a
// forwarder, so nothing global is replaced.
type FetchMock = ReturnType<typeof mock<Fetch>>
let currentFetch: Fetch = () => Promise.reject(new Error('no fetch set for this test'))
function fetchStub(): FetchMock {
  const stub = mock<Fetch>()
  currentFetch = stub
  return stub
}
const tokens = layer((input, init) => currentFetch(input, init))
const run = <A, E>(body: Effect.Effect<A, E, TokenEndpoint>) => Effect.runPromise(body.pipe(Effect.provide(tokens)))

// The old promise API's shapes over the token endpoint: a grant or a failure.
async function exchange(input: string, verifier: string, redirectUri: string, expectedState?: string) {
  const callback = exchangeCallback(input, verifier, redirectUri, expectedState)
  if (callback === undefined) return { type: 'failed' as const }
  return run(
    TokenEndpoint.use((endpoint) => endpoint.exchange(callback, verifier, redirectUri)).pipe(
      Effect.map((grant) => ({ type: 'success' as const, ...grant })),
      Effect.catchTag('ExchangeFailed', () => Effect.succeed({ type: 'failed' as const })),
    ),
  )
}

async function refreshToken(refreshTokenValue: string) {
  return run(
    TokenEndpoint.use((endpoint) => endpoint.refresh(refreshTokenValue)).pipe(
      Effect.map((grant) => ({ type: 'success' as const, ...grant })),
      Effect.catchTag('TokenRefused', (refused) => Effect.succeed({ type: 'failed' as const, status: refused.status })),
    ),
  )
}

const bodyOf = (body: string | undefined): Record<string, unknown> => JSON.parse(body ?? 'null')

describe('exchange', () => {
  test('accepts code#state format', async () => {
    let capturedBody: string | undefined

    fetchStub().mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result.type).toBe('success')
    const body = bodyOf(capturedBody)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.redirect_uri).toBe(CODE_CALLBACK_URL)
  })

  test('accepts a full callback URL', async () => {
    let capturedBody: string | undefined

    fetchStub().mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    await exchange(
      'https://platform.claude.com/oauth/code/callback?code=mycode&state=mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    const body = bodyOf(capturedBody)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'not-a-callback',
      'verifier',
      CODE_CALLBACK_URL,
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'code#wrong',
      'verifier',
      CODE_CALLBACK_URL,
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rejects oversized OAuth inputs before serializing or fetching', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    expect(
      await exchange(
        `${'x'.repeat(16 * 1024)}#state`,
        'verifier',
        CODE_CALLBACK_URL,
        'state',
      ),
    ).toEqual({ type: 'failed' })
    expect(
      await exchange(
        'code#state',
        'v'.repeat(1025),
        CODE_CALLBACK_URL,
        'state',
      ),
    ).toEqual({ type: 'failed' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rejects malformed UTF-16 OAuth inputs before fetching', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    expect(
      await exchange(
        'code\ud800#state',
        'verifier',
        CODE_CALLBACK_URL,
        'state',
      ),
    ).toEqual({ type: 'failed' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed for a malformed token response', async () => {
    fetchStub().mockResolvedValue(
      Response.json({ access_token: 'access' }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result.type).toBe('failed')
  })

  test('returns failed when the token response is not JSON', async () => {
    fetchStub().mockResolvedValue(
      new Response('<html>upstream error</html>', { status: 200 }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result.type).toBe('failed')
  })

  test('uses a 30-second timeout and fails cleanly when exchange times out', async () => {
    const timeout = new AbortController()
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(
      timeout.signal,
    )
    fetchStub().mockImplementation(((_input, init) => {
      expect(init?.signal).toBe(timeout.signal)
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        )
        timeout.abort(new DOMException('Timed out', 'TimeoutError'))
      })
    }) as typeof fetch)

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result).toEqual({ type: 'failed' })
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
    timeoutSpy.mockRestore()
  })

  test('rejects an oversized token response', async () => {
    fetchStub().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 + 1) },
      }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result).toEqual({ type: 'failed' })
  })

  test('rejects oversized token values', async () => {
    fetchStub().mockResolvedValue(
      Response.json({
        refresh_token: 'r'.repeat(8 * 1024 + 1),
        access_token: 'access',
        expires_in: 3600,
      }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result).toEqual({ type: 'failed' })
  })

  test.each([
    'refresh_token',
    'access_token',
  ])('rejects a token value over 8 KiB by UTF-8 bytes: %s', async (field) => {
    fetchStub().mockResolvedValue(
      Response.json({
        refresh_token:
          field === 'refresh_token' ? '😀'.repeat(3000) : 'refresh',
        access_token: field === 'access_token' ? '😀'.repeat(3000) : 'access',
        expires_in: 3600,
      }),
    )

    expect(
      await exchange('code#state', 'verifier', CODE_CALLBACK_URL, 'state'),
    ).toEqual({ type: 'failed' })
  })

  test('rejects malformed UTF-8 in a token response', async () => {
    const fetchSpy = fetchStub().mockResolvedValue(
      new Response(Uint8Array.of(0xc3, 0x28), { status: 200 }),
    )

    const result = await exchange(
      'code#state',
      'verifier',
      CODE_CALLBACK_URL,
      'state',
    )

    expect(result).toEqual({ type: 'failed' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('refreshToken', () => {
  test('rejects an oversized refresh token before fetching', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    expect(await refreshToken('r'.repeat(8 * 1024 + 1))).toEqual({
      type: 'failed',
      status: 400,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rejects a malformed UTF-16 refresh token before fetching', async () => {
    const fetchSpy = fetchStub().mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    expect(await refreshToken('refresh\udc00')).toEqual({
      type: 'failed',
      status: 400,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('exchanges a refresh token for a new access/refresh token pair', async () => {
    let capturedBody: string | undefined

    fetchStub().mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result.type).toBe('success')
    if (result.type !== 'success') throw new Error('unreachable')
    expect(result.access).toBe('new-access')
    expect(result.refresh).toBe('new-refresh')
    expect(result.expires).toBeGreaterThan(Date.now())

    const body = bodyOf(capturedBody)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old-refresh')
    expect(body.client_id).toBe(CLIENT_ID)
  })

  test('does not retry transient 5xx failures', async () => {
    let attempts = 0

    fetchStub().mockImplementation((() => {
      attempts++
      if (attempts === 1) {
        return Promise.resolve(
          new Response('Temporary failure', { status: 500 }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(attempts).toBe(1)
    expect(result).toEqual({ type: 'failed', status: 500 })
  })

  test('returns failed after the first transient server response', async () => {
    let attempts = 0
    fetchStub().mockImplementation((() => {
      attempts++
      return Promise.resolve(new Response('Temporary failure', { status: 503 }))
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 503 })
    expect(attempts).toBe(1)
  })

  test('does not mask a 5xx status when response cleanup rejects', async () => {
    let attempts = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error('cancel failed'))
      },
    })
    fetchStub().mockImplementation((() => {
      attempts++
      return Promise.resolve(new Response(body, { status: 502 }))
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-' + 'refresh')

    expect(result).toEqual({ type: 'failed', status: 502 })
    expect(attempts).toBe(1)
  })

  test('does not retry a connection reset', async () => {
    let attempts = 0
    fetchStub().mockImplementation((() => {
      attempts++
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        )
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 0 })
    expect(attempts).toBe(1)
  })

  test('does not retry non-network exceptions', async () => {
    const failure = new Error('unexpected parser failure')
    const fetchSpy = fetchStub().mockRejectedValue(failure)

    await expect(refreshToken('old-refresh')).rejects.toMatchObject({
      _tag: 'TokenRequestBroken',
      message: failure.message,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('does not recurse or retry a cyclic error cause', async () => {
    const failure = new Error('application failure') as Error & {
      cause?: unknown
    }
    failure.cause = failure
    const fetchSpy = fetchStub().mockRejectedValue(failure)

    await expect(refreshToken('old-refresh')).rejects.toMatchObject({
      _tag: 'TokenRequestBroken',
      message: failure.message,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('returns failed without retrying non-transient (4xx) failures', async () => {
    let attempts = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error('cancel failed'))
      },
    })
    fetchStub().mockImplementation((() => {
      attempts++
      return Promise.resolve(new Response(body, { status: 403 }))
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(attempts).toBe(1)
    expect(result).toEqual({ type: 'failed', status: 403 })
  })

  test('returns failed for a malformed successful response', async () => {
    const fetchSpy = fetchStub().mockResolvedValue(
      Response.json({ access_token: 'new-access' }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('returns failed when token expiry exceeds the safe timestamp range', async () => {
    const fetchSpy = fetchStub().mockResolvedValue(
      Response.json({
        refresh_token: 'new-refresh',
        access_token: 'new-access',
        expires_in: Number.MAX_VALUE,
      }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('returns failed when a successful response is not JSON', async () => {
    const fetchSpy = fetchStub().mockResolvedValue(
      new Response('<html>upstream error</html>', { status: 200 }),
    )

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('does not retry a timed-out request', async () => {
    let attempts = 0
    const timeout = new AbortController()
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(
      timeout.signal,
    )
    fetchStub().mockImplementation(((_input, init) => {
      attempts++
      if (attempts === 1) {
        expect(init?.signal).toBe(timeout.signal)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
          timeout.abort(
            new DOMException('The operation timed out', 'TimeoutError'),
          )
        })
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 0 })
    expect(attempts).toBe(1)
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
    timeoutSpy.mockRestore()
  })

  test('does not retry when token response body streaming times out', async () => {
    let attempts = 0
    const timeout = new AbortController()
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    fetchStub().mockImplementation(((_input, init) => {
      attempts++
      if (attempts === 1) {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(init.signal?.reason),
              { once: true },
            )
            queueMicrotask(() =>
              timeout.abort(
                new DOMException('The operation timed out', 'TimeoutError'),
              ),
            )
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 0 })
    timeoutSpy.mockRestore()
    expect(attempts).toBe(1)
  })

  test('does not retry a terminated token response body', async () => {
    let attempts = 0
    fetchStub().mockImplementation((() => {
      attempts++
      if (attempts === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('terminated'))
              },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch)

    const result = await refreshToken('old-refresh')

    expect(result).toEqual({ type: 'failed', status: 0 })
    expect(attempts).toBe(1)
  })
})

describe('exchange - callback parsing', () => {
  test('accepts a query-string callback with code and state', async () => {
    fetchStub().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await exchange(
      'code=abc&state=xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('success')
  })
})

describe('exchange - token endpoint failures', () => {
  test('returns failed when the token endpoint rejects the code', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const stub = fetchStub().mockResolvedValue(new Response(body, { status: 400 }))
    const calls = stub.mock.calls

    const result = await exchange(
      'abc#xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('failed')
    expect(calls).toHaveLength(1)
    expect(cancelled).toBe(true)
  })

  test('returns failed on a 500 from the token endpoint', async () => {
    const stub = fetchStub().mockResolvedValue(new Response('boom', { status: 500 }))
    const calls = stub.mock.calls

    const result = await exchange(
      'abc#xyz',
      'verifier',
      'https://example.com/callback',
      'xyz',
    )

    expect(result.type).toBe('failed')
    expect(calls).toHaveLength(1)
  })
})
