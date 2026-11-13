// The plugin seam: the cache mod's server plugin on a stand-in host whose
// request hook and events the test drives, the ledger in memory, on the test
// clock. Each primary or compaction request a session sends becomes one ledger
// line once its step ends, judged against the request before: first, a hit,
// a changed prefix naming its first changed segment, an expiry, a pool login
// move, a compaction; a failed step writes nothing, and a broken ledger still
// answers the TUI's RPC. tests/cache.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, PubSub, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { PingLine } from "@dotfiles/opencode-cache/keepalive"
import * as MemoryPings from "@dotfiles/opencode-cache/memory/ping-log"
import * as MemoryPinger from "@dotfiles/opencode-cache/memory/pinger"
import * as Memory from "@dotfiles/opencode-cache/memory/request-log"
import type { SessionSteps } from "@dotfiles/opencode-cache/request-log"
import { PingFailed } from "@dotfiles/opencode-cache/service"
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

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A one-token answer as Anthropic streams it, with a rate-limit header. */
const STREAMED: MemoryPinger.MemoryNetwork["answer"] = () =>
  Effect.succeed({
    status: 200,
    headers: [
      ["content-type", "text/event-stream"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.4"],
      ["request-id", "req_1"],
    ],
    text: [
      "event: message_start",
      `data: ${json({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0, output_tokens: 1 } } })}`,
      "",
      "event: message_delta",
      `data: ${json({ type: "message_delta", usage: { output_tokens: 1 } })}`,
      "",
    ].join("\n"),
  })

/** The stand-in network, answering every ping with `STREAMED`. */
const network = (): MemoryPinger.MemoryNetwork => {
  const net = MemoryPinger.make()
  net.answer = STREAMED
  return net
}

const start = (ledger: Memory.MemoryLedger, net: MemoryPinger.MemoryNetwork = network(), pings: Array<PingLine> = []) =>
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
        // A session named `ses_child…` is a subagent's; any other a root's.
        get: ({ sessionID }: { readonly sessionID: string }) =>
          Effect.succeed({ id: sessionID, parentID: Option.getOrUndefined(Option.liftPredicate("ses_root", () => sessionID.startsWith("ses_child"))) }),
      },
      // As the host does, a subscription hears only the types it names.
      event: {
        subscribe: ({ types }: { readonly types: ReadonlyArray<string> }) =>
          Stream.fromPubSub(events).pipe(Stream.filter((event) => types.includes(event.type))),
      },
      rpc: {
        register: (_definition: unknown, registered: Handlers) =>
          Effect.sync(() => {
            handlers = registered
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() => Layer.mergeAll(Memory.layer(ledger), MemoryPings.layer(pings), MemoryPinger.layer(net))).effect(host)
    yield* settle

    /**
     * A request goes out on the session, as OpenCode sends it: `model.request`, where the pool names its login and
     * lifetime in headers, then `http.request`, which the auth plugin reaches first and strips them from, unless
     * `kept` (this plugin's hook first, or no auth plugin).
     */
    const send = Effect.fn("CacheServerTest.send")(function* (
      sessionID: string,
      json: unknown,
      options: {
        readonly kind?: string
        readonly login?: string
        readonly ttl?: string
        readonly kept?: boolean
        /** Headers on the request as the hook sees it: the auth plugin's signing, when its hook ran first. */
        readonly headers?: Record<string, string>
      } = {},
    ) {
      const scope = { sessionID, agent: "build", model: { providerID: "anthropic", id: "claude-x" }, kind: options.kind ?? "primary" }
      const pool: Record<string, string> = {}
      if (options.login !== undefined) pool[CREDENTIAL_HEADER] = options.login
      if (options.ttl !== undefined) pool[CACHE_TTL_HEADER] = options.ttl
      for (const callback of hooks["model.request"] ?? []) yield* callback({ ...scope, headers: { ...pool } })
      const headers = new Headers({ "content-type": "application/json", ...(options.kept === true ? pool : {}), ...options.headers })
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

  // The ledger, 2026-11-09 10:58:29: with background compaction on, a planner's background summary went out while
  // its next step was in flight, and the step's end was written as the summary's line, a `hit` on the step's usage,
  // while the step itself got no line.
  test("a background summary sent while a step is in flight: the step is judged on its usage, the summary on its own", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const plugin = yield* start(ledger)
        yield* plugin.send("ses_1", body("Friday", 3))
        yield* plugin.ended("ses_1", "msg_1", 0, 40_000)
        yield* TestClock.adjust(MINUTE)
        yield* plugin.send("ses_1", body("Friday", 5))
        // The host summarizes everything before the latest response in the background: the step's prefix, then its prompt.
        yield* plugin.send("ses_1", { ...body("Friday", 3), messages: [...body("Friday", 3).messages, { role: "user", content: "summarize" }] }, { kind: "compaction" })
        yield* plugin.ended("ses_1", "msg_2", 40_000, 2_000)
        yield* TestClock.adjust(MINUTE)
        yield* plugin.send("ses_1", body("Friday", 7))
        yield* plugin.ended("ses_1", "msg_3", 42_000, 2_000)
        // Later the automatic compaction swaps the held summary in, billed what its request cost.
        yield* TestClock.adjust(MINUTE)
        yield* plugin.emit("session.compaction.ended", { sessionID: "ses_1", tokens: plugin.usage(40_000, 1_000) })
        yield* plugin.send("ses_1", { ...body("Friday", 1), messages: [{ role: "user", content: "the summary" }] })
        yield* plugin.ended("ses_1", "msg_4", 0, 5_000)
        expect(ledger.lines.map((line) => [line.kind, line.messageID, line.cause, line.read])).toEqual([
          ["primary", "msg_1", "first", 0],
          ["primary", "msg_2", "hit", 40_000],
          ["primary", "msg_3", "hit", 42_000],
          ["compaction", undefined, "hit", 40_000],
          ["primary", "msg_4", "compaction", 0],
        ])
        // The summary is judged against the request before it went out, the way its cache was read.
        expect(ledger.lines[3]?.gapMs).toBe(MINUTE)
      }),
    ))

  // The ledger, 2026-11-08 00:38:55: a build session's first request after a restart read 12,952 of
  // 198,763 tokens, and the line said only `first`: the request before it was the old process's.
  test("after a restart, a session's first request is judged against the last request the old process sent", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const before = yield* start(ledger)
        yield* before.send("ses_1", body("Friday", 1), { login: "cred-a" })
        yield* before.ended("ses_1", "msg_1", 0, 40_000)
        yield* TestClock.adjust(MINUTE)
        // The server restarts: a new copy of the plugin, the same ledger.
        const after = yield* start(ledger)
        yield* after.send("ses_1", body("Saturday", 3), { login: "cred-a" })
        yield* after.ended("ses_1", "msg_2", 300, 42_000)
        yield* TestClock.adjust(MINUTE)
        yield* after.send("ses_1", body("Saturday", 5), { login: "cred-b" })
        yield* after.ended("ses_1", "msg_3", 0, 44_000)
        yield* TestClock.adjust(MINUTE)
        // A session it never saw is still first.
        yield* after.send("ses_2", body("Saturday", 1))
        yield* after.ended("ses_2", "msg_4", 0, 40_000)
        expect(ledger.lines.map((line) => [line.messageID, line.cause, line.gapMs, line.restored])).toEqual([
          ["msg_1", "first", undefined, undefined],
          ["msg_2", "prefix", MINUTE, true],
          ["msg_3", "login", MINUTE, undefined],
          ["msg_4", "first", undefined, undefined],
        ])
        expect(ledger.lines[1]?.change).toMatchObject({ segment: "system[1] ¶2", head: "Today is Saturday." })
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

/** An Anthropic body on the five-minute cache, as a subagent's turn sends it, ending on the tool call's turn. */
const shortBody = (turns: number) => ({
  model: "claude-x",
  max_tokens: 32_000,
  stream: true,
  thinking: { type: "adaptive", display: "omitted" },
  tools: TOOLS,
  system: [{ type: "text", text: "You are a worker.", cache_control: { type: "ephemeral" } }],
  messages: body("Friday", turns).messages,
})

/** The headers the auth plugin's hook leaves on a request it signed. */
const SIGNED = { authorization: "Bearer sk-ant-oat-test", "anthropic-beta": "oauth-2025-04-20", "content-length": "999" }

const SECOND = 1_000
const PING = 270 * SECOND
const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("the keepalive", () => {
  const called = (sessionID: string, id: string, executed = false) =>
    ["session.tool.called", { sessionID, assistantMessageID: "msg_1", id, input: {}, executed }] as const
  const returned = (sessionID: string, id: string, type: "session.tool.success" | "session.tool.failed" = "session.tool.success") =>
    [type, { sessionID, assistantMessageID: "msg_1", id }] as const
  /** Moves the test clock on, then lets the pings it set off run. */
  const pass = (ms: number) => TestClock.adjust(ms).pipe(Effect.andThen(settle))

  test("a subagent waiting on a tool: its last request again at max_tokens 1, 4.5 minutes on and every 4.5 after, 4 at most, the answers kept out of the session", () =>
    onTestClock(
      Effect.gen(function* () {
        const ledger = Memory.make()
        const net = network()
        const pings: Array<PingLine> = []
        const plugin = yield* start(ledger, net, pings)
        yield* plugin.send("ses_child", shortBody(3), { login: "cred-a", headers: SIGNED })
        yield* plugin.ended("ses_child", "msg_1", 80_000, 10_000)
        yield* plugin.emit(...called("ses_child", "call_1"))
        yield* pass(PING - SECOND)
        expect(net.received).toHaveLength(0)
        yield* pass(SECOND)
        expect(net.received).toHaveLength(1)
        for (const _ of [2, 3, 4]) yield* pass(PING)
        expect(net.received).toHaveLength(4)
        yield* pass(20 * 60 * SECOND)
        expect(net.received).toHaveLength(4)

        // Each ping is the request as it went out, at max_tokens 1, but its length.
        const sent = net.received.map((ping) => {
          const headers = new Headers(ping.headers.map(([name, value]) => [name, value]))
          return [ping.url, ping.method, headers.has("content-length"), headers.get("authorization"), headers.get("anthropic-beta"), parsed(ping.body)]
        })
        expect(sent).toEqual(
          Array.from({ length: 4 }, () => [
            "https://api.anthropic.com/v1/messages",
            "POST",
            false,
            "Bearer sk-ant-oat-test",
            "oauth-2025-04-20",
            { ...shortBody(3), max_tokens: 1 },
          ]),
        )

        expect(pings.map((line) => [line.sessionID, line.ping, line.gapMs, line.status, line.read, line.write])).toEqual([
          ["ses_child", 1, PING, Option.some(200), 90_000, 0],
          ["ses_child", 2, PING, Option.some(200), 90_000, 0],
          ["ses_child", 3, PING, Option.some(200), 90_000, 0],
          ["ses_child", 4, PING, Option.some(200), 90_000, 0],
        ])
        expect(pings[0]).toMatchObject({
          host: "mac",
          agent: Option.some("build"),
          model: "anthropic/claude-x",
          login: Option.some("cred-a"),
          ttlMs: 300_000,
          input: 3,
          output: 1,
          limits: { "anthropic-ratelimit-unified-5h-utilization": "0.4" },
        })
        // The answers never reach the session: no ledger line and no step beyond the request's own.
        expect(ledger.lines.map((line) => line.messageID)).toEqual(["msg_1"])
        expect((yield* plugin.steps({ sessionID: "ses_child" })).steps.map((step) => step.messageID)).toEqual(["msg_1"])
      }),
    ))

  test("the tool's return ends the wait at once, a ping in flight aborted; so do the next request and the execution's end", () =>
    onTestClock(
      Effect.gen(function* () {
        const net = network()
        const plugin = yield* start(Memory.make(), net)
        yield* plugin.send("ses_child", shortBody(3), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_1"))
        yield* pass(PING)
        expect(net.received).toHaveLength(1)
        yield* plugin.emit(...returned("ses_child", "call_1"))
        yield* pass(20 * 60 * SECOND)
        expect(net.received).toHaveLength(1)

        // A ping that hangs is aborted when the tool returns.
        net.answer = () => Effect.never
        yield* plugin.send("ses_child", shortBody(5), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_2"))
        yield* pass(PING)
        expect(net.received).toHaveLength(2)
        yield* plugin.emit(...returned("ses_child", "call_2", "session.tool.failed"))
        expect(net.aborted).toHaveLength(1)

        // The next request ends a wait whose tool event never came; the execution's end ends another.
        net.answer = STREAMED
        yield* plugin.send("ses_child", shortBody(7), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_3"))
        yield* pass(PING - SECOND)
        yield* plugin.send("ses_child", shortBody(9), { headers: SIGNED })
        yield* pass(PING)
        expect(net.received).toHaveLength(2)
        yield* plugin.send("ses_child", shortBody(11), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_4"))
        yield* plugin.emit("session.execution.interrupted", { sessionID: "ses_child" })
        yield* pass(20 * 60 * SECOND)
        expect(net.received).toHaveLength(2)
      }),
    ))

  test("parallel calls are one wait, pinged until the last returns; the next wait counts its own 4", () =>
    onTestClock(
      Effect.gen(function* () {
        const net = network()
        const plugin = yield* start(Memory.make(), net)
        yield* plugin.send("ses_child", shortBody(3), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_a"))
        yield* plugin.emit(...called("ses_child", "call_b"))
        yield* pass(PING)
        yield* plugin.emit(...returned("ses_child", "call_a"))
        yield* pass(PING)
        expect(net.received).toHaveLength(2)
        // A third call in the same wait sends no ping past the wait's fourth.
        yield* plugin.emit(...called("ses_child", "call_c"))
        for (const _ of [3, 4, 5]) yield* pass(PING)
        expect(net.received).toHaveLength(4)
        yield* plugin.emit(...returned("ses_child", "call_b"))
        yield* plugin.emit(...returned("ses_child", "call_c"))
        yield* plugin.send("ses_child", shortBody(5), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_d"))
        for (const _ of [1, 2, 3, 4, 5]) yield* pass(PING)
        expect(net.received).toHaveLength(8)
      }),
    ))

  test("never a root session, an hour's cache, an unsigned request, a budgeted thinking body, a provider's own tool, or a cache already expired", () =>
    onTestClock(
      Effect.gen(function* () {
        const net = network()
        const plugin = yield* start(Memory.make(), net)
        const wait = (sessionID: string) => plugin.emit(...called(sessionID, "call_1")).pipe(Effect.andThen(pass(PING)), Effect.andThen(pass(PING)))
        yield* plugin.send("ses_root", shortBody(3), { headers: SIGNED })
        yield* wait("ses_root")
        yield* plugin.send("ses_child_hour", body("Friday", 3), { headers: SIGNED })
        yield* wait("ses_child_hour")
        yield* plugin.send("ses_child_unsigned", shortBody(3))
        yield* wait("ses_child_unsigned")
        yield* plugin.send("ses_child_budget", { ...shortBody(3), thinking: { type: "enabled", budget_tokens: 10_000 } }, { headers: SIGNED })
        yield* wait("ses_child_budget")
        yield* plugin.send("ses_child_hosted", shortBody(3), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child_hosted", "srv_1", true))
        yield* pass(PING)
        // A tool that starts once the cache has expired: a ping would only write a new one.
        yield* plugin.send("ses_child_late", shortBody(3), { headers: SIGNED })
        yield* pass(301 * SECOND)
        yield* wait("ses_child_late")
        expect(net.received).toHaveLength(0)
      }),
    ))

  test("a refused ping ends the wait, logged with its status; a ping with no answer is logged with its error", () =>
    onTestClock(
      Effect.gen(function* () {
        const net = network()
        const pings: Array<PingLine> = []
        const plugin = yield* start(Memory.make(), net, pings)
        net.answer = () => Effect.succeed({ status: 429, headers: [["anthropic-ratelimit-unified-status", "rejected"]], text: '{"type":"error"}' })
        yield* plugin.send("ses_child", shortBody(3), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_1"))
        for (const _ of [1, 2, 3]) yield* pass(PING)
        expect(net.received).toHaveLength(1)
        net.answer = () => Effect.fail(new PingFailed({ message: "network down" }))
        yield* plugin.send("ses_child", shortBody(5), { headers: SIGNED })
        yield* plugin.emit(...called("ses_child", "call_2"))
        for (const _ of [1, 2, 3]) yield* pass(PING)
        expect(net.received).toHaveLength(2)
        expect(pings.map((line) => [line.ping, Option.getOrElse(line.status, () => 0), Option.getOrElse(line.error, () => "answered"), line.read, line.limits])).toEqual([
          [1, 429, "answered", 0, { "anthropic-ratelimit-unified-status": "rejected" }],
          [1, 0, "network down", 0, {}],
        ])
      }),
    ))
})
