// The plugin seam: the composition root on a stand-in host. On test layers it
// checks what OpenCode sees: the credential header, the retry decision, the
// ledger's keys, the sign-in marks and the pool's RPC answers. On the live
// adapters it checks how they reach the host's integration, quota RPC and
// storage. tests/pool-failover.test.ts and tests/pool-gent-opencode.test.ts
// run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "@dotfiles/opencode-pool/account-pool"
import { CACHE_LIFE_MS, WINDOW_MS } from "@dotfiles/opencode-pool/accounts"
import * as LedgerTest from "@dotfiles/opencode-pool/memory/ledger"
import * as LoginsTest from "@dotfiles/opencode-pool/memory/logins"
import * as QuotaTest from "@dotfiles/opencode-pool/memory/quota"
import type { Pace } from "@dotfiles/opencode-pool/pace"
import type { QuotaReading } from "@dotfiles/opencode-pool/quota"
import type { PublishedReading } from "@dotfiles/opencode-pool/service"
import { GentSource } from "@dotfiles/opencode-pool/gent/store"
import type { Alerts, PoolsStatus, SessionAnswer, SessionLogins } from "@dotfiles/opencode-pool/status"
import Pool, { CREDENTIAL_HEADER, live, make } from "./server.ts"

const HOUR = 3_600_000
const ANTHROPIC = PoolId.make("anthropic")

type Host = Parameters<(typeof Pool)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
type Handler = (input: unknown) => Effect.Effect<unknown>

/** The provider's logins: two OAuth logins and an API key, which the pool leaves out. */
const CONNECTIONS = [
  { type: "credential", id: "cred-a", label: "Anthropic 1", method: "oauth" },
  { type: "credential", id: "cred-b", label: "Anthropic 2", method: "oauth" },
  { type: "credential", id: "cred-key", label: "Anthropic key", method: "key" },
]

const model = { providerID: "anthropic", id: "claude-haiku-4-5" }

interface SessionEvent {
  readonly type: "session.step.ended" | "session.idle"
  readonly data: { readonly sessionID: string; readonly cost?: number; readonly assistantMessageID?: string }
}

/**
 * What the outside systems hold for one test. The test layers read it, and so
 * do the stand-in host's integration, quota RPC and storage the live adapters reach.
 */
interface World {
  /** The auth plugin's newest reading of each login. */
  readonly readings: Map<string, QuotaReading>
  /** The integration's connections (a pool absent there cannot be read) and the sign-in marks set on them. */
  readonly integration: LoginsTest.Integration
  /** The plugin's storage, by key. */
  readonly storage: Map<string, Schema.Json>
  /** Each agent's own prompt-cache lifetime (`request.settings.cacheTTL`), by agent id; an agent absent here is unknown to the host. */
  readonly agents: Map<string, string | undefined>
  /** Each fork's source, by fork id; a session absent here is no fork. */
  readonly forks: Map<string, string>
}

const world = (): World => ({
  readings: new Map(),
  integration: { connections: new Map([[ANTHROPIC, CONNECTIONS]]), marks: [] },
  storage: new Map(),
  agents: new Map([["build", undefined]]),
  forks: new Map(),
})

/** The outside systems as test layers over `state`. */
const testLayers = (state: World, published: Queue.Dequeue<PublishedReading>) => () =>
  Layer.mergeAll(
    LoginsTest.layer(state.integration),
    QuotaTest.layer(new Map([[ANTHROPIC, state.readings]]), new Map([[ANTHROPIC, published]])),
    LedgerTest.layer(state.storage),
  )

/** A hook or RPC handler the plugin registered; a missing one fails the test. */
const registered = <F>(table: Readonly<Record<string, F>>, name: string) =>
  Effect.suspend(() => {
    const found = table[name]
    return found === undefined ? Effect.die(new Error(`not registered: ${name}`)) : Effect.succeed(found)
  })

