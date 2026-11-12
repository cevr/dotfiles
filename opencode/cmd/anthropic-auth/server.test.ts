// The plugin seam: the composition root on a stand-in host. Each test starts
// the plugin (`make`) on a promise-shaped mock of the host's integration,
// with the network, the environment and the clock the test controls, and
// drives the hooks, methods and quota RPC it registers as OpenCode would.
// tests/pool-gent.test.ts and testbeds/anthropic-auth.ts run it in OpenCode.
import { describe, expect, mock, test } from 'bun:test'
import { Clock, Effect, Exit, Logger, Scope } from 'effect'
import { REQUIRED_BETAS } from '@dotfiles/opencode-anthropic-auth/betas'
import { describeConnection } from '@dotfiles/opencode-anthropic-auth/rate-limit'
import { processRegistry } from '@dotfiles/opencode-anthropic-auth/registry/credential-sources'
import {
  ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR,
  CLAUDE_CODE_VERSION,
} from '@dotfiles/opencode-anthropic-auth/version'
import Plugin, { type Env, type Fetch, make, makeShared } from './server.ts'

type Host = Parameters<(typeof Plugin)['effect']>[0]

/** A value the plugin answered, read as JSON-shaped data in assertions. */
interface Tree {
  readonly [key: string]: Tree
}

interface EventModel {
  readonly providerID: string
  readonly modelID?: string
  readonly id?: string
}

/** An `http.request` event; the hook replaces `request`. */
interface RequestEvent {
  sessionID?: string
  agent?: string
  kind?: string
  model: EventModel
  request: Request
}

/** An `http.response` event; the hook replaces `response`. */
interface ResponseEvent extends RequestEvent {
  response: Response
}

interface SessionHooks {
  get(name: 'http.request'): (event: RequestEvent) => Promise<void>
  get(name: 'http.response'): (event: ResponseEvent) => Promise<void>
}

/** A credential as a test hands it to the OAuth method. */
interface CredentialInput {
  readonly type: string
  readonly methodID: string
  readonly refresh: string
  readonly access: string
  readonly expires: number
}

interface Authorization {
  readonly url: string
  readonly instructions: string
  readonly mode: string
  readonly callback: (code: string) => Promise<Tree>
}

/** The OAuth method the plugin registered, as promises. */
interface Registration {
  readonly integrationID: string
  readonly method: unknown
  readonly authorize: (answer?: unknown) => Promise<Authorization>
  readonly refresh: (credential: CredentialInput) => Promise<Tree>
  readonly label: (credential: CredentialInput) => string | undefined
}

interface QuotaHandlers {
  readonly reading: (input: unknown) => Promise<Tree>
  readonly usage: (input: unknown) => Promise<Tree>
  readonly claim: (input: unknown) => Promise<Tree>
}

/** The method and RPC handlers as the host receives them. */
interface HostMethod {
  readonly integrationID: string
  readonly method: unknown
  readonly authorize: (answer: unknown) => Effect.Effect<
    {
      readonly url: string
      readonly instructions: string
      readonly mode: string
      readonly callback: (code: string) => Effect.Effect<unknown, unknown>
    },
    unknown,
    Scope.Scope
  >
  readonly refresh: (credential: unknown) => Effect.Effect<unknown, unknown>
  readonly label: (credential: unknown) => string | undefined
}
type HostHook = (event: RequestEvent) => Effect.Effect<void>
type HostHandler = (input: unknown) => Effect.Effect<unknown>

/** The network every setup reaches; a test that sets it restores it. */
const unreachable: Fetch = () => Promise.reject(new Error('the seam tests reach no network'))
const network: { fetch: Fetch } = { fetch: unreachable }

/** The environment a setup reads; a test that sets it restores it. */
const environment: { -readonly [K in keyof Env]: Env[K] } = {
  baseUrl: undefined,
  insecure: undefined,
  versionOverride: undefined,
}

/** The credential sources the tests register, handed to the plugin in place of the process's registry. */
const sourceRegistry = new Map<string, Set<unknown>>()

/** One process's worth of shared state, as the default export keeps it. */
const subject = make({
  fetch: (input, init) => network.fetch(input, init),
  env: () => ({ ...environment }),
  shared: makeShared(),
  registry: () => sourceRegistry,
})

/** What each log level reaches: the spy a test set, else nothing. */
const logSinks = new Map<string, (message: string) => void>()
const logSpy = (level: 'Error' | 'Warn') => {
  const spy = mock((_message: string) => {})
  logSinks.set(level, spy)
  return spy
}
const collector = Logger.make(({ logLevel, message }) =>
  logSinks.get(logLevel)?.(Array.isArray(message) ? message.join(' ') : String(message)),
)

