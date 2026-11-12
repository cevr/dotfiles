// The plugin seam: the composition root on a stand-in host. On test layers it
// checks what OpenCode sees: the credential header, the retry decision, the
// ledger's keys, the sign-in marks and the pool's RPC answers. On the live
// adapters it checks how they reach the host's integration, quota RPC and
// storage. tests/pool-failover.test.ts and tests/pool-gent-opencode.test.ts
// run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Queue, Schedule, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "@dotfiles/opencode-pool/account-pool"
import { CACHE_LIFE_MS, WINDOW_MS } from "@dotfiles/opencode-pool/accounts"
import * as FleetTest from "@dotfiles/opencode-pool/memory/fleet"
import * as LedgerTest from "@dotfiles/opencode-pool/memory/ledger"
import * as LimitsLive from "@dotfiles/opencode-pool/opencode/limits"
import type { LimitsAnswer } from "@dotfiles/opencode-pool/model"
import * as LoginsTest from "@dotfiles/opencode-pool/memory/logins"
import * as OwnerTest from "@dotfiles/opencode-pool/memory/owner"
import * as PeersTest from "@dotfiles/opencode-pool/memory/peers"
import * as QuotaTest from "@dotfiles/opencode-pool/memory/quota"
import * as ResetsTest from "@dotfiles/opencode-pool/memory/resets"
import type { Pace } from "@dotfiles/opencode-pool/pace"
import type { QuotaReading } from "@dotfiles/opencode-pool/quota"
import type { PublishedReading } from "@dotfiles/opencode-pool/service"
import { GentSource } from "@dotfiles/opencode-pool/gent/store"
import type { Alerts, FleetStatus, PoolsStatus, Report, ResetsStatus, SessionAnswer, SessionLogins } from "@dotfiles/opencode-pool/status"
import { spentAccount, startFakeChatGPT } from "../../tests/fake-chatgpt.ts"
import Pool, { CACHE_TTL_HEADER, CREDENTIAL_HEADER, live, make } from "./server.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const ANTHROPIC = PoolId.make("anthropic")

type Host = Parameters<(typeof Pool)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
type Handler = (input: unknown) => Effect.Effect<unknown>
/** A tool the plugin added: its name and how it runs, as the stand-in host keeps it. */
interface ToolDefinition {
  readonly name: string
  readonly execute: (input: never, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, unknown>
}

/** The provider's logins: two OAuth logins and an API key, which the pool leaves out. */
const CONNECTIONS = [
  { type: "credential", id: "cred-a", label: "Anthropic 1", method: "oauth" },
  { type: "credential", id: "cred-b", label: "Anthropic 2", method: "oauth" },
  { type: "credential", id: "cred-key", label: "Anthropic key", method: "key" },
]

const model = { providerID: "anthropic", id: "claude-haiku-4-5" }

interface SessionEvent {
  readonly type: "session.step.started" | "session.step.ended" | "session.idle"
  readonly data: {
    readonly sessionID: string
    readonly cost?: number
    readonly assistantMessageID?: string
    readonly model?: { readonly providerID: string; readonly id: string }
    readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  }
}

/** A limit tally of the test's own, in every start's options: the live adapters otherwise keep it under the owner's XDG_STATE_HOME. */
const scratchLimits = () => join(mkdtempSync(join(tmpdir(), "pool-state-")), "limits.json")

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
  /** The fleet's peers and what each answers, by name, in the config's order. */
  readonly peers: Map<string, PeersTest.Answer>
  /** Each login's credential as the host resolves it, by id. */
  readonly credentials: Map<string, unknown>
  /** The integration's active login, by integration. */
  readonly active: Map<string, string>
  /** The owner the pool asks about a Claude reset. */
  readonly owner: OwnerTest.MemoryOwner
  /** Each subagent session's parent, by id. */
  readonly parents: Map<string, string>
}

const world = (): World => ({
  readings: new Map(),
  integration: { connections: new Map([[ANTHROPIC, CONNECTIONS]]), marks: [] },
  storage: new Map(),
  agents: new Map([["build", undefined]]),
  forks: new Map(),
  peers: new Map(),
  credentials: new Map(),
  active: new Map(),
  owner: OwnerTest.empty(),
  parents: new Map(),
})