/**
 * The plugin started on a stand-in host: its hooks, transforms and RPC, with
 * the host's integration, quota RPC and storage over `state`. `externals`
 * picks the adapters: the test layers by default, `live` for the real ones.
 */
const start = (
  options: Record<string, unknown> = { sweepMinutes: 0 },
  state: World = world(),
  externals: Parameters<typeof make>[0] | "test" = "test",
) =>
  Effect.gen(function* () {
    const hooks: Record<string, Hook> = {}
    const rpc: Record<string, Record<string, Handler>> = {}
    const transforms: Array<(editor: unknown) => void> = []
    const quotaIDs: Array<string> = []
    const statuses: Array<{ readonly credentialID: unknown; readonly status: unknown }> = []
    const events = yield* Queue.unbounded<SessionEvent>()
    const published = yield* Queue.unbounded<PublishedReading>()
    const answer = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.sync(() => ({ reading: state.readings.get(credentialID) ?? null }))
    const host = {
      options,
      session: {
        get: ({ sessionID }: { readonly sessionID: string }) => {
          const source = state.forks.get(sessionID)
          return Effect.succeed({ id: sessionID, ...(source === undefined ? {} : { fork: { sessionID: source, boundary: {} } }) })
        },
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            hooks[name] = callback
            return { dispose: Effect.void }
          }),
      },
      provider: {
        transform: (callback: (editor: unknown) => void) =>
          Effect.sync(() => {
            transforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(events) },
      agent: {
        get: ({ agentID }: { readonly agentID: string }) => {
          if (!state.agents.has(agentID)) return Effect.fail(new Error(`Agent not found: ${agentID}`))
          const cacheTTL = state.agents.get(agentID)
          return Effect.succeed({ location: {}, data: { id: agentID, request: { settings: cacheTTL === undefined ? {} : { cacheTTL } } } })
        },
      },
      integration: {
        get: ({ integrationID }: { readonly integrationID: PoolId }) => {
          const connections = state.integration.connections.get(integrationID)
          return connections === undefined
            ? Effect.fail(new Error("no such integration"))
            : Effect.succeed({ location: {}, data: { id: integrationID, connections } })
        },
        connection: {
          status: ({ connection, status }: { readonly connection: { readonly id?: string }; readonly status: unknown }) =>
            Effect.sync(() => void statuses.push({ credentialID: connection.id, status })),
        },
      },
      rpc: Object.assign(
        (definition: { readonly id: string }) => {
          quotaIDs.push(definition.id)
          return { reading: answer, usage: answer, events: { subscribe: () => Stream.fromQueue(published) } }
        },
        {
          register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
            Effect.sync(() => {
              rpc[definition.id] = handlers
              return { dispose: Effect.void }
            }),
        },
      ),
      storage: LedgerTest.storage(state.storage),
    } as unknown as Host
    yield* make(externals === "test" ? testLayers(state, published) : externals).effect(host)

    /** One model request of a session: the login the pool names on it. */
    const request = Effect.fn(function* (sessionID = "ses_1", providerID = "anthropic", kind = "primary", agent = "build") {
      const headers: Record<string, string> = {}
      yield* (yield* registered(hooks, "model.request"))({ sessionID, agent, model: { ...model, providerID }, kind, headers })
      return headers[CREDENTIAL_HEADER]
    })
    const respond = Effect.fn(function* (status: number, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "http.response"))({
        sessionID,
        agent: "build",
        model,
        kind: "primary",
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: new Response(null, { status }),
      })
    })
    /** The host's retry decision after the pool saw the failed request. */
    const retry = Effect.fn(function* (decision: unknown = { retry: false }, sessionID = "ses_1") {
      const event: Record<string, unknown> = { sessionID, agent: "build", model, error: { type: "api" }, attempt: 1, decision }
      yield* (yield* registered(hooks, "retry"))(event)
      return event.decision
    })
    const idle = Effect.fn(function* (sessionID: string) {
      yield* (yield* registered(hooks, "experimental.idle"))({ sessionID, background: [] })
    })
    const method = (name: string) => Effect.flatMap(registered(rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, name))
    const pace = Effect.fn(function* (providerID: string) {
      return (yield* (yield* method("pace"))({ providerID })) as Pace
    })
    const status = Effect.gen(function* () {
      return (yield* (yield* method("status"))({})) as PoolsStatus
    })
    const session = Effect.fn(function* (query: unknown) {
      return (yield* (yield* method("session"))(query)) as SessionAnswer
    })
    /** A host event or a published reading, taken in before the test goes on. */
    const emit = (event: SessionEvent) => Queue.offer(events, event).pipe(Effect.andThen(settle))
    const publish = (reading: PublishedReading) => Queue.offer(published, reading).pipe(Effect.andThen(settle))
    const alerts = Effect.gen(function* () {
      return (yield* (yield* method("alerts"))({})) as Alerts
    })
    const logins = Effect.fn(function* (query: unknown) {
      return (yield* (yield* method("logins"))(query)) as SessionLogins
    })
    return { request, respond, retry, idle, pace, status, session, alerts, logins, emit, publish, transforms, quotaIDs, statuses, rpc }
  })

