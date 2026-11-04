/**
 * The pool as an OpenCode server plugin.
 *
 * For each pooled provider it chooses the login each request goes out on
 * (`model.request` sets the credential header the provider's auth plugin
 * honours), holds a login its provider refuses, and turns a refused primary
 * request into an immediate retry on another login. Quota comes from the
 * provider's auth plugin over the quota RPC: a reading after each response,
 * and a sweep of the usage endpoint every few minutes.
 *
 * Options (all optional):
 * - `providers`: provider id to integration id, default `{ anthropic: "anthropic" }`.
 * - `sweepMinutes`: how often to read each login's usage; 0 turns it off. Default 10.
 */
import { Plugin } from "@opencode/plugin"
import { AccountPool, type RequestKind, type Store } from "./pool.ts"
import { asReading, quotaProtocol } from "./quota.ts"

/** The request header that names the login a request goes out on. Its auth plugin strips it. */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"
/** How long the list of a provider's logins is trusted before it is read again. */
const CREDENTIALS_LIFE_MS = 30_000
const DEFAULT_SWEEP_MINUTES = 10

/** The pool's own RPC: each pooled provider's accounts, holds and readings. No secrets. */
export const POOL_STATUS = {
  id: "opencode-gent.pool",
  methods: {
    status: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const

type Context = Plugin.Context

type Connection = Awaited<ReturnType<Context["integration"]["get"]>>["data"]["connections"][number]

interface Pooled {
  readonly pool: AccountPool
  readonly quota: ReturnType<typeof quotaClient>
  connections: ReadonlyArray<Connection>
  readAt: number
  /** Logins this plugin marked as needing a sign-in. */
  readonly flagged: Set<string>
}

const quotaClient = (ctx: Context, integrationID: string) => ctx.rpc(quotaProtocol(integrationID))

const providerMap = (options: Context["options"]): Readonly<Record<string, string>> => {
  const configured = options.providers
  if (typeof configured !== "object" || configured === null) return { anthropic: "anthropic" }
  return Object.fromEntries(
    Object.entries(configured as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

export default Plugin.define({
  id: "opencode-gent.pool",
  setup: async (ctx) => {
    const providers = providerMap(ctx.options)
    const sweepMinutes =
      typeof ctx.options.sweepMinutes === "number" ? ctx.options.sweepMinutes : DEFAULT_SWEEP_MINUTES
    const pools = new Map<string, Pooled>()
    const background = new AbortController()
    const disposers: Array<() => Promise<void> | void> = []

    const storeFor = (integrationID: string): Store => {
      const prefix = `${integrationID}/`
      const settle = (write: Promise<void>) => write.catch(() => undefined)
      return {
        put: (key, value) => void settle(ctx.storage.set(prefix + key, value as never)),
        remove: (key) => void settle(ctx.storage.remove(prefix + key)),
      }
    }

    const ledger = async (integrationID: string) => {
      const prefix = `${integrationID}/`
      const entries: Array<{ key: string; value: unknown }> = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: 500 })
        for (const entry of page.entries) entries.push({ key: entry.key.slice(prefix.length), value: entry.value })
        after = page.next
      } while (after !== undefined)
      return entries
    }

    for (const integrationID of new Set(Object.values(providers))) {
      const pool = new AccountPool(integrationID, storeFor(integrationID))
      pool.load(await ledger(integrationID).catch(() => []))
      const quota = quotaClient(ctx, integrationID)
      pools.set(integrationID, { pool, quota, connections: [], readAt: 0, flagged: new Set() })
    }

    const pooledFor = (providerID: string) => {
      const integrationID = providers[providerID]
      return integrationID === undefined ? undefined : pools.get(integrationID)
    }

    /** The provider's subscription logins, in its integration's order. */
    const refreshCredentials = async (pooled: Pooled, force = false) => {
      if (!force && Date.now() - pooled.readAt < CREDENTIALS_LIFE_MS) return
      const integration = await ctx.integration.get({ integrationID: pooled.pool.integrationID })
      pooled.connections = integration.data.connections.filter(
        (connection) => connection.type === "credential" && connection.method === "oauth",
      )
      pooled.readAt = Date.now()
      pooled.pool.setCredentials(
        pooled.connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : [])),
      )
    }

    /** Mark a login as needing a sign-in when its provider says so, and clear the mark when it reads well again. */
    const signInStatus = async (pooled: Pooled, credentialID: string, needsSignIn: boolean) => {
      if (needsSignIn === pooled.flagged.has(credentialID)) return
      const connection = pooled.connections.find(
        (entry) => entry.type === "credential" && entry.id === credentialID,
      )
      if (connection === undefined) return
      if (needsSignIn) pooled.flagged.add(credentialID)
      else pooled.flagged.delete(credentialID)
      await ctx.integration.connection
        .status({
          integrationID: pooled.pool.integrationID,
          connection,
          status: needsSignIn
            ? { status: "needs_auth", message: "This login could not refresh its token: sign in again." }
            : undefined,
        })
        .catch(() => undefined)
    }

    const take = async (pooled: Pooled, credentialID: string, raw: unknown) => {
      const reading = asReading(raw)
      if (reading === undefined) return undefined
      const hold = pooled.pool.observe(credentialID, reading)
      await signInStatus(pooled, credentialID, reading.refusal?.kind === "signin")
      return hold
    }

    /** The provider's newest reading of one login, as its auth plugin holds it now. */
    const pull = async (pooled: Pooled, credentialID: string) => {
      const answer = await pooled.quota.reading({ credentialID }).catch(() => undefined)
      return take(pooled, credentialID, (answer as { reading?: unknown } | undefined)?.reading)
    }

    disposers.push(
      await ctx.session.hook("model.request", async (event) => {
        const pooled = pooledFor(event.model.providerID)
        if (pooled === undefined) return
        await refreshCredentials(pooled).catch(() => undefined)
        const credentialID = pooled.pool.place(event.sessionID, event.kind as RequestKind)
        if (credentialID !== undefined) event.headers[CREDENTIAL_HEADER] = credentialID
      }).then((registration) => registration.dispose),
    )

    disposers.push(
      await ctx.session.hook("http.response", async (event) => {
        const status = event.response.status
        if (status !== 401 && status !== 429) return
        const pooled = pooledFor(event.model.providerID)
        if (pooled === undefined) return
        const credentialID = pooled.pool.placedOn(event.sessionID, event.kind as RequestKind)
        if (credentialID === undefined) return
        const hold = await pull(pooled, credentialID)
        if (hold === undefined) pooled.pool.refused(credentialID, status)
      }).then((registration) => registration.dispose),
    )

    disposers.push(
      await ctx.session.hook("retry", async (event) => {
        const pooled = pooledFor(event.model.providerID)
        if (pooled === undefined) return
        const credentialID = pooled.pool.placedOn(event.sessionID, "primary")
        if (credentialID === undefined) return
        // A refusal that never reached a response (a sign-in that failed before
        // the request went out) is only in the provider's reading.
        if (!pooled.pool.held(credentialID)) await pull(pooled, credentialID)
        if (pooled.pool.shouldFailOver(event.sessionID)) event.decision = { retry: true, delay: 0 }
      }).then((registration) => registration.dispose),
    )

    disposers.push(
      await ctx.session.hook("experimental.idle", (event) => {
        for (const pooled of pools.values()) pooled.pool.release(event.sessionID)
      }).then((registration) => registration.dispose),
    )

    for (const pooled of pools.values()) {
      disposers.push(
        pooled.quota.events.on(
          "reading",
          async (event) => {
            const data = event.data as { credentialID?: unknown; reading?: unknown }
            if (typeof data.credentialID !== "string") return
            await take(pooled, data.credentialID, data.reading)
          },
          { signal: background.signal },
        ),
      )
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.step.ended", "session.idle"],
        signal: background.signal,
      })) {
        if (event.type === "session.idle") {
          for (const pooled of pools.values()) pooled.pool.release(event.data.sessionID)
          continue
        }
        if (event.type !== "session.step.ended") continue
        // The step's event names no model: it belongs to the pool that placed the session's newest request.
        const sessionID = event.data.sessionID
        const latest = [...pools.values()]
          .map((pooled) => ({ pooled, at: pooled.pool.lastPlacedAt(sessionID) ?? -1 }))
          .sort((left, right) => right.at - left.at)[0]
        if (latest !== undefined && latest.at >= 0) latest.pooled.pool.step(sessionID, Number(event.data.cost))
      }
    })().catch(() => undefined)

    const sweep = async () => {
      for (const pooled of pools.values()) {
        await refreshCredentials(pooled, true).catch(() => undefined)
        for (const credentialID of pooled.pool.accounts()) {
          if (background.signal.aborted) return
          const answer = await pooled.quota.usage({ credentialID }).catch(() => undefined)
          await take(pooled, credentialID, (answer as { reading?: unknown } | undefined)?.reading)
        }
        pooled.pool.prune()
      }
    }
    if (sweepMinutes > 0) {
      // The first sweep waits a moment so the providers' auth plugins have set up.
      const first = setTimeout(() => void sweep().catch(() => undefined), 1_000)
      const every = setInterval(() => void sweep().catch(() => undefined), sweepMinutes * 60_000)
      disposers.push(() => {
        clearTimeout(first)
        clearInterval(every)
      })
    }

    const status = await ctx.rpc.register(POOL_STATUS, {
      status: async () =>
        Object.fromEntries(
          [...pools.values()].map((pooled) => [pooled.pool.integrationID, { accounts: pooled.pool.status() }]),
        ) as never,
    })
    disposers.push(status.dispose)

    return async () => {
      background.abort()
      for (const dispose of disposers.reverse()) await dispose()
    }
  },
})
