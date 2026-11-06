// The plugin seam: the composition root on a stand-in host over the memory
// doubles. It checks what OpenCode sees: the four direct tools, their answers
// and refusals, the RPC's pending list and `due`, a `changed` event per change,
// a fire reaching the session, a notice leaving once its message was taken, a
// deleted session's wakes going, the start arming what was stored, and a
// latch kept over the RPC and opened through the opener.
// tests/wake.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import type { Tool } from "@opencode/plugin/effect"
import { Effect, Exit, Layer, Queue, Schema, type Scope, Stream } from "effect"
import { Latched } from "@dotfiles/opencode-wake/latch"
import { alarm, latch } from "@dotfiles/opencode-wake/laws"
import * as MemoryBackstop from "@dotfiles/opencode-wake/memory/backstop"
import * as MemoryChecks from "@dotfiles/opencode-wake/memory/checks"
import * as MemoryCourier from "@dotfiles/opencode-wake/memory/courier"
import * as MemoryOpener from "@dotfiles/opencode-wake/memory/opener"
import * as MemoryRunner from "@dotfiles/opencode-wake/memory/runner"
import * as MemoryStore from "@dotfiles/opencode-wake/memory/store"
import { Armed, Cancelled, Due, Pending, WAKES } from "@dotfiles/opencode-wake/wake"
import WakePlugin, { make, SCHEDULE_TOOLS } from "./server.ts"

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
/** Waits, a few ms at a time, until `done` holds or `ms` pass. */
const until = (done: () => boolean, ms = 3_000) =>
  Effect.gen(function* () {
    const by = Date.now() + ms
    while (!done() && Date.now() < by) yield* settle(10)
  })

interface Doubles {
  readonly store: MemoryStore.MemoryWakes
  readonly sessions: MemoryCourier.MemorySessions
  readonly jobs: MemoryBackstop.MemoryJobs
  readonly checks: MemoryChecks.MemoryChecks
  readonly opener: MemoryOpener.MemoryOpener
  readonly runner: MemoryRunner.MemoryRunner
}

/** The plugin started on a stand-in host over the doubles. */
const start = (
  doubles: Doubles = { store: MemoryStore.empty(), sessions: MemoryCourier.empty("ses_root", "ses_child"), jobs: MemoryBackstop.empty(), checks: MemoryChecks.empty(), opener: MemoryOpener.empty(), runner: MemoryRunner.empty() },
  options: unknown = { backstop: "off" },
) =>
  Effect.gen(function* () {
    doubles.sessions.parents.set("ses_child", "ses_root")
    const rpc: Record<string, Record<string, Handler>> = {}
    const emitted: Array<readonly [string, unknown]> = []
    const events = yield* Queue.unbounded<Event>()
    const added = new Map<string, Added>()
    // The registry's built-in tools before the transform: OpenCode's schedule tools beside one that stays.
    const builtin = new Set<string>(["shell", ...SCHEDULE_TOOLS])
    const host = {
      options,
      location: { directory: DIR },
      tool: {
        transform: (callback: (editor: { add: (tool: Added) => void; remove: (id: string) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void added.set(tool.name, tool), remove: (id) => void builtin.delete(id) })
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
      Layer.mergeAll(
        MemoryStore.layer(doubles.store),
        MemoryCourier.layer(doubles.sessions),
        MemoryChecks.layer(doubles.checks),
        MemoryBackstop.layer(doubles.jobs),
        MemoryOpener.layer(doubles.opener),
        MemoryRunner.layer(doubles.runner),
      ),
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
    const latched = (input: unknown) => method("latch", input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Latched)), Effect.orDie)
    const cancel = (input: unknown) => method("cancel", input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Cancelled)), Effect.orDie)
    const set = (input: unknown) => method("set", input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Armed)), Effect.orDie)
    const inbox = (sessionID = "ses_root") => doubles.sessions.inboxes.get(sessionID) ?? []
    return { added, builtin, call, fail, pending, due, latched, cancel, set, inbox, emitted, emit: (event: Event) => Queue.offer(events, event).pipe(Effect.andThen(settle())), doubles }
  })