/** Let the plugin's background fibers take in what was just offered: a real moment, on the test clock too. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 5)))

type Scoped<A, E> = Effect.Effect<A, E, import("effect").Scope.Scope>
const scenario = <A, E>(body: Scoped<A, E>) => Effect.runPromise(Effect.scoped(body))
/** On the test clock, which starts at 0 and moves only when told. */
const onTestClock = <A, E>(body: Scoped<A, E>) =>
  scenario(
    Effect.gen(function* () {
      return yield* body
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe("the options", () => {
  test("take their defaults when absent or undefined", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ providers: undefined, sweepMinutes: undefined, sources: undefined, cacheLifeMs: undefined })
        expect(yield* plugin.request()).toBe("cred-a")
        expect(plugin.transforms).toEqual([])
      }),
    ))

  test("a malformed option stops the plugin and says which", async () => {
    const malformed: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ providers: "anthropic" }, '["providers"]'],
      [{ providers: { anthropic: 7 } }, '["providers"]["anthropic"]'],
      [{ sweepMinutes: "10" }, '["sweepMinutes"]'],
      [{ sweepMinutes: Number.POSITIVE_INFINITY }, '["sweepMinutes"]'],
      [{ sources: [{ kind: "other", dir: "/x" }] }, '["sources"][0]["kind"]'],
      [{ sources: [{ kind: "gent", dir: "" }] }, '["sources"][0]["dir"]'],
      [{ sources: [{ kind: "gent", dir: "/x", tokenURL: 7 }] }, '["sources"][0]["tokenURL"]'],
      [{ cacheLifeMs: "1h" }, '["cacheLifeMs"]'],
      [{ cacheLifeMs: 0 }, '["cacheLifeMs"]'],
    ]
    for (const [options, path] of malformed) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start(options))))
      expect(exit._tag).toBe("Failure")
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
      expect(reason?._tag).toBe("Die")
      const message = reason?._tag === "Die" && reason.defect instanceof Error ? reason.defect.message : ""
      expect(message).toStartWith("dotfiles-opencode.pool: invalid options: ")
      expect(message).toContain(`at ${path}`)
    }
  })
})

