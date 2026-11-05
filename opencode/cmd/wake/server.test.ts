// The plugin seam: the composition root on a stand-in host over the memory
// doubles. It checks what OpenCode sees: the four direct tools, their answers
// and refusals, the RPC's pending list and `due`, a `changed` event per change,
// a fire reaching the session, a notice leaving once its message was taken, a
// deleted session's wakes going, and the start arming what was stored.
// tests/wake.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import type { Tool } from "@opencode/plugin/effect"
import { Effect, Exit, Layer, Queue, Schema, type Scope, Stream } from "effect"
import { alarm } from "@dotfiles/opencode-wake/laws"
import * as MemoryBackstop from "@dotfiles/opencode-wake/memory/backstop"
import * as MemoryChecks from "@dotfiles/opencode-wake/memory/checks"
import * as MemoryCourier from "@dotfiles/opencode-wake/memory/courier"
import * as MemoryStore from "@dotfiles/opencode-wake/memory/store"
import { Due, Pending, WAKES } from "@dotfiles/opencode-wake/wake"
import WakePlugin, { make } from "./server.ts"

type Host = Parameters<(typeof WakePlugin)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown>
type Event = { readonly type: "session.deleted"; readonly data: { readonly sessionID: string } } | { readonly type: "session.inbox.delivered"; readonly data: { readonly sessionID: string; readonly inboxID: string } }

/** A tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (input: unknown, context: unknown) => Effect.Effect<{ readonly content: ReadonlyArray<Tool.Content> }, Tool.Error>
}

const DIR = "/work/app"
const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const settle = (ms = 20) => Effect.promise(() => new Promise<void>((done) => setTimeout(done, ms)))

/** The plugin started on a stand-in host over the doubles. */
const start = (
  doubles = { store: MemoryStore.empty(), sessions: MemoryCourier.empty("ses_root", "ses_child"), jobs: MemoryBackstop.empty(), checks: MemoryChecks.empty() },
  options: unknown = { backstop: "off" },
) =>
  Effect.gen(function* () {
    doubles.sessions.parents.set("ses_child", "ses_root")
    const rpc: Record<string, Record<string, Handler>> = {}
    const emitted: Array<readonly [string, unknown]> = []
    const events = yield* Queue.unbounded<Event>()
    const added = new Map<string, Added>()
    const host = {
      options,
      location: { directory: DIR },
      tool: {
        transform: (callback: (editor: { add: (tool: Added) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void added.set(tool.name, tool) })
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(events) },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void, events: { emit: (name: string, data: unknown) => Effect.sync(() => void emitted.push([name, data])) } }
          }),
      },
    } as unknown as Host
    yield* make(() =>
      Layer.mergeAll(MemoryStore.layer(doubles.store), MemoryCourier.layer(doubles.sessions), MemoryChecks.layer(doubles.checks), MemoryBackstop.layer(doubles.jobs)),
    ).effect(host)
    yield* settle()
    const handlers = rpc[WAKES.id]
    if (handlers === undefined) return yield* Effect.die(new Error(`not registered: ${WAKES.id}`))
    const toolOf = (name: string) => {
      const tool = added.get(name)
      return tool === undefined ? Effect.die(new Error(`no tool ${name}`)) : Effect.succeed(tool)
    }
    const execute = (name: string, input: unknown, sessionID = "ses_root") =>
      toolOf(name).pipe(Effect.flatMap((tool) => tool.execute(input, { sessionID, agent: "build", messageID: "msg_1", id: "call_1", progress: () => Effect.void })))
    const call = (name: string, input: unknown, sessionID?: string) =>
      execute(name, input, sessionID).pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")))
    const fail = (name: string, input: unknown, sessionID?: string) => Effect.flip(execute(name, input, sessionID)).pipe(Effect.map((error) => error.message))
    const method = (name: string, input: unknown) => {
      const handler = handlers[name]
      return handler === undefined ? Effect.die(new Error(`no method ${name}`)) : handler(input)
    }
    const pending = (...sessionIDs: ReadonlyArray<string>) => method("pending", { sessionIDs }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pending)), Effect.orDie)
    const due = (id: string) => method("due", { id }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Due)), Effect.orDie)
    const inbox = (sessionID = "ses_root") => doubles.sessions.inboxes.get(sessionID) ?? []
    return { added, call, fail, pending, due, inbox, emitted, emit: (event: Event) => Queue.offer(events, event).pipe(Effect.andThen(settle())), doubles }
  })

