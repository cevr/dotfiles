// The plugin seam: the composition root on a stand-in host whose hooks and
// events the test drives, its sessions read through the OpenCode adapter over
// a world in memory, on the test clock. It checks when OpenCode is asked to
// compact: at expiry minus the margin for an idle, large session, its
// background work running or not, not after a new request started, not twice
// for one cache, not back to back without new work, not while it runs (a
// foreground subagent included), and only when it costs less than expiry.
// "One copy per location" runs several copies on one host, as the fork does,
// and checks that a session's idle window gets one decision and one compaction.
// tests/idle-compact.test.ts runs it in OpenCode, on a scripted model.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Logger, PubSub, References, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CHILDREN, type Host as SessionsHost, layer as sessionsLayer, type MessageView, type ModelView } from "@dotfiles/opencode-idle-compact/opencode/sessions"
import IdleCompact, { make, Options, SETTLE } from "./server.ts"

type Host = Parameters<(typeof IdleCompact)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
interface HostEvent {
  readonly type: string
  /** The location it was published in; none for a host-wide one. */
  readonly location?: { readonly directory: string }
  readonly data: { readonly sessionID?: string }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** How long the catalog stays quiet before a look. */
const SETTLE_MS = Duration.toMillis(SETTLE)

/** One session of the world: its times, in test-clock ms, and its context. */
interface WorldSession {
  /** Where it runs; `/work` when absent. */
  directory?: string
  parentID?: string
  title?: string
  busy?: number
  idle?: number
  messages: Array<MessageView>
}

const MODELS: ReadonlyArray<ModelView> = [
  { providerID: "anthropic", modelID: "claude-x", window: 200_000 },
  { providerID: "anthropic", modelID: "claude-long", window: 1_000_000, ttl: "1h" },
  // Opus 5.5 as the catalog prices it: compacting pays above 147,693 prompt tokens on its hour's cache (mods/idle-compact/price.ts).
  { providerID: "anthropic", modelID: "claude-priced", window: 1_000_000, ttl: "1h", rates: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }] },
]

/** The host's sessions, kept in memory, and the compactions OpenCode was asked for. */
const world = () => {
  const sessions = new Map<string, WorldSession>()
  /** The catalog as the host reads it now: a reload changes it. */
  const catalog = { models: [...MODELS], agents: new Map<string, string | undefined>([["build", undefined]]), unreadable: false }
  const compactions: Array<string> = []
  /** The host's heavy reads, as the plugin made them: a session's whole context, its children, the recent main sessions. */
  const reads = { messages: new Array<string>(), children: new Array<{ readonly sessionID: string; readonly limit: number }>(), roots: 0 }
  const view = (id: string, session: WorldSession) => ({ id, ...session, directory: session.directory ?? "/work" })
  const host: SessionsHost = {
    location: { directory: "/work" },
    session: (id) => {
      const session = sessions.get(id)
      return session === undefined ? Effect.fail(new Error(`no session ${id}`)) : Effect.succeed(view(id, session))
    },
    messages: (id) =>
      Effect.sync(() => {
        reads.messages.push(id)
        return sessions.get(id)?.messages ?? []
      }),
    children: (id, limit) =>
      Effect.sync(() => {
        reads.children.push({ sessionID: id, limit })
        return [...sessions]
          .filter(([, session]) => session.parentID === id)
          .map(([child, session]) => view(child, session))
          .toReversed()
          .slice(0, limit)
      }),
    model: (ref) =>
      catalog.unreadable
        ? Effect.fail(new Error(`provider ${ref.providerID} cannot be read`))
        : Effect.succeed(catalog.models.find((model) => model.providerID === ref.providerID && model.modelID === ref.id)),
    agentTTL: (id) => (catalog.agents.has(id) ? Effect.succeed(catalog.agents.get(id)) : Effect.fail(new Error(`Agent not found: ${id}`))),
    catalog: Effect.sync(() => ({ models: catalog.models, agents: [...catalog.agents] })),
    roots: Effect.sync(() => {
      reads.roots += 1
      return [...sessions].filter(([, session]) => session.parentID === undefined).map(([id, session]) => view(id, session))
    }),
    compact: (id) => Effect.sync(() => void compactions.push(id)),
  }
  const session = (id: string, fields: Partial<WorldSession> = {}): WorldSession => {
    const made = { messages: [], ...fields }
    sessions.set(id, made)
    return made
  }
  return { sessions, compactions, host, session, catalog, reads }
}
type World = ReturnType<typeof world>