describe("the hooks", () => {
  test("pool only the provider's OAuth logins and name the chosen one on the request", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        expect(yield* plugin.request("ses_3")).not.toBe("cred-key")
      }),
    ))

  test("leave other providers alone", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1", "openai")).toBeUndefined()
      }),
    ))

  test("a plan-limit 429 holds the login, in the ledger too, and its run retries at once on the other", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        expect(yield* plugin.request()).toBe("cred-a")
        state.readings.set("cred-a", {
          at: Date.now(),
          status: "rejected",
          windows: [{ name: "5h", utilization: 1, resetAt: Date.now() + 2 * HOUR }],
          refusal: { kind: "usage-limit", until: Date.now() + 2 * HOUR },
        })
        yield* plugin.respond(429)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
        expect(yield* plugin.request()).toBe("cred-b")
      }),
    ))

  test("a 429 without a reading still holds the login for the default time", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.request()
        yield* plugin.respond(429)
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
      }),
    ))

  test("an overloaded answer holds nothing and leaves the host's retry decision", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        yield* plugin.respond(529)
        expect(yield* plugin.retry({ retry: true, delay: 2000 })).toEqual({ retry: true, delay: 2000 })
        expect(yield* plugin.request()).toBe("cred-a")
        // Only where the session's cache is: no hold.
        expect([...state.storage.keys()]).toEqual(["anthropic/cache/ses_1"])
      }),
    ))

  test("a sign-in refusal that never reached a response fails over, and marks the login as needing a sign-in once", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        state.readings.set("cred-a", { at: Date.now(), windows: [], refusal: { kind: "signin", until: Date.now() + 30 * 60_000 } })
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
        expect(state.integration.marks).toEqual([{ pool: ANTHROPIC, credentialID: "cred-a", needed: true }])
        expect(yield* plugin.request()).toBe("cred-b")
        // A reading that no longer asks for a sign-in clears the mark, once.
        state.readings.set("cred-a", { at: Date.now(), windows: [] })
        yield* plugin.pace("anthropic")
        yield* plugin.pace("anthropic")
        expect(state.integration.marks).toEqual([
          { pool: ANTHROPIC, credentialID: "cred-a", needed: true },
          { pool: ANTHROPIC, credentialID: "cred-a", needed: false },
        ])
      }),
    ))

  test("readings published by the auth plugin hold a login without any request", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.request("ses_0")
        yield* plugin.publish({
          credentialID: "cred-a",
          reading: { at: Date.now(), windows: [], refusal: { kind: "rate-limit", until: Date.now() + 60_000 } },
        })
        expect(yield* plugin.request("ses_new")).toBe("cred-b")
      }),
    ))

  test("a priced step counts on its session's login, and an idle session's run ends", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 3 } })
        // A step of a session the pool never placed counts nowhere.
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_other", cost: 5 } })
        const loads = (yield* plugin.status).anthropic?.accounts.map((account) => [account.credentialID, account.load, account.live])
        expect(loads).toEqual([
          ["cred-a", 3, 1],
          ["cred-b", 0, 0],
        ])
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        // The run of an idle session ends, whichever way the host says so.
        yield* plugin.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
        yield* plugin.idle("ses_2")
        const live = (yield* plugin.status).anthropic?.accounts.map((account) => account.live)
        expect(live).toEqual([1, 1])
      }),
    ))
})

