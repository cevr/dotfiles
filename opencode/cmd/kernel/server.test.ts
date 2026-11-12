// The plugin seam: the composition root on a stand-in host, with the sessions
// in memory, the stored bindings in OpenCode's storage format over the
// stand-in's storage, and the workers live (the worker is this repo's own
// program, run in a scratch directory). It checks what
// OpenCode sees: the kernel tool's answers and errors, the storage entry, the
// runtime's description, the agents' rules and a deleted session's cleanup.
// tests/kernel.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tool } from "@opencode/plugin/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import type { Json } from "@dotfiles/opencode-kernel/frame"
import type { Reached, Rule } from "@dotfiles/opencode-kernel/tools"
import * as FileStoreFiles from "@dotfiles/opencode-kernel/filestore/files"
import * as MemorySessions from "@dotfiles/opencode-kernel/memory/sessions"
import * as OpenCodeSnapshots from "@dotfiles/opencode-kernel/opencode/snapshots"
import * as ProcessWorkers from "@dotfiles/opencode-kernel/worker/workers"
import Kernel, { make } from "./server.ts"

/** The session's directory: a scratch directory of the scenario's own, removed when its scope closes. */
const scratchWork = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "kernel-plugin-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

type Host = Parameters<(typeof Kernel)["effect"]>[0]

/** The kernel tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly execute: (input: { code: string; reset?: boolean }, context: unknown) => Effect.Effect<{ readonly content: string | ReadonlyArray<Tool.Content> }, Tool.Error>
  readonly options?: {
    readonly runtime?: { readonly describe: (tools: ReadonlyArray<Reached>) => string; readonly direct?: ReadonlyArray<string> }
  }
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
const start = (options: Record<string, unknown> = {}, world: World = {}, stored: Map<string, Json> = new Map()) =>
  Effect.gen(function* () {
    const work = yield* scratchWork
    const entries = new Map<string, Json>()
    const hooks = new Map<string, Array<(event: RequestEvent) => Effect.Effect<void>>>()
    const synthetics: Array<{ readonly sessionID: string; readonly text: string; readonly resume?: boolean }> = []
    const announced = yield* Queue.unbounded<void>()
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
      // The plugin's own storage, where the frozen descriptions live.
      storage: {
        get: (key: string) => Effect.sync(() => stored.get(key)),
        set: (key: string, value: Json) => Effect.sync(() => void stored.set(key, JSON.parse(JSON.stringify(value)))),
        remove: (key: string) => Effect.sync(() => void stored.delete(key)),
      },
      session: {
        hook: (name: string, callback: (event: RequestEvent) => Effect.Effect<void>) =>
          Effect.sync(() => {
            hooks.set(name, [...(hooks.get(name) ?? []), callback])
            return { dispose: Effect.void }
          }),
        synthetic: (input: { readonly sessionID: string; readonly text: string; readonly resume?: boolean }) =>
          Effect.sync(() => void synthetics.push(input)).pipe(Effect.andThen(Queue.offer(announced, undefined))),
      },
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
    /**
     * One model request of `sessionID` (a primary one, or a compaction) as the fork makes it: the
     * runtime describes `tools`, then the request hooks see the kernel's definition; the description
     * the request offers.
     */
    const request = (sessionID: string, tools: ReadonlyArray<Reached>, hook: "context" | "compaction" = "context") =>
      offer(sessionID, tools, hook).pipe(Effect.map((offered) => offered.kernel))
    /**
     * The same request, with the definitions the fork offers beside the kernel: each of `tools`
     * the runtime names direct. The kernel's description and the names of every tool it offers.
     */
    const offer = (sessionID: string, tools: ReadonlyArray<Reached>, hook: "context" | "compaction" = "context") =>
      Effect.gen(function* () {
        const runtime = tool?.options?.runtime
        const live = runtime?.describe(tools)
        if (live === undefined) return yield* Effect.die("the kernel is not the runtime")
        const direct = tools.filter((item) => runtime?.direct?.includes(item.name))
        const event: RequestEvent = {
          sessionID,
          agent: "build",
          tools: { kernel: { description: live, input: {} }, ...Object.fromEntries(direct.map((item) => [item.name, { description: item.description, input: item.input }])) },
        }
        for (const callback of hooks.get(hook) ?? []) yield* callback(event)
        return { kernel: event.tools.kernel!.description, tools: Object.keys(event.tools) }
      })
    return { call, parts, fail, entries, agentRules, tool, deleteSession, request, offer, synthetics, announced, work }
  })