describe("the wake tools", () => {
  test("are five direct tools", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect([...plugin.added.keys()]).toEqual(["wake", "monitor", "wake_cancel", "wake_list", "job"])
        for (const tool of plugin.added.values()) expect(tool.options).toEqual({ codemode: false })
        expect(plugin.added.get("wake")?.description).toContain("even if no OpenCode server is running")
      }),
    ))

  test("take OpenCode's schedule tools out of the registry, leaving the other built-in tools", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect([...plugin.builtin]).toEqual(["shell"])
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
        expect(yield* plugin.call("wake_list", {})).toContain("No alarms, monitors or latches pending.")
      }),
    ))

  test("the tray's cancel RPC cancels one entry as wake_cancel does, and says why it refuses", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("wake", { afterSeconds: 600, note: "later" })
        yield* plugin.call("wake", { afterSeconds: 900, note: "kept" })
        const [first, second] = (yield* plugin.pending("ses_root")).entries
        const before = plugin.emitted.length
        expect(yield* plugin.cancel({ sessionID: "ses_root", id: first?.id ?? "" })).toEqual({ outcome: "cancelled", ids: [first?.id ?? ""] })
        expect((yield* plugin.pending("ses_root")).entries.map((entry) => entry.note)).toEqual(["kept"])
        expect(plugin.emitted.slice(before)).toContainEqual(["changed", { sessionID: "ses_root" }])
        expect(yield* plugin.cancel({ sessionID: "ses_root", id: "w000000" })).toEqual({
          outcome: "refused",
          reason: `No pending wake w000000 in this session. Pending: ${second?.id}.`,
        })
        expect(yield* plugin.cancel({ sessionID: "ses_root" })).toMatchObject({ outcome: "refused" })
      }),
    ))

  test("the set RPC sets an alarm or a repeating monitor for a session as its tool would, and refuses what the tool refuses", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const alarm = yield* plugin.set({ sessionID: "ses_root", wake: { afterSeconds: 3600, note: "Read /tmp/p.md and do it." } })
        const monitor = yield* plugin.set({
          sessionID: "ses_root",
          monitor: { command: "gh pr view 7", intervalSeconds: 900, timeoutSeconds: 3 * 86_400, repeat: "change", baseline: "7 OPEN", note: "Reviews changed." },
        })
        expect(alarm).toMatchObject({ outcome: "set" })
        expect(monitor).toMatchObject({ outcome: "set" })
        const entries = (yield* plugin.pending("ses_root")).entries
        expect(entries.map((entry) => [entry.kind, entry.note, entry.repeat])).toEqual([
          ["alarm", "Read /tmp/p.md and do it.", undefined],
          ["monitor", "Reviews changed.", "change"],
        ])
        expect(plugin.emitted).toContainEqual(["changed", { sessionID: "ses_root" }])
        expect(yield* plugin.set({ sessionID: "ses_child", wake: { afterSeconds: 60, note: "n" } })).toMatchObject({ outcome: "refused", reason: expect.stringContaining("Wait in a background shell") })
        expect(yield* plugin.set({ sessionID: "ses_root", monitor: { command: "true", repeat: "match", baseline: "x", note: "n" } })).toEqual({
          outcome: "refused",
          reason: 'a baseline is for repeat: "change"',
        })
        expect(yield* plugin.set({ sessionID: "ses_root" })).toMatchObject({ outcome: "refused", reason: expect.stringContaining("not a wake or a monitor") })
      }),
    ))

  test("a repeating monitor wakes the session on each change with a short letter, and stays pending", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        plugin.doubles.checks.answers.set("gh pr list", [MemoryChecks.check(0, "7 REVIEW_REQUIRED"), MemoryChecks.check(0, "7 APPROVED"), MemoryChecks.check(0, "7 APPROVED")])
        const receipt = yield* plugin.call("monitor", { command: "gh pr list", intervalSeconds: 1, repeat: "change", note: "A review changed." })
        expect(receipt).toContain("fires each time its matching output changes")
        expect(receipt).toContain("the first match is the baseline")
        yield* until(() => plugin.inbox().length > 0)
        const [letter] = plugin.inbox()
        expect(letter?.resume).toBe(true)
        expect(letter?.letter.text).toMatch(/^⏰ Monitor w[0-9a-z]{6} changed \(fire 1\): `gh pr list`\./)
        expect(letter?.letter.text).toContain("Note: A review changed.\nOutput (exit 0):\n7 APPROVED")
        expect((yield* plugin.pending("ses_root")).entries.map((entry) => entry.kind)).toEqual(["monitor"])
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
        const doubles = { store: MemoryStore.empty(), sessions: MemoryCourier.empty("ses_root"), jobs: MemoryBackstop.empty(), checks: MemoryChecks.empty(), opener: MemoryOpener.empty(), runner: MemoryRunner.empty() }
        const now = Date.now()
        doubles.store.entries.set(alarm.id, { ...alarm, sessionID: "ses_root", directory: DIR, setAt: now - 3 * 3600_000, dueAt: now - 2 * 3600_000 })
        const plugin = yield* start(doubles)
        expect(plugin.inbox()[0]?.letter.text).toContain("It fired 2h late: no OpenCode server was running at")
        expect(yield* plugin.due(alarm.id)).toEqual({ outcome: "gone" })
        expect(yield* plugin.due("not an id")).toEqual({ outcome: "gone" })
      }),
    ))

  test("latch keeps a held start for its parent, lists it, and opens it through the opener at its time", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        plugin.doubles.opener.answer = () => ({ outcome: "opened" })
        const now = Date.now()
        const ask = { sessionID: "ses_root", subagent: latch.subagent, hold: "pace", reason: latch.reason, opensAt: now + 200, recheckAt: now + 200, context: {} }
        const answer = yield* plugin.latched(ask)
        if (answer.outcome !== "latched") return yield* Effect.die(new Error(answer.reason))
        expect((yield* plugin.pending("ses_root")).entries.map((entry) => [entry.kind, entry.note, entry.child])).toEqual([["latch", "Add the export", answer.child]])
        expect(yield* plugin.call("wake_list", {})).toContain(`- ${answer.id}: latch`)
        // The wakes look again no sooner than MIN_RECHECK_MS (1 s) after a latch.
        yield* until(() => plugin.doubles.opener.asked.length > 0)
        yield* settle()
        expect(plugin.doubles.opener.asked.map((asked) => asked.id)).toEqual([answer.id])
        expect((yield* plugin.pending("ses_root")).entries).toEqual([])
        expect(yield* plugin.latched({ sessionID: "ses_root" })).toMatchObject({ outcome: "refused" })
      }),
    ))

  test("a malformed option stops the plugin, naming it", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(start(undefined, { backstop: "launchd" })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("dotfiles-opencode.wake: invalid options")
  })
})