function restoreVersionOverride(original: string | undefined) {
  environment.versionOverride = original
}

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(new TextEncoder().encode(name)).toString('base64url')}`
}

/** The first entry; a test whose list is empty fails here. */
function firstOf<T>(entries: ReadonlyArray<T>): T {
  const [entry] = entries
  if (entry === undefined) throw new Error('expected an entry')
  return entry
}

/** The last entry; a test whose list is empty fails here. */
function lastOf<T>(entries: ReadonlyArray<T>): T {
  const entry = entries.at(-1)
  if (entry === undefined) throw new Error('expected an entry')
  return entry
}

/** A stream the test feeds by hand. */
function controlled() {
  const box: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      box.controller = controller
    },
  })
  const { controller } = box
  if (controller === undefined) throw new Error('the stream did not start')
  return { stream, controller }
}

/** A clock the test can move: the wall clock shifted by `advance`. */
function shiftedClock() {
  let offset = 0
  const now = () => Date.now() + offset
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    sleep: (duration) => Effect.sleep(duration),
  }
  return {
    clock,
    advance: (ms: number) => {
      offset += ms
    },
  }
}

/**
 * The host's integration as promises, the way a test sets it up, and what
 * the plugin registers on the host once a test starts it with `plugin.setup`.
 */
function makeMockContext() {
  const integrationMethods: Registration[] = []
  const hooks = new Map<string, HostHook>()
  const rpcHandlers = new Map<string, QuotaHandlers>()
  const rpcEvents: Array<{ id: string; name: string; payload: Tree }> = []
  const connections: Array<{ type: 'credential'; id: string; label: string }> = []
  const agentSettings = new Map<string, Record<string, unknown>>()
  const { clock, advance } = shiftedClock()
  const ctx = {
    integration: {
      get: mock(async (_input: { integrationID: string }) => ({
        location: {},
        data: { id: 'anthropic', name: 'Anthropic', methods: [], connections },
      })),
      connection: {
        active: mock(async (_id: string): Promise<{ id: string } | undefined> => undefined),
        resolve: mock(async (_connection: { readonly id: string }): Promise<unknown> => undefined),
      },
    },
  }
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([collector])), Effect.provideService(Clock.Clock, clock)))
  const sessionHooks: SessionHooks = {
    get: (name: string) => (event: RequestEvent) => {
      const hook = hooks.get(name)
      return hook === undefined ? Promise.reject(new Error(`not registered: ${name}`)) : run(hook(event))
    },
  }
  const promised = (input: HostMethod): Registration => ({
    integrationID: input.integrationID,
    method: input.method,
    authorize: (answer = {}) =>
      run(Effect.scoped(input.authorize(answer))).then((authorization) => ({
        url: authorization.url,
        instructions: authorization.instructions,
        mode: authorization.mode,
        callback: (code: string) => run(authorization.callback(code)).then((value) => value as Tree),
      })),
    refresh: (credential) => run(input.refresh(credential)).then((value) => value as Tree),
    label: (credential) => input.label(credential),
  })
  const host = {
    integration: {
      transform: (callback: (draft: { method: { update: (input: HostMethod) => void } }) => void) =>
        Effect.sync(() => {
          callback({ method: { update: (input) => void integrationMethods.push(promised(input)) } })
          return { dispose: Effect.void }
        }),
      get: (input: { integrationID: string }) =>
        Effect.tryPromise({ try: () => ctx.integration.get(input), catch: (error) => error }),
      connection: {
        active: (id: string) => Effect.promise(() => ctx.integration.connection.active(id)),
        resolve: (connection: { readonly id: string }) =>
          Effect.tryPromise({ try: () => ctx.integration.connection.resolve(connection), catch: (error) => error }),
      },
    },
    rpc: {
      register: (definition: { id: string }, handlers: Record<'reading' | 'usage' | 'claim', HostHandler>) =>
        Effect.sync(() => {
          rpcHandlers.set(definition.id, {
            reading: (input) => run(handlers.reading(input)).then((value) => value as Tree),
            usage: (input) => run(handlers.usage(input)).then((value) => value as Tree),
            claim: (input) => run(handlers.claim(input)).then((value) => value as Tree),
          })
          return {
            events: {
              emit: (name: string, payload: unknown) =>
                Effect.sync(() => void rpcEvents.push({ id: definition.id, name, payload: payload as Tree })),
            },
            dispose: Effect.void,
          }
        }),
    },
    session: {
      hook: (name: string, callback: HostHook) =>
        Effect.sync(() => {
          hooks.set(name, callback)
          return { dispose: Effect.void }
        }),
    },
    // Each agent's request settings, by id; an agent not listed sets none.
    agent: {
      get: (input: { agentID: string }) =>
        Effect.succeed({ data: { request: { settings: agentSettings.get(input.agentID) ?? {} } } }),
    },
  }
  return {
    ctx,
    agentSettings,
    host: host as unknown as Host,
    run,
    advance,
    connections,
    rpcEvents,
    rpcHandlers: {
      get: (id: string): QuotaHandlers => {
        const handlers = rpcHandlers.get(id)
        if (handlers === undefined) throw new Error(`not registered: ${id}`)
        return handlers
      },
    },
    integrationMethods,
    sessionHooks,
  }
}

type Mocked = ReturnType<typeof makeMockContext>
type MockContext = Mocked['ctx']
const hosts = new WeakMap<MockContext, Mocked>()

/** The plugin as the tests start it: on a mock context, answering its cleanup. */
const plugin = {
  setup: async (ctx: MockContext): Promise<() => Promise<void>> => {
    const mocked = hosts.get(ctx)
    if (mocked === undefined) throw new Error('not a mock context')
    const scope = Scope.makeUnsafe()
    await mocked.run(subject.effect(mocked.host).pipe(Scope.provide(scope)))
    return () => Effect.runPromise(Scope.close(scope, Exit.void))
  },
}

function createMockContext(): Mocked {
  const mocked = makeMockContext()
  hosts.set(mocked.ctx, mocked)
  return mocked
}

describe('default export', () => {
  test('is a v2 plugin definition with an id and an effect', () => {
    expect(Plugin.id).toBe('ex-machina.anthropic-auth')
    expect(Plugin.effect).toBeFunction()
  })
})

describe('integration registration', () => {
  test('registers a Claude Pro/Max OAuth method on the anthropic integration', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx)

    expect(integrationMethods).toHaveLength(1)
    const registration = firstOf(integrationMethods)
    expect(registration.integrationID).toBe('anthropic')
    expect(registration.method).toEqual({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
    expect(registration.label).toBeFunction()
  })

  test('creates a privacy-safe random label for each successful OAuth connection', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx)
    const registration = firstOf(integrationMethods)
    const credential = {
      type: 'oauth',
      methodID: 'claude-max',
      refresh: 'fixture-refresh-value',
      access: 'fixture-access-value',
      expires: Date.now() + 60_000,
    }

    const label = registration.label(credential)

    expect(label).toMatch(/^Claude OAuth • [A-F0-9]{8}$/)
    expect(label).not.toContain(credential.refresh)
    expect(label).not.toContain(credential.access)
  })

  test('authorize() returns a code-mode authorization pointing at claude.ai', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx)

    const registration = firstOf(integrationMethods)
    const authorization = await registration.authorize({})

    expect(authorization.mode).toBe('code')
    expect(authorization.instructions).toBeString()
    const url = new URL(authorization.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(authorization.callback).toBeFunction()
  })

  test('authorize callback exchanges a valid code for a Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = network.fetch
    network.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh-1',
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const authorization = await registration.authorize({})

      const credential = await authorization.callback(
        `somecode#${new URL(authorization.url).searchParams.get('state')}`,
      )

      expect<unknown>(credential.type).toBe('oauth')
      expect<unknown>(credential.methodID).toBe('claude-max')
      expect<unknown>(credential.access).toBe('access-1')
      expect<unknown>(credential.refresh).toBe('refresh-1')
      expect(credential.expires).toBeGreaterThan(Date.now())
    } finally {
      network.fetch = originalFetch
    }
  })

  test('authorize callback throws on a failed exchange (invalid code)', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx)

    const registration = firstOf(integrationMethods)
    const authorization = await registration.authorize({})

    await expect(
      authorization.callback('not-a-valid-callback'),
    ).rejects.toThrow(/Failed to exchange/)
  })

  test('refresh() exchanges the refresh token for a rotated Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = network.fetch
    network.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('old-refresh')
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
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)

      const rotated = await registration.refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      expect<unknown>(rotated).toEqual({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: rotated.expires,
      })
    } finally {
      network.fetch = originalFetch
    }
  })

  test('refresh() throws a descriptive error on failure', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = network.fetch
    network.fetch = mock(() =>
      Promise.resolve(new Response('Forbidden', { status: 403 })),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'old-refresh',
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow('Anthropic token refresh failed: 403')
    } finally {
      network.fetch = originalFetch
    }
  })

  test('rejects a corrupted multibyte refresh token before fetching', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const fetchSpy = mock(() =>
      Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      ),
    )
    const originalFetch = network.fetch
    network.fetch = fetchSpy as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const refresh = `corrupt-${'😀'.repeat(3000)}`
      expect(refresh.length).toBeLessThan(8192)
      expect(new TextEncoder().encode(refresh).byteLength).toBeGreaterThan(8192)

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh,
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      network.fetch = originalFetch
    }
  })

  test('bounds distinct in-flight refreshes and preserves joining callers', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const originalFetch = network.fetch
    const resolvers = new Map<string, (response: Response) => void>()
    let tokenRequests = 0
    network.fetch = mock((_input: unknown, init?: RequestInit) => {
      tokenRequests++
      const token = String(
        (JSON.parse(String(init?.body)) as { refresh_token: string })
          .refresh_token,
      )
      return new Promise<Response>((resolve) => {
        resolvers.set(token, resolve)
      })
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx)
      let pending: Promise<unknown>[] = []
      try {
        const registration = firstOf(integrationMethods)
        const credential = (refresh: string) => ({
          type: 'oauth' as const,
          methodID: 'claude-max',
          refresh,
          access: 'old-access',
          expires: Date.now() - 1000,
        })
        const tokens = Array.from(
          { length: 256 },
          (_, index) => `capacity-${index}`,
        )
        const inFlight = tokens.map((token) =>
          registration.refresh(credential(token)),
        )
        pending = [...inFlight]

        expect(tokenRequests).toBe(256)
        expect(resolvers.size).toBe(256)
        const overflow = registration.refresh(credential('capacity-256'))
        pending.push(overflow)
        expect(tokenRequests).toBe(256)

        const joined = registration.refresh(credential(firstOf(tokens)))
        pending.push(joined)
        expect(tokenRequests).toBe(256)

        for (const [token, resolve] of resolvers) {
          resolve(
            Response.json({
              refresh_token: `rotated-${token}`,
              access_token: `access-${token}`,
              expires_in: 3600,
            }),
          )
        }
        await expect(overflow).rejects.toThrow(
          'Too many active Anthropic token refreshes',
        )
        await Promise.allSettled(pending)
        expect(tokenRequests).toBe(256)
      } finally {
        for (const [token, resolve] of resolvers) {
          resolve(
            Response.json({
              refresh_token: `rotated-${token}`,
              access_token: `access-${token}`,
              expires_in: 3600,
            }),
          )
        }
        await Promise.allSettled(pending)
        await cleanup?.()
      }
    } finally {
      network.fetch = originalFetch
    }
  })

  test('concurrent refresh() calls deduplicate to a single token request', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock(() => {
      tokenRequests++
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
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const results = await Promise.all(
        Array.from({ length: 5 }, () => registration.refresh(credential)),
      )

      expect(tokenRequests).toBe(1)
      for (const result of results) {
        expect<unknown>(result.access).toBe('new-access')
      }
    } finally {
      network.fetch = originalFetch
    }
  })

  test('deduplicates concurrent refreshes across independent plugin setups', async () => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    let tokenRequests = 0
    let releaseResponse = () => {}
    let responseReleased = false
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const originalFetch = network.fetch
    network.fetch = mock(async () => {
      tokenRequests++
      await responseReady
      return Response.json({
        ['refresh' + '_token']: 'new-' + 'refresh',
        ['access' + '_token']: 'new-' + 'access',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx),
        plugin.setup(secondContext.ctx),
      ])
      const firstRegistration = firstOf(firstContext.integrationMethods)
      const secondRegistration = firstOf(secondContext.integrationMethods)
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-' + 'refresh',
        access: 'old-' + 'access',
        expires: Date.now() - 1000,
      }

      const firstRefresh = firstRegistration.refresh(credential)
      const secondRefresh = secondRegistration.refresh(credential)
      await Promise.resolve()
      responseReleased = true
      releaseResponse()
      const [first, second] = await Promise.all([firstRefresh, secondRefresh])

      expect(tokenRequests).toBe(1)
      expect(second).toEqual(first)
    } finally {
      if (!responseReleased) releaseResponse()
      network.fetch = originalFetch
    }
  })

  test.each([
    ['HTTP 503', () => Promise.resolve(new Response('busy', { status: 503 }))],
    [
      'network failure status 0',
      () =>
        Promise.reject(
          Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        ),
    ],
    [
      'malformed 200 body',
      () => Promise.resolve(new Response('{', { status: 200 })),
    ],
  ])('does not retry an ambiguous %s refresh across independent setups', async (_description, response) => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    const refresh = `ambiguous-${_description.replaceAll(' ', '-')}`
    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock(() => {
      tokenRequests++
      return response() as Promise<Response>
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx),
        plugin.setup(secondContext.ctx),
      ])
      const firstRegistration = firstOf(firstContext.integrationMethods)
      const secondRegistration = firstOf(secondContext.integrationMethods)
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      await expect(firstRegistration.refresh(credential)).rejects.toThrow()
      await expect(secondRegistration.refresh(credential)).rejects.toThrow()
      expect(tokenRequests).toBe(1)
    } finally {
      network.fetch = originalFetch
    }
  })

  test('a deterministic 400 refresh failure may start a later request', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refresh = `deterministic-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(new Response('invalid', { status: 400 }))
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }
      await expect(registration.refresh(credential)).rejects.toThrow()
      await expect(registration.refresh(credential)).rejects.toThrow()
      expect(tokenRequests).toBe(2)
    } finally {
      network.fetch = originalFetch
    }
  })

  test('keeps different refresh tokens isolated across independent setups', async () => {
    const firstContext = createMockContext()
    const secondContext = createMockContext()
    const seen: string[] = []
    const originalFetch = network.fetch
    network.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refresh = String(body.refresh_token)
      seen.push(refresh)
      return Promise.resolve(
        Response.json({
          ['refresh' + '_token']: `new-${refresh}`,
          ['access' + '_token']: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await Promise.all([
        plugin.setup(firstContext.ctx),
        plugin.setup(secondContext.ctx),
      ])
      const first = await firstOf(firstContext.integrationMethods).refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'first-' + 'refresh',
        access: 'old-' + 'access',
        expires: Date.now() - 1000,
      })
      const second = await firstOf(secondContext.integrationMethods).refresh(
        {
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'second-' + 'refresh',
          access: 'old-' + 'access',
          expires: Date.now() - 1000,
        },
      )

      expect(seen.toSorted()).toEqual([
        'first-' + 'refresh',
        'second-' + 'refresh',
      ])
      expect<unknown>(first.access).toBe('access-first-' + 'refresh')
      expect<unknown>(second.access).toBe('access-second-' + 'refresh')
      expect(first).not.toEqual(second)
    } finally {
      network.fetch = originalFetch
    }
  })

  test('reuses a successful refresh for delayed calls with the rotated token', async () => {
    const { ctx, integrationMethods, advance } = createMockContext()

    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const first = await registration.refresh(credential)
      const delayed = await registration.refresh(credential)

      expect(tokenRequests).toBe(1)
      expect(delayed).toEqual(first)

      // The settled refresh is kept for 30 seconds.
      advance(30_000)
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
    } finally {
      network.fetch = originalFetch
    }
  })

  test('fails closed instead of replaying a token when the settled refresh cache is full', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const prefix = `cache-bound-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock((_input: unknown, init?: RequestInit) => {
      tokenRequests++
      const refresh = String(
        (JSON.parse(String(init?.body)) as { refresh_token: string })
          .refresh_token,
      )
      return Promise.resolve(
        Response.json({
          refresh_token: `rotated-${refresh}`,
          access_token: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = (index: number) => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: `${prefix}-${index}`,
        access: 'old-access',
        expires: Date.now() - 1000,
      })
      for (let index = 0; index < 256; index++) {
        await registration.refresh(credential(index))
      }
      await expect(registration.refresh(credential(256))).rejects.toThrow(
        'consumed-token cache expires',
      )
      expect(tokenRequests).toBe(256)

      await registration.refresh(credential(0))
      expect(tokenRequests).toBe(256)
      await cleanup?.()
    } finally {
      network.fetch = originalFetch
    }
  })

  test('clears settled refresh credentials and timers during setup cleanup', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refresh = `cleanup-${crypto.randomUUID()}`
    let tokenRequests = 0
    const originalFetch = network.fetch
    network.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: `rotated-${refresh}`,
          access_token: `access-${refresh}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      const cleanup = await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = {
        type: 'oauth',
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      }
      await registration.refresh(credential)
      await registration.refresh(credential)
      expect(tokenRequests).toBe(1)

      await cleanup?.()
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
      await cleanup?.()
    } finally {
      network.fetch = originalFetch
    }
  })

  test('concurrent refreshes keep different credentials isolated', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refreshTokens: string[] = []
    const originalFetch = network.fetch
    network.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refreshToken = String(body.refresh_token)
      refreshTokens.push(refreshToken)
      return Promise.resolve(
        Response.json({
          refresh_token: `new-${refreshToken}`,
          access_token: `access-${refreshToken}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx)
      const registration = firstOf(integrationMethods)
      const credential = (refresh: string) => ({
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      const [first, second] = await Promise.all([
        registration.refresh(credential('first')),
        registration.refresh(credential('second')),
      ])

      expect(refreshTokens.toSorted()).toEqual(['first', 'second'])
      expect<unknown>(first.access).toBe('access-first')
      expect<unknown>(second.access).toBe('access-second')
    } finally {
      network.fetch = originalFetch
    }
  })
})

