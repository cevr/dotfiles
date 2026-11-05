// The plugin seam: the composition root on a stand-in host, over the memory
// store and the file store. It checks what OpenCode sees: the queue tool's
// answers and refusals, the RPC's answer after a call, a subagent's queue kept
// apart from its parent's, and a deleted session's queue going.
// tests/queue.test.ts runs it in OpenCode, directly and from a kernel cell.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool } from "@opencode/plugin/effect"
import { Effect, Queue, Schedule, Schema, type Scope, Stream } from "effect"
import * as MemoryStore from "@dotfiles/opencode-queue/memory/store"
import { QUEUE, type QueueInput, Snapshot } from "@dotfiles/opencode-queue/queue"
import { fileOf } from "@dotfiles/opencode-queue/filestore/store"
import QueuePlugin, { live, make, Options } from "./server.ts"

type Host = Parameters<(typeof QueuePlugin)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown>

/** The queue tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (input: QueueInput, context: unknown) => Effect.Effect<{ readonly content: ReadonlyArray<Tool.Content> }, Tool.Error>
}

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** The plugin started on a stand-in host: the tool it added, a call of it per session, its RPC, and a session deletion. */
const start = (options: Record<string, unknown> = {}, externals: Parameters<typeof make>[0] = () => MemoryStore.layer(MemoryStore.empty())) =>
  Effect.gen(function* () {
    const rpc: Record<string, Record<string, Handler>> = {}
    const deletions = yield* Queue.unbounded<{ readonly type: "session.deleted"; readonly data: { readonly sessionID: string } }>()
    let added: Added | undefined
    const host = {
      options,
      tool: {
        transform: (callback: (editor: { add: (tool: Added) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void (added = tool) })
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(deletions) },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    } as unknown as Host
    yield* make(externals).effect(host)
    const tool = added
    if (tool === undefined) return yield* Effect.die(new Error("the queue tool was not added"))
    const handler = rpc[QUEUE.id]?.get
    if (handler === undefined) return yield* Effect.die(new Error(`not registered: ${QUEUE.id}`))
    const execute = (input: QueueInput, sessionID = "ses_root") =>
      tool.execute(input, { sessionID, agent: "build", messageID: "msg_1", id: "call_1", progress: () => Effect.void })
    const call = (input: QueueInput, sessionID?: string) =>
      execute(input, sessionID).pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")))
    const fail = (input: QueueInput, sessionID?: string) => Effect.flip(execute(input, sessionID)).pipe(Effect.map((error) => error.message))
    const get = (sessionID: string) => handler({ sessionID }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)), Effect.orDie)
    const deleteSession = (sessionID: string) => Queue.offer(deletions, { type: "session.deleted", data: { sessionID } })
    return { tool, call, fail, get, deleteSession }
  })

describe("the options", () => {
  test("dir defaults under the state directory", () => {
    const decode = Schema.decodeUnknownSync(Options)
    expect(decode({}).dir).toEndWith("/opencode-queue")
    expect(decode({ dir: undefined }).dir).toEndWith("/opencode-queue")
    expect(decode({ dir: "/q" })).toEqual({ dir: "/q" })
  })

  test("a malformed option stops the plugin and says which", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ dir: 7 }))))
    const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
    const message = reason?._tag === "Die" && reason.defect instanceof Error ? reason.defect.message : ""
    expect(message).toStartWith("dotfiles-opencode.queue: invalid options: ")
    expect(message).toContain('at ["dir"]')
  })
})

