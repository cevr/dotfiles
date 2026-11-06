// The plugin seam: the cache mod's server plugin on a stand-in host whose
// request hook and events the test drives, the ledger in memory, on the test
// clock. Each primary or compaction request a session sends becomes one ledger
// line once its step ends, judged against the request before: first, a hit,
// a changed prefix naming its first changed segment, an expiry, a pool login
// move, a compaction; a failed step writes nothing, and a broken ledger still
// answers the TUI's RPC. tests/cache.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { Effect, PubSub, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Memory from "@dotfiles/opencode-cache/memory/request-log"
import type { SessionSteps } from "@dotfiles/opencode-cache/request-log"
import Cache, { CACHE_TTL_HEADER, CREDENTIAL_HEADER, make } from "./server.ts"

type Host = Parameters<(typeof Cache)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
interface HostEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}
type Handlers = { readonly steps: (input: unknown) => Effect.Effect<SessionSteps> }

const MINUTE = 60_000
const TOOLS = [{ name: "shell", description: "Run a command.", input_schema: { type: "object" } }]

/** An Anthropic body on an hour's cache: a stable block, then one naming `day`, then the conversation. */
const body = (day: string, turns: number) => ({
  tools: TOOLS,
  system: [
    { type: "text", text: "You are a coding agent." },
    { type: "text", text: `Follow the rules.\n\nToday is ${day}.`, cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: Array.from({ length: turns }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: `turn ${index}` })),
})

const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 5)))

const start = (ledger: Memory.MemoryLedger) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const events = yield* PubSub.unbounded<HostEvent>()
    let handlers: Handlers | undefined
    const host = {
      options: { host: "mac" },
      session: {
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            ;(hooks[name] ??= []).push(callback)
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromPubSub(events) },
      rpc: {
        register: (_definition: unknown, registered: Handlers) =>
          Effect.sync(() => {
            handlers = registered
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() => Memory.layer(ledger)).effect(host)
    yield* settle

    /**
     * A request goes out on the session, as OpenCode sends it: `model.request`, where the pool names its login and
     * lifetime in headers, then `http.request`, which the auth plugin reaches first and strips them from, unless
     * `kept` (this plugin's hook first, or no auth plugin).
     */
    const send = Effect.fn(function* (
      sessionID: string,
      json: unknown,
      options: { readonly kind?: string; readonly login?: string; readonly ttl?: string; readonly kept?: boolean } = {},
    ) {
      const scope = { sessionID, agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: options.kind ?? "primary" }
      const pool: Record<string, string> = {}
      if (options.login !== undefined) pool[CREDENTIAL_HEADER] = options.login
      if (options.ttl !== undefined) pool[CACHE_TTL_HEADER] = options.ttl
      for (const callback of hooks["model.request"] ?? []) yield* callback({ ...scope, headers: { ...pool } })
      const headers = new Headers({ "content-type": "application/json", ...(options.kept === true ? pool : {}) })
      const request = new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(json) })
      for (const callback of hooks["http.request"] ?? []) yield* callback({ ...scope, request })
    })
    const emit = (type: string, data: Record<string, unknown>) => PubSub.publish(events, { type, data }).pipe(Effect.andThen(settle))
    const usage = (read: number, write: number) => ({ input: 100, cache: { read, write } })
    /** The step that request wrote ends with this usage. */
    const ended = (sessionID: string, messageID: string, read: number, write: number) =>
      emit("session.step.ended", { sessionID, assistantMessageID: messageID, tokens: usage(read, write) })
    const steps = (input: unknown) => {
      if (handlers === undefined) throw new Error("the plugin registered no RPC")
      return handlers.steps(input)
    }
    return { send, emit, ended, usage, steps }
  })

const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(TestClock.layer()))))

