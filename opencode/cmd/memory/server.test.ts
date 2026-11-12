// The plugin seam: the composition root on a stand-in host whose tools and
// request hooks (`context`, `compaction`, `generate`) the test calls, over the SQLite store in memory and the
// OpenCode sessions adapter over a world of sessions. It checks save, repeat,
// correct, search, scope and forget as the agent meets them, the subagent
// rule, and the digest: in the system prompt, bounded, and the same on every
// request of a session. tests/memory.test.ts runs it in OpenCode, on a
// scripted model.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, type Scope } from "effect"
import { HEADING } from "@dotfiles/opencode-memory/digest"
import { MAX_TEXT } from "@dotfiles/opencode-memory/note"
import * as OpenCodeSessions from "@dotfiles/opencode-memory/opencode/sessions"
import * as SqliteStore from "@dotfiles/opencode-memory/sqlite/store"
import Memory, { make } from "./server.ts"

type Host = Parameters<(typeof Memory)["effect"]>[0]
interface ToolDef {
  readonly name: string
  readonly description: string
  readonly execute: (input: unknown, context: { sessionID: string }) => Effect.Effect<{ content: Array<{ text: string }> }, { message: string }>
}
interface ContextEvent {
  readonly sessionID: string
  system: Array<{ type: "text"; text: string }>
}

/** The host's sessions: a root in project `p1`, one in `p2`, and a subagent under the first. */
const SESSIONS: Record<string, OpenCodeSessions.SessionView> = {
  a: { projectID: "p1", location: { directory: "/work/p1" } },
  a2: { projectID: "p1", location: { directory: "/work/p1" } },
  a3: { projectID: "p1", location: { directory: "/work/p1" } },
  b: { projectID: "p2", location: { directory: "/work/p2" } },
  child: { projectID: "p1", location: { directory: "/work/p1" }, parentID: "a" },
}