describe("a session's cache", () => {
  /** Two sessions, each on its own login, then idle: s1's login carries more load, so b scores better. */
  const loaded = (plugin: Effect.Success<ReturnType<typeof start>>) =>
    Effect.gen(function* () {
      expect(yield* plugin.request("s1")).toBe("cred-a")
      expect(yield* plugin.request("s2")).toBe("cred-b")
      yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
      yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
      yield* plugin.idle("s1")
      yield* plugin.idle("s2")
    })

  test("keeps the session on its login for the cache life the options give, then load places it", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR })
        yield* loaded(plugin)
        yield* TestClock.adjust(HOUR / 2)
        expect(yield* plugin.request("s1")).toBe("cred-a")
        yield* plugin.idle("s1")
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("s1")).toBe("cred-b")
      }),
    ))

  test("a fork with no cache of its own goes to its source's login, against the load", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.forks.set("fork", "s1")
        const plugin = yield* start({ sweepMinutes: 0 }, state)
        yield* loaded(plugin)
        // b scores better, but the fork reads s1's cache, which is on a.
        expect(yield* plugin.request("fork")).toBe("cred-a")
        expect(yield* plugin.request("other")).toBe("cred-b")
      }),
    ))

  test("survives a restart: the new process keeps the session on its cache's login", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        yield* loaded(yield* start(undefined, state))
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        const next = yield* start(undefined, state)
        expect(yield* next.request("s1")).toBe("cred-a")
      }),
    ))

  /** The provider gives an hour; the implementor role keeps its own five minutes, as orchestrate sets it. */
  const roles = () => {
    const state = world()
    state.agents.set("implementor", "5m")
    return state
  }

  test("of a role that keeps its own 5-minute lifetime lets the session go after 5 minutes, though the provider's is an hour", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
        yield* plugin.idle("s1")
        yield* plugin.idle("s2")
        // Inside its five minutes the role stays on its cache's login, against the load.
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 0 } })
        yield* plugin.idle("s1")
        // Its step kept the role's lifetime: five minutes after it, load places the session.
        yield* TestClock.adjust(CACHE_LIFE_MS)
        expect((yield* plugin.status).anthropic?.accounts.map((account) => account.live)).toEqual([0, 1])
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-b")
      }),
    ))

  test("of a main session keeps the provider's hour, and an agent the host cannot name keeps it too", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect(yield* plugin.request("s1")).toBe("cred-a")
        expect(yield* plugin.request("s2", "anthropic", "primary", "ghost")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
        yield* plugin.idle("s1")
        yield* plugin.idle("s2")
        yield* TestClock.adjust(HOUR - 1)
        expect((yield* plugin.status).anthropic?.accounts.map((account) => account.live)).toEqual([1, 1])
        expect(yield* plugin.request("s1")).toBe("cred-a")
        expect(yield* plugin.request("s2", "anthropic", "primary", "ghost")).toBe("cred-b")
      }),
    ))

  test("of a role survives a restart with its own lifetime: dropped once its five minutes pass", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = roles()
        const first = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(yield* first.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        yield* first.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        expect(state.storage.get("anthropic/cache/s1")).toEqual({ credentialID: "cred-a", at: 0, lifeMs: CACHE_LIFE_MS })
        yield* TestClock.adjust(CACHE_LIFE_MS)
        yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect([...state.storage.keys()].filter((key) => key.includes("/cache/"))).toEqual([])
      }),
    ))

  test("that died before a restart is dropped from the ledger, and load places the session", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        yield* loaded(yield* start(undefined, state))
        yield* TestClock.adjust(CACHE_LIFE_MS)
        const next = yield* start(undefined, state)
        expect([...state.storage.keys()].filter((key) => key.includes("/cache/"))).toEqual([])
        expect(yield* next.request("s1")).toBe("cred-b")
      }),
    ))
})

describe("the ledger", () => {
  test("keeps holds, readings, priced steps and caches under the pool's id, and a new process reads them back", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(HOUR)
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request("s1")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 0.25 } })
        yield* plugin.publish({ credentialID: "cred-b", reading: { at: HOUR, windows: [], refusal: { kind: "usage-limit", until: 3 * HOUR } } })
        expect([...state.storage.keys()].sort()).toEqual([
          "anthropic/cache/s1",
          "anthropic/hold/cred-b",
          "anthropic/reading/cred-b",
          `anthropic/step/${String(HOUR).padStart(15, "0")}/s1`,
        ])

        const next = yield* start(undefined, state)
        expect(yield* next.request("s2")).toBe("cred-a")
        const accounts = (yield* next.status).anthropic?.accounts
        expect(accounts?.map((account) => [account.credentialID, account.load, account.hold?.kind])).toEqual([
          ["cred-a", 0.25, undefined],
          ["cred-b", 0, "usage-limit"],
        ])
      }),
    ))

  test("a new process drops steps out of the window and past holds, and leaves what does not decode out", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request("s1")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: 0, windows: [], refusal: { kind: "rate-limit", until: 1000 } } })
        state.storage.set("anthropic/reading/cred-b", "not a reading")
        state.storage.set("other/hold/cred-a", { kind: "usage-limit", until: WINDOW_MS * 2, at: 0 })
        yield* TestClock.adjust(WINDOW_MS)

        const next = yield* start(undefined, state)
        expect([...state.storage.keys()].sort()).toEqual(["anthropic/reading/cred-a", "anthropic/reading/cred-b", "other/hold/cred-a"])
        yield* next.pace("anthropic")
        const accounts = (yield* next.status).anthropic?.accounts
        expect(accounts?.map((account) => [account.credentialID, account.load, account.hold, account.reading?.at])).toEqual([
          ["cred-a", 0, undefined, 0],
          ["cred-b", 0, undefined, undefined],
        ])
      }),
    ))
})