/** The outside systems as test layers over `state`. */
const testLayers = (state: World, published: Queue.Dequeue<PublishedReading>) => () =>
  Layer.mergeAll(
    LoginsTest.layer(state.integration),
    QuotaTest.layer(new Map([[ANTHROPIC, state.readings]]), new Map([[ANTHROPIC, published]])),
    LedgerTest.layer(state.storage),
    PeersTest.layer(state.peers),
    FleetTest.layer(state.storage),
    ResetsTest.layer(state.storage),
    OwnerTest.layer(state.owner),
    LimitsLive.layer(LedgerTest.storage(state.storage), join(mkdtempSync(join(tmpdir(), "pool-limits-")), "limits.json")),
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
    const tools = new Map<string, ToolDefinition>()
    const quotaIDs: Array<string> = []
    const statuses: Array<{ readonly credentialID: unknown; readonly status: unknown }> = []
    const events = yield* Queue.unbounded<SessionEvent>()
    const published = yield* Queue.unbounded<PublishedReading>()
    const answer = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.sync(() => ({ reading: state.readings.get(credentialID) ?? null }))
    // The auth plugin's claim: recorded, never sent anywhere; a reset empties the account's 5-hour window.
    const claims: Array<{ readonly credentialID: string; readonly creditID: string; readonly requestID: string }> = []
    const claimOf = (input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) =>
      Effect.sync(() => {
        claims.push(input)
        const held = state.readings.get(input.credentialID)
        if (held !== undefined)
          state.readings.set(input.credentialID, {
            ...held,
            at: held.at + 1,
            windows: held.windows.map((window) => (window.name === "5h" ? { ...window, utilization: 0 } : window)),
          })
        return { outcome: "reset" }
      })
    // The questions plugin's RPC over the world's owner: a question asked as the pool, read back and withdrawn.
    const questionsRpc = {
      askFor: (input: { readonly key: string; readonly plugin: string } & Record<string, unknown>) =>
        Effect.sync(() => {
          const question = input as unknown as OwnerTest.MemoryOwner["asked"][number]
          if (!state.owner.questions.has(input.key)) {
            state.owner.questions.set(input.key, { question })
            state.owner.asked.push(question)
          }
          return { ok: true }
        }),
      asked: () =>
        Effect.sync(() => ({
          questions: [...state.owner.questions].map(([key, held]) => ({
            sessionID: held.question.sessionID,
            id: key,
            key,
            ...(held.answer === undefined ? {} : { answer: held.answer }),
          })),
        })),
      withdrawFor: ({ key }: { readonly key: string }) =>
        Effect.sync(() => {
          state.owner.questions.delete(key)
          state.owner.withdrawn.push(key)
          return { ok: true }
        }),
      events: { subscribe: () => Stream.fromQueue(state.owner.beats) },
    }
    const hostOptions = { limitsFile: scratchLimits(), ...options }
    const host = {
      options: hostOptions,
      session: {
        get: ({ sessionID }: { readonly sessionID: string }) => {
          const source = state.forks.get(sessionID)
          const parentID = state.parents.get(sessionID)
          return Effect.succeed({
            id: sessionID,
            ...(source === undefined ? {} : { fork: { sessionID: source, boundary: {} } }),
            ...(parentID === undefined ? {} : { parentID }),
          })
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
      tool: {
        transform: (callback: (editor: { readonly add: (tool: ToolDefinition) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void tools.set(tool.name, tool) })
            return { dispose: Effect.void }
          }),
      },
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
          resolve: (connection: { readonly id?: string }) => Effect.sync(() => state.credentials.get(connection.id ?? "")),
          active: (integrationID: string) =>
            Effect.sync(() => {
              const id = state.active.get(integrationID)
              return id === undefined ? undefined : { type: "credential", id, label: id, method: "oauth" }
            }),
        },
      },
      rpc: Object.assign(
        (definition: { readonly id: string }) => {
          if (definition.id === "dotfiles-opencode.questions") return questionsRpc
          quotaIDs.push(definition.id)
          return { reading: answer, usage: answer, claim: claimOf, events: { subscribe: () => Stream.fromQueue(published) } }
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

    /** One model request of a session: the headers the pool sets on it. */
    const send = Effect.fn(function* (sessionID = "ses_1", providerID = "anthropic", kind = "primary", agent = "build") {
      const headers: Record<string, string> = {}
      yield* (yield* registered(hooks, "model.request"))({ sessionID, agent, model: { ...model, providerID }, kind, headers })
      return headers
    })
    /** One model request of a session: the login the pool names on it. */
    const request = (...args: Parameters<typeof send>) => send(...args).pipe(Effect.map((headers) => headers[CREDENTIAL_HEADER]))
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
    const pace = Effect.fn(function* (providerID: string, sessionID?: string) {
      return (yield* (yield* method("pace"))({ providerID, ...(sessionID === undefined ? {} : { sessionID }) })) as Pace
    })
    const resets = Effect.gen(function* () {
      return (yield* (yield* method("resets"))({})) as ResetsStatus
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
    const started = Effect.fn(function* (input: unknown) {
      return yield* (yield* method("started"))(input)
    })
    const report = Effect.gen(function* () {
      return (yield* (yield* method("report"))({})) as Report
    })
    const fleet = Effect.gen(function* () {
      return (yield* (yield* method("fleet"))({})) as FleetStatus
    })
    const limits = Effect.gen(function* () {
      return (yield* (yield* method("limits"))({})) as LimitsAnswer
    })
    /** A response of `providerID`'s model came back carrying `headers`. */
    const responded = Effect.fn(function* (providerID: string, headers: Record<string, string>, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "http.response"))({
        sessionID,
        agent: "build",
        model: { ...model, providerID },
        kind: "primary",
        request: new Request("https://chatgpt.com/backend-api/codex/responses"),
        response: new Response(null, { status: 200, headers }),
      })
    })
    /** A frame of `providerID`'s websocket came in. */
    const received = Effect.fn(function* (providerID: string, frame: string, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "experimental.ws.receive"))({ sessionID, agent: "build", model: { ...model, providerID }, kind: "primary", frame })
    })
    return {
      /** The tally file the live adapters keep: the options' own, else this start's scratch one. */
      limitsFile: String(hostOptions.limitsFile),
      send,
      request,
      respond,
      retry,
      idle,
      pace,
      status,
      session,
      alerts,
      logins,
      started,
      report,
      fleet,
      limits,
      resets,
      claims,
      responded,
      received,
      emit,
      publish,
      transforms,
      quotaIDs,
      statuses,
      rpc,
      hooks,
      tools,
    }
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

describe("the limit tally", () => {
  const opus = { providerID: "anthropic", id: "claude-opus-5-5" }
  const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  test("a step's tokens count on its login once, and a reading of the login's window rates them", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        // Another copy of the plugin saw the same step: it counts once.
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* TestClock.adjust(MINUTE)
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: HOUR + MINUTE, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] } })
        const answer = yield* plugin.limits
        expect(answer.tally?.recent.map((w) => [w.pool, w.window, w.families.map((f) => [f.family, f.weighted.rate, f.n])])).toEqual([
          ["anthropic", "5h", [["Opus", 2, 1]]],
        ])
        expect(answer.line).toBe("limit/Mtok 5h: Opus 2.0% n 1 (last 7 days)")
        // What a peer reads of this host: its tokens on the open row.
        expect((yield* plugin.report).limits?.rows.map((row) => row.sums)).toEqual([{ Opus: { w: 1_000_000, raw: 1_000_000 } }])
      }),
    ))

  test("a step whose start the plugin never saw names no model: it counts in no tally", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: HOUR + MINUTE, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] } })
        expect((yield* plugin.limits).tally?.recent).toEqual([])
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

  // OpenCode runs a copy of the plugin per location, all on one storage. The ledger, 2026-11-08 02:17: after a
  // restart two build sessions 50 minutes into their hour's cache moved to another login and wrote 115k and
  // 138k tokens again; another location's copy, whose view of them was its start's, had pruned their marks.
  test("survives a restart after another location's copy swept its older view of the session", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const here = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        yield* loaded(here)
        // Another location's copy starts and reads the marks as they are now.
        yield* start({ sweepMinutes: 10, cacheLifeMs: HOUR }, state)
        // s1 goes on here for 50 minutes.
        yield* TestClock.adjust(50 * MINUTE)
        expect(yield* here.request("s1")).toBe("cred-a")
        yield* here.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* here.idle("s1")
        // The other copy sweeps past the hour of its own view of s1.
        yield* TestClock.adjust(20 * MINUTE)
        const next = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
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

  test("of a role survives a restart with its own lifetime: it holds the session five minutes, and its mark is kept the provider's hour", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = roles()
        const first = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(yield* first.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        yield* first.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* first.idle("s1")
        expect(state.storage.get("anthropic/cache/s1")).toEqual({ credentialID: "cred-a", at: 0, lifeMs: CACHE_LIFE_MS })
        yield* TestClock.adjust(CACHE_LIFE_MS)
        const second = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        // Kept, though it no longer holds the session: the status counts only another session live.
        expect(state.storage.has("anthropic/cache/s1")).toBe(true)
        yield* second.request("other")
        const live = (yield* second.status).anthropic?.accounts.map((account) => account.live) ?? []
        expect(live.reduce((total, count) => total + count, 0)).toBe(1)
        yield* TestClock.adjust(HOUR - CACHE_LIFE_MS)
        yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(state.storage.has("anthropic/cache/s1")).toBe(false)
      }),
    ))

  test("of a role that comes back after its five minutes, within the hour, asks for the hour from that request on", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = roles()
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        const step = (cost: number) => plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost } })
        const role = () => plugin.send("s1", "anthropic", "primary", "implementor")
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
        yield* step(1)
        // Back inside its five minutes: the role's own lifetime pays off.
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
        yield* step(1)
        // Back after a ten-minute shell command: its cache had expired, so the prompt it writes again is
        // written for the hour ...
        yield* TestClock.adjust(10 * MINUTE)
        const raised = yield* role()
        expect(raised[CACHE_TTL_HEADER]).toBe("1h")
        yield* step(1)
        // ... and the one after reads it at that hour, which keeps the session on its login that long.
        yield* TestClock.adjust(MINUTE)
        const next = yield* role()
        expect(next[CACHE_TTL_HEADER]).toBe("1h")
        expect(next[CREDENTIAL_HEADER]).toBe(raised[CREDENTIAL_HEADER])
        yield* step(1)
        // The ledger keeps it, so a restart goes on asking for the hour.
        expect(state.storage.get("anthropic/cache/s1")).toMatchObject({ lifeMs: HOUR, outlived: true })
        yield* plugin.idle("s1")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 0 } })
        yield* TestClock.adjust(30 * MINUTE)
        const later = yield* role()
        expect(later[CACHE_TTL_HEADER]).toBe("1h")
        expect(later[CREDENTIAL_HEADER]).toBe(raised[CREDENTIAL_HEADER])
        yield* step(1)
        // An hour without a request starts over at the role's own lifetime.
        yield* TestClock.adjust(HOUR)
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
      }),
    ))

  test("of a main session never names a lifetime: its agent keeps the provider's", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* TestClock.adjust(10 * MINUTE)
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* TestClock.adjust(MINUTE)
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
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
  test("a step's tokens reach the tally file this start names, at the next sweep", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 5 }, world(), live)
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        const opus = { providerID: "anthropic", id: "claude-opus-5-5" }
        const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: HOUR, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] } })
        yield* TestClock.adjust("5 minutes")
        yield* settle
        const written = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ line: Schema.NullOr(Schema.String) })))(readFileSync(plugin.limitsFile, "utf8"))
        expect(written.line).toContain("Opus")
      }),
    ))

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