describe("the wake tools", () => {
  test("are four direct tools", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect([...plugin.added.keys()]).toEqual(["wake", "monitor", "wake_cancel", "wake_list"])
        for (const tool of plugin.added.values()) expect(tool.options).toEqual({ codemode: false })
        expect(plugin.added.get("wake")?.description).toContain("even if no OpenCode server is running")
      }),
    ))

  test("wake answers at once, the tray's RPC lists it with a changed event, and it fires into the session with the note", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const receipt = yield* plugin.call("wake", { afterSeconds: 0.2, note: "Check CI run 42." })
        expect(receipt).toMatch(/^Alarm w[0-9a-z]{6} set: it wakes this session at /)
        expect(receipt).toContain("End your turn now")
        const listed = yield* plugin.pending("ses_root")
        expect(listed.entries.map((entry) => [entry.kind, entry.note])).toEqual([["alarm", "Check CI run 42."]])
        expect(plugin.emitted).toContainEqual(["changed", { sessionID: "ses_root" }])
        yield* settle(400)
        expect(plugin.inbox().map((message) => [message.resume, message.letter.text.split("\n").at(-1)])).toEqual([[true, "Note: Check CI run 42."]])
        expect((yield* plugin.pending("ses_root")).entries).toEqual([])
      }),
    ))

  test("a refusal is a tool error that says why; a subagent is refused", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.fail("wake", { note: "n" })).toBe("give afterSeconds (a number) or at (an ISO 8601 time)")
        expect(yield* plugin.fail("monitor", { command: "true", note: "n" }, "ses_child")).toContain("Wait in a background shell command instead")
        expect(yield* plugin.fail("wake_cancel", { id: "w000000" })).toBe("No pending wake w000000 in this session. Pending: none.")
      }),
    ))

  test("wake_list and wake_cancel", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("wake", { afterSeconds: 600, note: "later" })
        const listed = yield* plugin.call("wake_list", {})
        expect(listed).toContain("Pending (1):")
        const id = /- (w[0-9a-z]{6}): alarm/.exec(listed)?.[1] ?? ""
        expect(yield* plugin.call("wake_cancel", { id })).toBe(`Cancelled ${id}.`)
        expect(yield* plugin.call("wake_list", {})).toContain("No alarms or monitors pending.")
      }),
    ))
})

describe("the plugin's events and start", () => {
  test("a notify fire's notice shows until the session's turn takes its message", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("wake", { afterSeconds: 0, mode: "notify", note: "FYI" })
        yield* settle(100)
        const [message] = plugin.inbox()
        expect(message?.resume).toBe(false)
        expect((yield* plugin.pending("ses_root")).notices.map((notice) => notice.delivery)).toEqual([message?.id ?? ""])
        yield* plugin.emit({ type: "session.inbox.delivered", data: { sessionID: "ses_root", inboxID: message?.id ?? "" } })
        expect((yield* plugin.pending("ses_root")).notices).toEqual([])
      }),
    ))

  test("a deleted session's wakes go", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("wake", { afterSeconds: 600, note: "later" })
        yield* plugin.emit({ type: "session.deleted", data: { sessionID: "ses_root" } })
        expect((yield* plugin.pending("ses_root")).entries).toEqual([])
        expect(plugin.doubles.jobs.jobs.size).toBe(0)
      }),
    ))

  test("the start fires a stored wake that came due while no server ran; due then answers gone", () =>
    scenario(
      Effect.gen(function* () {
        const doubles = { store: MemoryStore.empty(), sessions: MemoryCourier.empty("ses_root"), jobs: MemoryBackstop.empty(), checks: MemoryChecks.empty() }
        const now = Date.now()
        doubles.store.entries.set(alarm.id, { ...alarm, sessionID: "ses_root", directory: DIR, setAt: now - 3 * 3600_000, dueAt: now - 2 * 3600_000 })
        const plugin = yield* start(doubles)
        expect(plugin.inbox()[0]?.letter.text).toContain("It fired 2h late: no OpenCode server was running at")
        expect(yield* plugin.due(alarm.id)).toEqual({ outcome: "gone" })
        expect(yield* plugin.due("not an id")).toEqual({ outcome: "gone" })
      }),
    ))

  test("a malformed option stops the plugin, naming it", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(start(undefined, { backstop: "launchd" })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("dotfiles-opencode.wake: invalid options")
  })
})