describe("the queue tool", () => {
  test("is a direct tool named queue that tells the agent to link subagent sessions", () =>
    scenario(
      Effect.gen(function* () {
        const { tool } = yield* start()
        expect(tool.name).toBe("queue")
        expect(tool.options).toEqual({ codemode: false })
        expect(tool.description).toContain("session set to its sessionID")
        expect(tool.description).toContain("Prefer a patch")
      }),
    ))

  test("a call answers the queue, and the RPC answers it with a new revision", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.get("ses_root")).toEqual({ revision: 0, items: [] })
        expect(
          yield* plugin.call({
            set: [
              { id: "pool", text: "Sidebar pool worker", state: "running", session: "ses_child" },
              { id: "panes", text: "Close old Claude panes", state: "needs-you" },
            ],
          }),
        ).toBe("Queue (2):\n● pool [running]: Sidebar pool worker · session ses_child\n! panes [needs-you]: Close old Claude panes")
        const first = yield* plugin.get("ses_root")
        expect(first.revision).toBe(1)
        expect(first.items.map((item) => [item.id, item.state])).toEqual([
          ["pool", "running"],
          ["panes", "needs-you"],
        ])
        yield* plugin.call({ upsert: [{ id: "panes", state: "done" }] })
        const second = yield* plugin.get("ses_root")
        expect(second.revision).toBe(2)
        expect(second.items[1]?.state).toBe("done")
        expect(second.items[1]?.doneAt).toBeNumber()
        // The same change again changes nothing, and the revision stays.
        yield* plugin.call({ upsert: [{ id: "panes", state: "done" }] })
        expect((yield* plugin.get("ses_root")).revision).toBe(2)
      }),
    ))

  test("a subagent's calls keep its own queue, never its parent's", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ set: [{ id: "a", text: "Parent's", state: "next" }] })
        yield* plugin.call({ set: [{ id: "b", text: "Child's", state: "running" }] }, "ses_child")
        expect((yield* plugin.get("ses_root")).items.map((item) => item.id)).toEqual(["a"])
        expect((yield* plugin.get("ses_child")).items.map((item) => item.id)).toEqual(["b"])
      }),
    ))

  test("a refused change is a tool error that says why, and changes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call({ set: [{ id: "a", text: "A", state: "next" }] })
        expect(yield* plugin.fail({ upsert: [{ id: "a", state: "blocked" }] })).toBe(
          'Item "a": unknown state "blocked". Use one of: needs-you, running, waiting, scheduled, next, done.',
        )
        expect(yield* plugin.fail({ remove: ["gone"] })).toBe('No item "gone" to remove. The queue holds: a.')
        expect(yield* plugin.fail({})).toBe("Nothing changed: give set, or upsert and/or remove.")
        expect(yield* plugin.get("ses_root")).toEqual({ revision: 1, items: [{ id: "a", text: "A", state: "next", owner: "mine" }] })
      }),
    ))

  test("calls at once each see the other's change", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* Effect.all(
          ["a", "b", "c", "d"].map((id) => plugin.call({ upsert: [{ id, text: id, state: "next" }] })),
          { concurrency: "unbounded" },
        )
        const snapshot = yield* plugin.get("ses_root")
        expect(snapshot.revision).toBe(4)
        expect(snapshot.items.map((item) => item.id).sort()).toEqual(["a", "b", "c", "d"])
      }),
    ))
})

describe("on the file store", () => {
  const scratch = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "queue-plugin-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

  test("a queue survives a restart, and a deleted session's queue goes", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const first = yield* start({ dir }, live)
        yield* first.call({ set: [{ id: "a", text: "A", state: "scheduled", at: "2026-11-04T22:07:00Z" }] })
        const again = yield* start({ dir }, live)
        expect(yield* again.get("ses_root")).toEqual({
          revision: 1,
          items: [{ id: "a", text: "A", state: "scheduled", owner: "mine", at: "2026-11-04T22:07:00.000Z" }],
        })
        yield* again.deleteSession("ses_root")
        // The deletion is handled in the background: wait for the file to go.
        yield* Effect.suspend(() => (existsSync(fileOf(dir, "ses_root")) ? Effect.fail("present") : Effect.void)).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        )
        expect(existsSync(fileOf(dir, "ses_root"))).toBe(false)
      }),
    ))

  test("set replaces a queue file that does not decode; a patch reports it", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const plugin = yield* start({ dir }, live)
        yield* Effect.promise(() => Bun.write(fileOf(dir, "ses_root"), "{ broken"))
        expect(yield* plugin.fail({ remove: ["a"] })).toStartWith(`The queue could not be read: ${fileOf(dir, "ses_root")}: `)
        yield* plugin.call({ set: [{ id: "a", text: "A", state: "next" }] })
        expect((yield* plugin.get("ses_root")).items.map((item) => item.id)).toEqual(["a"])
      }),
    ))
})

