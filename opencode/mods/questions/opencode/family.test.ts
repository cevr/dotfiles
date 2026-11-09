// The OpenCode Family over a stand-in host's `session.get`.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Family } from "../service.ts"
import { layer } from "./family.ts"

const sessions: Record<string, { id: string; parentID?: string; title?: string; agent?: string; cost: number }> = {
  ses_root: { id: "ses_root", title: "Orchestrate auth", cost: 0 },
  ses_child: { id: "ses_child", parentID: "ses_root", title: "implementor auth r1", agent: "implementor", cost: 0 },
}
const host = { get: (sessionID: string) => (sessionID in sessions ? Effect.succeed(sessions[sessionID]!) : Effect.fail({ _tag: "Session.NotFoundError", sessionID })) }
const info = (sessionID: string) => Effect.runPromise(Family.use((family) => family.info(sessionID)).pipe(Effect.provide(layer(host))))

test("a session reads as its id, parent, title and agent; one the host does not have is undefined", async () => {
  expect(await info("ses_child")).toEqual({ id: "ses_child", parentID: "ses_root", title: "implementor auth r1", agent: "implementor" })
  expect(await info("ses_root")).toEqual({ id: "ses_root", title: "Orchestrate auth" })
  expect(await info("ses_gone")).toBeUndefined()
})
