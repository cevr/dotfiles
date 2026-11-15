// OpenCode's Notices over a stand-in for the host's `session.synthetic`: a
// wake is a steered synthetic message that resumes the session, and a host
// that refuses it does not fail the wake.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Notices } from "../service.ts"
import * as OpenCodeNotices from "./notices.ts"

const wake = (synthetic: (input: OpenCodeNotices.Synthetic) => Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(
    Effect.flatMap(Notices, (notices) => notices.wake("ses_1", { text: "rift land: passed", description: "rift land · accept passed" })).pipe(
      Effect.provide(OpenCodeNotices.layer(synthetic)),
    ),
  )

test("a wake is a steered synthetic message that resumes the session; a refused one is skipped", async () => {
  const sent: Array<OpenCodeNotices.Synthetic> = []
  await wake((input) => Effect.sync(() => sent.push(input)))
  expect(sent).toEqual([
    { sessionID: "ses_1", text: "rift land: passed", description: "rift land · accept passed", metadata: { rift: "land" }, delivery: "steer", resume: true },
  ])
  await wake(() => Effect.fail(new Error("Session not found: ses_1")))
})