describe("the sweep", () => {
  test("reads every login's usage a moment after start, then every few minutes", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.readings.set("cred-a", { at: 0, windows: [], refusal: { kind: "usage-limit", until: 2 * HOUR } })
        const plugin = yield* start({ sweepMinutes: 5 }, state)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(false)
        yield* TestClock.adjust("1 second")
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(yield* plugin.request()).toBe("cred-b")
        state.readings.set("cred-b", { at: 1000, windows: [{ name: "7d", utilization: 0.5, resetAt: 3 * HOUR }] })
        yield* TestClock.adjust("4 minutes")
        expect(state.storage.has("anthropic/reading/cred-b")).toBe(false)
        yield* TestClock.adjust("1 minute")
        expect(state.storage.has("anthropic/reading/cred-b")).toBe(true)
      }),
    ))

  test("is off at 0 minutes", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.readings.set("cred-a", { at: 0, windows: [], refusal: { kind: "usage-limit", until: 2 * HOUR } })
        yield* start({ sweepMinutes: 0 }, state)
        yield* TestClock.adjust(HOUR)
        expect([...state.storage.keys()]).toEqual([])
      }),
    ))
})

describe("the RPC", () => {
  test("logins names the login each step of a session went out on, by its message, in the ledger too", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        // The ledger keys a step by its millisecond: each step here ends in its own.
        const step = (sessionID: string, assistantMessageID?: string) =>
          plugin
            .emit({ type: "session.step.ended", data: { sessionID, cost: 1, ...(assistantMessageID === undefined ? {} : { assistantMessageID }) } })
            .pipe(Effect.andThen(TestClock.adjust("1 second")))
        expect(yield* plugin.request("s1")).toBe("cred-a")
        yield* step("s1", "msg_1")
        // A 429 holds cred-a: the session's next request moves to cred-b.
        yield* plugin.respond(429, "s1")
        expect(yield* plugin.request("s1")).toBe("cred-b")
        yield* step("s1", "msg_2")
        // A step whose event names no message is left out; so is another session's.
        yield* step("s1")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* step("s2", "msg_3")
        expect(yield* plugin.logins({ sessionID: "s1" })).toEqual({
          steps: [
            { pool: "anthropic", messageID: "msg_1", credentialID: "cred-a" },
            { pool: "anthropic", messageID: "msg_2", credentialID: "cred-b" },
          ],
        })
        expect(yield* plugin.logins({ session: "s1" })).toEqual({ steps: [] })
        // A new process reads the steps' messages back from the ledger.
        const next = yield* start(undefined, state)
        expect((yield* next.logins({ sessionID: "s1" })).steps.map((step) => step.messageID)).toEqual(["msg_1", "msg_2"])
      }),
    ))

  test("pace admits unpooled models, holds the measured pool and picks up newer quota readings", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        const at = Date.now()
        for (const id of ["cred-a", "cred-b"])
          state.readings.set(id, { at, windows: [{ name: "7d", utilization: 0.8, resetAt: at + 3.5 * 86400000 }] })
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: false })
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, measured: true })
        for (const id of ["cred-a", "cred-b"])
          state.readings.set(id, { at, windows: [{ name: "7d", utilization: 0.2, resetAt: at + 3.5 * 86400000 }] })
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: true, measured: true })
      }),
    ))

  test("status lists each login's hold and reading, and never a token", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        state.readings.set("cred-a", { at: Date.now(), windows: [], refusal: { kind: "rate-limit", until: Date.now() + 60_000 } })
        yield* plugin.respond(429)
        const status = yield* plugin.status
        expect(status.anthropic?.accounts.map((account) => [account.credentialID, account.hold?.kind])).toEqual([
          ["cred-a", "rate-limit"],
          ["cred-b", undefined],
        ])
        expect(JSON.stringify(status)).not.toContain("token")
      }),
    ))

  test("session names the login a session is on by its label, with its reading, and nothing for an unpooled provider", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        // Before any request the pool has listed no login: nothing to name.
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toEqual({})
        expect(yield* plugin.request("ses_0")).toBe("cred-a")
        // Listed now: a session with no request yet sees the pool's pick for it.
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toMatchObject({
          account: { pool: "anthropic", credentialID: "cred-b", label: "Anthropic 2", on: "next" },
        })
        expect(yield* plugin.request("ses_1")).toBe("cred-b")
        const at = Date.now()
        yield* plugin.publish({ credentialID: "cred-b", reading: { at, windows: [{ name: "7d", utilization: 0.41, resetAt: at + HOUR }] } })
        const placed: SessionAnswer = {
          account: {
            pool: "anthropic",
            credentialID: "cred-b",
            label: "Anthropic 2",
            on: "placed",
            reading: { at, windows: [{ name: "7d", utilization: 0.41, resetAt: at + HOUR }] },
          },
        }
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toEqual(placed)
        // Without a provider: the pool its newest request went through.
        expect(yield* plugin.session({ sessionID: "ses_1" })).toEqual(placed)
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "openai" })).toEqual({})
        expect(yield* plugin.session({ sessionID: "ses_never" })).toEqual({})
        expect(yield* plugin.session({ providerID: "anthropic" })).toEqual({})
        expect(JSON.stringify(yield* plugin.session({ sessionID: "ses_1" }))).not.toContain("token")
      }),
    ))

  test("pace on a pool whose logins cannot be read fails, and the hooks and status go on", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.delete(ANTHROPIC)
        const plugin = yield* start(undefined, state)
        expect(yield* plugin.request()).toBeUndefined()
        expect((yield* Effect.exit(plugin.pace("anthropic")))._tag).toBe("Failure")
        expect((yield* plugin.status).anthropic?.accounts).toEqual([])
      }),
    ))
})