describe("the cache ledger plugin", () => {
  test("a session's requests: first, then a hit, then a changed system paragraph named with how far in it sits", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const plugin = yield* start(ledger)
        yield* plugin.send("ses_1", body("Friday", 1))
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        yield* TestClock.adjust(MINUTE)
        yield* plugin.send("ses_1", body("Friday", 3))
        yield* plugin.ended("ses_1", "msg_2", 40_000, 2_000)
        yield* TestClock.adjust(MINUTE)
        yield* plugin.send("ses_1", body("Saturday", 5))
        yield* plugin.ended("ses_1", "msg_3", 0, 44_000)

        expect(ledger.lines.map((line) => [line.messageID, line.cause, line.ttlMs, line.gapMs])).toEqual([
          ["msg_1", "first", 3_600_000, undefined],
          ["msg_2", "hit", 3_600_000, MINUTE],
          ["msg_3", "prefix", 3_600_000, MINUTE],
        ])
        expect(ledger.lines[2]).toMatchObject({ host: "mac", sessionID: "ses_1", agent: "build", model: "anthropic/claude-x", missed: 42_100, write: 44_000 })
        expect(ledger.lines[2]?.change).toMatchObject({ segment: "system[1] ¶2", head: "Today is Saturday." })
        // The TUI asks how each step was judged.
        const answer = yield* plugin.steps({ sessionID: "ses_1" })
        expect(answer.steps.map((step) => [step.messageID, step.cause, step.change?.segment])).toEqual([
          ["msg_1", "first", undefined],
          ["msg_2", "hit", undefined],
          ["msg_3", "prefix", "system[1] ¶2"],
        ])
        expect((yield* plugin.steps({ sessionID: "ses_other" })).steps).toEqual([])
        expect((yield* plugin.steps({ nothing: true })).steps).toEqual([])
      }),
    ))

  test("past the cache's lifetime the miss is an expiry; on an unchanged prompt inside it, the cache lost it", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const plugin = yield* start(ledger)
        // The pool's header writes a 5-minute cache over the body's hour.
        yield* plugin.send("ses_1", body("Friday", 1), { ttl: "5m" })
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        yield* TestClock.adjust(6 * MINUTE)
        yield* plugin.send("ses_1", body("Friday", 3), { ttl: "5m" })
        yield* plugin.ended("ses_1", "msg_2", 0, 41_000)
        yield* TestClock.adjust(MINUTE)
        yield* plugin.send("ses_1", body("Friday", 5), { ttl: "5m" })
        yield* plugin.ended("ses_1", "msg_3", 0, 42_000)
        expect(ledger.lines.map((line) => [line.cause, line.ttlMs, line.gapMs])).toEqual([
          ["first", 300_000, undefined],
          ["expired", 300_000, 6 * MINUTE],
          ["unchanged", 300_000, MINUTE],
        ])
      }),
    ))

  test("a request the pool moved to another login names both logins", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const plugin = yield* start(ledger)
        yield* plugin.send("ses_1", body("Friday", 1), { login: "cred-a" })
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        yield* plugin.send("ses_1", body("Friday", 3), { login: "cred-b" })
        yield* plugin.ended("ses_1", "msg_2", 0, 41_000)
        expect(ledger.lines[1]).toMatchObject({ cause: "login", login: "cred-b", from: "cred-a" })
        // The headers still on the request, as when this hook runs before the auth plugin's.
        yield* plugin.send("ses_1", body("Friday", 5), { login: "cred-a", kept: true })
        yield* plugin.ended("ses_1", "msg_3", 0, 42_000)
        expect(ledger.lines[2]).toMatchObject({ cause: "login", login: "cred-a", from: "cred-b" })
        // A title request's placement is not joined to the next conversation request.
        yield* plugin.send("ses_1", { messages: [{ role: "user", content: "name this" }] }, { kind: "title", login: "cred-z" })
        yield* plugin.send("ses_1", body("Friday", 7), { login: "cred-a" })
        yield* plugin.ended("ses_1", "msg_4", 0, 43_000)
        expect(ledger.lines[3]).toMatchObject({ cause: "unchanged", login: "cred-a" })
      }),
    ))

  test("a compaction's request and the request after it are compaction misses; a title request and a failed step write nothing", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const plugin = yield* start(ledger)
        yield* plugin.send("ses_1", body("Friday", 3))
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        yield* plugin.send("ses_1", { messages: [{ role: "user", content: "name this" }] }, { kind: "title" })
        // A step that fails leaves the request before as the reference.
        yield* plugin.send("ses_1", body("Saturday", 5))
        yield* plugin.emit("session.step.failed", { sessionID: "ses_1" })
        yield* plugin.send("ses_1", { ...body("Friday", 3), messages: [{ role: "user", content: "summarize" }] }, { kind: "compaction" })
        yield* plugin.emit("session.compaction.ended", { sessionID: "ses_1", tokens: plugin.usage(0, 30_000) })
        yield* plugin.send("ses_1", { ...body("Friday", 1), messages: [{ role: "user", content: "the summary" }] })
        yield* plugin.ended("ses_1", "msg_2", 0, 35_000)
        expect(ledger.lines.map((line) => [line.kind, line.messageID, line.cause])).toEqual([
          ["primary", "msg_1", "first"],
          ["compaction", undefined, "compaction"],
          ["primary", "msg_2", "compaction"],
        ])
      }),
    ))

  test("a ledger that cannot be written still answers the TUI", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        ledger.broken = true
        const plugin = yield* start(ledger)
        yield* plugin.send("ses_1", body("Friday", 1))
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        expect(ledger.lines).toEqual([])
        expect((yield* plugin.steps({ sessionID: "ses_1" })).steps).toEqual([{ messageID: "msg_1", cause: "first" }])
      }),
    ))
})
