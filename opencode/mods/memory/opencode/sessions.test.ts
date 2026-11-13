import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Sessions, SessionUnreadable } from "../service.ts"
import { HELD, layer, type SessionView } from "./sessions.ts"

const WORLD: Record<string, SessionView> = {
  root: { projectID: "prj_1", location: { directory: "/work/prj_1" }, metadata: { wake: "kept" } },
  child: { projectID: "prj_1", location: { directory: "/work/prj_1" }, parentID: "root" },
}

const host = layer(
  (id) => (WORLD[id] === undefined ? Effect.fail(new Error(`no session ${id}`)) : Effect.succeed(WORLD[id]!)),
  (id, metadata) => Effect.sync(() => void (WORLD[id] = { ...WORLD[id]!, metadata })),
)

test("a session's project, whether it is a subagent's and the digest it holds; one the host cannot read fails naming it", () =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    expect(yield* sessions.facts("root")).toEqual({ project: "prj_1", directory: "/work/prj_1", child: false, held: Option.none() })
    expect(yield* sessions.facts("child")).toEqual({ project: "prj_1", directory: "/work/prj_1", child: true, held: Option.none() })
    const error = yield* Effect.flip(sessions.facts("gone"))
    expect(error).toBeInstanceOf(SessionUnreadable)
    expect(error).toMatchObject({ sessionID: "gone", message: "no session gone" })

    // A held digest is read back, and the session's other metadata stays.
    yield* sessions.hold("root", "## Memory")
    expect(WORLD["root"]?.metadata).toEqual({ wake: "kept", [HELD]: "## Memory" })
    expect((yield* sessions.facts("root")).held).toEqual(Option.some("## Memory"))
    expect(yield* Effect.flip(sessions.hold("gone", "x"))).toBeInstanceOf(SessionUnreadable)
  }).pipe(Effect.provide(host), Effect.runPromise))