describe("the fleet", () => {
  const DAY = 86_400_000
  /** A weekly reading `utilization` spent, halfway through the week, at `at`. */
  const week = (utilization: number, at: number): QuotaReading => ({ at, windows: [{ name: "7d", utilization, resetAt: at + 3.5 * DAY }] })
  const FLEET = { host: "mac", peers: [{ name: "workbox", ssh: "bite-workbox" }, { name: "laptop", ssh: "laptop" }], startCost: 0.1 }

  test("a peer's recent starts count on the pace here, its newer readings join, and a peer that cannot be read is named and skipped", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = Date.now()
        state.readings.set("cred-b", week(0.45, now - 1_000))
        state.peers.set("workbox", {
          host: "bite-cristian",
          at: now,
          starts: [1, 2, 3].map((n) => ({ providerID: "anthropic", at: now - n * 60_000 })),
          // cred-a is read only there; a login this pool does not list is left out.
          readings: [
            { pool: "anthropic", credentialID: "cred-a", reading: week(0.45, now - 500) },
            { pool: "anthropic", credentialID: "gent:elsewhere", reading: week(1, now - 500) },
          ],
        })
        state.peers.set("laptop", { down: "ssh: connect to host laptop port 22: Connection refused" })
        const plugin = yield* start({ sweepMinutes: 0, fleet: FLEET }, state)
        yield* settle
        expect(yield* plugin.fleet).toEqual({
          host: "mac",
          starts: 0,
          settleMinutes: 10,
          peers: [
            { name: "workbox", host: "bite-cristian", seenAt: expect.any(Number), starts: 3 },
            { name: "laptop", starts: 0, missed: { since: expect.any(Number), message: "ssh: connect to host laptop port 22: Connection refused" } },
          ],
        })
        // 90% read across two accounts halfway through their week is on pace; the three starts are 30% more.
        const pace = yield* plugin.pace("anthropic")
        expect(pace).toMatchObject({ ok: false, measured: true })
        expect(pace.reason).toBe(
          "the pool's weekly pace is over (90.0% spent across 2 accounts, +30.0% for 3 agents started in the last 10 min)",
        )
        // It holds until the oldest start settles, sooner than the week catches up.
        expect(pace.ok ? 0 : pace.retryAt).toBe(now - 3 * 60_000 + 10 * 60_000 + 1)
        // The pace read cred-b here; cred-a's reading came from the workbox.
        expect((yield* plugin.status).anthropic?.accounts.map((account) => [account.credentialID, account.reading?.at])).toEqual([
          ["cred-a", now - 500],
          ["cred-b", now - 1_000],
        ])
      }),
    ))

  test("started records a new agent on this host, the report tells a peer of it with the readings and no token, and the pace counts it", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = Date.now()
        state.readings.set("cred-a", week(0.5, now))
        state.readings.set("cred-b", week(0.5, now))
        const plugin = yield* start({ sweepMinutes: 0, fleet: { host: "mac", startCost: 0.1 } }, state)
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: true })
        expect(yield* plugin.started({ providerID: "anthropic" })).toEqual({})
        // A malformed question records nothing; a provider this pool does not pace is reported but not counted here.
        expect(yield* plugin.started({ provider: "anthropic" })).toEqual({})
        yield* plugin.started({ providerID: "openai" })
        const report = yield* plugin.report
        // The starts are a set: two in the same millisecond come back in either order.
        expect(report.starts.map((start) => start.providerID).sort()).toEqual(["anthropic", "openai"])
        expect(report).toEqual({
          host: "mac",
          at: expect.any(Number),
          starts: expect.arrayContaining([
            { providerID: "anthropic", at: expect.any(Number) },
            { providerID: "openai", at: expect.any(Number) },
          ]),
          readings: [
            { pool: "anthropic", credentialID: "cred-a", reading: week(0.5, now) },
            { pool: "anthropic", credentialID: "cred-b", reading: week(0.5, now) },
          ],
          // No step has counted yet: the limit tally tells the peer of no tokens.
          limits: { since: expect.any(Number), rows: [] },
        })
        expect(JSON.stringify(report)).not.toContain("token")
        expect((yield* plugin.fleet).starts).toBe(2)
        expect((yield* plugin.pace("anthropic")).reason).toContain("+10.0% for 1 agent started in the last 10 min")
      }),
    ))

  test("the plugin's instances on one host (one per directory) share the fleet: a start in one counts in the other, and they share the peer reads", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = Date.now()
        state.readings.set("cred-a", week(0.5, now))
        state.readings.set("cred-b", week(0.5, now))
        // Each read of a peer looks its answer up once.
        let reads = 0
        const peers = new (class extends Map<string, PeersTest.Answer> {
          override get(name: string) {
            reads += 1
            return super.get(name)
          }
        })([["workbox", { host: "bite-cristian", at: now, starts: [], readings: [] }]])
        const shared: World = { ...state, peers }
        const fleet = { host: "mac", startCost: 0.1, pollSeconds: 30, peers: [{ name: "workbox", ssh: "bite-workbox" }] }
        // Both instances run over the same storage, as OpenCode's are over the host's.
        const project = yield* start({ sweepMinutes: 0, fleet }, shared)
        const home = yield* start({ sweepMinutes: 0, fleet }, shared)
        yield* settle
        // Both instances' polls ran; only the first read the peer.
        expect(reads).toBe(1)
        expect((yield* home.fleet).peers).toEqual([{ name: "workbox", host: "bite-cristian", seenAt: expect.any(Number), starts: 0 }])
        yield* project.started({ providerID: "anthropic" })
        expect((yield* home.fleet).starts).toBe(1)
        expect((yield* home.report).starts).toEqual([{ providerID: "anthropic", at: expect.any(Number) }])
        expect((yield* home.pace("anthropic")).reason).toContain("+10.0% for 1 agent started in the last 10 min")
      }),
    ))

  test("malformed fleet options stop the plugin", async () => {
    for (const fleet of [{ peers: [{ name: "workbox" }] }, { pollSeconds: 0 }, { startCost: 2 }, { host: "" }]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, fleet }))))
      expect(exit._tag).toBe("Failure")
    }
  })
})