describe('session http.request hook', () => {
  function anthropicOAuthContext() {
    const mocked = createMockContext()
    mocked.ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    mocked.ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    return mocked
  }

  test('ignores non-anthropic providers', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)

    const originalRequest = new Request('https://api.openai.com/v1/chat', {
      method: 'POST',
      body: '{}',
    })
    const event: RequestEvent = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')(event)

    expect(event.request).toBe(originalRequest)
  })

  test('leaves API-key Anthropic requests untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: '{}',
      },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')(event)

    expect(event.request).toBe(originalRequest)
  })

  test('rewrites headers, body, and URL for an active OAuth connection', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-length': String(body.length),
          'content-encoding': 'gzip',
          'content-digest': 'sha-256=:stale:',
          'content-md5': 'stale',
          'content-range': 'bytes 0-1/2',
          digest: 'sha-256=stale',
          etag: 'stale',
          'x-api-key': 'my-access-token',
        },
        body,
      },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')(event)

    expect(event.request).not.toBe(originalRequest)
    const rewritten: Request = event.request
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
    expect(rewritten.headers.get('x-api-key')).toBeNull()
    expect(rewritten.headers.get('content-length')).toBeNull()
    expect(rewritten.headers.get('content-encoding')).toBeNull()
    expect(rewritten.headers.get('content-digest')).toBeNull()
    expect(rewritten.headers.get('content-md5')).toBeNull()
    expect(rewritten.headers.get('content-range')).toBeNull()
    expect(rewritten.headers.get('digest')).toBeNull()
    expect(rewritten.headers.get('etag')).toBeNull()
    expect(rewritten.redirect).toBe('error')
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    expect(rewritten.url).toContain('beta=true')

    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.tools[0].name).toBe(shortAlias('bash'))
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
  })

  test('uses one configured Claude Code version for headers and billing', async () => {
    const originalVersion = environment.versionOverride
    environment.versionOverride = '2.9.99'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      environment.versionOverride = '3.0.0'

      const event: RequestEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hello world test message' }],
          }),
        }),
      }
      await sessionHooks.get('http.request')(event)

      expect(event.request.headers.get('user-agent')).toBe(
        'claude-cli/2.9.99 (external, cli)',
      )
      const parsedBody = JSON.parse(await event.request.text())
      expect(parsedBody.system[0].text).toContain('cc_version=2.9.99.')
    } finally {
      restoreVersionOverride(originalVersion)
    }
  })

  test('logs and ignores a malformed Claude Code version', async () => {
    const originalVersion = environment.versionOverride
    const consoleError = logSpy('Error')
    const malformedValue = 'credential-like-private-value'
    environment.versionOverride = malformedValue

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)

      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(
        ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR,
      )
      expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(
        malformedValue,
      )

      const event: RequestEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')(event)
      expect(event.request.headers.get('user-agent')).toBe(
        `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      )
    } finally {
      consoleError.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('warns about an outdated version override but still reports it', async () => {
    const originalVersion = environment.versionOverride
    const consoleWarn = logSpy('Warn')
    environment.versionOverride = '2.1.99'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      expect(consoleWarn).toHaveBeenCalledTimes(1)

      const event: RequestEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')(event)
      expect(event.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.99 (external, cli)',
      )
    } finally {
      consoleWarn.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('stays silent for an override at or above the bundled version', async () => {
    const originalVersion = environment.versionOverride
    const consoleError = logSpy('Error')
    const consoleWarn = logSpy('Warn')
    environment.versionOverride = CLAUDE_CODE_VERSION

    try {
      const { ctx } = anthropicOAuthContext()
      await plugin.setup(ctx)
      expect(consoleError).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('preserves GET requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'GET',
    })
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('GET')
    expect(await rewritten.text()).toBe('')
  })

  test('routes non-transform requests through the configured custom endpoint', async () => {
    const originalBaseUrl = environment.baseUrl
    environment.baseUrl = 'https://proxy.example/base'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      const requestHook = sessionHooks.get('http.request')

      const getEvent: RequestEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request(
          'https://api.anthropic.com/v1/models?source=opencode',
        ),
      }
      await requestHook(getEvent)

      expect(getEvent.request.url).toBe(
        'https://proxy.example/v1/models?source=opencode',
      )
      expect(getEvent.request.method).toBe('GET')
      expect(getEvent.request.headers.get('authorization')).toBe(
        'Bearer my-access-token',
      )

      const body = '{"model":"claude-3"}'
      const postEvent: RequestEvent = {
        model: getEvent.model,
        request: new Request('https://api.anthropic.com/v1/models', {
          method: 'POST',
          headers: {
            'content-length': String(body.length),
            'content-type': 'application/json',
          },
          body,
        }),
      }
      await requestHook(postEvent)

      expect(postEvent.request.url).toBe('https://proxy.example/v1/models')
      expect(postEvent.request.method).toBe('POST')
      expect(postEvent.request.headers.get('content-length')).toBe(
        String(body.length),
      )
      expect(await postEvent.request.text()).toBe(body)
    } finally {
      environment.baseUrl = originalBaseUrl
    }
  })

  test('preserves POST requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST' },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('POST')
    expect(rewritten.body).toBeNull()
  })

  test('does not rewrite an unrelated Anthropic POST endpoint body or representation headers', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const body = '{"model":"claude-3"}'
    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'content-encoding': 'gzip',
        etag: '"model-list"',
        'x-api-key': 'stale-key',
      },
      body,
    })
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await sessionHooks.get('http.request')(event)

    const rewritten: Request = event.request
    expect(await rewritten.text()).toBe(body)
    expect(rewritten.headers.get('content-type')).toBe('application/json')
    expect(rewritten.headers.get('content-length')).toBe(
      originalRequest.headers.get('content-length'),
    )
    expect(rewritten.headers.get('content-encoding')).toBe('gzip')
    expect(rewritten.headers.get('etag')).toBe('"model-list"')
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
  })

  test('keeps invalid body and representation headers coherent on unrelated endpoints', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const body = 'not-json'
    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        digest: 'sha-256=upstream',
      },
      body,
    })
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await sessionHooks.get('http.request')(event)

    const rewritten: Request = event.request
    expect(await rewritten.text()).toBe(body)
    expect(rewritten.headers.get('content-type')).toBe('application/json')
    expect(rewritten.headers.get('content-length')).toBe(
      originalRequest.headers.get('content-length'),
    )
    expect(rewritten.headers.get('digest')).toBe('sha-256=upstream')
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
  })

  test('rewrites count_tokens request bodies but does not transform their responses', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request(
        'https://api.anthropic.com/v1/messages/count_tokens',
        {
          method: 'POST',
          body: JSON.stringify({
            tools: [{ name: 'bash', type: 'function' }],
            system: 'Count this',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      ),
    }
    await sessionHooks.get('http.request')(requestEvent)

    const parsedBody = JSON.parse(await requestEvent.request.text())
    expect(parsedBody.tools[0].name).toBe(shortAlias('bash'))
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )

    const responseBody = '{"input_tokens":42}'
    const originalResponse = new Response(responseBody, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'count-tokens-1',
        'x-ratelimit-remaining': '99',
      },
    })
    const responseEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')(responseEvent)

    expect(responseEvent.response).toBe(originalResponse)
    expect(responseEvent.response.status).toBe(200)
    expect(responseEvent.response.statusText).toBe('OK')
    expect(responseEvent.response.headers.get('content-type')).toBe(
      'application/json',
    )
    expect(responseEvent.response.headers.get('x-request-id')).toBe(
      'count-tokens-1',
    )
    expect(responseEvent.response.headers.get('x-ratelimit-remaining')).toBe(
      '99',
    )
    expect(await responseEvent.response.text()).toBe(responseBody)
  })

  test('refuses to send OAuth credentials to an untrusted origin', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const originalRequest = new Request(
      'https://api.anthropic.com.evil.test/v1/messages',
      { method: 'POST', body: '{}' },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
      'Refusing to send Anthropic OAuth credentials to an untrusted origin',
    )
    expect(event.request).toBe(originalRequest)
    expect(event.request.headers.get('authorization')).toBeNull()
  })

  test('rewrites an image-heavy request body above 10 MiB', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const imageData = 'A'.repeat(12 * 1024 * 1024)
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          system: 'Look at this',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: imageData,
                  },
                },
              ],
            },
          ],
        }),
      }),
    }
    await sessionHooks.get('http.request')(event)
    const parsedBody = JSON.parse(await event.request.text())
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
    expect(parsedBody.messages[0].content[0].source.data).toBe(imageData)
  })

  test('rejects a declared request body above 32 MiB', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
        body: '{}',
      },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
      'Anthropic request body exceeds 33554432 byte limit',
    )
    expect(event.request).toBe(originalRequest)
  })

  test('rejects an untrackable transformed URL without exposing its query', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const query = `private-query-${'x'.repeat(8 * 1024)}`
    const originalRequest = new Request(
      `https://api.anthropic.com/v1/messages?marker=${query}`,
      { method: 'POST', body: '{}' },
    )
    const event: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }

    let failure: unknown
    try {
      await sessionHooks.get('http.request')(event)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Unable to track transformed Anthropic request',
    )
    expect((failure as Error).message).not.toContain(query)
    expect(event.request).toBe(originalRequest)
    expect(event.request.headers.get('authorization')).toBeNull()
  })
})