const start = (options: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const tools = new Map<string, ToolDef>()
    const hooks = new Map<string, Array<(event: ContextEvent) => Effect.Effect<void>>>()
    const host = {
      options,
      tool: {
        transform: (callback: (editor: { add: (tool: ToolDef) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void tools.set(tool.name, tool) })
            return { dispose: Effect.void }
          }),
      },
      session: {
        hook: (name: string, callback: (event: ContextEvent) => Effect.Effect<void>) =>
          Effect.sync(() => {
            hooks.set(name, [...(hooks.get(name) ?? []), callback])
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    const externals = () =>
      Layer.merge(
        SqliteStore.layer(":memory:"),
        OpenCodeSessions.layer((id) => (SESSIONS[id] === undefined ? Effect.fail(new Error(`no session ${id}`)) : Effect.succeed(SESSIONS[id]!))),
      )
    yield* make(externals).effect(host)

    /** Calls the tool as the agent of `sessionID`: its text, or its refusal's message. */
    const call = (name: string, sessionID: string, input: Record<string, unknown>) =>
      tools.get(name)!.execute(input, { sessionID }).pipe(
        Effect.map((result) => ({ ok: true as const, text: result.content.map((part) => part.text).join("\n") })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, text: error.message })),
      )
    /** One request's system prompt as the hooks of its kind leave it: `context` for a primary request. */
    const request = Effect.fn("MemoryServerTest.request")(function* (sessionID: string, kind: "context" | "compaction" | "generate" | "title" = "context") {
      const event: ContextEvent = { sessionID, system: [{ type: "text", text: "the host's instructions" }] }
      for (const hook of hooks.get(kind) ?? []) yield* hook(event)
      return event.system.map((part) => part.text)
    })
    return { tools, call, request }
  })

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the memory plugin", () => {
  test("registers the three tools, each telling what is worth saving", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect([...plugin.tools.keys()]).toEqual(["memory_save", "memory_search", "memory_forget"])
        expect(plugin.tools.get("memory_save")!.description).toContain("Do not save task state")
      }),
    ))

  test("a save adds a note; one that repeats it updates it in place; a search finds it", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.call("memory_save", "a", { text: "The user prefers bun over npm", scope: "global", tags: ["bun"] })).toEqual({
          ok: true,
          text: "Saved #1 (global).",
        })
        const repeat = yield* plugin.call("memory_save", "a2", { text: "the user prefers bun over npm for scripts", scope: "global" })
        expect(repeat.text).toStartWith("Updated #1 (global), which said nearly the same")
        const found = yield* plugin.call("memory_search", "a", { query: "bun" })
        expect(found.text).toStartWith('1 note for "bun":\n#1 [global] the user prefers bun over npm for scripts [bun] · updated ')
      }),
    ))

  test("a project's notes stay in its project; global notes reach every project", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("memory_save", "a", { text: "Run the gate with bun run gate before a push" })
        yield* plugin.call("memory_save", "a", { text: "Answer the user in plain English", scope: "global" })
        expect((yield* plugin.call("memory_search", "a", { query: "gate english" })).text).toContain("2 notes")
        const elsewhere = yield* plugin.call("memory_search", "b", { query: "gate english" })
        expect(elsewhere.text).toContain("1 note")
        expect(elsewhere.text).toContain("#2 [global]")
        expect(yield* plugin.call("memory_forget", "b", { id: 1 })).toEqual({
          ok: false,
          text: "No note #1 in this project or the global notes. memory_search finds the ids.",
        })
        expect((yield* plugin.call("memory_search", "b", { query: "nothing here" })).text).toBe('No note matches "nothing here".')
      }),
    ))

  test("a save with an id corrects that note; forget drops it", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("memory_save", "a", { text: "Deploys go through alchemy" })
        expect((yield* plugin.call("memory_save", "a", { id: 1, text: "Deploys go through railway" })).text).toBe(
          'Corrected #1 (project); it said: "Deploys go through alchemy".',
        )
        expect((yield* plugin.call("memory_search", "a", { query: "deploys" })).text).toContain("railway")
        expect((yield* plugin.call("memory_forget", "a", { id: 1 })).text).toBe('Forgot #1: "Deploys go through railway".')
        expect((yield* plugin.call("memory_search", "a", { query: "deploys" })).text).toBe('No note matches "deploys".')
      }),
    ))

  test("a subagent searches but neither saves nor forgets", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("memory_save", "a", { text: "Use oxlint for lint" })
        const save = yield* plugin.call("memory_save", "child", { text: "Something a worker found" })
        expect(save.ok).toBe(false)
        expect(save.text).toStartWith("A subagent does not write memory")
        expect((yield* plugin.call("memory_forget", "child", { id: 1 })).ok).toBe(false)
        expect((yield* plugin.call("memory_search", "child", { query: "oxlint" })).text).toContain("#1")
      }),
    ))

  test("an empty note, one too long and a query with no words are refused with what to do", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect((yield* plugin.call("memory_save", "a", { text: "  " })).text).toBe("The note is empty: write the fact to keep.")
        expect((yield* plugin.call("memory_save", "a", { text: "x".repeat(MAX_TEXT + 1) })).text).toContain("shorten it or split it")
        expect((yield* plugin.call("memory_search", "a", { query: "!!" })).text).toBe('"!!" has no words to search for.')
      }),
    ))

  test("the digest goes last in the system prompt and stays the same for the whole session", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("a")).toEqual(["the host's instructions"])
        yield* plugin.call("memory_save", "a", { text: "The user prefers bun over npm", scope: "global" })
        // Session a started with no notes: it keeps none, so its prefix never changes.
        expect(yield* plugin.request("a")).toEqual(["the host's instructions"])
        const first = yield* plugin.request("a2")
        expect(first).toHaveLength(2)
        expect(first[1]).toStartWith(HEADING)
        expect(first[1]).toContain("- #1 The user prefers bun over npm")
        yield* plugin.call("memory_save", "a2", { text: "Run the gate before a push" })
        expect(yield* plugin.request("a2")).toEqual(first)
        expect((yield* plugin.request("a3"))[1]).toContain("#2 Run the gate before a push")
        // A subagent starts with its project's digest too; another project sees the global note only.
        expect((yield* plugin.request("child"))[1]).toContain("#2 Run the gate")
        expect((yield* plugin.request("b"))[1]).not.toContain("Run the gate")
      }),
    ))

  test("a compaction's summary request and a generate request carry the session's digest too; a title request none", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.call("memory_save", "a", { text: "The user prefers bun over npm", scope: "global" })
        const turn = yield* plugin.request("a2")
        expect(turn).toHaveLength(2)
        // Each resends the conversation: the same system prompt keeps the cached prefix.
        expect(yield* plugin.request("a2", "compaction")).toEqual(turn)
        expect(yield* plugin.request("a2", "generate")).toEqual(turn)
        expect(yield* plugin.request("a2", "title")).toEqual(["the host's instructions"])
      }),
    ))

  test("the digest holds what the options allow", () =>
    run(
      Effect.gen(function* () {
        const plugin = yield* start({ digestNotes: 2, digestChars: 4_000 })
        for (const fact of ["alpha one", "beta two", "gamma three"]) yield* plugin.call("memory_save", "a", { text: `fact ${fact}` })
        const digest = (yield* plugin.request("a2"))[1] ?? ""
        expect(digest.split("\n").filter((line) => line.startsWith("- #"))).toHaveLength(2)
      }),
    ))

  test("a malformed option stops the plugin, naming it", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(start({ digestChars: "lots" })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("dotfiles-opencode.memory: invalid options")
  })
})
