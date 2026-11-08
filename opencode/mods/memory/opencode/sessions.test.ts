import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Sessions, SessionUnreadable } from "../service.ts"
import { layer, type SessionView } from "./sessions.ts"

const WORLD: Record<string, SessionView> = {
  root: { projectID: "prj_1", location: { directory: "/work/prj_1" } },
  child: { projectID: "prj_1", location: { directory: "/work/prj_1" }, parentID: "root" },
}

const host = layer((id) => (WORLD[id] === undefined ? Effect.fail(new Error(`no session ${id}`)) : Effect.succeed(WORLD[id]!)))
const facts = (sessionID: string) =>
  Effect.gen(function* () {
    return yield* (yield* Sessions).facts(sessionID)
  }).pipe(Effect.provide(host))

test("a session's project and whether it is a subagent's; one the host cannot read fails naming it", async () => {
  expect(await Effect.runPromise(facts("root"))).toEqual({ project: "prj_1", directory: "/work/prj_1", child: false })
  expect(await Effect.runPromise(facts("child"))).toEqual({ project: "prj_1", directory: "/work/prj_1", child: true })
  const error = await Effect.runPromise(Effect.flip(facts("gone")))
  expect(error).toBeInstanceOf(SessionUnreadable)
  expect(error).toMatchObject({ sessionID: "gone", message: "no session gone" })
})
