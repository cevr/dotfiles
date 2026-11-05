// OpenCode's latches over a stand-in for the wakes' RPC and the subagent
// tool: the laws, and the answers that refuse the latch (no wakes, a failure,
// an answer that is not one).
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { latchesLaws } from "../laws.ts"
import { Latches } from "../service.ts"
import * as OpenCodeLatches from "./latches.ts"

latchesLaws("OpenCode's Latches", (world) => {
  let n = 0
  return OpenCodeLatches.layer(
    () => {
      n += 1
      return Effect.succeed(world.refuse === undefined ? { outcome: "latched", id: `w00000${n}`, child: `ses_${n}` } : { outcome: "refused", reason: world.refuse })
    },
    () => (world.fail === undefined ? Effect.void : Effect.fail(new Error(world.fail))),
  )
})

const ask = {
  parent: "ses_parent",
  from: "build",
  messageID: "msg_1",
  callID: "call-1",
  agent: "worker",
  description: "d",
  prompt: "p",
  hold: "pace" as const,
  why: "held",
  opensAt: 9_000,
  recheckAt: 5_000,
  context: {},
}

test("no wakes, a failed ask, or an answer that is not one refuses the latch, saying so", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reasonOf = (latch: OpenCodeLatches.Latch) =>
        Effect.flip(Latches.use((latches) => latches.latch(ask))).pipe(
          Effect.provide(OpenCodeLatches.layer(latch, () => Effect.void)),
          Effect.map((refused) => refused.reason),
        )
      expect(yield* reasonOf(() => Effect.fail(new Error("no server for dotfiles-opencode.wake")))).toBe("the wakes could not be asked: no server for dotfiles-opencode.wake")
      expect(yield* reasonOf(() => Effect.die("broken"))).toBe("the wakes could not be asked: broken")
      expect(yield* reasonOf(() => Effect.succeed({ outcome: "maybe" }))).toBe("the wakes' answer is not one")
    }),
  ))

test("the wakes are asked with the request as their latch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Array<unknown> = []
      yield* Latches.use((latches) => latches.latch({ ...ask, model: "openai/gpt-5#high" })).pipe(
        Effect.provide(
          OpenCodeLatches.layer(
            (input) => Effect.sync(() => (asked.push(input), { outcome: "latched", id: "w000001", child: "ses_1" })),
            () => Effect.void,
          ),
        ),
      )
      expect(asked).toEqual([
        {
          sessionID: "ses_parent",
          subagent: { agent: "worker", description: "d", prompt: "p", model: "openai/gpt-5#high", from: "build", messageID: "msg_1", callID: "call-1" },
          hold: "pace",
          reason: "held",
          opensAt: 9_000,
          recheckAt: 5_000,
          context: {},
        },
      ])
    }),
  ))
