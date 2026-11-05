// The plugin seam: the composition root on a stand-in host whose hooks and
// events the test drives, its sessions read through the OpenCode adapter over
// a world in memory, on the test clock. It checks when OpenCode is asked to
// compact: at expiry minus the margin for an idle, large session, not after a
// new request started, not twice for one cache, not while a subagent runs.
// tests/idle-compact.test.ts runs it in OpenCode, on a scripted model.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Queue, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type Host as SessionsHost, layer as sessionsLayer, type MessageView, type ModelView } from "@dotfiles/opencode-idle-compact/opencode/sessions"
import IdleCompact, { make, Options } from "./server.ts"

type Host = Parameters<(typeof IdleCompact)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
interface HostEvent {
  readonly type: string
  readonly data: { readonly sessionID: string }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** One session of the world: its times, in test-clock ms, and its context. */
interface WorldSession {
  parentID?: string
  title?: string
  busy?: number
  idle?: number
  messages: Array<MessageView>
}

const MODELS: ReadonlyArray<ModelView> = [
  { providerID: "anthropic", modelID: "claude-x", window: 200_000 },
  { providerID: "anthropic", modelID: "claude-long", window: 1_000_000, ttl: "1h" },
]

/** The host's sessions, kept in memory, and the compactions OpenCode was asked for. */
const world = () => {
  const sessions = new Map<string, WorldSession>()
  const compactions: Array<string> = []
  const view = (id: string, session: WorldSession) => ({ id, directory: "/work", ...session })
  const host: SessionsHost = {
    session: (id) => {
      const session = sessions.get(id)
      return session === undefined ? Effect.fail(new Error(`no session ${id}`)) : Effect.succeed(view(id, session))
    },
    messages: (id) => Effect.succeed(sessions.get(id)?.messages ?? []),
    children: (id) => Effect.succeed([...sessions].filter(([, session]) => session.parentID === id).map(([child, session]) => view(child, session))),
    model: (ref) => Effect.succeed(MODELS.find((model) => model.providerID === ref.providerID && model.modelID === ref.id)),
    roots: Effect.sync(() => [...sessions].filter(([, session]) => session.parentID === undefined).map(([id, session]) => view(id, session))),
    compact: (id) => Effect.sync(() => void compactions.push(id)),
  }
  const session = (id: string, fields: Partial<WorldSession> = {}): WorldSession => {
    const made = { messages: [], ...fields }
    sessions.set(id, made)
    return made
  }
  return { sessions, compactions, host, session }
}
type World = ReturnType<typeof world>

/** Let the plugin's fibers take in what was just offered: a real moment, on the test clock too. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 5)))

/** The plugin started on a stand-in host over `state`, and the host's moves. */
const start = (state: World, options: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const events = yield* Queue.unbounded<HostEvent>()
    const host = {
      options,
      session: {
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            ;(hooks[name] ??= []).push(callback)
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(events) },
    } as unknown as Host
    yield* make(() => sessionsLayer(state.host)).effect(host)
    yield* settle

    const hook = Effect.fn(function* (name: string, event: Record<string, unknown>) {
      for (const callback of hooks[name] ?? []) yield* callback(event)
    })
    const emit = (type: string, sessionID: string) => Queue.offer(events, { type, data: { sessionID } }).pipe(Effect.andThen(settle))
    const now = TestClock.testClockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()))

    /**
     * One turn of one model request, as OpenCode runs it: the execution starts, the request starts now and streams
     * for `streams`, its usage is recorded, and the execution ends.
     */
    const turn = Effect.fn(function* (
      sessionID: string,
      usage: { readonly input?: number; readonly read?: number; readonly write?: number } = {},
      options: { readonly streams?: number; readonly model?: string; readonly kind?: string } = {},
    ) {
      const session = state.sessions.get(sessionID) ?? state.session(sessionID)
      yield* emit("session.execution.started", sessionID)
      session.busy = yield* now
      const started = yield* now
      yield* hook("model.request", { sessionID, agent: "build", model: { providerID: "anthropic", id: options.model ?? "claude-x" }, kind: options.kind ?? "primary", headers: {} })
      yield* TestClock.adjust(options.streams ?? 10_000)
      session.messages.push({
        type: "assistant",
        created: started + 500,
        tokens: { input: usage.input ?? 1_000, cache: { read: usage.read ?? 90_000, write: usage.write ?? 2_000 } },
        model: { providerID: "anthropic", id: options.model ?? "claude-x" },
      })
      yield* hook("experimental.idle", { sessionID, background: [] })
      session.idle = yield* now
      yield* emit("session.execution.succeeded", sessionID)
    })

    /** Moves the test clock to `at` ms, letting each timer due on the way fire. */
    const until = Effect.fn(function* (at: number) {
      const current = yield* now
      if (at > current) yield* TestClock.adjust(at - current)
      yield* settle
    })
    return { hook, emit, turn, until, now }
  })

type Scoped<A, E> = Effect.Effect<A, E, Scope.Scope>
/** On the test clock, which starts at 0 and moves only when told. */
const onTestClock = <A, E>(body: Scoped<A, E>) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(TestClock.layer()))))

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

  test("never while a subagent runs, whether its session runs or the idle hook lists it", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(state)
        yield* plugin.turn("ses_1")
        state.session("ses_child", { parentID: "ses_1", title: "reviewer", busy: 5_000, idle: 0 })
        yield* plugin.until(HOUR)
        expect(state.compactions).toEqual([])

        // The idle hook says a background subagent of ses_2 runs, which no child session shows yet.
        yield* plugin.turn("ses_2")
        const background = [{ kind: "subagent", sessionID: "ses_2", childSessionID: "ses_x", agent: "worker", description: "scan" }]
        yield* plugin.hook("experimental.idle", { sessionID: "ses_2", background })
        yield* plugin.emit("session.execution.succeeded", "ses_2")
        yield* plugin.until(2 * HOUR)
        expect(state.compactions).toEqual([])
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
            { type: "assistant", created: 0, tokens: { input: 1_000, cache: { read: 90_000, write: 0 } }, model: { providerID: "anthropic", id: "claude-x" } },
          ],
        })
        const plugin = yield* start(state)
        yield* plugin.until(4 * MINUTE - 1)
        expect(state.compactions).toEqual([])
        yield* plugin.until(4 * MINUTE)
        expect(state.compactions).toEqual(["ses_1"])
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