/** Let the plugin's fibers take in what was just offered: a real moment, on the test clock too. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 5)))

/**
 * The plugin started on a stand-in host over `state`, and the host's moves. `at` places it as one copy of several on
 * one host: the copy for `directory` (`/work` by default), hearing the host-wide `bus`, its own when none is given.
 * Its hooks are its location's, so `hook` and `turn` drive only this copy's.
 */
const start = (
  state: World,
  options: Record<string, unknown> = {},
  at: { readonly directory?: string; readonly bus?: PubSub.PubSub<HostEvent> } = {},
) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const events = at.bus ?? (yield* PubSub.unbounded<HostEvent>())
    const host = {
      options,
      location: { directory: at.directory ?? "/work" },
      session: {
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            ;(hooks[name] ??= []).push(callback)
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromPubSub(events) },
    } as unknown as Host
    yield* make(() => sessionsLayer({ ...state.host, location: { directory: at.directory ?? "/work" } })).effect(host)
    yield* settle

    const hook = Effect.fn("IdleCompactServerTest.hook")(function* (name: string, event: Record<string, unknown>) {
      for (const callback of hooks[name] ?? []) yield* callback(event)
    })
    const emit = (type: string, sessionID: string) => PubSub.publish(events, { type, data: { sessionID } }).pipe(Effect.andThen(settle))
    /** The host publishes this copy's location's catalog change, as it does once a reload is applied. */
    const publish = (type: "provider.updated" | "model.updated" | "agent.updated") =>
      PubSub.publish(events, { type, location: { directory: at.directory ?? "/work" }, data: {} }).pipe(Effect.andThen(settle))
    const now = TestClock.testClockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()))

    /**
     * One turn of one model request, as OpenCode runs it: the execution starts, the request starts now and streams
     * for `streams`, its usage is recorded, and the execution ends. With `requests`, that many in a row, as a turn
     * that calls tools runs them.
     */
    const turn = Effect.fn("IdleCompactServerTest.turn")(function* (
      sessionID: string,
      usage: { readonly input?: number; readonly read?: number; readonly write?: number } = {},
      options: {
        readonly streams?: number
        readonly model?: string
        readonly kind?: string
        readonly requests?: number
        readonly agent?: string
      } = {},
    ) {
      const session = state.sessions.get(sessionID) ?? state.session(sessionID)
      yield* emit("session.execution.started", sessionID)
      session.busy = yield* now
      for (let request = 0; request < (options.requests ?? 1); request += 1) {
        const started = yield* now
        yield* hook("model.request", { sessionID, agent: options.agent ?? "build", model: { providerID: "anthropic", id: options.model ?? "claude-x" }, kind: options.kind ?? "primary", headers: {} })
        yield* TestClock.adjust(options.streams ?? 10_000)
        session.messages.push({
          type: "assistant",
          created: started + 500,
          tokens: { input: usage.input ?? 1_000, cache: { read: usage.read ?? 90_000, write: usage.write ?? 2_000 } },
          model: { providerID: "anthropic", id: options.model ?? "claude-x" },
          agent: options.agent ?? "build",
        })
      }
      yield* hook("experimental.idle", { sessionID, background: [] })
      session.idle = yield* now
      yield* emit("session.execution.succeeded", sessionID)
    })

    /** Moves the test clock to `at` ms, letting each timer due on the way fire. */
    const until = Effect.fn("IdleCompactServerTest.until")(function* (at: number) {
      const current = yield* now
      if (at > current) yield* TestClock.adjust(at - current)
      yield* settle
    })
    return { hook, emit, publish, turn, until, now }
  })

