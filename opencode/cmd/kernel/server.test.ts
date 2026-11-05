// The plugin seam: the composition root on a stand-in host, with the sessions
// in memory, the stored bindings in OpenCode's storage format over the
// stand-in's storage, and the workers live (the worker is this repo's own
// program, run in a scratch directory). It checks what
// OpenCode sees: the kernel tool's answers and errors, the storage entry, the
// runtime's description, the agents' rules and a deleted session's cleanup.
// tests/kernel.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tool } from "@opencode/plugin/effect"
import { Cause, Effect, Exit, Layer, Queue, Schema, type Scope, Stream } from "effect"
import type { Json } from "@dotfiles/opencode-kernel/frame"
import type { Reached, Rule } from "@dotfiles/opencode-kernel/tools"
import * as FileStoreFiles from "@dotfiles/opencode-kernel/filestore/files"
import * as MemorySessions from "@dotfiles/opencode-kernel/memory/sessions"
import * as OpenCodeSnapshots from "@dotfiles/opencode-kernel/opencode/snapshots"
import * as ProcessWorkers from "@dotfiles/opencode-kernel/worker/workers"
import Kernel, { make } from "./server.ts"

const work = mkdtempSync(join(tmpdir(), "kernel-plugin-"))

type Host = Parameters<(typeof Kernel)["effect"]>[0]

/** The kernel tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly execute: (input: { code: string; reset?: boolean }, context: unknown) => Effect.Effect<{ readonly content: string | ReadonlyArray<Tool.Content> }, Tool.Error>
  readonly options?: { readonly runtime?: { readonly describe: (tools: ReadonlyArray<Reached>) => string } }
}

/** The agent's other tools while the kernel is its runtime. */
interface Runtime {
  readonly tools: ReadonlyArray<Reached>
  readonly call: (name: string, input: unknown) => Effect.Effect<{ readonly output?: unknown }, Tool.Error>
}

/** A registered tool, shaped as the registry lists it. */
interface Listed {
  readonly id: string
  readonly description: string
  readonly input: unknown
  readonly execute: (input: never) => Effect.Effect<{ readonly content: string }, Tool.Error>
}

/** The outside systems' state for one test. */
interface World {
  readonly tools?: ReadonlyArray<Listed>
  /** The host knows no session, so none can be read. */
  readonly noSessions?: boolean
}

/**
 * The plugin started on a stand-in host: the kernel tool it added, a call of
 * it, the storage's entries, the build agent's rules, and a way to delete a
 * session.
 */