describe("the job tool", () => {
  test("runs a job, lists it, and its end steers a letter with the exit code, log tail and note into the session", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const receipt = yield* plugin.call("job", { command: "bun test", note: "Read the failures.", heavy: true })
        const id = /^Job (j[0-9a-z]{6}) started\. Log: (\S+)/.exec(receipt)?.[1] ?? ""
        expect(id).not.toBe("")
        expect(receipt).toContain("niced")
        expect(receipt).toContain("$JOB_DRIP")
        expect(plugin.doubles.runner.jobs.get(id)?.spec).toMatchObject({ command: "bun test", cwd: DIR, heavy: true, sessionID: "ses_root" })
        expect(yield* plugin.call("job", { action: "list" })).toContain(`- ${id}: `)
        expect(plugin.emitted).toContainEqual(["changed", { sessionID: "ses_root" }])

        const job = plugin.doubles.runner.jobs.get(id)
        if (job !== undefined) job.log = "2 pass\n1 fail\n"
        MemoryRunner.ended(plugin.doubles.runner, id, 1, Date.now())
        expect(yield* plugin.due(id)).toEqual({ outcome: "fired" })
        const [letter] = plugin.inbox()
        expect(letter?.resume).toBe(true)
        expect(letter?.letter.text).toContain(`Job ${id} `)
        expect(letter?.letter.text).toContain("1 fail")
        expect(letter?.letter.text).toContain("Note: Read the failures.")
        expect(yield* plugin.due(id)).toEqual({ outcome: "gone" })
        expect(yield* plugin.call("job", { action: "list" })).toBe("No jobs are running or waiting to report in this session.")
      }),
    ))

  test("wait and kill take a job's end themselves, so no letter follows; check leaves it", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const idOf = (receipt: string) => /^Job (j[0-9a-z]{6})/.exec(receipt)?.[1] ?? ""
        const waited = idOf(yield* plugin.call("job", { command: "make", note: "n" }))
        MemoryRunner.ended(plugin.doubles.runner, waited, 0, Date.now())
        expect(yield* plugin.call("job", { action: "check", id: waited })).toContain(`Job ${waited} `)
        expect(yield* plugin.call("job", { action: "wait", id: waited, ms: 1000 })).toContain(`Job ${waited} `)
        const killed = idOf(yield* plugin.call("job", { command: "sleep 99", note: "n" }))
        expect(yield* plugin.call("job", { action: "kill", id: killed })).toContain(`Job ${killed} `)
        expect(plugin.doubles.runner.killed).toEqual([killed])
        yield* settle(50)
        expect(yield* plugin.due(waited)).toEqual({ outcome: "gone" })
        expect(yield* plugin.due(killed)).toEqual({ outcome: "gone" })
        expect(plugin.inbox()).toEqual([])
      }),
    ))

  test("refuses a run without a command or note, an action without an id, and a launch the runner refuses", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.fail("job", { note: "n" })).toContain("needs a command and a note")
        expect(yield* plugin.fail("job", { action: "kill" })).toContain("needs the job's id")
        plugin.doubles.runner.refusing = "no bun"
        expect(yield* plugin.fail("job", { command: "true", note: "n" })).toBe("the job did not start: no bun")
        expect(yield* plugin.call("job", { action: "list" })).toBe("No jobs are running or waiting to report in this session.")
      }),
    ))
})