describe("on the live adapters", () => {
  test("the pool reads the integration's OAuth logins and its quota RPC, keeps holds in storage, and asks a refused login to sign in", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state, live)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        // The integration's label names the login a session is on.
        expect((yield* plugin.session({ sessionID: "ses_2", providerID: "anthropic" })).account?.label).toBe("Anthropic 2")
        state.readings.set("cred-a", { at: Date.now(), windows: [], refusal: { kind: "signin", until: Date.now() + 30 * 60_000 } })
        yield* plugin.respond(401)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(new Set(plugin.quotaIDs)).toEqual(new Set(["credential-quota.anthropic"]))
        expect(plugin.statuses).toEqual([
          { credentialID: "cred-a", status: { status: "needs_auth", message: expect.stringContaining("sign in") } },
        ])
        // A reading published over the quota RPC holds a login too.
        yield* plugin.publish({
          credentialID: "cred-b",
          reading: { at: Date.now(), windows: [], refusal: { kind: "rate-limit", until: Date.now() + 60_000 } },
        })
        expect(state.storage.has("anthropic/hold/cred-b")).toBe(true)
        expect(Object.keys(plugin.rpc)).toEqual(["dotfiles-opencode.pool"])
      }),
    ))

  test("a gent store joins the anthropic pool, which OpenCode then offers without a login of its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-gent-"))
    return scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "gent", dir }] }, world(), live)
        expect((yield* plugin.status).anthropic?.sources).toEqual([{ kind: "gent", dir, accounts: [], skipped: [] }])
        let activation = "auto"
        const editor = {
          get: () => ({ provider: { activation } }),
          update: (_: string, change: (provider: { activation: string }) => void) => {
            const provider = { activation }
            change(provider)
            activation = provider.activation
          },
        }
        expect(plugin.transforms).toHaveLength(1)
        for (const transform of plugin.transforms) transform(editor)
        expect(activation).toBe("enabled")
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })
})