interface LogLine {
  readonly level: string
  readonly message: string
  readonly annotations: Readonly<Record<string, unknown>>
}
/** What the plugin logged in the running test; each test starts it empty. */
const logs: Array<LogLine> = []
const logger = Logger.make((entry) => {
  logs.push({
    level: entry.logLevel,
    message: (Array.isArray(entry.message) ? entry.message : [entry.message]).map(String).join(" "),
    annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
  })
})

type Scoped<A, E> = Effect.Effect<A, E, Scope.Scope>
/** On the test clock, which starts at 0 and moves only when told, with the plugin's logs kept in `logs`. */
const onTestClock = <A, E>(body: Scoped<A, E>) => {
  logs.length = 0
  return Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger])))))
}

describe("the idle compaction plugin", () => {
  test("compacts an idle, large session one minute before its five-minute cache expires, counted from the request's start", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("compacts five minutes before an hour's cache expires", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1", {}, { model: "claude-long" })
        yield* plugin.until(55 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(55 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("a small session does not compact", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1", { input: 1_000, read: 50_000, write: 0 })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("a request that starts before the timer fires cancels it, and the next idle stretch counts from that request", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(3 * MINUTE)
        // The owner sends the next message: a new request, a new cache.
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE + 30_000)
        expect(state.compactions).toEqual([])
        yield* plugin.until(7 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(7 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("a request on its own cancels the timer, without an execution around it", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(3 * MINUTE)
        yield* plugin.hook("model.request", { sessionID: "ses_1", agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: "generate", headers: {} })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("a title request leaves the timer alone", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(MINUTE)
        yield* plugin.hook("model.request", { sessionID: "ses_1", agent: "title", model: { providerID: "anthropic", id: "claude-x" }, kind: "title", headers: {} })
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("queued input cancels the timer", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.emit("session.inbox.enqueued", "ses_1")
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("never compacts one cache twice: not when its compaction is recorded, nor when the session settles again before it is", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        // The host has not run the compaction yet, and the session settles again.
        yield* plugin.emit("session.execution.succeeded", "ses_1")
        yield* plugin.until(4 * MINUTE + 30_000)
        expect(state.compactions).toEqual(["ses_1"])
        // The host runs it: its request, its record, the end of the execution.
        const session = state.sessions.get("ses_1")
        yield* plugin.emit("session.inbox.enqueued", "ses_1")
        yield* plugin.emit("session.execution.started", "ses_1")
        yield* plugin.hook("model.request", { sessionID: "ses_1", agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: "compaction", headers: {} })
        session?.messages.push({ type: "compaction" })
        if (session !== undefined) session.idle = (yield* plugin.now) + 1
        yield* plugin.emit("session.execution.succeeded", "ses_1")
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("never while a foreground subagent runs: its parent's tool call runs, so the parent does", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        // The parent's next execution calls the subagent and waits on it: the parent runs until it answers.
        yield* plugin.emit("session.execution.started", "ses_1")
        const parent = state.sessions.get("ses_1")
        if (parent !== undefined) parent.busy = yield* plugin.now
        state.session("ses_child", { parentID: "ses_1", title: "reviewer", busy: yield* plugin.now })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("a background subagent that outlives the cache: the idle parent compacts at expiry less the margin, whether its session runs or the idle hook lists it", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        state.session("ses_child", { parentID: "ses_1", title: "reviewer", busy: 5_000, idle: 0 })
        yield* plugin.until(4 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])

        // The idle hook says a background subagent of ses_2 runs, which no child session shows yet.
        yield* plugin.turn("ses_2")
        const started = (yield* plugin.now) - 10_000
        const background = [{ kind: "subagent", sessionID: "ses_2", childSessionID: "ses_x", agent: "worker", description: "scan" }]
        yield* plugin.hook("experimental.idle", { sessionID: "ses_2", background })
        yield* plugin.emit("session.execution.succeeded", "ses_2")
        yield* plugin.until(started + 4 * MINUTE - 1)
        expect(state.compactions).toEqual(["ses_1"])
        yield* plugin.until(started + 4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1", "ses_2"])
      }),
    ))

  test("a background job that ends before the timer: its notice wakes the session and cancels it, and the next idle stretch counts from the wake's request", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.hook("experimental.idle", { sessionID: "ses_1", background: [{ kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "bun test" }] })
        yield* plugin.emit("session.execution.succeeded", "ses_1")
        yield* plugin.until(2 * MINUTE)
        // The shell ends: its notice is queued, and the session wakes on it.
        yield* plugin.emit("session.inbox.enqueued", "ses_1")
        yield* plugin.until(3 * MINUTE)
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE + 30_000)
        expect(state.compactions).toEqual([])
        yield* plugin.until(7 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(7 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("a session already idle when the plugin starts, its background subagent still running, compacts on time", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(10 * MINUTE)
        const state = world()
        state.session("ses_1", {
          busy: 0,
          idle: 30_000,
          messages: [
            { type: "assistant", created: 0, tokens: { input: 1_000, cache: { read: 90_000, write: 0 } }, model: { providerID: "anthropic", id: "claude-long" }, agent: "build" },
          ],
        })
        state.session("ses_child", { parentID: "ses_1", title: "implementor", busy: 20_000 })
        const plugin = yield* start(state)
        yield* plugin.until(55 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(55 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("each decision is one line: scheduled with when and why, compacting, and not compacting with the reason; a session that could not compact at debug", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1", {}, { model: "claude-long" })
        state.session("ses_child", { parentID: "ses_1", title: "reviewer", busy: 5_000 })
        yield* plugin.turn("ses_small", { input: 1_000, read: 10_000, write: 0 })
        yield* plugin.until(HOUR)
        const lines = logs.filter((line) => line.message.startsWith("idle-compact") && line.level === "Info")
        expect(lines.map((line) => [line.level, line.message, line.annotations["sessionID"]])).toEqual([
          ["Info", "idle-compact: compaction scheduled", "ses_1"],
          ["Info", "idle-compact: compacting the idle session before its cache expires", "ses_1"],
        ])
        expect(lines[0]?.annotations).toMatchObject({ trigger: "settled", tokens: 93_000, ttlSeconds: 3_600, inSeconds: 3_290, threshold: 60_000 })
        expect(lines[1]?.annotations).toMatchObject({ trigger: "timer", tokens: 93_000, busy: "subagent reviewer", ttlSeconds: 3_600, cacheAgeSeconds: 3_300 })
        const small = logs.filter((line) => line.annotations["sessionID"] === "ses_small" && line.annotations["trigger"] === "settled")
        expect(small.map((line) => [line.level, line.message])).toEqual([["Debug", "idle-compact: not compacting"]])
        expect(small[0]?.annotations).toMatchObject({ reason: "too-small", tokens: 11_000 })
      }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug")),
    ))

  test("no compaction back to back: after one, idle again with no new request, or only the summary's first, does not compact", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        // The host runs it and records it; the session settles with no request of its own after it.
        const session = state.sessions.get("ses_1")
        yield* plugin.emit("session.execution.started", "ses_1")
        yield* plugin.hook("model.request", { sessionID: "ses_1", agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: "compaction", headers: {} })
        session?.messages.push({ type: "compaction" })
        if (session !== undefined) session.idle = (yield* plugin.now) + 1
        yield* plugin.emit("session.execution.succeeded", "ses_1")
        yield* plugin.until(30 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        // The owner comes back: one request on top of the summary, above the threshold, and idle again.
        yield* plugin.turn("ses_1", { input: 1_000, read: 0, write: 70_000 })
        yield* plugin.until(2 * HOUR)
        expect(state.compactions).toEqual(["ses_1"])
        const reasons = logs.filter((line) => line.message === "idle-compact: not compacting").map((line) => line.annotations["reason"])
        expect(reasons).toEqual(["compacted", "no-new-work"])
      }),
    ))

  test("not right after OpenCode's own compaction, automatic or manual, nor when the plugin starts on it", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(MINUTE)
        const state = world()
        const large = (created: number): MessageView => ({
          type: "assistant",
          created,
          tokens: { input: 1_000, cache: { read: 150_000, write: 0 } },
          model: { providerID: "anthropic", id: "claude-x" },
          agent: "build",
        })
        // Compacted on the window, its turn's next request on top of the summary; compacted by hand, nothing since.
        state.session("ses_auto", { busy: 0, idle: 20_000, messages: [large(0), { type: "compaction" }, { type: "other" }, large(10_000)] })
        state.session("ses_manual", { busy: 0, idle: 20_000, messages: [large(0), { type: "compaction" }] })
        const plugin = yield* start(state)
        yield* plugin.emit("session.execution.succeeded", "ses_auto")
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("after a compaction, a new turn above the threshold is new work: idle again, it compacts", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.until(4 * MINUTE)
        const session = state.sessions.get("ses_1")
        session?.messages.push({ type: "compaction" })
        yield* plugin.until(30 * MINUTE)
        // A turn that calls a tool: the request that loads the summary, then the one after the tool's result.
        yield* plugin.turn("ses_1", {}, { requests: 2 })
        const second = (yield* plugin.now) - 10_000
        yield* plugin.until(second + 4 * MINUTE - 1)
        expect(state.compactions).toEqual(["ses_1"])
        yield* plugin.until(second + 4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1", "ses_1"])
      }),
    ))

  test("only when compacting costs less than the cache expiring, at the catalog's prices, and the check is logged", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        // 141k on Opus's hour cache: compacting costs $1.20, letting it expire $1.13.
        yield* plugin.turn("ses_small", { input: 1_000, read: 140_000, write: 0 }, { model: "claude-priced" })
        // 201k: compacting costs $1.19, letting it expire $1.61.
        yield* plugin.turn("ses_large", { input: 1_000, read: 200_000, write: 0 }, { model: "claude-priced" })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual(["ses_large"])
        const lines = logs.filter((line) => line.message.startsWith("idle-compact"))
        expect(lines[0]?.annotations).toMatchObject({
          sessionID: "ses_small",
          reason: "costs-more",
          verdict: "costs-more",
          avoidedUsd: 1.128,
          costUsd: 1.1802,
          breakEvenTokens: 147_693,
        })
        expect(lines[1]?.annotations).toMatchObject({ sessionID: "ses_large", verdict: "pays", avoidedUsd: 1.608, costUsd: 1.1922 })
        expect(lines[1]?.message).toBe("idle-compact: compaction scheduled")
      }),
    ))

  test("a subagent's own session does not compact unless the options say so", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.session("ses_root")
        state.session("ses_child", { parentID: "ses_root" })
        const plugin = yield* start(state)
        yield* plugin.turn("ses_child")
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])

        const other = world()
        other.session("ses_root")
        other.session("ses_child", { parentID: "ses_root" })
        const enabled = yield* start(other, { subagents: true })
        yield* enabled.turn("ses_child")
        yield* enabled.until(2 * HOUR)
        expect(other.compactions).toEqual(["ses_child"])
      }),
    ))

  test("an execution end reads a main session's context and children once, and a subagent's neither", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.session("ses_root")
        state.session("ses_child", { parentID: "ses_root" })
        const plugin = yield* start(state)
        // The first look reads the main session once.
        yield* plugin.until(SETTLE_MS + 1)
        expect(state.reads.messages).toEqual(["ses_root"])
        state.reads.messages.length = 0
        state.reads.children.length = 0
        // An orchestrator's subagents end by the hundred: theirs is no main session's idle window to read.
        for (let index = 0; index < 3; index += 1) yield* plugin.turn("ses_child")
        expect(state.reads).toMatchObject({ messages: [], children: [] })
        yield* plugin.turn("ses_root")
        // Its children are read for the log alone: one page of the newest, however many it has.
        expect(state.reads).toMatchObject({ messages: ["ses_root"], children: [{ sessionID: "ses_root", limit: CHILDREN }] })
      }),
    ))

  test("a deleted session's timer ends", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        yield* plugin.emit("session.deleted", "ses_1")
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
      }),
    ))

  test("a session already idle when the plugin starts is decided then", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(MINUTE)
        const state = world()
        state.session("ses_1", {
          busy: 0,
          idle: 10_000,
          messages: [
            { type: "assistant", created: 0, tokens: { input: 1_000, cache: { read: 90_000, write: 0 } }, model: { providerID: "anthropic", id: "claude-x" }, agent: "build" },
          ],
        })
        const plugin = yield* start(state)
        yield* plugin.until(4 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("a reload: the first look waits for the catalog to settle, so a provider read without its configured hour does not compact an hour's cache early", () =>
    onTestClock(
      Effect.gen(function* () {
        // As on the workbox at 12:06Z: a 291k session idle 250 s on a model whose provider configures an hour.
        yield* TestClock.adjust(250_000)
        const state = world()
        const large: MessageView = {
          type: "assistant",
          created: 0,
          tokens: { input: 1_000, cache: { read: 290_000, write: 41 } },
          model: { providerID: "anthropic", id: "claude-long" },
          agent: "build",
        }
        state.session("ses_w23", { busy: 0, idle: 20_000, messages: [large] })
        // The config plugins load after this one: until then the provider reads without its `cache.ttl`.
        const configured = state.catalog.models
        state.catalog.models = configured.map((model) => ({ ...model, ttl: undefined }))
        const plugin = yield* start(state)
        yield* plugin.until(250_400)
        state.catalog.models = configured
        yield* plugin.publish("provider.updated")
        yield* plugin.publish("model.updated")
        yield* plugin.until(55 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(55 * MINUTE)
        expect(state.compactions).toEqual(["ses_w23"])
        const scheduled = logs.find((line) => line.message === "idle-compact: compaction scheduled")
        expect(scheduled?.annotations).toMatchObject({ trigger: "resume", ttlSeconds: 3_600 })
      }),
    ))

  test("a catalog change after the first look decides the recent sessions again on the lifetime it now names", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(MINUTE)
        const state = world()
        state.session("ses_1", {
          busy: 0,
          idle: 10_000,
          messages: [
            { type: "assistant", created: 0, tokens: { input: 1_000, cache: { read: 90_000, write: 0 } }, model: { providerID: "anthropic", id: "claude-long" }, agent: "build" },
          ],
        })
        const configured = state.catalog.models
        state.catalog.models = configured.map((model) => ({ ...model, ttl: undefined }))
        const plugin = yield* start(state)
        yield* plugin.until(2 * MINUTE)
        state.catalog.models = configured
        yield* plugin.publish("provider.updated")
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual([])
        yield* plugin.until(55 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        const scheduled = logs.filter((line) => line.message === "idle-compact: compaction scheduled").map((line) => line.annotations)
        expect(scheduled.map((line) => [line["trigger"], line["ttlSeconds"]])).toEqual([
          ["resume", 300],
          ["catalog", 3_600],
        ])
      }),
    ))

  test("an agent's own lifetime is the one its sessions are judged by", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.catalog.agents.set("verifier", "5m")
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1", {}, { model: "claude-long", agent: "verifier" })
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))

  test("a lifetime that cannot be read does not compact, and says so at info", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.catalog.unreadable = true
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1", {}, { model: "claude-long" })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])
        const line = logs.find((entry) => entry.annotations["sessionID"] === "ses_1" && entry.annotations["trigger"] === "settled")
        expect(line?.level).toBe("Info")
        expect(line?.annotations).toMatchObject({ reason: "ttl-unknown", unresolved: "the catalog cannot be read: provider anthropic cannot be read" })
      }),
    ))

  test("the short TTL override and margin of the options", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state, { ttlSeconds: 20, shortMarginSeconds: 5 })
        yield* plugin.turn("ses_1", {}, { streams: 2_000 })
        yield* plugin.until(15_000 - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(15_000)
        expect(state.compactions).toEqual(["ses_1"])
      }),
    ))
})