describe("a paced provider on the live adapters", () => {
  const OPENAI = PoolId.make("openai")
  const DAY = 86_400_000

  test("OpenAI's pace reads the ChatGPT account's usage, then what its responses and frames show, and its requests are never placed", () => {
    const resetAt = Math.round((Date.now() + 3.5 * DAY) / 1000)
    const seen: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push(request.headers.get("chatgpt-account-id"))
        return request.headers.get("authorization") === "Bearer chatgpt-access"
          ? Response.json({
              plan_type: "pro",
              rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: resetAt } },
            })
          : new Response("unauthorized", { status: 401 })
      },
    })
    return scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
        state.credentials.set("chatgpt-1", {
          type: "oauth",
          methodID: "browser",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + DAY,
          metadata: { accountID: "acct-1" },
        })
        state.active.set("openai", "chatgpt-1")
        const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: `${server.url.origin}/backend-api/wham/usage` }, state, live)
        // 80% of the week spent halfway through it: over the pace.
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: false, measured: true })
        expect(seen).toEqual(["acct-1"])
        expect(yield* plugin.request("ses_1", "openai")).toBeUndefined()
        // A response's headers say 20%: the pace opens, without asking the endpoint again.
        yield* plugin.responded("openai", {
          "x-codex-primary-used-percent": "20",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": String(resetAt),
        })
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: true })
        // A websocket frame says 95%: held again.
        yield* plugin.received(
          "openai",
          JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 95, window_minutes: 10_080, reset_at: resetAt } } }),
        )
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: false, measured: true })
        expect(seen).toEqual(["acct-1"])
        // The anthropic pool still reads its auth plugin; OpenAI's is not asked.
        expect(plugin.quotaIDs).not.toContain("credential-quota.openai")
        const status = JSON.stringify(yield* plugin.status)
        expect(status).toContain("chatgpt-1")
        expect(status).not.toContain("chatgpt-access")
        expect(status).not.toContain("chatgpt-refresh")
      }),
    ).finally(() => server.stop(true))
  })

  test("a ChatGPT login that cannot be read leaves the pace open", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
        const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: "http://127.0.0.1:9/none" }, state, live)
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: false })
      }),
    ))
})