describe("the alerts RPC", () => {
  /** A gent store with one expired login, and a source over it that trades at a fake endpoint answering `status`. */
  const store = (status: number, headers: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "pool-alerts-"))
    mkdirSync(join(dir, ".slots/anthropic"), { recursive: true })
    const login = { access: "fake-access-alerts", refresh: "fake-refresh-alerts" }
    writeFileSync(
      join(dir, ".slots/anthropic/work"),
      JSON.stringify({ _tag: "Oauth", type: "oauth", ...login, expires: Date.now() - 1000, accountId: null, metadata: { owner: "gent" } }),
      { mode: 0o600 },
    )
    // A second source over the directory shares the plugin's state for it, as every copy in the process does.
    const trader = new GentSource({
      dir,
      fetch: async () => Response.json({ error: "refused" }, { status, headers }),
    })
    const trade = Effect.promise(() => trader.resolve("gent:work").then(() => "served", () => "failed"))
    return { dir, login, trade }
  }

  test("names a gent login the endpoint refused, with the command that signs it in again, and never its token", () => {
    const { dir, login, trade } = store(400)
    return scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "gent", dir }] }, world(), live)
        expect(yield* plugin.alerts).toEqual({ lost: [], outages: [] })
        expect(yield* trade).toBe("failed")
        const alerts = yield* plugin.alerts
        expect(alerts).toEqual({
          lost: [
            {
              pool: "anthropic",
              credentialID: "gent:work",
              label: "work",
              since: expect.any(Number),
              command: `GENT_AUTH_DIRECTORY=${dir} gent auth login anthropic --method "Sign in to a Claude account" --slot work`,
            },
          ],
          outages: [],
        })
        expect(JSON.stringify(alerts)).not.toContain(login.access)
        expect(JSON.stringify(alerts)).not.toContain(login.refresh)
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })

  test("names a store whose refreshes have failed for refreshOutageMinutes, with the endpoint's status, server and retry-after", () => {
    const { dir, trade } = store(429, { server: "cloudflare", "retry-after": "600" })
    return scenario(
      Effect.gen(function* () {
        // A threshold of 30 ms: one 429 that pauses the store for ten minutes is out once it passes.
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "gent", dir }], refreshOutageMinutes: 0.0005 }, world(), live)
        expect(yield* trade).toBe("failed")
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 50)))
        expect(yield* plugin.alerts).toEqual({
          lost: [],
          outages: [
            {
              pool: "anthropic",
              dir,
              since: expect.any(Number),
              lastAt: expect.any(Number),
              failures: 1,
              cause: { status: 429, server: "cloudflare", retryAfter: "600" },
            },
          ],
        })
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })

  test("a refreshOutageMinutes that is not a positive number stops the plugin", async () => {
    for (const refreshOutageMinutes of [0, -1, "10"]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, refreshOutageMinutes }))))
      expect(exit._tag).toBe("Failure")
    }
  })

  test("a pool with no gent store has no alerts", () =>
    scenario(
      Effect.gen(function* () {
        expect(yield* (yield* start()).alerts).toEqual({ lost: [], outages: [] })
      }),
    ))
})