describe("one copy per location", () => {
  /** The idle-compact lines at info for `sessionID`: what the owner reads in the log. */
  const decisions = (sessionID: string) =>
    logs
      .filter((line) => line.level === "Info" && line.message.startsWith("idle-compact") && line.annotations["sessionID"] === sessionID)
      .map((line) => [line.message, line.annotations["trigger"]])

  test("six copies on one host, as the fork runs them: each idle session gets one decision, one compaction, from its own location's copy", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        // Already idle when the copies start: the resume looks at it.
        state.session("ses_resumed", {
          directory: "/a",
          busy: 0,
          idle: 10_000,
          messages: [
            { type: "assistant", created: 0, tokens: { input: 1_000, cache: { read: 90_000, write: 0 } }, model: { providerID: "anthropic", id: "claude-x" }, agent: "build" },
          ],
        })
        const bus = yield* PubSub.unbounded<HostEvent>()
        const work = yield* start(state, {}, { directory: "/work", bus })
        for (const directory of ["/a", "/b", "/c", "/d", "/e"]) yield* start(state, {}, { directory, bus })
        // A turn in /work: its hooks reach /work's copy, its events every copy.
        yield* work.turn("ses_1")
        yield* work.until(4 * MINUTE)
        expect(state.compactions.toSorted()).toEqual(["ses_1", "ses_resumed"])
        expect(decisions("ses_1")).toEqual([
          ["idle-compact: compaction scheduled", "settled"],
          ["idle-compact: compacting the idle session before its cache expires", "timer"],
        ])
        expect(decisions("ses_resumed")).toEqual([
          ["idle-compact: compaction scheduled", "resume"],
          ["idle-compact: compacting the idle session before its cache expires", "timer"],
        ])
        // Settling again before the host runs it: still the one copy, and the cache is not asked twice.
        yield* work.emit("session.execution.succeeded", "ses_1")
        yield* work.until(HOUR)
        expect(state.compactions.toSorted()).toEqual(["ses_1", "ses_resumed"])
        expect(decisions("ses_1").at(-1)).toEqual(["idle-compact: not compacting", "settled"])
        expect(decisions("ses_1")).toHaveLength(3)
      }),
    ))

  test("a turn that settles before the copies' first look keeps its one decision: the look is for sessions idle before they started", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const bus = yield* PubSub.unbounded<HostEvent>()
        const work = yield* start(state, {}, { directory: "/work", bus })
        yield* start(state, {}, { directory: "/a", bus })
        // As on a loaded host: the turn ends within the first look's settle.
        yield* work.turn("ses_1", {}, { streams: 1_000 })
        yield* work.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        expect(decisions("ses_1")).toEqual([
          ["idle-compact: compaction scheduled", "settled"],
          ["idle-compact: compacting the idle session before its cache expires", "timer"],
        ])
      }),
    ))

  test("the host's background summary of an idle session refreshes its cache and moves its compaction, not cancels it", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const work = yield* start(state)
        yield* work.turn("ses_1")
        // With background compaction on, the host summarizes the idle session ahead (a compaction request, outside
        // any execution): it reads the prefix from cache, so the cache lives on from it, and nothing settles after.
        yield* work.until(30_000)
        yield* work.hook("model.request", { sessionID: "ses_1", agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: "compaction", headers: {} })
        yield* work.until(30_000 + 4 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* work.until(30_000 + 4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
        expect(decisions("ses_1")).toEqual([
          ["idle-compact: compaction scheduled", "settled"],
          ["idle-compact: compaction scheduled", "refresh"],
          ["idle-compact: compacting the idle session before its cache expires", "timer"],
        ])
      }),
    ))

  test("a second Location boots: every Location publishes its catalog again unchanged, and only the new copy looks at its sessions", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const idle = (created: number): MessageView => ({
          type: "assistant",
          created,
          tokens: { input: 1_000, cache: { read: 90_000, write: 0 } },
          model: { providerID: "anthropic", id: "claude-x" },
          agent: "build",
        })
        for (const id of ["ses_1", "ses_2", "ses_3"]) state.session(id, { busy: 0, idle: 1_000, messages: [idle(0)] })
        state.session("ses_b", { directory: "/b", busy: 0, idle: 1_000, messages: [idle(0)] })
        const bus = yield* PubSub.unbounded<HostEvent>()
        const work = yield* start(state, {}, { directory: "/work", bus })
        yield* work.until(SETTLE_MS + 1)
        expect(state.reads.roots).toBe(1)
        expect(state.reads.messages.toSorted()).toEqual(["ses_1", "ses_2", "ses_3"])
        state.reads.roots = 0
        state.reads.messages.length = 0

        // /b opens: its copy starts, and the host publishes each Location's catalog again, unchanged.
        const b = yield* start(state, {}, { directory: "/b", bus })
        for (const copy of [work, b]) {
          yield* copy.publish("provider.updated")
          yield* copy.publish("model.updated")
        }
        yield* work.until((yield* work.now) + 2 * SETTLE_MS)
        // One look, /b's first; /work's copy reads none of its sessions again.
        expect(state.reads.roots).toBe(1)
        expect(state.reads.messages).toEqual(["ses_b"])
        // Its timers stand: each session still compacts on time, once.
        yield* work.until(4 * MINUTE)
        expect(state.compactions.toSorted()).toEqual(["ses_1", "ses_2", "ses_3", "ses_b"])
      }),
    ))

  test("a catalog change published in another Location is that Location's copy's to look at", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.session("ses_1")
        const bus = yield* PubSub.unbounded<HostEvent>()
        const work = yield* start(state, {}, { directory: "/work", bus })
        const a = yield* start(state, {}, { directory: "/a", bus })
        yield* work.until(SETTLE_MS + 1)
        state.reads.roots = 0
        state.catalog.agents.set("verifier", "5m")
        yield* a.publish("agent.updated")
        yield* work.until((yield* work.now) + 2 * SETTLE_MS)
        // /a's copy looks; /work's hears the event but it is not its Location's.
        expect(state.reads.roots).toBe(1)
      }),
    ))

  test("a session of a location with no copy is no copy's to decide", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.session("ses_far", { directory: "/far" })
        const bus = yield* PubSub.unbounded<HostEvent>()
        const work = yield* start(state, {}, { directory: "/work", bus })
        // Its events reach the copy; its hooks would go to /far's copy, which the host has not loaded.
        yield* work.emit("session.execution.started", "ses_far")
        state.sessions.get("ses_far")?.messages.push({
          type: "assistant",
          created: yield* work.now,
          tokens: { input: 1_000, cache: { read: 90_000, write: 2_000 } },
          model: { providerID: "anthropic", id: "claude-x" },
          agent: "build",
        })
        yield* work.emit("session.execution.succeeded", "ses_far")
        yield* work.until(HOUR)
        expect(state.compactions).toEqual([])
        expect(logs.filter((line) => line.annotations["sessionID"] === "ses_far")).toEqual([])
      }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug")),
    ))
})

describe("the options", () => {
  test("take their defaults when absent or undefined", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Options)({ ttlSeconds: undefined }))
    expect(decoded).toEqual({ shortMarginSeconds: 60, longMarginSeconds: 300, thresholdRatio: 0.3, thresholdTokens: 60_000, subagents: false })
  })

  test("a malformed one stops the plugin, naming it", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(make(() => sessionsLayer(world().host)).effect({ options: { shortMarginSeconds: -1 } } as unknown as Host)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("dotfiles-opencode.idle-compact: invalid options")
  })
})
