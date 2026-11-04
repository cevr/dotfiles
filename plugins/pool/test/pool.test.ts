// The pool's placement and hold policy, one case per decision, and its
// OpenCode hooks against a fake plugin context. No OpenCode, no network.
import { describe, expect, test } from "bun:test"
import { AccountPool, CACHE_LIFE_MS, DEFAULT_HOLD_MS, PIN_IDLE_MS, WINDOW_MS, type Store } from "../src/pool.ts"
import { rankPlacement, type PlacementSlot } from "../src/rank.ts"
import type { QuotaReading } from "../src/quota.ts"
import pool from "../src/server.ts"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

const memoryStore = () => {
  const data = new Map<string, unknown>()
  const store: Store = { put: (key, value) => data.set(key, value), remove: (key) => data.delete(key) }
  return { data, store }
}

const clock = (start = T0) => {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

const poolOf = (accounts: ReadonlyArray<string>, time = clock()) => {
  const { data, store } = memoryStore()
  const accountPool = new AccountPool("anthropic", store, time.now)
  accountPool.setCredentials(accounts)
  return { pool: accountPool, data, time }
}

const reading = (fields: Partial<QuotaReading> = {}): QuotaReading => ({ at: T0, windows: [], ...fields })

const slot = (name: string, fields: Partial<PlacementSlot<string>> = {}): PlacementSlot<string> => ({
  slot: name,
  load: 0,
  live: 0,
  held: false,
  noRoom: false,
  ...fields,
})

describe("rankPlacement", () => {
  test("a held account is never chosen while another is eligible, and goes last", () => {
    expect(rankPlacement({ slots: [slot("a", { held: true }), slot("b"), slot("c")], spent: 0, sessions: 0 })).toEqual([
      "b",
      "c",
      "a",
    ])
  })

  test("with every account held, the preferred one, else the first", () => {
    const held = [slot("a", { held: true }), slot("b", { held: true })] as const
    expect(rankPlacement({ slots: [...held], spent: 0, sessions: 0 })[0]).toBe("a")
    expect(rankPlacement({ slots: [...held], spent: 0, sessions: 0, preferred: "b" })[0]).toBe("b")
  })

  test("among equal accounts, the soonest weekly reset wins; a missing reset goes last", () => {
    const ranked = rankPlacement({
      slots: [slot("a"), slot("b", { weeklyResetAt: T0 + 90 * HOUR }), slot("c", { weeklyResetAt: T0 + 20 * HOUR })],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["c", "b", "a"])
  })

  test("accounts below their pace come first, by the soonest weekly reset", () => {
    const ranked = rankPlacement({
      slots: [
        slot("a", { sustainable: 4, live: 1, weeklyResetAt: T0 + 90 * HOUR }),
        slot("b", { sustainable: 1, live: 1, weeklyResetAt: T0 + 10 * HOUR }),
        slot("c", { sustainable: 3, live: 2, weeklyResetAt: T0 + 30 * HOUR }),
      ],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["c", "a", "b"])
  })

  test("an account at its share goes after every account with room, whatever its score", () => {
    const ranked = rankPlacement({
      slots: [slot("full", { noRoom: true }), slot("busy", { live: 3 })],
      spent: 0,
      sessions: 0,
    })
    expect(ranked).toEqual(["busy", "full"])
  })

  test("score is recorded load in mean sessions plus live sessions", () => {
    // Unit: $10 over 5 sessions = $2. a: 6/2 + 0 = 3. b: 0/2 + 2 = 2.
    const ranked = rankPlacement({ slots: [slot("a", { load: 6 }), slot("b", { live: 2 })], spent: 10, sessions: 5 })
    expect(ranked[0]).toBe("b")
  })

  test("the preferred account stays within one session of the best score, and not beyond", () => {
    const within = rankPlacement({ slots: [slot("a", { live: 1 }), slot("b")], spent: 0, sessions: 0, preferred: "a" })
    expect(within[0]).toBe("a")
    const beyond = rankPlacement({ slots: [slot("a", { live: 2 }), slot("b")], spent: 0, sessions: 0, preferred: "a" })
    expect(beyond[0]).toBe("b")
  })

  test("the preferred account at its share gives way to one with room", () => {
    const ranked = rankPlacement({
      slots: [slot("a", { noRoom: true }), slot("b")],
      spent: 0,
      sessions: 0,
      preferred: "a",
    })
    expect(ranked[0]).toBe("b")
  })
})

describe("AccountPool", () => {
  test("a held account is skipped by a new placement", () => {
    const { pool, time } = poolOf(["a", "b"])
    pool.observe("a", reading({ refusal: { kind: "rate-limit", until: time.now() + 30_000 } }))
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("a run keeps its account for every request, even when another ranks better", () => {
    const { pool } = poolOf(["a", "b"])
    expect(pool.place("s1", "primary")).toBe("a")
    pool.step("s1", 5)
    expect(pool.place("s2", "primary")).toBe("b")
    pool.step("s2", 0.1)
    // A new run would go to b now: a carries s1's $5 and s1 itself.
    expect(pool.rank("s9")[0]).toBe("b")
    expect(pool.place("s1", "primary")).toBe("a")
    expect(pool.place("s1", "title")).toBe("a")
  })

  test("a run leaves its account only when the account is held", () => {
    const { pool, time } = poolOf(["a", "b"])
    expect(pool.place("s1", "primary")).toBe("a")
    pool.observe("a", reading({ refusal: { kind: "usage-limit", until: time.now() + 20 * 60_000 } }))
    expect(pool.place("s1", "primary")).toBe("b")
    // The new pin holds after a's hold ends.
    time.advance(21 * 60_000)
    expect(pool.held("a")).toBe(false)
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("a run that ended is placed afresh, near its cache while it lives", () => {
    const { pool, time } = poolOf(["a", "b"])
    expect(pool.place("s1", "primary")).toBe("a")
    expect(pool.place("s2", "primary")).toBe("b")
    expect(pool.place("s3", "primary")).toBe("a")
    pool.release("s1")
    // a carries s3, b carries s2: a tie, and s1's cache is on a.
    expect(pool.place("s1", "primary")).toBe("a")
    pool.step("s3", 1)
    // a now scores 2 (s3 live, one mean session of load), b 1: within one session, s1 stays by its cache.
    expect(pool.place("s1", "primary")).toBe("a")
    pool.release("s1")
    time.advance(CACHE_LIFE_MS)
    // Its cache gone, s1 goes to the lower score.
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("a pin of a run that stopped without going idle expires", () => {
    const { pool, time } = poolOf(["a", "b"])
    pool.place("s1", "primary")
    pool.observe("b", reading({ windows: [{ name: "7d", utilization: 0.2, resetAt: T0 + 5 * HOUR }] }))
    pool.observe("a", reading({ windows: [{ name: "7d", utilization: 0.2, resetAt: T0 + 50 * HOUR }] }))
    time.advance(PIN_IDLE_MS)
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("the soonest weekly reset wins between fresh accounts", () => {
    const { pool } = poolOf(["a", "b"])
    pool.observe("a", reading({ windows: [{ name: "7d", utilization: 0.3, resetAt: T0 + 100 * HOUR }] }))
    pool.observe("b", reading({ windows: [{ name: "7d", utilization: 0.6, resetAt: T0 + 10 * HOUR }] }))
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("a window that has reset counts as empty", () => {
    const { pool, time } = poolOf(["a", "b"])
    pool.observe("a", reading({ windows: [{ name: "5h", utilization: 0.95, resetAt: T0 + HOUR }] }))
    expect(pool.rank("s1")[0]).toBe("b")
    time.advance(HOUR)
    expect(pool.rank("s1")[0]).toBe("a")
  })

  test("a plan-limit refusal holds the account until its window resets, then frees it", () => {
    const { pool, time } = poolOf(["a", "b"])
    const reset = T0 + 3 * HOUR
    const hold = pool.observe(
      "a",
      reading({
        status: "rejected",
        windows: [{ name: "5h", utilization: 1, resetAt: reset }],
        refusal: { kind: "usage-limit", until: reset },
      }),
    )
    expect(hold).toEqual({ kind: "usage-limit", until: reset, at: T0 })
    time.advance(3 * HOUR - 1)
    expect(pool.held("a")).toBe(true)
    time.advance(1)
    expect(pool.held("a")).toBe(false)
  })

  test("a window read as exhausted holds the account until it resets, with no refusal", () => {
    const { pool } = poolOf(["a", "b"])
    const hold = pool.observe("a", reading({ windows: [{ name: "7d", utilization: 1, resetAt: T0 + 40 * HOUR }] }))
    expect(hold?.until).toBe(T0 + 40 * HOUR)
    expect(pool.place("s1", "primary")).toBe("b")
  })

  test("a hold only grows: a shorter refusal never frees an account a longer one holds", () => {
    const { pool } = poolOf(["a", "b"])
    pool.observe("a", reading({ refusal: { kind: "usage-limit", until: T0 + 5 * HOUR } }))
    pool.observe("a", reading({ refusal: { kind: "rate-limit", until: T0 + 20_000 } }))
    expect(pool.status()[0]?.hold).toEqual({ kind: "usage-limit", until: T0 + 5 * HOUR, at: T0 })
  })

  test("a refused response without a reading holds the account for the default time", () => {
    const { pool } = poolOf(["a", "b"])
    expect(pool.refused("a", 429)).toEqual({ kind: "rate-limit", until: T0 + DEFAULT_HOLD_MS, at: T0 })
    expect(pool.refused("b", 401)?.kind).toBe("unauthorized")
  })

  test("after a refresh with an unclear outcome, the login is held and never tried again until signed in", () => {
    // The auth plugin blocks a refresh token whose refresh failed unclearly
    // and reports a sign-in refusal: the pool must not send that login again.
    const { pool, time } = poolOf(["a", "b"])
    expect(pool.place("s1", "primary")).toBe("a")
    pool.observe("a", reading({ refusal: { kind: "signin", until: T0 + 30 * 60_000 } }))
    expect(pool.shouldFailOver("s1")).toBe(true)
    expect(pool.place("s1", "primary")).toBe("b")
    for (const session of ["s2", "s3", "s4"]) expect(pool.place(session, "primary")).toBe("b")
    time.advance(29 * 60_000)
    expect(pool.place("s5", "primary")).toBe("b")
  })

  test("a failed request fails over only when its account is held and another is not", () => {
    const { pool } = poolOf(["a", "b"])
    pool.place("s1", "primary")
    expect(pool.shouldFailOver("s1")).toBe(false)
    pool.observe("b", reading({ refusal: { kind: "rate-limit", until: T0 + 60_000 } }))
    pool.observe("a", reading({ refusal: { kind: "rate-limit", until: T0 + 60_000 } }))
    expect(pool.shouldFailOver("s1")).toBe(false)
  })

  test("the ledger writes holds, readings and priced steps, and a new pool reads them back", () => {
    const { pool, data } = poolOf(["a", "b"])
    pool.place("s1", "primary")
    pool.step("s1", 0.25)
    pool.observe("b", reading({ refusal: { kind: "usage-limit", until: T0 + HOUR } }))
    expect([...data.keys()].sort()).toEqual(["hold/b", "reading/b", `step/00${T0}/s1`])

    const next = new AccountPool("anthropic", memoryStore().store, () => T0 + 1)
    next.setCredentials(["a", "b"])
    next.load([...data].map(([key, value]) => ({ key, value })))
    expect(next.held("b")).toBe(true)
    expect(next.status().find((account) => account.credentialID === "a")?.load).toBe(0.25)
  })

  test("pruning drops steps out of the window and past holds, from the ledger too", () => {
    const { pool, data, time } = poolOf(["a"])
    pool.place("s1", "primary")
    pool.step("s1", 1)
    pool.observe("a", reading({ refusal: { kind: "rate-limit", until: T0 + 1000 } }))
    time.advance(WINDOW_MS)
    pool.prune()
    expect([...data.keys()]).toEqual(["reading/a"])
    expect(pool.status()[0]?.load).toBe(0)
  })
})

// ── The OpenCode hooks, against a fake plugin context ───────────────────

type Hook = (event: any) => Promise<void> | void

const fakeContext = (options: Record<string, unknown> = { sweepMinutes: 0 }) => {
  const hooks = new Map<string, Hook>()
  const readings = new Map<string, unknown>()
  const statuses: Array<{ credentialID: string; status: unknown }> = []
  const storage = new Map<string, unknown>()
  const rpcHandlers = new Map<string, Record<string, (input: any) => Promise<unknown>>>()
  const readingListeners: Array<(event: any) => Promise<void> | void> = []
  const connections = [
    { type: "credential", id: "cred-a", label: "Anthropic 1", method: "oauth" },
    { type: "credential", id: "cred-b", label: "Anthropic 2", method: "oauth" },
    { type: "credential", id: "cred-key", label: "Anthropic key", method: "key" },
  ]
  const rpc = Object.assign(
    (definition: { id: string }) => ({
      reading: async ({ credentialID }: { credentialID: string }) => {
        expect(definition.id).toBe("credential-quota.anthropic")
        return { reading: readings.get(credentialID) ?? null }
      },
      usage: async ({ credentialID }: { credentialID: string }) => ({ reading: readings.get(credentialID) ?? null }),
      events: {
        on: (_name: string, handler: (event: any) => Promise<void> | void) => {
          readingListeners.push(handler)
          return () => undefined
        },
      },
    }),
    {
      register: async (definition: { id: string }, handlers: Record<string, (input: any) => Promise<unknown>>) => {
        rpcHandlers.set(definition.id, handlers)
        return { events: { emit: async () => undefined }, dispose: async () => undefined }
      },
    },
  )
  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
    },
    integration: {
      get: async () => ({ location: {}, data: { id: "anthropic", connections } }),
      connection: {
        status: async ({ connection, status }: { connection: { id: string }; status: unknown }) => {
          statuses.push({ credentialID: connection.id, status })
        },
      },
    },
    rpc,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
  }
  return { ctx, hooks, readings, statuses, storage, rpcHandlers, readingListeners }
}

const model = { providerID: "anthropic", id: "claude-haiku-4-5" }

const request = async (hooks: Map<string, Hook>, sessionID = "ses_1", kind = "primary") => {
  const event = { sessionID, agent: "build", model, kind, headers: {} as Record<string, string> }
  await hooks.get("model.request")!(event)
  return event.headers["x-opencode-credential-id"]
}

const respond = (hooks: Map<string, Hook>, status: number, sessionID = "ses_1") =>
  hooks.get("http.response")!({
    sessionID,
    agent: "build",
    model,
    kind: "primary",
    request: new Request("https://api.anthropic.com/v1/messages"),
    response: new Response(null, { status }),
  })

const retry = async (hooks: Map<string, Hook>, decision: unknown = { retry: false }, sessionID = "ses_1") => {
  const event = { sessionID, agent: "build", model, error: { type: "api" }, attempt: 1, decision }
  await hooks.get("retry")!(event)
  return event.decision
}

describe("pool plugin hooks", () => {
  test("pace RPC admits unpooled models, holds the measured pool and picks up newer quota readings", async () => {
    const { ctx, readings, rpcHandlers } = fakeContext()
    const dispose = await pool.setup(ctx as never)
    try {
      const at = Date.now()
      for (const id of ["cred-a", "cred-b"]) readings.set(id, { at, windows: [{ name: "7d", utilization: 0.8, resetAt: at + 3.5 * 86400000 }] })
      const pace = rpcHandlers.get("opencode-gent.pool")!.pace!
      expect(await pace({ providerID: "openai" })).toMatchObject({ ok: true, measured: false })
      expect(await pace({ providerID: "anthropic" })).toMatchObject({ ok: false, measured: true })
      for (const id of ["cred-a", "cred-b"]) readings.set(id, { at, windows: [{ name: "7d", utilization: 0.2, resetAt: at + 3.5 * 86400000 }] })
      expect(await pace({ providerID: "anthropic" })).toMatchObject({ ok: true, measured: true })
    } finally { await dispose?.() }
  })
  test("pools only the provider's OAuth logins and names the chosen one on the request", async () => {
    const { ctx, hooks } = fakeContext()
    await pool.setup(ctx as never)
    expect(await request(hooks)).toBe("cred-a")
    expect(await request(hooks, "ses_2")).toBe("cred-b")
    expect(await request(hooks, "ses_3")).not.toBe("cred-key")
  })

  test("leaves other providers alone", async () => {
    const { ctx, hooks } = fakeContext()
    await pool.setup(ctx as never)
    const event = { sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "gpt" }, kind: "primary", headers: {} }
    await hooks.get("model.request")!(event)
    expect(event.headers).toEqual({})
  })

  test("a plan-limit 429 holds the login and its run retries at once on the other", async () => {
    const { ctx, hooks, readings, storage } = fakeContext()
    await pool.setup(ctx as never)
    expect(await request(hooks)).toBe("cred-a")
    readings.set("cred-a", {
      at: Date.now(),
      status: "rejected",
      windows: [{ name: "5h", utilization: 1, resetAt: Date.now() + 2 * HOUR }],
      refusal: { kind: "usage-limit", until: Date.now() + 2 * HOUR },
    })
    await respond(hooks, 429)
    expect(storage.has("anthropic/hold/cred-a")).toBe(true)
    expect(await retry(hooks)).toEqual({ retry: true, delay: 0 })
    expect(await request(hooks)).toBe("cred-b")
  })

  test("a 429 without a reading still holds the login for the default time", async () => {
    const { ctx, hooks } = fakeContext()
    await pool.setup(ctx as never)
    await request(hooks)
    await respond(hooks, 429)
    expect(await retry(hooks)).toEqual({ retry: true, delay: 0 })
  })

  test("an overloaded answer holds nothing and leaves the host's retry decision", async () => {
    const { ctx, hooks } = fakeContext()
    await pool.setup(ctx as never)
    await request(hooks)
    await respond(hooks, 529)
    expect(await retry(hooks, { retry: true, delay: 2000 })).toEqual({ retry: true, delay: 2000 })
    expect(await request(hooks)).toBe("cred-a")
  })

  test("a sign-in refusal that never reached a response fails over, and marks the login as needing a sign-in", async () => {
    const { ctx, hooks, readings, statuses } = fakeContext()
    await pool.setup(ctx as never)
    await request(hooks)
    readings.set("cred-a", { at: Date.now(), windows: [], refusal: { kind: "signin", until: Date.now() + 30 * 60_000 } })
    expect(await retry(hooks)).toEqual({ retry: true, delay: 0 })
    expect(statuses).toEqual([
      { credentialID: "cred-a", status: { status: "needs_auth", message: expect.stringContaining("sign in") } },
    ])
    expect(await request(hooks)).toBe("cred-b")
  })

  test("readings published by the auth plugin hold a login without any request", async () => {
    const { ctx, hooks, readingListeners } = fakeContext()
    await pool.setup(ctx as never)
    await request(hooks, "ses_0")
    for (const listener of readingListeners) {
      await listener({
        data: {
          credentialID: "cred-a",
          reading: { at: Date.now(), windows: [], refusal: { kind: "rate-limit", until: Date.now() + 60_000 } },
        },
      })
    }
    expect(await request(hooks, "ses_new")).toBe("cred-b")
  })

  test("the status RPC lists each login's hold and reading, and never a token", async () => {
    const { ctx, hooks, readings, rpcHandlers } = fakeContext()
    await pool.setup(ctx as never)
    await request(hooks)
    readings.set("cred-a", { at: Date.now(), windows: [], refusal: { kind: "rate-limit", until: Date.now() + 60_000 } })
    await respond(hooks, 429)
    const status = (await rpcHandlers.get("opencode-gent.pool")!.status!({})) as any
    expect(status.anthropic.accounts.map((account: any) => [account.credentialID, account.hold?.kind])).toEqual([
      ["cred-a", "rate-limit"],
      ["cred-b", undefined],
    ])
  })
})