const start = (options: Record<string, unknown> = {}, world: World = {}) =>
  Effect.gen(function* () {
    const entries = new Map<string, Json>()
    const dropped = yield* Queue.unbounded<string>()
    const deletions = yield* Queue.unbounded<{ readonly type: "session.deleted"; readonly data: { readonly sessionID: string } }>()
    const agentRules: Array<Rule> = []
    let added: Added | undefined
    const host = {
      options,
      tool: {
        list: () => Effect.succeed([...(world.tools ?? []), { id: "kernel", description: "itself", input: {}, execute: () => Effect.die("not called") }]),
        transform: (callback: (editor: { add: (tool: Added) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void (added = tool) })
            return { dispose: Effect.void }
          }),
      },
      agent: {
        transform: (callback: (editor: unknown) => void) =>
          Effect.sync(() => {
            const agent = { id: "build", permissions: agentRules }
            callback({ list: () => [agent], update: (_id: string, update: (item: typeof agent) => void) => update(agent) })
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(deletions) },
    } as unknown as Host
    // The host's storage: JSON in, JSON out; a removal is reported once it is done.
    const snapshots = OpenCodeSnapshots.layer({
      get: (key) => Effect.sync(() => entries.get(key)),
      set: (key, value) => Effect.sync(() => void entries.set(key, JSON.parse(JSON.stringify(value)))),
      remove: (key) => Effect.sync(() => void entries.delete(key)).pipe(Effect.andThen(Queue.offer(dropped, key))),
    })
    yield* make((_ctx, decoded) =>
      Layer.mergeAll(
        ProcessWorkers.layer({ timeoutMs: decoded.timeoutMs }),
        snapshots,
        MemorySessions.layer({ sessions: world.noSessions ? {} : { ses_1: { directory: work } }, agents: {} }),
        FileStoreFiles.layer,
      ),
    ).effect(host)
    expect(added).toBeDefined()
    const tool = added

    /** The kernel tool's answer to `code` in session ses_1: its text, or the error's message. */
    const run = (code: string, extra: { readonly reset?: boolean; readonly runtime?: Runtime } = {}) =>
      Effect.suspend(() =>
        tool === undefined
          ? Effect.die("the kernel tool was not added")
          : tool.execute(
              { code, ...(extra.reset ? { reset: true } : {}) },
              {
                sessionID: "ses_1",
                agent: "build",
                messageID: "msg_1",
                id: "call_1",
                progress: () => Effect.void,
                ...(extra.runtime === undefined ? {} : { runtime: extra.runtime }),
              },
            ),
      )
    /** The answer's content parts: a string answer is one text part. */
    const parts = (code: string, extra: { readonly reset?: boolean; readonly runtime?: Runtime } = {}) =>
      run(code, extra).pipe(
        Effect.map((result): ReadonlyArray<Tool.Content> => (typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content)),
      )
    /** The answer's text: its text parts joined. */
    const call = (code: string, extra: { readonly reset?: boolean; readonly runtime?: Runtime } = {}) =>
      parts(code, extra).pipe(Effect.map((content) => content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")))
    const fail = (code: string, extra: { readonly runtime?: Runtime } = {}) =>
      Effect.flip(run(code, extra)).pipe(Effect.map((error) => error.message))
    const deleteSession = (sessionID: string) =>
      Queue.offer(deletions, { type: "session.deleted", data: { sessionID } }).pipe(Effect.andThen(Queue.take(dropped)))
    return { call, parts, fail, entries, agentRules, tool, deleteSession }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const readTool: Listed = {
  id: "read",
  description: "Read a file",
  input: Schema.Struct({ path: Schema.String }),
  execute: (input: { readonly path: string }) => Effect.promise(() => Bun.file(input.path).text()).pipe(Effect.map((content) => ({ content }))),
}

// Stands for OpenCode's subagent tool, whose policy runs in hooks a cell skips.
const subagentTool: Listed = {
  id: "subagent",
  description: "Start a subagent",
  input: Schema.Struct({ prompt: Schema.String }),
  execute: () => Effect.succeed({ content: "started" }),
}

const names = (entry: Json | undefined) =>
  Schema.decodeUnknownSync(OpenCodeSnapshots.Stored)(entry).bindings.map((binding) => binding.name)

describe("the kernel tool", () => {
  test("keeps state across calls in the session's storage entry, and reset clears both", () =>
    scenario(
      Effect.gen(function* () {
        const { call, fail, entries } = yield* start()
        yield* call("let x = 1")
        expect(yield* call("x + 1")).toBe("2")
        expect(names(entries.get("kernel:ses_1"))).toEqual(["x"])
        expect(yield* call("typeof x", { reset: true })).toBe("[kernel reset]\nundefined")
        expect(entries.get("kernel:ses_1")).toEqual({ bindings: [] })
        expect(yield* fail("x")).toContain("ReferenceError")
      }),
    ))

  test("lets a cell call a tool through its execute, with the input decoded", () =>
    scenario(
      Effect.gen(function* () {
        const file = join(work, "note.txt")
        yield* Effect.promise(() => Bun.write(file, "kept text"))
        const { call, fail } = yield* start({}, { tools: [readTool] })
        expect(yield* call(`const text = await tools.read({ path: ${JSON.stringify(file)} }); text.length`)).toBe("9")
        expect(yield* fail("await tools.read({ path: 1 })")).toContain("Invalid input for read")
        expect(yield* fail("await tools.kernel({ code: '1' })")).toContain("Tools: tools.read")
      }),
    ))

  test("does not let a cell start a subagent, whose guards run only for direct calls", () =>
    scenario(
      Effect.gen(function* () {
        const { call, fail } = yield* start({}, { tools: [readTool, subagentTool] })
        expect(yield* fail("await tools.subagent({ prompt: 'x' })")).toContain("Tools: tools.read")
        expect(yield* call("tools.list().map((tool) => tool.id).join()")).toBe("read")
      }),
    ))

  test("shows the head and tail of long output", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start({ viewChars: 100 })
        const view = yield* call('"a".repeat(300) + "END"')
        expect(view.length).toBeLessThan(160)
        expect(view.startsWith("a".repeat(50))).toBe(true)
        expect(view.endsWith("END")).toBe(true)
        expect(view).toContain("characters omitted")
      }),
    ))

  test("answers a crash as an error, and the next call starts fresh from the stored bindings", () =>
    scenario(
      Effect.gen(function* () {
        const { call, fail } = yield* start()
        yield* call("let kept = 7; const f = () => kept")
        expect(yield* fail("process.exit(5)")).toContain("exited (code 5)")
        expect(yield* call("[kept, f()]")).toBe("[new kernel; restored f, kept]\n[ 7, 7 ]")
      }),
    ))

  test("keeps a value over the old frame size through a crash, cycles and all", () =>
    scenario(
      Effect.gen(function* () {
        const { call, fail } = yield* start()
        yield* call("const block = new Uint8Array(4 * 1024 * 1024).fill(3); const loop = { block }; loop.self = loop")
        expect(yield* fail("process.exit(5)")).toContain("exited (code 5)")
        expect(yield* call("[block.length, block[100], loop.self === loop, loop.block.length]")).toBe(
          "[new kernel; restored block, loop]\n[ 4194304, 3, true, 4194304 ]",
        )
      }),
    ))

  test("restores bindings stored by the earlier tagged-JSON format too", () =>
    scenario(
      Effect.gen(function* () {
        const { call, entries } = yield* start()
        const tag = (kind: string, value: Json) => ({ $kernel: kind, value })
        entries.set("kernel:ses_1", {
          bindings: [
            { name: "count", value: 3 },
            { name: "lookup", value: tag("map", [["a", tag("bigint", "12")]]) },
            { name: "when", value: tag("date", 0) },
            { name: "tagged", value: tag("object", { $kernel: "kept", n: tag("number", "NaN") }) },
          ],
        })
        expect(yield* call("[count, lookup.get('a'), when.getTime(), tagged.$kernel, tagged.n]")).toBe(
          '[new kernel; restored count, lookup, when, tagged]\n[ 3, 12n, 0, "kept", NaN ]',
        )
      }),
    ))

  test("starts empty from a storage entry it cannot read", () =>
    scenario(
      Effect.gen(function* () {
        const { call, entries } = yield* start()
        entries.set("kernel:ses_1", { bindings: "not a list" })
        expect(yield* call("1")).toBe("1")
      }),
    ))

  test("names a value that cannot be stored once, when it is bound", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        expect(yield* call("const f = (() => () => 1)(); 1")).toBe("[not kept across restarts: f (function)]\n1")
        expect(yield* call("2")).toBe("2")
      }),
    ))

  test("kills a runaway cell at the time limit; the next call restores", () =>
    scenario(
      Effect.gen(function* () {
        const { call, fail } = yield* start({ timeoutMs: 300 })
        yield* call("let before = 1")
        expect(yield* fail("while (true) {}")).toContain("0.3 s of compute")
        expect(yield* call("before")).toBe("[new kernel; restored before]\n1")
      }),
    ))

  test("stops an idle session's worker; the next call restores", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start({ idleMs: 100 })
        yield* call("let waited = 1")
        yield* Effect.sleep("400 millis")
        expect(yield* call("waited")).toBe("[new kernel; restored waited]\n1")
      }),
    ))

  test("drops a deleted session's worker and its stored bindings", () =>
    scenario(
      Effect.gen(function* () {
        const { call, entries, deleteSession } = yield* start()
        yield* call("let gone = 1")
        expect(entries.has("kernel:ses_1")).toBe(true)
        expect(yield* deleteSession("ses_1")).toBe("kernel:ses_1")
        expect(entries.has("kernel:ses_1")).toBe(false)
        expect(yield* call("typeof gone")).toBe("undefined")
      }),
    ))

  test("answers a session it cannot read as an error naming why", () =>
    scenario(
      Effect.gen(function* () {
        const { fail } = yield* start({}, { noSessions: true })
        expect(yield* fail("1")).toBe("Session not found: ses_1")
      }),
    ))
})

