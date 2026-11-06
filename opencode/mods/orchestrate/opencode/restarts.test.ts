// OpenCode's Restarts over a stand-in host: the laws, and how the host's
// records read as the restart's entries.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { restartsLaws } from "../laws.ts"
import { Restarts } from "../service.ts"
import { childOf, entryOf, type Host, layer, samePlace, type ToolView } from "./restarts.ts"

restartsLaws("OpenCode's Restarts", (world) => {
  const view = (id: string) => {
    const session = world.sessions[id]
    return session === undefined ? undefined : { id, parentID: session.parentID, updated: session.updated, directory: session.here ? "/work/" : "/elsewhere" }
  }
  const host: Host = {
    location: { directory: "/work" },
    list: Effect.sync(() => Object.keys(world.sessions).flatMap((id) => view(id) ?? [])),
    get: (id) => {
      const found = view(id)
      return found === undefined ? Effect.fail({ _tag: "Session.NotFoundError" }) : Effect.succeed(found)
    },
    context: () => Effect.succeed([]),
    run: () => (world.fail === undefined ? Effect.void : Effect.fail(new Error(world.fail))),
    synthetic: () => (world.refuseNotice === undefined ? Effect.void : Effect.fail(new Error(world.refuseNotice))),
  }
  return layer(host)
})

const tool = (state: ToolView["state"]): ToolView => ({ type: "tool", id: "call-1", name: "subagent", state })

describe("reading the host", () => {
  test("a subagent call names its child by its metadata, a follow-up's input, or an interrupted call's error", () => {
    expect(childOf(tool({ status: "completed", metadata: { sessionID: "ses_a" } }))).toBe("ses_a")
    expect(childOf(tool({ status: "running", input: { sessionID: "ses_b" } }))).toBe("ses_b")
    expect(childOf(tool({ status: "error", input: {}, error: { type: "aborted", message: "Tool execution interrupted (sessionID: ses_c)" } }))).toBe("ses_c")
    expect(childOf(tool({ status: "error", input: {}, error: { type: "aborted", message: "Tool execution interrupted" } }))).toBeUndefined()
  })

  test("each message reads as its entry: OpenCode's restart notice apart from other notices", () => {
    expect(entryOf({ type: "user", created: 1, text: "go" })).toEqual({ type: "prompt", at: 1, text: "go" })
    expect(entryOf({ type: "synthetic", created: 2, metadata: { notice: "restart" } })).toEqual({ type: "restarted", at: 2 })
    expect(entryOf({ type: "synthetic", created: 3, metadata: { source: "shell" } })).toEqual({ type: "other" })
    expect(entryOf({ type: "synthetic", created: 3, metadata: { source: "orchestrate", notice: "resumed", children: ["ses_a", 7] } })).toEqual({
      type: "told",
      at: 3,
      children: ["ses_a"],
    })
    expect(entryOf({ type: "idle", created: 4, outcome: "interrupted" })).toEqual({ type: "idle", at: 4, outcome: "interrupted" })
    expect(entryOf({ type: "other" })).toEqual({ type: "other" })
    expect(
      entryOf({
        type: "assistant",
        id: "msg_1",
        agent: "build",
        created: 5,
        completed: 6,
        error: { type: "aborted" },
        content: [
          { type: "text" },
          tool({ status: "error", input: {}, error: { type: "aborted", message: "Tool execution interrupted (sessionID: ses_c)" } }),
          { type: "tool", id: "call-2", name: "shell", state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } } },
        ],
      }),
    ).toEqual({ type: "assistant", id: "msg_1", agent: "build", at: 6, aborted: true, calls: [{ id: "call-1", child: "ses_c", interrupted: true }] })
  })

  test("a location is its directory, with or without a trailing separator, and its workspace", () => {
    expect(samePlace({ directory: "/work/" }, { directory: "/work" })).toBe(true)
    expect(samePlace({ directory: "/work", workspaceID: "w1" }, { directory: "/work" })).toBe(false)
  })

  test("a host that cannot list its sessions gives no children", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const children = yield* (yield* Restarts).children(0)
        expect(children).toEqual([])
      }).pipe(
        Effect.provide(
          layer({
            location: { directory: "/work" },
            list: Effect.fail(new Error("database is locked")),
            get: () => Effect.fail("no"),
            context: () => Effect.fail("no"),
            run: () => Effect.void,
            synthetic: () => Effect.void,
          }),
        ),
      ),
    ))
})