/** A request hook's event, as much of it as the kernel reads. */
interface RequestEvent {
  readonly sessionID: string
  readonly agent: string
  readonly tools: Record<string, { description: string; input: unknown }>
}

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
        const { call, fail, work } = yield* start({}, { tools: [readTool] })
        const file = join(work, "note.txt")
        yield* Effect.promise(() => Bun.write(file, "kept text"))
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
        const { parts, work } = yield* start()
        const file = join(work, "pixel.png")
        yield* Effect.promise(() => Bun.write(file, PIXEL))
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
        const { parts, work } = yield* start()
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
          ["direct", "memory_save"],
        ] as const) {
          const exit = yield* Effect.exit(start({ [option]: value }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(option)
        }
      }),
    ))
})

describe("as the runtime", () => {
  test("codeOnly makes the kernel the runtime, its description listing each tool it reaches on a line with its input", () =>
    scenario(
      Effect.gen(function* () {
        const runtime = (yield* start()).tool?.options?.runtime
        const text = runtime?.describe([
          { name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
          { name: "mcp-search", description: "Search", input: { type: "object", properties: { mode: { enum: ["a", "b"] } } } },
          { name: "kernel", description: "itself", input: {} },
        ])
        expect(text).toContain("- tools.read(input: { path: string, limit?: number }): Read a file")
        expect(text).toContain(`- tools["mcp-search"](input: { mode?: "a" | "b" }): Search`)
        expect(text).not.toContain("tools.kernel")
        expect((yield* start({ codeOnly: false })).tool?.options?.runtime).toBeUndefined()
      }),
    ))

  test("by default the memory tools are offered beside it, off its list; direct: [] leaves the kernel alone", () =>
    scenario(
      Effect.gen(function* () {
        const tools: ReadonlyArray<Reached> = [
          { name: "read", description: "Read a file", input: {} },
          { name: "memory_save", description: "Save a note", input: {} },
        ]
        const runtime = (yield* start()).tool?.options?.runtime
        expect(runtime?.direct).toEqual(["memory_save", "memory_search", "memory_forget"])
        const text = runtime?.describe(tools)
        expect(text).toContain("the kernel is your main tool. The few tools offered beside it you call directly")
        expect(text).toContain("- tools.read(")
        expect(text).not.toContain("tools.memory_save")
        const alone = (yield* start({ direct: [] })).tool?.options?.runtime
        expect(alone?.direct).toEqual([])
        expect(alone?.describe(tools)).toContain("the kernel is your only tool")
        expect(alone?.describe(tools)).toContain("- tools.memory_save(")
      }),
    ))

  test("a cell still calls a direct tool through the runtime", () =>
    scenario(
      Effect.gen(function* () {
        const runtime: Runtime = {
          tools: [{ name: "memory_save", description: "Save a note", input: {} }],
          call: (name, input) => Effect.succeed({ output: `${name} ${JSON.stringify(input)}` }),
        }
        const { call } = yield* start()
        expect(yield* call("await tools.memory_save({ text: 'x' })", { runtime })).toBe('memory_save {"text":"x"}')
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

  // A cell that pulls new plugin code reloads the plugin under itself: the host
  // closes the old plugin's scope while that cell's call is still open.
  test("a call in flight when the plugin stops fails, naming why, instead of waiting forever", () =>
    scenario(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const runtime: Runtime = {
          tools: [{ name: "shell", description: "Run a command", input: {} }],
          call: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
        }
        const plugin = yield* Scope.make()
        const { fail } = yield* start({}, { tools: [readTool] }).pipe(Effect.provideService(Scope.Scope, plugin))
        const call = yield* Effect.forkChild(fail("await tools.shell({ command: 'git pull' })", { runtime }))
        yield* Deferred.await(reached)
        yield* Scope.close(plugin, Exit.void)
        const message = yield* Fiber.join(call).pipe(Effect.timeoutOption("5 seconds"))
        expect(Option.getOrUndefined(message)).toContain("reloaded or shut down its plugins")
      }),
    ))
})

describe("a session's frozen description", () => {
  const read: Reached = { name: "read", description: "Read a file. It reads.", input: { type: "object", properties: { path: { type: "string" } } } }
  const browse: Reached = { name: "browse_snapshot", description: "Snapshot the page. It lists the elements.", input: { type: "object", properties: {} } }
  const kernel: Reached = { name: "kernel", description: "itself", input: {} }

  test("keeps its bytes when an MCP tool joins mid-session; the tool is callable, its docs readable, and told once", () =>
    scenario(
      Effect.gen(function* () {
        const { call, request, synthetics, announced } = yield* start()
        const first = yield* request("ses_1", [kernel, read])
        expect(first).toContain("- tools.read(input: { path?: string }): Read a file.")
        // The browse MCP server connects: the live description changes, the session's does not.
        const joined = [kernel, read, browse]
        expect(yield* request("ses_1", joined)).toBe(first)
        yield* Queue.take(announced)
        expect(yield* request("ses_1", joined)).toBe(first)
        expect(yield* request("ses_1", joined, "compaction")).toBe(first)
        expect(synthetics).toHaveLength(1)
        expect(synthetics[0]).toMatchObject({ sessionID: "ses_1", resume: false })
        expect(synthetics[0]?.text).toContain("- tools.browse_snapshot: Snapshot the page.")
        // The runtime reaches the live tools, so the new one runs, and its docs are there.
        const runtime: Runtime = { tools: joined, call: (name) => Effect.succeed({ output: `ran ${name}` }) }
        expect(yield* call("await tools.browse_snapshot({})", { runtime })).toBe("ran browse_snapshot")
        expect(yield* call("tools.docs('browse_snapshot').description", { runtime })).toBe("Snapshot the page. It lists the elements.")
        expect(yield* call("tools.docs.search('page').map((hit) => hit.name).join()", { runtime })).toBe("browse_snapshot")
      }),
    ))

  test("a subagent freezes its own at its first request; a gone tool is told and its call throws", () =>
    scenario(
      Effect.gen(function* () {
        const { fail, request, synthetics, announced } = yield* start()
        const parent = yield* request("ses_1", [kernel, read, browse])
        const child = yield* request("ses_child", [kernel, read])
        expect(child).not.toBe(parent)
        expect(child).not.toContain("browse_snapshot")
        expect(yield* request("ses_child", [kernel, read])).toBe(child)
        // browse disconnects: the parent keeps its text and is told; the child never had it.
        expect(yield* request("ses_1", [kernel, read])).toBe(parent)
        yield* Queue.take(announced)
        expect(synthetics.map((item) => item.sessionID)).toEqual(["ses_1"])
        expect(synthetics[0]?.text).toContain("Gone (a call now throws):\n- tools.browse_snapshot")
        const runtime: Runtime = { tools: [read], call: () => Effect.die("not called") }
        expect(yield* fail("await tools.browse_snapshot({})", { runtime })).toContain("tools.browse_snapshot is not a tool here")
      }),
    ))

  test("keeps the direct tools its first request offered: one that joins later is dropped and told, a new session gets it", () =>
    scenario(
      Effect.gen(function* () {
        const save: Reached = { name: "memory_save", description: "Save a note. It keeps it.", input: {} }
        const search: Reached = { name: "memory_search", description: "Search the notes. It ranks them.", input: {} }
        const forget: Reached = { name: "memory_forget", description: "Forget a note. It drops it.", input: {} }
        const stored = new Map<string, Json>()
        const { offer, synthetics, announced } = yield* start({}, {}, stored)
        const first = yield* offer("ses_1", [kernel, read, save, search])
        expect(first.tools).toEqual(["kernel", "memory_save", "memory_search"])
        expect(first.kernel).not.toContain("tools.memory_")
        // memory_forget joins mid-session: the definitions stay as they were, byte for byte.
        const joined = [kernel, read, save, search, forget]
        expect(yield* offer("ses_1", joined)).toEqual(first)
        yield* Queue.take(announced)
        expect(synthetics[0]?.text).toContain("- tools.memory_forget: Forget a note.")
        expect(yield* offer("ses_1", joined, "compaction")).toEqual(first)
        // A session that starts now is offered all three.
        expect((yield* offer("ses_2", joined)).tools).toEqual(["kernel", "memory_save", "memory_search", "memory_forget"])
        // A session frozen with none (the memory plugin came late) keeps none, across a restart too.
        const bare = yield* offer("ses_3", [kernel, read])
        const restarted = yield* start({}, {}, stored)
        expect(yield* restarted.offer("ses_3", joined)).toEqual(bare)
        expect(yield* restarted.offer("ses_1", joined)).toEqual(first)
      }),
    ))

  test("holds across a plugin restart and goes when the session is deleted", () =>
    scenario(
      Effect.gen(function* () {
        const stored = new Map<string, Json>()
        const before = yield* start({}, {}, stored)
        const first = yield* before.request("ses_1", [kernel, read])
        const after = yield* start({}, {}, stored)
        expect(yield* after.request("ses_1", [kernel, read, browse])).toBe(first)
        expect(stored.has("kernel-catalog:ses_1")).toBe(true)
        yield* after.call("1")
        yield* after.deleteSession("ses_1")
        expect(stored.has("kernel-catalog:ses_1")).toBe(false)
      }),
    ))
})