// The smallest PNG: one transparent pixel.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

describe("attach", () => {
  test("shows an attached image as a file part after the text, its data a data URI named by its resolved path", () =>
    scenario(
      Effect.gen(function* () {
        const file = join(work, "pixel.png")
        yield* Effect.promise(() => Bun.write(file, PIXEL))
        const { parts } = yield* start()
        const content = yield* parts('attach("pixel.png")')
        expect(content).toEqual([
          { type: "text", text: "attached 1 image: pixel.png" },
          // The worker runs in the directory itself, so the path is the real one (macOS's /var is /private/var).
          { type: "file", mime: "image/png", uri: `data:image/png;base64,${PIXEL.toString("base64")}`, name: realpathSync(file) },
        ])
      }),
    ))

  test("names a missing path and why in the text, and adds no part for it", () =>
    scenario(
      Effect.gen(function* () {
        const { parts } = yield* start()
        const missing = join(work, "absent.png")
        const content = yield* parts(`attach(${JSON.stringify(missing)}); "after"`)
        expect(content).toHaveLength(1)
        expect(content[0]).toEqual({ type: "text", text: `after\n[not attached: ${missing}: no such file]` })
      }),
    ))
})

describe("the options", () => {
  test("without codeOnly, denyExecute denies code mode's execute to every agent", () =>
    scenario(
      Effect.gen(function* () {
        expect((yield* start({ codeOnly: false })).agentRules).toEqual([{ action: "execute", resource: "*", effect: "deny" }])
        expect((yield* start({ codeOnly: false, denyExecute: false })).agentRules).toEqual([])
        expect((yield* start()).agentRules).toEqual([])
      }),
    ))

  test("an option left undefined takes its default; a malformed one stops the plugin, naming it", () =>
    scenario(
      Effect.gen(function* () {
        expect((yield* start({ codeOnly: undefined, denyExecute: undefined })).agentRules).toEqual([])
        for (const [option, value] of [
          ["timeoutMs", "30000"],
          ["idleMs", 0],
          ["viewChars", -1],
          ["codeOnly", "yes"],
        ] as const) {
          const exit = yield* Effect.exit(start({ [option]: value }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(option)
        }
      }),
    ))
})

describe("as the runtime", () => {
  test("codeOnly makes the kernel the runtime, its description listing each tool it reaches with its input", () =>
    scenario(
      Effect.gen(function* () {
        const runtime = (yield* start()).tool?.options?.runtime
        const text = runtime?.describe([
          { name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
          { name: "mcp-search", description: "Search", input: { type: "object", properties: { mode: { enum: ["a", "b"] } } } },
          { name: "kernel", description: "itself", input: {} },
        ])
        expect(text).toContain("### tools.read(input: { path: string, limit?: number })\nRead a file")
        expect(text).toContain('### tools["mcp-search"](input: { mode?: "a" | "b" })\nSearch')
        expect(text).not.toContain("tools.kernel")
        expect(text).toContain("the kernel is your only tool")
        expect((yield* start({ codeOnly: false })).tool?.options?.runtime).toBeUndefined()
      }),
    ))

  test("a cell reaches every tool through it, subagent included, and a refusal throws", () =>
    scenario(
      Effect.gen(function* () {
        const calls: Array<[string, unknown]> = []
        const runtime: Runtime = {
          tools: [
            { name: "read", description: "Read a file", input: {} },
            { name: "subagent", description: "Start a subagent", input: {} },
          ],
          call: (name, input) =>
            Effect.suspend(() => {
              calls.push([name, input])
              return name === "read"
                ? Effect.fail(new Tool.Error({ message: "It is the Sabbath" }))
                : Effect.succeed({ output: { sessionID: "ses_child", status: "completed", output: "done" } })
            }),
        }
        const { call, fail } = yield* start({}, { tools: [readTool] })
        expect(yield* call("(await tools.subagent({ prompt: 'x' })).output", { runtime })).toBe("done")
        expect(yield* call("tools.list().map((tool) => tool.id).join()", { runtime })).toBe("read,subagent")
        expect(yield* fail("await tools.read({ path: 'a' })", { runtime })).toContain("It is the Sabbath")
        expect(calls).toEqual([
          ["subagent", { prompt: "x" }],
          ["read", { path: "a" }],
        ])
      }),
    ))
})