describe('session http.response hook', () => {
  function anthropicOAuthContext() {
    const mocked = createMockContext()
    mocked.ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    mocked.ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    return mocked
  }

  function versionRejectionBody(
    rejectedVersion: string,
    requiredVersion: string,
  ) {
    return JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          `Claude Code ${rejectedVersion} does not support this model; ` +
          `version ${requiredVersion} or newer is required. Run 'claude update', ` +
          'or update the Claude desktop app, then try again.',
        details: { error_code: 'claude_code_version_too_old' },
      },
      request_id: 'req_fixture_version_gate',
    })
  }

  test('adopts an exact version-gate floor and marks only its response retryable', async () => {
    const originalVersion = environment.versionOverride
    environment.versionOverride = undefined

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      const model = { providerID: 'anthropic', id: 'claude-opus-test' }
      const requestHook = sessionHooks.get('http.request')
      const responseHook = sessionHooks.get('http.response')
      const makeRequest = () => ({
        sessionID: 'session-version-gate',
        agent: 'build',
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'version gate fixture' }],
          }),
        }),
      })

      const initial: RequestEvent = makeRequest()
      await requestHook(initial)
      expect(initial.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.280 (external, cli)',
      )
      expect(
        JSON.parse(await initial.request.clone().text()).system[0].text,
      ).toContain('cc_version=2.1.280.')

      const firstBody = versionRejectionBody('2.1.280', '2.1.281')
      const firstResponse: ResponseEvent = {
        sessionID: initial.sessionID,
        agent: initial.agent,
        model,
        request: new Request(initial.request),
        response: new Response(firstBody, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      }
      await responseHook(firstResponse)
      expect(firstResponse.response.headers.get('x-should-retry')).toBe('true')
      expect(await firstResponse.response.text()).toBe(firstBody)

      const retried: RequestEvent = makeRequest()
      await requestHook(retried)
      expect(retried.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.281 (external, cli)',
      )
      expect(
        JSON.parse(await retried.request.clone().text()).system[0].text,
      ).toContain('cc_version=2.1.281.')

      const secondResponse: ResponseEvent = {
        sessionID: retried.sessionID,
        agent: retried.agent,
        model,
        request: new Request(retried.request),
        response: new Response(versionRejectionBody('2.1.281', '2.1.282'), {
          status: 400,
        }),
      }
      await responseHook(secondResponse)
      expect(secondResponse.response.headers.get('x-should-retry')).toBeNull()

      const laterRequest: RequestEvent = makeRequest()
      await requestHook(laterRequest)
      expect(laterRequest.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.282 (external, cli)',
      )
    } finally {
      restoreVersionOverride(originalVersion)
    }
  })

  test('does not replace or retry an explicit version override', async () => {
    const originalVersion = environment.versionOverride
    environment.versionOverride = '2.9.99'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      const model = { providerID: 'anthropic', id: 'claude-opus-test' }
      const requestEvent: RequestEvent = {
        sessionID: 'session-version-override',
        agent: 'build',
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')(requestEvent)

      const responseEvent: ResponseEvent = {
        sessionID: requestEvent.sessionID,
        agent: requestEvent.agent,
        model,
        request: new Request(requestEvent.request),
        response: new Response(versionRejectionBody('2.9.99', '3.0.0'), {
          status: 400,
        }),
      }
      await sessionHooks.get('http.response')(responseEvent)
      expect(responseEvent.response.headers.get('x-should-retry')).toBeNull()

      const laterRequest: RequestEvent = {
        ...requestEvent,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')(laterRequest)
      expect(laterRequest.request.headers.get('user-agent')).toBe(
        'claude-cli/2.9.99 (external, cli)',
      )
    } finally {
      restoreVersionOverride(originalVersion)
    }
  })

  test('retries concurrent stale-version responses for distinct recovery keys', async () => {
    const originalVersion = environment.versionOverride
    environment.versionOverride = undefined

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      const model = { providerID: 'anthropic', id: 'claude-opus-test' }
      const requestHook = sessionHooks.get('http.request')
      const responseHook = sessionHooks.get('http.response')
      const makeRequest = (sessionID: string) => ({
        sessionID,
        agent: 'build',
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      })

      const first: RequestEvent = makeRequest('session-version-gate-concurrent-a')
      const second: RequestEvent = makeRequest('session-version-gate-concurrent-b')
      await requestHook(first)
      await requestHook(second)
      expect(first.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.280 (external, cli)',
      )
      expect(second.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.280 (external, cli)',
      )

      const firstResponse: ResponseEvent = {
        ...first,
        request: new Request(first.request),
        response: new Response(versionRejectionBody('2.1.280', '2.1.281'), {
          status: 400,
        }),
      }
      const secondResponse: ResponseEvent = {
        ...second,
        request: new Request(second.request),
        response: new Response(versionRejectionBody('2.1.280', '2.1.282'), {
          status: 400,
        }),
      }

      await Promise.all([
        responseHook(firstResponse),
        responseHook(secondResponse),
      ])
      expect(firstResponse.response.headers.get('x-should-retry')).toBe('true')
      expect(secondResponse.response.headers.get('x-should-retry')).toBe('true')

      const later: RequestEvent = makeRequest('session-version-gate-after-concurrent')
      await requestHook(later)
      expect(later.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.282 (external, cli)',
      )
    } finally {
      restoreVersionOverride(originalVersion)
    }
  })

  test('can recover after ignoring a malformed version override', async () => {
    const originalVersion = environment.versionOverride
    const consoleError = logSpy('Error')
    environment.versionOverride = 'not-a-version'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx)
      const model = { providerID: 'anthropic', id: 'claude-opus-test' }
      const requestEvent: RequestEvent = {
        sessionID: 'session-malformed-version-override',
        agent: 'build',
        model,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')(requestEvent)

      const responseEvent: ResponseEvent = {
        sessionID: requestEvent.sessionID,
        agent: requestEvent.agent,
        model,
        request: new Request(requestEvent.request),
        response: new Response(
          versionRejectionBody(CLAUDE_CODE_VERSION, '2.1.281'),
          { status: 400 },
        ),
      }
      await sessionHooks.get('http.response')(responseEvent)

      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(responseEvent.response.headers.get('x-should-retry')).toBe('true')
    } finally {
      consoleError.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('shares identical long aliases across concurrent reconstructed responses and cleans up after both', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const sourceName = 'x'.repeat(64)
    const body = JSON.stringify({ tools: [{ name: sourceName }] })
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEventA: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }
    const requestEventB: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }

    const requestHook = sessionHooks.get('http.request')
    await Promise.all([requestHook(requestEventA), requestHook(requestEventB)])
    const aliasA = JSON.parse(await requestEventA.request.clone().text())
      .tools[0].name
    const aliasB = JSON.parse(await requestEventB.request.clone().text())
      .tools[0].name
    expect(aliasA).toBe(aliasB)
    expect(aliasA).not.toBe(sourceName)

    const responseHook = sessionHooks.get('http.response')
    const responseEventA: ResponseEvent = {
      model,
      request: new Request(requestEventA.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasA }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    const responseEventB: ResponseEvent = {
      model,
      request: new Request(requestEventB.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasB }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }

    await Promise.all([
      responseHook(responseEventA),
      responseHook(responseEventB),
    ])
    const [decodedA, decodedB] = await Promise.all([
      responseEventA.response.text(),
      responseEventB.response.text(),
    ])
    expect(JSON.parse(decodedA).content[0].name).toBe(sourceName)
    expect(JSON.parse(decodedB).content[0].name).toBe(sourceName)

    const thirdEvent: ResponseEvent = {
      model,
      request: new Request(requestEventA.request),
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: aliasA }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await responseHook(thirdEvent)
    expect(JSON.parse(await thirdEvent.response.text()).content[0].name).toBe(
      aliasA,
    )
  })

  test('keeps one long alias alive across multiple concurrent reconstructed response streams', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'parallel-reconstructed-'.repeat(4)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const encoder = new TextEncoder()
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })
    const responseEvent = (stream: ReadableStream<Uint8Array>): ResponseEvent => ({
      model,
      request: new Request(requestEvent.request),
      response: new Response(stream, {
        headers: { 'content-type': 'application/json' },
      }),
    })
    const { stream: firstStream, controller: firstController } = controlled()
    const { stream: secondStream, controller: secondController } = controlled()
    const firstEvent = responseEvent(firstStream)
    const secondEvent = responseEvent(secondStream)
    const responseHook = sessionHooks.get('http.response')
    await responseHook(firstEvent)
    await responseHook(secondEvent)

    firstController.enqueue(encoder.encode(responseBody))
    firstController.close()
    expect(JSON.parse(await firstEvent.response.text()).content[0].name).toBe(
      originalName,
    )

    secondController.enqueue(encoder.encode(responseBody))
    secondController.close()
    expect(JSON.parse(await secondEvent.response.text()).content[0].name).toBe(
      originalName,
    )
  })

  test('keeps reconstructed ownership atomic when a concurrent response finalizes synchronously', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'synchronous-passthrough-'.repeat(4)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const { stream, controller } = controlled()
    const passthroughEvent: ResponseEvent = {
      model,
      request: new Request(requestEvent.request),
      response: new Response('unchanged', {
        headers: { 'content-type': 'text/plain' },
      }),
    }
    const transformedEvent: ResponseEvent = {
      model,
      request: new Request(requestEvent.request),
      response: new Response(stream, {
        headers: { 'content-type': 'application/json' },
      }),
    }
    const responseHook = sessionHooks.get('http.response')
    await Promise.all([
      responseHook(passthroughEvent),
      responseHook(transformedEvent),
    ])
    expect(await passthroughEvent.response.text()).toBe('unchanged')

    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      ),
    )
    controller.close()
    expect(
      JSON.parse(await transformedEvent.response.text()).content[0].name,
    ).toBe(originalName)
  })

  test('keeps aliases active past the request TTL while a response stream owns them', async () => {
    const { ctx, sessionHooks, advance } = anthropicOAuthContext()
    const cleanup = await plugin.setup(ctx)
    const originalName = 'long-running-stream-'.repeat(4)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const { stream, controller } = controlled()
    const event: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    }
    await sessionHooks.get('http.response')(event)

    // Past the request's five-minute lease.
    advance(5 * 60_000 + 1)
    controller.enqueue(
      new TextEncoder().encode(
        `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${alias}"}}\n\n`,
      ),
    )
    controller.close()

    expect(await event.response.text()).toContain(`"name":"${originalName}"`)
    await cleanup?.()
  })

  test('extends an idle alias lease when an identical request reuses it', async () => {
    const { ctx, sessionHooks, advance } = anthropicOAuthContext()
    const cleanup = await plugin.setup(ctx)
    const originalName = 'reused-request-'.repeat(5)
    const body = JSON.stringify({ tools: [{ name: originalName }] })
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestHook = sessionHooks.get('http.request')
    const firstEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }
    await requestHook(firstEvent)
    advance(4 * 60_000)

    const secondEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body,
      }),
    }
    await requestHook(secondEvent)
    const alias = JSON.parse(await secondEvent.request.clone().text())
      .tools[0].name
    // Past the first request's lease, inside the second's.
    advance(2 * 60_000)

    const responseEvent: ResponseEvent = {
      model,
      request: secondEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await sessionHooks.get('http.response')(responseEvent)
    expect(
      JSON.parse(await responseEvent.response.text()).content[0].name,
    ).toBe(originalName)
    await cleanup?.()
  })

  test('fails closed when a reconstructed transformed request body was consumed', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const sourceName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    await reconstructedRequest.text()
    const responseEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }

    await sessionHooks.get('http.response')(responseEvent)
    expect(
      JSON.parse(await responseEvent.response.text()).content[0].name,
    ).toBe(alias)
  })

  test('delivers a successful response when reconstructed alias lookup exceeds the request bound', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'bounded-lookup-'.repeat(8)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructed = new Request(requestEvent.request)
    reconstructed.headers.set('content-length', String(32 * 1024 * 1024 + 1))
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })
    const event: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructed,
      response: new Response(responseBody, {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_fixture_lookup',
        },
      }),
    }

    await expect(
      sessionHooks.get('http.response')(event),
    ).resolves.toBeUndefined()
    expect(event.response.status).toBe(200)
    expect(event.response.statusText).toBe('OK')
    expect(event.response.headers.get('x-request-id')).toBe(
      'req_fixture_lookup',
    )
    expect(await event.response.text()).toBe(responseBody)
  })

  test('reclaims an unresolved alias lease after its idle TTL', async () => {
    const { ctx, sessionHooks, advance } = anthropicOAuthContext()
    const cleanup = await plugin.setup(ctx)
    const originalName = 'unresolved-lease-'.repeat(5)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const reconstructed = new Request(requestEvent.request)
    reconstructed.headers.set('content-length', String(32 * 1024 * 1024 + 1))
    const responseHook = sessionHooks.get('http.response')
    const unresolvedEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructed,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await responseHook(unresolvedEvent)
    expect(
      JSON.parse(await unresolvedEvent.response.text()).content[0].name,
    ).toBe(alias)

    // Past the request's five-minute lease.
    advance(5 * 60_000 + 1)
    const afterExpiry: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await responseHook(afterExpiry)
    expect(
      JSON.parse(await afterExpiry.response.text()).content[0].name,
    ).toBe(alias)
    await cleanup?.()
  })

  test('releases a long alias when a transformed response body is locked', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const originalName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    const lockedResponse = new Response(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    const lockedBody = lockedResponse.body
    if (lockedBody === null) throw new Error('the response has no body')
    const reader = lockedBody.getReader()

    try {
      const lockedEvent: ResponseEvent = {
        model: requestEvent.model,
        request: reconstructedRequest,
        response: lockedResponse,
      }
      await expect(
        Promise.resolve().then(() =>
          sessionHooks.get('http.response')(lockedEvent),
        ),
      ).rejects.toThrow()
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }

    const freshEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(freshEvent)
    expect(JSON.parse(await freshEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('preserves long aliases after setup cleanup', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    const cleanup = await plugin.setup(ctx)

    const sourceName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructedRequest = new Request(requestEvent.request)
    await cleanup?.()

    const responseEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(responseEvent)
    expect(
      JSON.parse(await responseEvent.response.text()).content[0].name,
    ).toBe(alias)
  })

  test('defers alias disposal until an active response stream finalizes after setup cleanup', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    const cleanup = await plugin.setup(ctx)
    const originalName = 'cleanup-active-stream-'.repeat(4)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    const requestHook = sessionHooks.get('http.request')
    const responseHook = sessionHooks.get('http.response')
    await requestHook(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const { stream, controller } = controlled()
    const event: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(stream, {
        headers: { 'content-type': 'application/json' },
      }),
    }
    await responseHook(event)
    await cleanup?.()

    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: alias }],
        }),
      ),
    )
    controller.close()
    expect(JSON.parse(await event.response.text()).content[0].name).toBe(
      originalName,
    )

    const laterResponse = Response.json({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })
    const laterEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: laterResponse,
    }
    await responseHook(laterEvent)
    expect(laterEvent.response).toBe(laterResponse)
    expect(JSON.parse(await laterEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('isolates long aliases between reconstructed requests', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const sourceA = 'a'.repeat(64)
    const sourceB = 'b'.repeat(64)
    const requestEventA: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceA }] }),
      }),
    }
    const requestEventB: RequestEvent = {
      model: requestEventA.model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: sourceB }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEventA)
    await sessionHooks.get('http.request')(requestEventB)
    const aliasA = JSON.parse(await requestEventA.request.clone().text())
      .tools[0].name
    const aliasB = JSON.parse(await requestEventB.request.clone().text())
      .tools[0].name
    expect(aliasA).not.toBe(aliasB)

    const reconstructedB = new Request(requestEventB.request)
    const responseEvent: ResponseEvent = {
      model: requestEventB.model,
      request: reconstructedB,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [
            { type: 'tool_use', name: aliasA },
            { type: 'tool_use', name: aliasB },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(responseEvent)
    expect(JSON.parse(await responseEvent.response.text()).content).toEqual([
      { type: 'tool_use', name: aliasA },
      { type: 'tool_use', name: sourceB },
    ])
  })

  test('decodes a long tool alias after a reconstructed OAuth request', async () => {
    const mocked = createMockContext()
    const { ctx, sessionHooks } = mocked
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const originalName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const emittedBody = JSON.parse(await requestEvent.request.clone().text())
    const emittedAlias = emittedBody.tools[0].name
    expect(emittedAlias).not.toBe(originalName)
    expect(emittedAlias).toMatch(/^mcp_H[A-Za-z0-9_-]+$/)

    const reconstructedRequest = new Request(requestEvent.request)
    const responseEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(responseEvent)

    const decoded = JSON.parse(await responseEvent.response.text())
    expect(decoded.content[0].name).toBe(originalName)
  })

  test('decodes and releases a direct owned alias after its request body was consumed', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'consumed-direct-'.repeat(6)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    await requestEvent.request.text()
    const responseHook = sessionHooks.get('http.response')
    const response = () =>
      Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      })
    const firstEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: response(),
    }

    await responseHook(firstEvent)
    expect(JSON.parse(await firstEvent.response.text()).content[0].name).toBe(
      originalName,
    )

    const laterEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: response(),
    }
    await responseHook(laterEvent)
    expect(JSON.parse(await laterEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('decodes a streamed tool alias when the plugin reloads mid-request', async () => {
    const before = anthropicOAuthContext()
    const disposeBefore = await plugin.setup(before.ctx)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'shell' }] }),
      }),
    }
    await before.sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    await requestEvent.request.text()

    ;void disposeBefore()
    const after = anthropicOAuthContext()
    await plugin.setup(after.ctx)
    const event = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: alias,
        input: {},
      },
    })
    const responseEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(`event: content_block_start\ndata: ${event}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    }

    await after.sessionHooks.get('http.response')(responseEvent)
    const data = (await responseEvent.response.text()).match(/^data: (.*)$/m)
    expect(JSON.parse(String(data?.[1])).content_block.name).toBe('shell')
  })

  test('decodes and releases aliases when the request explicitly uses beta=false', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)

    const originalName = 'beta-false-'.repeat(8)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages?beta=false', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    const requestHook = sessionHooks.get('http.request')
    const responseHook = sessionHooks.get('http.response')
    await requestHook(requestEvent)
    expect(new URL(requestEvent.request.url).searchParams.get('beta')).toBe(
      'false',
    )
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    expect(alias).toMatch(/^mcp_H[A-Za-z0-9_-]+$/)

    const firstEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await responseHook(firstEvent)
    expect(JSON.parse(await firstEvent.response.text()).content[0].name).toBe(
      originalName,
    )

    const laterEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await responseHook(laterEvent)
    expect(JSON.parse(await laterEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('releases a long alias after a reconstructed response is fully consumed', async () => {
    const mocked = createMockContext()
    const { ctx, sessionHooks } = mocked
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const originalName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const reconstructedRequest = new Request(requestEvent.request)

    const firstEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(firstEvent)
    const decoded = JSON.parse(await firstEvent.response.text())
    expect(decoded.content[0].name).toBe(originalName)

    const secondEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructedRequest,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(secondEvent)
    const preserved = JSON.parse(await secondEvent.response.text())

    expect(preserved.content[0].name).toBe(emittedAlias)
  })

  test('strips tool prefixes when the matching request used OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    let oauthActive = true
    ctx.integration.connection.active.mockImplementation(async () =>
      oauthActive ? { id: 'conn-1' } : undefined,
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'bash' }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    oauthActive = false

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${emittedAlias}"}}\n\n`,
          ),
        )
        controller.close()
      },
    })
    const originalResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const event: ResponseEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')(event)

    expect(event.response).not.toBe(originalResponse)
    const text = await event.response.text()
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain(emittedAlias)
  })

  test('strips tool prefixes after another hook clones the OAuth request', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({
        id: 'conn-1',
      }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)

    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'bash' }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name

    const clonedRequest = new Request(requestEvent.request)
    const responseEvent: ResponseEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: clonedRequest,
      response: new Response(
        `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${emittedAlias}"}}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    }
    await sessionHooks.get('http.response')(responseEvent)

    expect(await responseEvent.response.text()).toContain('"name":"bash"')
  })

  test('leaves non-anthropic responses untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)

    const originalResponse = new Response(null, { status: 200 })
    const event: ResponseEvent = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: new Request('https://api.openai.com/v1/chat'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves Anthropic responses untouched when the request did not use OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)

    const originalResponse = new Response('ok')
    const event: ResponseEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves structurally matching bearer responses untouched when this plugin did not own the request', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)
    const responseHook = sessionHooks.get('http.response')
    const headers = {
      authorization: 'Bearer externally-managed',
      'anthropic-beta': REQUIRED_BETAS.join(','),
    }
    const malformed =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use"\n\n'

    for (const suffix of ['', '?beta=false', '?beta=true']) {
      const originalResponse = new Response(malformed, {
        headers: { 'content-type': 'text/event-stream' },
      })
      const event: ResponseEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request(`https://api.anthropic.com/v1/messages${suffix}`, {
          method: 'POST',
          headers,
          body: '{}',
        }),
        response: originalResponse,
      }

      await responseHook(event)
      expect(event.response).toBe(originalResponse)
      expect(await event.response.text()).toBe(malformed)
    }
  })

  test('leaves an unowned Anthropic 429 response unchanged', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'This request would exceed your account usage limit.',
      },
    })
    const originalResponse = new Response(body, {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '60',
        'x-request-id': 'req_fixture_unowned',
      },
    })
    const event: ResponseEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer externally-managed',
          'anthropic-beta': REQUIRED_BETAS.join(','),
        },
        body: '{}',
      }),
      response: originalResponse,
    }

    await sessionHooks.get('http.response')(event)
    expect(event.response).toBe(originalResponse)
    expect(event.response.headers.get('x-should-retry')).toBeNull()
    expect(event.response.headers.get('retry-after')).toBe('60')
    expect(await event.response.text()).toBe(body)
  })

  test('does not share reconstructed ownership across body, bearer, or URL changes', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'ownership-isolation-'.repeat(4)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    const requestHook = sessionHooks.get('http.request')
    const responseHook = sessionHooks.get('http.response')
    await requestHook(requestEvent)
    const rewrittenBody = await requestEvent.request.clone().text()
    const alias = JSON.parse(rewrittenBody).tools[0].name
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: alias }],
    })

    const variants = [
      {
        label: 'body',
        url: requestEvent.request.url,
        authorization: requestEvent.request.headers.get('authorization'),
        body: `${rewrittenBody} `,
      },
      {
        label: 'bearer',
        url: requestEvent.request.url,
        authorization: 'Bearer externally-managed',
        body: rewrittenBody,
      },
      {
        label: 'URL',
        url: requestEvent.request.url.replace('beta=true', 'beta=false'),
        authorization: requestEvent.request.headers.get('authorization'),
        body: rewrittenBody,
      },
    ]

    for (const variant of variants) {
      const headers = new Headers(requestEvent.request.headers)
      if (variant.authorization) {
        headers.set('authorization', variant.authorization)
      }
      const request = new Request(variant.url, {
        method: 'POST',
        headers,
        body: variant.body,
      })
      const originalResponse = new Response(responseBody, {
        headers: {
          'content-type': 'application/json',
          'x-fixture': variant.label,
        },
      })
      const event: ResponseEvent = { model, request, response: originalResponse }

      await responseHook(event)
      expect(event.response).toBe(originalResponse)
      expect(await event.response.text()).toBe(responseBody)
    }

    const ownedEvent: ResponseEvent = {
      model,
      request: requestEvent.request,
      response: new Response(responseBody, {
        headers: { 'content-type': 'application/json' },
      }),
    }
    await responseHook(ownedEvent)
    expect(JSON.parse(await ownedEvent.response.text()).content[0].name).toBe(
      originalName,
    )
  })

  test('bounds concurrent reconstructed ownership lookups and leaves overflow untouched', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    const cleanup = await plugin.setup(ctx)
    const model = { providerID: 'anthropic', modelID: 'claude-3' }
    const requestEvent: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: 'bash' }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const rewrittenBody = await requestEvent.request.clone().text()
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const pendingEvents: ResponseEvent[] = []
    const responseHook = sessionHooks.get('http.response')

    try {
      const pending = Array.from({ length: 32 }, () => {
        const { stream, controller } = controlled()
        const request = new Request(requestEvent.request.url, {
          method: 'POST',
          headers: requestEvent.request.headers,
          body: stream,
        })
        controllers.push(controller)
        const event: ResponseEvent = {
          model,
          request,
          response: Response.json({ type: 'message', content: [] }),
        }
        pendingEvents.push(event)
        return responseHook(event)
      })

      const overflowResponse = Response.json({ type: 'message', content: [] })
      const overflowEvent: ResponseEvent = {
        model,
        request: new Request(requestEvent.request.url, {
          method: 'POST',
          headers: requestEvent.request.headers,
          body: rewrittenBody,
        }),
        response: overflowResponse,
      }
      await responseHook(overflowEvent)
      expect(overflowEvent.response).toBe(overflowResponse)

      const bytes = new TextEncoder().encode(rewrittenBody)
      for (const controller of controllers) {
        controller.enqueue(bytes)
        controller.close()
      }
      await Promise.all(pending)
      await Promise.all(
        pendingEvents.map((event) => event.response.body?.cancel()),
      )
    } finally {
      for (const controller of controllers) {
        try {
          controller.close()
        } catch {
          // The normal path already closed this request stream.
        }
      }
      await Promise.all(
        pendingEvents.map((event) => event.response.body?.cancel()),
      )
      await cleanup?.()
    }
  })

  test('leaves a non-2xx reconstructed response unchanged despite a forged large length', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'x'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const emittedAlias = JSON.parse(await requestEvent.request.clone().text())
      .tools[0].name
    const reconstructed = new Request(requestEvent.request)
    reconstructed.headers.set('content-length', String(32 * 1024 * 1024 + 1))
    const body = 'upstream failure'
    const originalResponse = new Response(body, {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'content-type': 'application/json',
        'content-length': String(32 * 1024 * 1024 + 1),
        etag: '"upstream"',
      },
    })
    const event: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructed,
      response: originalResponse,
    }

    await expect(
      sessionHooks.get('http.response')(event),
    ).resolves.toBeUndefined()
    expect(event.response).toBe(originalResponse)
    expect(event.response.status).toBe(503)
    expect(event.response.statusText).toBe('Service Unavailable')
    expect(event.response.headers.get('content-length')).toBe(
      String(32 * 1024 * 1024 + 1),
    )
    expect(await event.response.text()).toBe(body)

    // A real direct request lease is also released when the upstream response
    // is non-2xx; a later response for that request must not decode its alias.
    const directResponse = new Response(body, {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
    const directEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: directResponse,
    }
    await sessionHooks.get('http.response')(directEvent)
    expect(directEvent.response).toBe(directResponse)
    const laterEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', name: emittedAlias }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    }
    await sessionHooks.get('http.response')(laterEvent)
    const laterBody = await laterEvent.response.text()
    expect(laterBody).toContain(emittedAlias)
    expect(laterBody).not.toContain(originalName)
  })

  test('releases an alias lease after a reconstructed non-2xx response', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const originalName = 'r'.repeat(64)
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ tools: [{ name: originalName }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const alias = JSON.parse(await requestEvent.request.clone().text()).tools[0]
      .name
    const reconstructed = new Request(requestEvent.request)
    const failedEvent: ResponseEvent = {
      model: requestEvent.model,
      request: reconstructed,
      response: new Response('failed', { status: 503 }),
    }
    await sessionHooks.get('http.response')(failedEvent)

    const laterEvent: ResponseEvent = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: alias }],
      }),
    }
    await sessionHooks.get('http.response')(laterEvent)

    expect(JSON.parse(await laterEvent.response.text()).content[0].name).toBe(
      alias,
    )
  })

  test('does not rewrite responses for an evil origin or GET request with markers', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx)
    const markerHeaders = {
      authorization: 'Bearer forged',
      'anthropic-beta': 'oauth-2025-04-20, interleaved-thinking-2025-05-14',
    }
    const responseBody = JSON.stringify({
      type: 'message',
      content: [{ type: 'tool_use', name: shortAlias('forged') }],
    })
    for (const [label, request] of [
      [
        'evil origin',
        new Request('https://evil.example/v1/messages?beta=true', {
          method: 'POST',
          headers: markerHeaders,
          body: '{}',
        }),
      ],
      [
        'GET',
        new Request('https://api.anthropic.com/v1/messages?beta=true', {
          method: 'GET',
          headers: markerHeaders,
        }),
      ],
    ] as const) {
      const originalResponse = new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"${label}"` },
      })
      const event: ResponseEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request,
        response: originalResponse,
      }
      await sessionHooks.get('http.response')(event)
      expect(event.response).toBe(originalResponse)
      expect(await event.response.text()).toBe(responseBody)
    }
  })
})

describe('response transform concurrency bounds', () => {
  test('caps aggregate active transforms and releases slots on cancellation', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.integration.connection.active.mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ctx.integration.connection.resolve.mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'fixture-access',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx)
    const responseHook = sessionHooks.get('http.response')
    const requestEvent: RequestEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-test' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    }
    await sessionHooks.get('http.request')(requestEvent)
    const request = requestEvent.request
    const active: Response[] = []

    try {
      for (let index = 0; index < 256; index += 1) {
        const event: ResponseEvent = {
          model: { providerID: 'anthropic', modelID: 'claude-test' },
          request,
          response: Response.json({ type: 'message', content: [] }),
        }
        await responseHook(event)
        active.push(event.response)
      }

      const unownedResponse = Response.json({ type: 'message', content: [] })
      const unowned: ResponseEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-test' },
        request: new Request(
          'https://api.anthropic.com/v1/messages?beta=true',
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer externally-managed',
              'anthropic-beta': REQUIRED_BETAS.join(','),
            },
            body: '{}',
          },
        ),
        response: unownedResponse,
      }
      await responseHook(unowned)
      expect(unowned.response).toBe(unownedResponse)

      const overflow: ResponseEvent = {
        model: { providerID: 'anthropic', modelID: 'claude-test' },
        request,
        response: Response.json({ type: 'message', content: [] }),
      }
      await expect(responseHook(overflow)).rejects.toThrow(
        'Too many active Anthropic response transforms',
      )
      await overflow.response.body?.cancel()
    } finally {
      await Promise.all(active.map((response) => response.body?.cancel()))
    }

    const afterRelease: ResponseEvent = {
      model: { providerID: 'anthropic', modelID: 'claude-test' },
      request,
      response: Response.json({ type: 'message', content: [] }),
    }
    await responseHook(afterRelease)
    await afterRelease.response.body?.cancel()
  })
})

describe('multiple Anthropic connections and HTTP 429', () => {
  test('attributes each 429 to the connection used by that request and never rotates accounts', async () => {
    const { ctx, sessionHooks } = createMockContext()
    const connectionA = {
      type: 'credential',
      id: 'cred-active-a',
      label: 'Anthropic 3',
    }
    const connectionB = {
      type: 'credential',
      id: 'cred-active-b',
      label: 'Claude OAuth • 0123ABCD',
    }
    let activeConnection = connectionA
    ctx.integration.connection.active.mockImplementation(
      async () => activeConnection,
    )
    ctx.integration.connection.resolve.mockImplementation(
      async (connection: { id: string }) => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: `fixture-refresh-${connection.id}`,
        access:
          connection.id === connectionA.id
            ? 'fixture-access-a'
            : 'fixture-access-b',
        expires: Date.now() + 60_000,
      }),
    )
    await plugin.setup(ctx)

    const model = { providerID: 'anthropic', modelID: 'claude-test' }
    const requestA: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      }),
    }
    await sessionHooks.get('http.request')(requestA)
    expect(requestA.request.headers.get('authorization')).toBe(
      'Bearer fixture-access-a',
    )

    activeConnection = connectionB
    const requestB: RequestEvent = {
      model,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'b' }] }),
      }),
    }
    await sessionHooks.get('http.request')(requestB)
    expect(requestB.request.headers.get('authorization')).toBe(
      'Bearer fixture-access-b',
    )

    const responseA: ResponseEvent = {
      model,
      request: new Request(requestA.request),
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Usage credits are required for fast mode.',
          },
          request_id: 'req_fast_mode_123',
        },
        {
          status: 429,
          headers: {
            'anthropic-ratelimit-unified-overage-disabled-reason':
              'org_level_disabled',
            'anthropic-ratelimit-unified-reset': '1790812800',
            'request-id': 'req_fast_mode_123',
          },
        },
      ),
    }
    await sessionHooks.get('http.response')(responseA)
    const bodyA = (await responseA.response.json()) as {
      error: { message: string }
      request_id?: string
    }
    expect(bodyA.error.message).toContain('category=fast-mode-credits')
    expect(bodyA.error.message).toContain(
      'Anthropic requires usage credits (extra usage) for fast mode on this account.',
    )
    expect(bodyA.error.message).toContain(
      'Enable extra usage for the Anthropic account or organization',
    )
    expect(bodyA.error.message).toContain('overage-disabled=org_level_disabled')
    expect(bodyA.request_id).toBe('req_fast_mode_123')
    expect(responseA.response.headers.get('x-should-retry')).toBe('false')
    expect(bodyA.error.message).toContain(
      `active=${describeConnection(connectionA)}`,
    )
    expect(bodyA.error.message).not.toContain(describeConnection(connectionB))

    const responseB: ResponseEvent = {
      model,
      request: new Request(requestB.request),
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.',
          },
        },
        { status: 429, headers: { 'retry-after': '2' } },
      ),
    }
    await sessionHooks.get('http.response')(responseB)
    const bodyB = (await responseB.response.json()) as {
      error: { message: string }
    }
    expect(bodyB.error.message).toContain(
      `active=${describeConnection(connectionB)}`,
    )
    expect(bodyB.error.message).not.toContain(describeConnection(connectionA))
    expect(responseB.response.headers.get('x-should-retry')).toBeNull()

    expect(ctx.integration.connection.active).toHaveBeenCalledTimes(2)
    expect(ctx.integration.connection.resolve).toHaveBeenCalledTimes(2)
    expect(ctx.integration.connection.resolve).toHaveBeenNthCalledWith(
      1,
      connectionA,
    )
    expect(ctx.integration.connection.resolve).toHaveBeenNthCalledWith(
      2,
      connectionB,
    )
  })
})

describe('credential choice, wire extras and quota readings', () => {
  const HOUR = 3_600_000
  const seconds = (ms: number) => String(Math.floor(ms / 1000))

  function twoAccounts() {
    const mocked = createMockContext()
    const accessOf: Record<string, string> = {
      'cred-a': `fixture-access-a-${crypto.randomUUID()}`,
      'cred-b': `fixture-access-b-${crypto.randomUUID()}`,
    }
    const expires = Date.now() + 8 * HOUR
    mocked.connections.push(
      { type: 'credential', id: 'cred-a', label: 'Anthropic 1' },
      { type: 'credential', id: 'cred-b', label: 'Anthropic 2' },
    )
    mocked.ctx.integration.connection.active.mockImplementation(
      async () => mocked.connections[0],
    )
    mocked.ctx.integration.connection.resolve.mockImplementation(
      async (connection: { id: string }) => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: `fixture-refresh-${connection.id}`,
        access: accessOf[connection.id],
        expires,
      }),
    )
    return { ...mocked, accessOf, expires }
  }

  const model = { providerID: 'anthropic', id: 'claude-sonnet-4-5' }

  function messagesRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: crypto.randomUUID() }],
      }),
    })
  }

  async function send(
    hooks: SessionHooks,
    headers: Record<string, string> = {},
    sessionID = 'ses_one',
    eventModel: { providerID: string; id: string } = model,
  ) {
    const event: RequestEvent = {
      sessionID,
      model: eventModel,
      kind: 'primary',
      request: messagesRequest(headers),
    }
    await hooks.get('http.request')(event)
    return event.request as Request
  }

  async function answer(
    hooks: SessionHooks,
    request: Request,
    response: Response,
  ) {
    const event: ResponseEvent = {
      sessionID: 'ses_one',
      model,
      kind: 'primary',
      request,
      response,
    }
    await hooks.get('http.response')(event)
    return event.response as Response
  }

  test('sends a request on the credential the header names, and strips the header', async () => {
    const { ctx, sessionHooks, accessOf } = twoAccounts()
    await plugin.setup(ctx)

    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-b',
    })

    expect(sent.headers.get('authorization')).toBe(
      `Bearer ${accessOf['cred-b']}`,
    )
    expect(sent.headers.has('x-opencode-credential-id')).toBe(false)
    expect(ctx.integration.connection.active).not.toHaveBeenCalled()
  })

  describe('the cache-lifetime header', () => {
    const fiveMinutes = { type: 'ephemeral', ttl: '5m' }
    /** A role's request: its breakpoints at five minutes, and a tool input that only looks like one. */
    const roleRequest = (headers: Record<string, string>) =>
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          model: model.id,
          tools: [{ name: 'bash', input_schema: { type: 'object' }, cache_control: fiveMinutes }],
          system: [{ type: 'text', text: 'You are a role.', cache_control: fiveMinutes }],
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { cache_control: fiveMinutes } }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done', cache_control: fiveMinutes }] },
                { type: 'text', text: 'go on', cache_control: fiveMinutes },
              ],
            },
          ],
        }),
      })
    const sendRole = async (sessionHooks: SessionHooks, headers: Record<string, string>) => {
      const event: RequestEvent = { sessionID: 'ses_one', model, kind: 'primary', request: roleRequest(headers) }
      await sessionHooks.get('http.request')(event)
      const sent = event.request as Request
      return { sent, body: await sent.clone().json() }
    }
    const breakpoints = (body: any) => [
      body.tools[0].cache_control,
      body.system.at(-1).cache_control,
      body.messages[1].content[0].content[0].cache_control,
      body.messages[1].content[1].cache_control,
    ]

    test('writes every cache breakpoint for the lifetime it names, never a tool input, and is stripped', async () => {
      const { ctx, sessionHooks } = twoAccounts()
      await plugin.setup(ctx)

      const { sent, body } = await sendRole(sessionHooks, { 'x-opencode-cache-ttl': '1h' })

      expect(sent.headers.has('x-opencode-cache-ttl')).toBe(false)
      expect(breakpoints(body)).toEqual(Array(4).fill({ type: 'ephemeral', ttl: '1h' }))
      expect(body.messages[0].content[0].input).toEqual({ cache_control: fiveMinutes })
    })

    describe("an agent's own lifetime", () => {
      const oneHour = { type: 'ephemeral', ttl: '1h' }
      const providerDefault = { type: 'ephemeral' }
      /** A request at the provider's configured hour (or its default), sent as agent `planner`. */
      const sendAs = async (sessionHooks: SessionHooks, breakpoint: object, headers: Record<string, string> = {}) => {
        const request = roleRequest(headers)
        const body = JSON.stringify(await request.json()).replaceAll(JSON.stringify(fiveMinutes), JSON.stringify(breakpoint))
        const event: RequestEvent = {
          sessionID: 'ses_one',
          agent: 'planner',
          model,
          kind: 'primary',
          request: new Request(request.url, { method: 'POST', headers: request.headers, body }),
        }
        await sessionHooks.get('http.request')(event)
        const sent = event.request as Request
        return { sent, body: await sent.clone().json() }
      }

      test('replaces the lifetime the provider configures on every breakpoint, never a tool input', async () => {
        const { ctx, sessionHooks, agentSettings } = twoAccounts()
        agentSettings.set('planner', { cacheTTL: '5m', compactionWindow: 50_000 })
        await plugin.setup(ctx)

        const { body } = await sendAs(sessionHooks, oneHour)

        expect(breakpoints(body)).toEqual(Array(4).fill(fiveMinutes))
        expect(body.messages[0].content[0].input).toEqual({ cache_control: oneHour })
      })

      test("gives way to the lifetime another plugin names for the request", async () => {
        const { ctx, sessionHooks, agentSettings } = twoAccounts()
        agentSettings.set('planner', { cacheTTL: '5m' })
        await plugin.setup(ctx)

        const { sent, body } = await sendAs(sessionHooks, oneHour, { 'x-opencode-cache-ttl': '1h' })

        expect(sent.headers.has('x-opencode-cache-ttl')).toBe(false)
        expect(breakpoints(body)).toEqual(Array(4).fill(oneHour))
      })

      test("leaves a provider's default lifetime, an agent without one, and a value Anthropic does not take", async () => {
        const { ctx, sessionHooks, agentSettings } = twoAccounts()
        agentSettings.set('planner', { cacheTTL: '5m' })
        await plugin.setup(ctx)
        expect(breakpoints((await sendAs(sessionHooks, providerDefault)).body)).toEqual(Array(4).fill(providerDefault))

        for (const settings of [{}, { cacheTTL: '2h' }, { cacheTTL: 300 }]) {
          agentSettings.set('planner', settings)
          expect(breakpoints((await sendAs(sessionHooks, oneHour)).body)).toEqual(Array(4).fill(oneHour))
        }
      })
    })

    test('leaves the breakpoints as they came without it, or with a lifetime Anthropic does not take', async () => {
      const { ctx, sessionHooks } = twoAccounts()
      await plugin.setup(ctx)

      const cases: ReadonlyArray<Record<string, string>> = [{}, { 'x-opencode-cache-ttl': '2h' }]
      for (const headers of cases) {
        const { sent, body } = await sendRole(sessionHooks, headers)
        expect(sent.headers.has('x-opencode-cache-ttl')).toBe(false)
        expect(breakpoints(body)).toEqual(Array(4).fill(fiveMinutes))
      }
    })
  })

  test('without the header, sends on the active connection', async () => {
    const { ctx, sessionHooks, accessOf } = twoAccounts()
    await plugin.setup(ctx)

    const sent = await send(sessionHooks)

    expect(sent.headers.get('authorization')).toBe(
      `Bearer ${accessOf['cred-a']}`,
    )
  })

  test('fails closed on a credential that is not a connection, sending nothing', async () => {
    const { ctx, sessionHooks } = twoAccounts()
    await plugin.setup(ctx)
    const event: RequestEvent = {
      sessionID: 'ses_one',
      model,
      kind: 'primary',
      request: messagesRequest({ 'x-opencode-credential-id': 'cred-gone' }),
    }

    await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
      'not a connection of this integration',
    )
    expect(event.request.headers.has('authorization')).toBe(false)
    expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
  })

  test('strips the header even when no OAuth login handles the request', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx)

    const sent = await send(sessionHooks, { 'x-opencode-credential-id': '' })

    expect(sent.headers.has('x-opencode-credential-id')).toBe(false)
    expect(sent.headers.has('authorization')).toBe(false)
  })

  test('names the session with a stable v4-shaped id that differs per session', async () => {
    const { ctx, sessionHooks } = twoAccounts()
    await plugin.setup(ctx)

    const first = (await send(sessionHooks, {}, 'ses_one')).headers.get(
      'x-claude-code-session-id',
    )
    const again = (await send(sessionHooks, {}, 'ses_one')).headers.get(
      'x-claude-code-session-id',
    )
    const other = (await send(sessionHooks, {}, 'ses_two')).headers.get(
      'x-claude-code-session-id',
    )

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(first).not.toContain('ses_one')
  })

  test("sends the model's beta set", async () => {
    const { ctx, sessionHooks } = twoAccounts()
    await plugin.setup(ctx)

    const haiku = await send(sessionHooks, {}, 'ses_one', {
      providerID: 'anthropic',
      id: 'claude-haiku-4-5',
    })
    const betas = String(haiku.headers.get('anthropic-beta')).split(',')

    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('oauth-2025-04-20')
    expect(betas).toContain('context-management-2025-06-27')
    expect(betas).not.toContain('interleaved-thinking-2025-05-14')
  })

  test('reads the quota headers of a successful response and serves them over RPC', async () => {
    const { ctx, sessionHooks, rpcEvents, rpcHandlers, accessOf } =
      twoAccounts()
    await plugin.setup(ctx)
    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-b',
    })
    const fiveHourReset = Date.now() + 2 * HOUR
    const weeklyReset = Date.now() + 50 * HOUR

    await answer(
      sessionHooks,
      sent,
      new Response('event: message_stop\ndata: {}\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-5h-utilization': '0.4',
          'anthropic-ratelimit-unified-5h-reset': seconds(fiveHourReset),
          'anthropic-ratelimit-unified-7d-utilization': '0.25',
          'anthropic-ratelimit-unified-7d-reset': seconds(weeklyReset),
        },
      }),
    )

    expect(rpcEvents).toHaveLength(1)
    const event = firstOf(rpcEvents)
    expect<unknown>(event.id).toBe('credential-quota.anthropic')
    expect<unknown>(event.name).toBe('reading')
    expect<unknown>(event.payload.credentialID).toBe('cred-b')
    expect<unknown>(event.payload.reading.status).toBe('allowed')
    expect<unknown>(event.payload.reading.windows).toEqual([
      {
        name: '5h',
        utilization: 0.4,
        resetAt: Math.floor(fiveHourReset / 1000) * 1000,
      },
      {
        name: '7d',
        utilization: 0.25,
        resetAt: Math.floor(weeklyReset / 1000) * 1000,
      },
    ])
    const served = (await rpcHandlers.get('credential-quota.anthropic')
      .reading({ credentialID: 'cred-b' }))
    expect(served.reading).toEqual(event.payload.reading)
    const none = (await rpcHandlers.get('credential-quota.anthropic').reading(
      { credentialID: 'cred-a' },
    ))
    expect(none.reading).toBeNull()
    for (const access of Object.values(accessOf)) {
      expect(JSON.stringify(rpcEvents)).not.toContain(access)
    }
  })

  test('a plan-limit 429 refuses the credential until the rejected window resets', async () => {
    const { ctx, sessionHooks, rpcEvents } = twoAccounts()
    await plugin.setup(ctx)
    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-a',
    })
    const reset = Date.now() + 3 * HOUR

    const response = await answer(
      sessionHooks,
      sent,
      Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'You have reached your session usage limit.',
          },
        },
        {
          status: 429,
          headers: {
            'retry-after': '10800',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-representative-claim': 'five_hour',
            'anthropic-ratelimit-unified-reset': seconds(reset),
            'anthropic-ratelimit-unified-5h-utilization': '0.97',
            'anthropic-ratelimit-unified-5h-reset': seconds(reset),
            'anthropic-ratelimit-unified-7d-utilization': '0.3',
            'anthropic-ratelimit-unified-7d-reset': seconds(
              Date.now() + 90 * HOUR,
            ),
          },
        },
      ),
    )

    expect(response.headers.get('x-should-retry')).toBe('false')
    const reading = lastOf(rpcEvents).payload.reading
    expect<unknown>(lastOf(rpcEvents).payload.credentialID).toBe('cred-a')
    expect<unknown>(reading.status).toBe('rejected')
    expect<unknown>(reading.windows[0]).toMatchObject({ name: '5h', utilization: 1 })
    expect<unknown>(reading.refusal).toEqual({
      kind: 'usage-limit',
      until: Math.floor(reset / 1000) * 1000,
    })
  })

  test('a transient 429 refuses the credential for its retry-after', async () => {
    const { ctx, sessionHooks, rpcEvents } = twoAccounts()
    await plugin.setup(ctx)
    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-b',
    })
    const before = Date.now()

    await answer(
      sessionHooks,
      sent,
      Response.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message:
              'Number of requests has exceeded your per-minute rate limit',
          },
        },
        { status: 429, headers: { 'retry-after': '20' } },
      ),
    )

    const refusal = lastOf(rpcEvents).payload.reading.refusal
    expect<unknown>(refusal.kind).toBe('rate-limit')
    expect(refusal.until).toBeGreaterThanOrEqual(before + 20_000)
    expect(refusal.until).toBeLessThanOrEqual(Date.now() + 20_000)
  })

  test('a 401 refuses the credential until the host refreshes its token', async () => {
    const { ctx, sessionHooks, rpcEvents, expires } = twoAccounts()
    await plugin.setup(ctx)
    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-b',
    })

    await answer(
      sessionHooks,
      sent,
      Response.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid token' },
        },
        { status: 401 },
      ),
    )

    expect<unknown>(lastOf(rpcEvents).payload).toEqual({
      credentialID: 'cred-b',
      reading: expect.objectContaining({
        refusal: { kind: 'unauthorized', until: expires - 5 * 60_000 },
      }),
    })
  })

  test('a login whose token cannot be resolved is refused, and the request fails', async () => {
    const { ctx, sessionHooks, rpcEvents } = twoAccounts()
    ctx.integration.connection.resolve.mockImplementation(
      async () => {
        throw new Error(
          'Anthropic token refresh blocked after ambiguous failure: 503',
        )
      },
    )
    await plugin.setup(ctx)
    const event: RequestEvent = {
      sessionID: 'ses_one',
      model,
      kind: 'primary',
      request: messagesRequest({ 'x-opencode-credential-id': 'cred-a' }),
    }

    await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
      'ambiguous failure',
    )
    const refusal = lastOf(rpcEvents).payload.reading.refusal
    expect<unknown>(lastOf(rpcEvents).payload.credentialID).toBe('cred-a')
    expect<unknown>(refusal.kind).toBe('signin')
    expect(refusal.until).toBeGreaterThan(Date.now() + 29 * 60_000)
  })

  test('reads the usage endpoint for one credential and keeps a live refusal', async () => {
    const { ctx, sessionHooks, rpcHandlers, rpcEvents, accessOf } =
      twoAccounts()
    await plugin.setup(ctx)
    const sent = await send(sessionHooks, {
      'x-opencode-credential-id': 'cred-a',
    })
    await answer(
      sessionHooks,
      sent,
      Response.json(
        {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limited.' },
        },
        { status: 429, headers: { 'retry-after': '600' } },
      ),
    )
    const fiveHourReset = new Date(Date.now() + HOUR).toISOString()
    const seen: Request[] = []
    const originalFetch = network.fetch
    network.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return Response.json({
        five_hour: { utilization: 62, resets_at: fiveHourReset },
        seven_day: { utilization: 15, resets_at: null },
        seven_day_opus: null,
      })
    })
    try {
      const answered = (await rpcHandlers.get('credential-quota.anthropic')
        .usage({ credentialID: 'cred-a' }))

      expect(seen).toHaveLength(1)
      expect(new URL(firstOf(seen).url).pathname).toBe('/api/oauth/usage')
      expect(firstOf(seen).headers.get('authorization')).toBe(
        `Bearer ${accessOf['cred-a']}`,
      )
      expect(firstOf(seen).headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
      expect<unknown>(answered.reading.windows).toEqual([
        { name: '5h', utilization: 0.62, resetAt: Date.parse(fiveHourReset) },
        { name: '7d', utilization: 0.15 },
      ])
      expect<unknown>(answered.reading.refusal.kind).toBe('rate-limit')
      expect(lastOf(rpcEvents).payload.reading).toEqual(answered.reading)
    } finally {
      network.fetch = originalFetch
    }
  })

  describe('claiming a reset grant (a stand-in Anthropic; never the real endpoint)', () => {
    /** A network that answers the profile with `org-1` and a claim with `claim`, recording each request. */
    const claimNetwork = (claim: () => Response) => {
      const seen: Array<{ readonly request: Request; readonly body: string }> = []
      const fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init)
        seen.push({ request, body: init?.body === undefined ? '' : String(init.body) })
        const path = new URL(request.url).pathname
        if (path === '/api/oauth/profile') return Response.json({ account: { uuid: 'acct-1' }, organization: { uuid: 'org-1' } })
        if (path === '/api/organizations/org-1/reset_rate_limits') return claim()
        return Response.json({
          five_hour: { utilization: 0, resets_at: new Date(Date.now() + 5 * HOUR).toISOString() },
          seven_day: { utilization: 40, resets_at: null },
        })
      })
      return { seen, fetch }
    }

    test('claims for the login\'s organization under the pool\'s request id, and a reset drops the held refusal', async () => {
      const { ctx, sessionHooks, rpcHandlers, accessOf } = twoAccounts()
      await plugin.setup(ctx)
      const sent = await send(sessionHooks, { 'x-opencode-credential-id': 'cred-a' })
      await answer(
        sessionHooks,
        sent,
        Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } }, { status: 429, headers: { 'retry-after': '600' } }),
      )
      const stand = claimNetwork(() => Response.json({ result: 'reset' }))
      const originalFetch = network.fetch
      network.fetch = stand.fetch
      try {
        const quota = rpcHandlers.get('credential-quota.anthropic')
        expect<unknown>(await quota.claim({ credentialID: 'cred-a', creditID: 'grant_4', requestID: 'pool-0123abcd' })).toEqual({ outcome: 'reset' })
        expect(stand.seen.map(({ request }) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
          'GET /api/oauth/profile',
          'POST /api/organizations/org-1/reset_rate_limits',
        ])
        expect(JSON.parse(lastOf(stand.seen).body)).toEqual({ program: 'cedar_ember', grant_id: 'grant_4', request_id: 'pool-0123abcd' })
        expect(lastOf(stand.seen).request.headers.get('authorization')).toBe(`Bearer ${accessOf['cred-a']}`)
        const after = await quota.usage({ credentialID: 'cred-a' })
        expect<unknown>(after.reading.refusal).toBeUndefined()
      } finally {
        network.fetch = originalFetch
      }
    })

    test('each answer in the pool\'s words: not limited, already used, ineligible, cooldown, unavailable, 429 and 401', async () => {
      const cases: ReadonlyArray<readonly [Response, unknown]> = [
        [Response.json({ result: 'not_limited' }), { outcome: 'nothing-to-reset', message: 'not_limited' }],
        [Response.json({ result: 'already_used' }), { outcome: 'already-redeemed', message: 'already_used' }],
        [Response.json({ result: 'ineligible' }), { outcome: 'no-credit', message: 'ineligible' }],
        [Response.json({ result: 'cooldown' }), { outcome: 'cooldown', message: 'cooldown' }],
        [Response.json({ result: 'unavailable' }), { outcome: 'unconfirmed', message: 'unavailable' }],
        [Response.json({ result: 'surprise' }), { outcome: 'failed', message: 'the claim\'s answer does not read: "surprise"' }],
        [new Response('slow down', { status: 429 }), { outcome: 'rate-limited', message: 'Claude is rate limiting resets' }],
        [new Response('no', { status: 401 }), { outcome: 'signed-out', message: 'the claim was refused: 401' }],
      ]
      const { ctx, rpcHandlers } = twoAccounts()
      await plugin.setup(ctx)
      const originalFetch = network.fetch
      try {
        for (const [response, expected] of cases) {
          network.fetch = claimNetwork(() => response.clone()).fetch
          expect<unknown>(await rpcHandlers.get('credential-quota.anthropic').claim({ credentialID: 'cred-a', creditID: 'grant_4', requestID: 'pool-1' })).toEqual(expected)
        }
      } finally {
        network.fetch = originalFetch
      }
    })

    test('a malformed grant id or claim is never sent', async () => {
      const { ctx, rpcHandlers } = twoAccounts()
      await plugin.setup(ctx)
      const stand = claimNetwork(() => Response.json({ result: 'reset' }))
      const originalFetch = network.fetch
      network.fetch = stand.fetch
      try {
        const quota = rpcHandlers.get('credential-quota.anthropic')
        expect<unknown>(await quota.claim({ credentialID: 'cred-a', creditID: 'grant/../x', requestID: 'pool-1' })).toEqual({
          outcome: 'failed',
          message: 'refusing to claim with a malformed grant or request id',
        })
        expect<unknown>(await quota.claim({ credentialID: 'cred-a' })).toEqual({ outcome: 'failed', message: 'malformed claim' })
        expect(stand.seen).toEqual([])
      } finally {
        network.fetch = originalFetch
      }
    })
  })

  describe('a credential another plugin keeps (a credential source)', () => {
    const registry = () => sourceRegistry

    function withSource(
      resolve: (id: string) => Promise<{ access: string; expires: number }>,
      peek?: (
        id: string,
      ) => Promise<{ access: string; expires: number } | undefined>,
    ) {
      const mocked = twoAccounts()
      const rejected: Array<[string, string]> = []
      const source = {
        owns: (id: string) => id.startsWith('src:'),
        resolve: mock(resolve),
        rejected: (id: string, access: string) => rejected.push([id, access]),
        ...(peek === undefined ? {} : { peek: mock(peek) }),
      }
      const sources = registry().get('anthropic') ?? new Set()
      registry().set('anthropic', sources)
      sources.add(source)
      const remove = () => sources.delete(source)
      return { ...mocked, source, rejected, remove }
    }

    test('sends on the token the source resolves, and never asks the host to resolve or refresh it', async () => {
      const access = `fixture-sourced-${crypto.randomUUID()}`
      const { ctx, sessionHooks, source, remove } = withSource(async () => ({
        access,
        expires: Date.now() + HOUR,
      }))
      try {
        await plugin.setup(ctx)
        const sent = await send(sessionHooks, {
          'x-opencode-credential-id': 'src:one',
        })

        expect(sent.headers.get('authorization')).toBe(`Bearer ${access}`)
        expect(sent.headers.has('x-opencode-credential-id')).toBe(false)
        expect(source.resolve).toHaveBeenCalledWith('src:one')
        expect(ctx.integration.get).not.toHaveBeenCalled()
        expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
        // The source reached the plugin through the registry the tests hand it, never the process's.
        const held = processRegistry().get('anthropic')
        expect(held instanceof Set && held.has(source)).toBe(false)
      } finally {
        remove()
      }
    })

    test("a credential no source owns still goes through the host's connections", async () => {
      const { ctx, sessionHooks, accessOf, source, remove } = withSource(
        async () => ({ access: 'unused', expires: Date.now() + HOUR }),
      )
      try {
        await plugin.setup(ctx)
        const sent = await send(sessionHooks, {
          'x-opencode-credential-id': 'cred-b',
        })

        expect(sent.headers.get('authorization')).toBe(
          `Bearer ${accessOf['cred-b']}`,
        )
        expect(source.resolve).not.toHaveBeenCalled()
      } finally {
        remove()
      }
    })

    test("a source's passing failure holds the credential as rate-limited until its retryAt, and the request answers a retryable 429", async () => {
      const retryAt = Date.now() + 60_000
      const { ctx, sessionHooks, rpcEvents, remove } = withSource(async () => {
        throw Object.assign(new Error('token endpoint unavailable'), {
          retryAt,
        })
      })
      try {
        await plugin.setup(ctx)
        const event: RequestEvent = {
          sessionID: 'ses_one',
          model,
          kind: 'primary',
          request: messagesRequest({ 'x-opencode-credential-id': 'src:one' }),
        }

        // The hook does not throw: a thrown hook error ends the turn.
        await sessionHooks.get('http.request')(event)
        expect(event.request.headers.has('authorization')).toBe(false)
        expect(event.request.url).toBe('data:text/plain,')
        expect<unknown>(lastOf(rpcEvents).payload).toEqual({
          credentialID: 'src:one',
          reading: expect.objectContaining({
            refusal: { kind: 'rate-limit', until: retryAt },
          }),
        })

        // The request goes nowhere; its answer is Anthropic's rate limit.
        const sent: Request = event.request
        const response = await answer(
          sessionHooks,
          sent,
          await fetch(sent),
        )
        expect(response.status).toBe(429)
        expect(response.headers.get('x-should-retry')).toBe('true')
        const retryAfter = Number(response.headers.get('retry-after'))
        expect(retryAfter).toBeGreaterThanOrEqual(59)
        expect(retryAfter).toBeLessThanOrEqual(60)
        const body = await response.json()
        expect(body.error.type).toBe('rate_limit_error')
        expect(body.error.message).not.toMatch(
          /quota|usage limit|budget|insufficient|token endpoint/i,
        )
      } finally {
        remove()
      }
    })

    test('a refused request waits for the soonest refused login, at most fifteen minutes', async () => {
      let retryAt = Date.now() + 2 * HOUR
      const { ctx, sessionHooks, remove } = withSource(async () => {
        throw Object.assign(new Error('token endpoint paused'), { retryAt })
      })
      const retryAfterOf = async (credentialID: string) => {
        const sent = await send(sessionHooks, {
          'x-opencode-credential-id': credentialID,
        })
        const response = await answer(sessionHooks, sent, await fetch(sent))
        return Number(response.headers.get('retry-after'))
      }
      try {
        await plugin.setup(ctx)
        expect(await retryAfterOf('src:one')).toBe(15 * 60)

        // Another login refused until sooner sets the wait.
        retryAt = Date.now() + 90_000
        expect(await retryAfterOf('src:two')).toBeLessThanOrEqual(90)
        retryAt = Date.now() + 10 * 60_000
        expect(await retryAfterOf('src:three')).toBeLessThanOrEqual(90)
      } finally {
        remove()
      }
    })

    test("a refused request's answer publishes no second refusal", async () => {
      const { ctx, sessionHooks, rpcEvents, remove } = withSource(async () => {
        throw Object.assign(new Error('busy'), { retryAt: Date.now() + 5_000 })
      })
      try {
        await plugin.setup(ctx)
        const sent = await send(sessionHooks, {
          'x-opencode-credential-id': 'src:one',
        })
        const events = rpcEvents.length
        await answer(sessionHooks, sent, await fetch(sent))
        // The refusal was published once, when the request was refused.
        expect(rpcEvents).toHaveLength(events)
      } finally {
        remove()
      }
    })

    test("a source's failure without a retry time asks for a new sign-in", async () => {
      const { ctx, sessionHooks, rpcEvents, remove } = withSource(async () => {
        throw new Error('refresh token rejected')
      })
      try {
        await plugin.setup(ctx)
        const event: RequestEvent = {
          sessionID: 'ses_one',
          model,
          kind: 'primary',
          request: messagesRequest({ 'x-opencode-credential-id': 'src:one' }),
        }

        await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
          'refresh token rejected',
        )
        expect<unknown>(lastOf(rpcEvents).payload).toEqual({
          credentialID: 'src:one',
          reading: expect.objectContaining({
            refusal: { kind: 'signin', until: expect.any(Number) },
          }),
        })
      } finally {
        remove()
      }
    })

    test('an answer without a usable token fails the request', async () => {
      const { ctx, sessionHooks, remove } = withSource(async () => ({
        access: '',
        expires: Date.now() + HOUR,
      }))
      try {
        await plugin.setup(ctx)
        const event: RequestEvent = {
          sessionID: 'ses_one',
          model,
          kind: 'primary',
          request: messagesRequest({ 'x-opencode-credential-id': 'src:one' }),
        }

        await expect(sessionHooks.get('http.request')(event)).rejects.toThrow(
          'without a usable token',
        )
      } finally {
        remove()
      }
    })

    test('a 401 tells the source which token was rejected, and holds the credential only briefly', async () => {
      const access = `fixture-sourced-${crypto.randomUUID()}`
      const { ctx, sessionHooks, rpcEvents, rejected, remove } = withSource(
        async () => ({ access, expires: Date.now() + 8 * HOUR }),
      )
      try {
        await plugin.setup(ctx)
        const sent = await send(sessionHooks, {
          'x-opencode-credential-id': 'src:one',
        })
        const before = Date.now()

        await answer(
          sessionHooks,
          sent,
          Response.json(
            {
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid' },
            },
            { status: 401 },
          ),
        )

        expect(rejected).toEqual([['src:one', access]])
        const refusal = lastOf(rpcEvents).payload.reading.refusal
        expect<unknown>(refusal.kind).toBe('unauthorized')
        expect(refusal.until).toBeGreaterThanOrEqual(before + 60_000)
        expect(refusal.until).toBeLessThanOrEqual(Date.now() + 60_000)
      } finally {
        remove()
      }
    })

    test("the usage read uses the source's token", async () => {
      const access = `fixture-sourced-${crypto.randomUUID()}`
      const { ctx, rpcHandlers, source, remove } = withSource(
        async () => ({ access, expires: Date.now() + HOUR }),
        async () => ({ access, expires: Date.now() + HOUR }),
      )
      const seen: Request[] = []
      const originalFetch = network.fetch
      network.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(input, init))
        return Response.json({
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        })
      })
      try {
        await plugin.setup(ctx)
        const answered = (await rpcHandlers.get('credential-quota.anthropic')
          .usage({ credentialID: 'src:one' }))

        expect(firstOf(seen).headers.get('authorization')).toBe(`Bearer ${access}`)
        expect<unknown>(answered.reading.windows).toEqual([
          { name: '5h', utilization: 0.1 },
          { name: '7d', utilization: 0.2 },
        ])
        // Read with the token the source holds: the sweep never makes it refresh.
        expect(source.peek).toHaveBeenCalledWith('src:one')
        expect(source.resolve).not.toHaveBeenCalled()
      } finally {
        network.fetch = originalFetch
        remove()
      }
    })

    test('the usage read skips a sourced credential whose token is due a refresh, keeping its reading', async () => {
      const retryAt = Date.now() + 60_000
      const { ctx, sessionHooks, rpcHandlers, source, remove } = withSource(
        async () => {
          throw Object.assign(new Error('token endpoint paused'), { retryAt })
        },
        async () => undefined,
      )
      try {
        await plugin.setup(ctx)
        // A refused request leaves a reading behind.
        await send(sessionHooks, { 'x-opencode-credential-id': 'src:one' })
        source.resolve.mockClear()
        const originalFetch = network.fetch
        const fetchSpy = mock(unreachable)
        network.fetch = fetchSpy
        try {
          const answered = (await rpcHandlers.get('credential-quota.anthropic')
            .usage({ credentialID: 'src:one' }))
          expect(fetchSpy).not.toHaveBeenCalled()
          expect(source.resolve).not.toHaveBeenCalled()
          expect<unknown>(answered.reading.refusal).toEqual({
            kind: 'rate-limit',
            until: retryAt,
          })
        } finally {
          network.fetch = originalFetch
        }
      } finally {
        remove()
      }
    })

    test('a sourced credential with no reading and no good token is resolved to read it, once its reading is recent it is skipped', async () => {
      const access = `fixture-sourced-${crypto.randomUUID()}`
      const { ctx, rpcHandlers, source, remove } = withSource(
        async () => ({ access, expires: Date.now() + HOUR }),
        async () => undefined,
      )
      const originalFetch = network.fetch
      const fetchSpy = mock(async () =>
        Response.json({
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        }))
      network.fetch = fetchSpy
      try {
        await plugin.setup(ctx)
        const usage = rpcHandlers.get('credential-quota.anthropic').usage
        const first = (await usage({ credentialID: 'src:one' }))
        // Unread, so the sweep has the source refresh it: an unread login would drop out of the pool's pace.
        expect(source.resolve).toHaveBeenCalledTimes(1)
        expect<unknown>(first.reading.windows).toContainEqual({ name: '7d', utilization: 0.2 })
        await usage({ credentialID: 'src:one' })
        expect(source.resolve).toHaveBeenCalledTimes(1)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        network.fetch = originalFetch
        remove()
      }
    })

    test('a source without peek is resolved for an unread usage read', async () => {
      const { ctx, rpcHandlers, source, remove } = withSource(async () => ({
        access: `fixture-sourced-${crypto.randomUUID()}`,
        expires: Date.now() + HOUR,
      }))
      const originalFetch = network.fetch
      network.fetch = mock(async () =>
        Response.json({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null } }))
      try {
        await plugin.setup(ctx)
        await rpcHandlers.get('credential-quota.anthropic').usage({ credentialID: 'src:one' })
        expect(source.resolve).toHaveBeenCalledTimes(1)
      } finally {
        network.fetch = originalFetch
        remove()
      }
    })
  })
})
