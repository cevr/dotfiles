// The nudge over a stand-in for `session.synthetic`: the laws, and what the
// host is asked: a steered, marked message that wakes the session, its
// description the same line.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MARK } from "../idle.ts"
import { steerLaws } from "../laws.ts"
import { Steer } from "../service.ts"
import * as OpenCodeSteer from "./steer.ts"

steerLaws("OpenCode's Steer", (world) => {
  const sent: Array<{ readonly sessionID: string; readonly line: string }> = []
  return {
    layer: OpenCodeSteer.layer((input) =>
      world.refuse === undefined ? Effect.sync(() => void sent.push({ sessionID: input.sessionID, line: input.text })) : Effect.fail(new Error(world.refuse)),
    ),
    sent: () => sent,
  }
})

test("the host is asked for a steered message carrying the mark, which wakes the session", async () => {
  const asked: Array<OpenCodeSteer.Synthetic> = []
  await Effect.runPromise(Steer.use((steer) => steer.nudge("ses_root", "the line")).pipe(Effect.provide(OpenCodeSteer.layer((input) => Effect.sync(() => void asked.push(input))))))
  expect(asked).toEqual([{ sessionID: "ses_root", text: "the line", description: "the line", metadata: { [MARK]: true }, delivery: "steer", resume: true }])
})