describe("resets on the live adapters", () => {
  const OPENAI = PoolId.make("openai")
  const DAY = 86_400_000

  /** A Claude login whose 5-hour window is spent, its week resetting in three days, with one reset grant. */
  const spentClaude = (now: number): QuotaReading => ({
    at: now,
    windows: [
      { name: "5h", utilization: 1, resetAt: now + 2 * HOUR },
      { name: "7d", utilization: 0.4, resetAt: now + 3 * DAY },
    ],
    resets: {
      available: 1,
      credits: [{ id: "grant-1", count: 1, usable: true, expiresAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
    },
  })

  test("every Codex account spent and a start held: the pool consumes one credit, once, on the ChatGPT backend, and asks no one", async () => {
    const reply = Promise.withResolvers<void>()
    const fake = startFakeChatGPT({ beforeConsumeResponse: () => reply.promise })
    const now = Date.now()
    fake.accounts.set("acct-1", spentAccount("access-1", "credit-1", now))
    try {
      await scenario(
        Effect.gen(function* () {
          const state = world()
          state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
          state.credentials.set("chatgpt-1", { type: "oauth", access: "access-1", refresh: "r", expires: now + DAY, metadata: { accountID: "acct-1" } })
          const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: fake.usageURL }, state, live)
          expect(yield* plugin.pace("openai", "ses_root")).toMatchObject({ ok: false, measured: true })
          yield* waitFor(() => fake.consumes.length > 0)
          yield* plugin.pace("openai", "ses_root")
          // Consumption precedes the HTTP reply and the post-claim usage read.
          // Keep that boundary open: a second pace must not lose or duplicate the claim.
          const pending = yield* plugin.resets
          expect(pending.claims).toEqual([])
          expect(pending.resets.map((reset) => reset.stage)).toEqual(["claiming"])
          reply.resolve()
          // Observe completion through the public RPC, not a fixed sleep after consumption.
          const resets = yield* plugin.resets.pipe(
            Effect.repeat({ until: (status) => status.claims.length > 0, schedule: Schedule.spaced("5 millis") }),
            Effect.timeout("1 second"),
          )
          yield* plugin.pace("openai", "ses_root")
          expect(fake.consumes.map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
            { account: "acct-1", creditID: "credit-1", code: "reset" },
          ])
          expect(String(fake.consumes[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
          expect(state.owner.asked).toEqual([])
          expect(resets.claims.map(({ provider, outcome, weekly }) => ({ provider, outcome, weekly }))).toEqual([
            { provider: "codex", outcome: "reset", weekly: "moved" },
          ])
          expect(JSON.stringify(resets)).not.toContain("access-1")
        }),
      )
    } finally {
      reply.resolve()
      await fake.stop()
    }
  })

  test("a Claude login: the owner is asked in the waiting subagent's root session, and the grant is claimed only on a yes", () =>
    scenario(
      Effect.gen(function* () {
        const now = Date.now()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(now))
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0 }, state, live)
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* waitFor(() => state.owner.asked.length > 0)
        const asked = state.owner.asked[0]! as OwnerTest.MemoryOwner["asked"][number] & { readonly plugin?: string }
        expect(asked).toMatchObject({ sessionID: "ses_root", plugin: "dotfiles-opencode.pool", header: "Claude reset · Anthropic 1" })
        expect(asked.question).toContain("3.0 days remain before the weekly reset")
        expect(plugin.claims).toEqual([])
        // The owner says yes; the questions change, and the pool reads the answer.
        yield* OwnerTest.answer(state.owner, asked.key, "Claim it")
        yield* waitFor(() => plugin.claims.length > 0)
        yield* settle
        expect(plugin.claims.map(({ credentialID, creditID }) => [credentialID, creditID])).toEqual([["cred-a", "grant-1"]])
        expect(state.owner.questions.size).toBe(0)
        const resets = yield* plugin.resets
        expect(resets.claims.map(({ provider, outcome, weekly }) => ({ provider, outcome, weekly }))).toEqual([
          { provider: "claude", outcome: "reset", weekly: "kept" },
        ])
      }),
    ))

  test("a no claims nothing", () =>
    scenario(
      Effect.gen(function* () {
        const now = Date.now()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(now))
        const plugin = yield* start({ sweepMinutes: 0 }, state, live)
        yield* plugin.pace("anthropic", "ses_root")
        yield* waitFor(() => state.owner.asked.length > 0)
        yield* OwnerTest.answer(state.owner, state.owner.asked[0]!.key, "Don't claim")
        yield* waitFor(() => state.owner.questions.size === 0)
        yield* plugin.pace("anthropic", "ses_root")
        yield* settle
        expect(plugin.claims).toEqual([])
        expect(state.owner.asked).toHaveLength(1)
        expect((yield* plugin.resets).resets.map((reset) => reset.stage)).toEqual(["declined"])
      }),
    ))

  test("a Claude reset about to expire unused is claimed with no one asked, and the owner is told after in the waiting session's root", () =>
    scenario(
      Effect.gen(function* () {
        const now = Date.now()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        // Fable's own week spent, resetting in five days; its reset ends in two hours: lost unless claimed now.
        state.readings.set("cred-a", {
          at: now,
          windows: [
            { name: "5h", utilization: 1, resetAt: now + 3 * HOUR },
            { name: "7d", utilization: 0.6, resetAt: now + 5 * DAY },
            { name: "7d:Fable", utilization: 1, resetAt: now + 5 * DAY, ofWeekly: 0.5 },
          ],
          resets: {
            available: 1,
            credits: [{ id: "fable-1", count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }],
          },
        })
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0 }, state, live)
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* waitFor(() => plugin.claims.length > 0 && state.owner.asked.length > 0)
        expect(plugin.claims.map(({ credentialID, creditID }) => [credentialID, creditID])).toEqual([["cred-a", "fable-1"]])
        // No question before the claim: the one asked is the notice after it.
        expect(state.owner.asked).toHaveLength(1)
        expect(state.owner.asked[0]).toMatchObject({ sessionID: "ses_root", header: "Pool reset claimed", options: [{ label: "OK" }] })
        expect(state.owner.asked[0]?.question).toContain("The pool claimed the Fable reset on account Anthropic 1 before it expired unused")
        // Read, it leaves the tray.
        // The reading the memory quota keeps still lists the grant: it is not offered again under another key.
        yield* OwnerTest.answer(state.owner, state.owner.asked[0]!.key, "OK")
        yield* waitFor(() => state.owner.questions.size === 0)
        yield* plugin.pace("anthropic", "ses_child")
        yield* settle
        expect(state.owner.asked).toHaveLength(1)
        expect(plugin.claims).toHaveLength(1)
        expect((yield* plugin.resets).resets.map(({ why, kind, stage }) => ({ why, kind, stage }))).toEqual([{ why: "expiring", kind: "fable", stage: "settled" }])
      }),
    ))

  test("resets: { auto: false } claims nothing no one asked for: the reset about to expire is left, the held start's question is still asked, and a yes claims", () =>
    scenario(
      Effect.gen(function* () {
        const now = Date.now()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        // As above: Fable's week spent, its reset ends in two hours; with auto on it is claimed at once.
        state.readings.set("cred-a", {
          at: now,
          windows: [
            { name: "5h", utilization: 1, resetAt: now + 3 * HOUR },
            { name: "7d", utilization: 0.6, resetAt: now + 5 * DAY },
            { name: "7d:Fable", utilization: 1, resetAt: now + 5 * DAY, ofWeekly: 0.5 },
          ],
          resets: {
            available: 1,
            credits: [{ id: "fable-1", count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }],
          },
        })
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0, resets: { auto: false } }, state, live)
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* waitFor(() => state.owner.asked.length > 0)
        yield* settle
        expect(plugin.claims).toEqual([])
        expect(state.owner.asked).toHaveLength(1)
        expect(state.owner.asked[0]).toMatchObject({ sessionID: "ses_root", header: "Claude reset · Anthropic 1" })
        yield* OwnerTest.answer(state.owner, state.owner.asked[0]!.key, "Claim it")
        yield* waitFor(() => plugin.claims.length > 0)
        expect(plugin.claims.map(({ credentialID, creditID }) => [credentialID, creditID])).toEqual([["cred-a", "fable-1"]])
      }),
    ))

  test("malformed resets options stop the plugin", async () => {
    for (const resets of [{ auto: "no" }, "yes", 1]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, resets }))))
      expect(exit._tag).toBe("Failure")
    }
  })

  test("resets: false works none", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(Date.now()))
        const plugin = yield* start({ sweepMinutes: 0, resets: false }, state, live)
        expect(yield* plugin.pace("anthropic", "ses_root")).toMatchObject({ ok: false })
        yield* settle
        expect(state.owner.asked).toEqual([])
        expect(yield* plugin.resets).toEqual({ resets: [], claims: [] })
      }),
    ))
})

describe("the lease RPC", () => {
  test("a peer's ask reaches the process's leases, which lend nothing while the process is newly started (it may have lent a lease it forgot); a release is taken; a malformed message lends nothing", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const lease = plugin.rpc["dotfiles-opencode.pool"]!.lease!
        const now = Date.now()
        const grants = [`grant-rpc-${now}`]
        const ask = (host: string, id: string) => ({ _tag: "Ask", host, id, provider: "claude", grants, readAt: now, requestedAt: now, holdMs: 60_000 })
        expect(yield* lease({ _tag: "Ask", host: "mac" })).toEqual({ granted: false, reason: "not a lease message" })
        // The grant, the refusal while lent and the release are lease.test.ts's and fleet-claims.test.ts's: the table here is the process's.
        expect(yield* lease(ask("mac", "a"))).toMatchObject({ granted: false, reason: expect.stringContaining("started lately and lends nothing until") })
        expect(yield* lease({ _tag: "Release", host: "mac", id: "a", provider: "claude", grants })).toEqual({ granted: true })
      }),
    ))
})

describe("the push", () => {
  test("pool_push starts a push from the calling session and answers with its plan; the push RPC takes the same request, and a malformed one changes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        // The test layers' owner walks the sessions' parents.
        state.owner.parents.set("ses_child", "ses_owner")
        const plugin = yield* start({ sweepMinutes: 0, fleet: { host: "workbox" } }, state)
        const tool = plugin.tools.get("pool_push")
        expect(tool).toBeDefined()
        const answer = yield* tool!.execute({ action: "start", goal: "ergo", session: true, resets: 1 } as never, { sessionID: "ses_child" })
        expect(answer.content[0]!.text).toContain('Push push-workbox_ses_owner__-')
        expect(answer.content[0]!.text).toContain('"ergo" (asked): host workbox, session ses_owner')
        const push = plugin.rpc["dotfiles-opencode.pool"]!.push!
        expect(yield* push({ action: "status" })).toMatchObject({ ok: true, pushes: [{ goal: "ergo", scope: { host: "workbox", sessionID: "ses_owner" } }] })
        expect(yield* push({ action: "launch" })).toEqual({ ok: false, text: "not a push request", pushes: [] })
        // A refusal is the tool's error, with the reason.
        const refused = yield* tool!.execute({ action: "start", goal: "" } as never, { sessionID: "ses_child" }).pipe(Effect.flip)
        expect(String((refused as { message?: string }).message)).toContain("A push needs a goal")
      }),
    ))
})

/** Wait, in real time, until `done` holds; a second without it fails the test. */
const waitFor = (done: () => boolean) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 1000
    while (!done()) {
      if (Date.now() > deadline) throw new Error("waited a second in vain")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })
