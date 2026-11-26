// The hour in cells in the plugin's storage, and the notice a root gets (cell-times.ts).
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { it } from "effect-bun-test"
import { CellTime, CellTimed } from "../cell-time.ts"
import { CellTimes, Notices } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import * as OpenCodeCellTimes from "./cell-times.ts"
import type { Store } from "./snapshots.ts"

/** A store over a map, which keeps a copy of each value as the host's storage does. */
const memoryStore = (data: Map<string, unknown>): Store => ({
  get: (key) => Effect.sync(() => data.get(key)),
  set: (key, value) => Effect.sync(() => void data.set(key, structuredClone(value))),
  remove: (key) => Effect.sync(() => void data.delete(key)),
})

const session = KernelSessionId.make("ses_root")
const notice = { text: "t", description: "d" }

describe("the store", () => {
  const data = new Map<string, unknown>()
  it.effect.layer(OpenCodeCellTimes.layer(memoryStore(data)))("reads a stored view back as it was; a missing or foreign one reads empty", () =>
    Effect.gen(function* () {
      const times = yield* CellTimes
      const state = CellTime.evolve(
        CellTime.initial,
        CellTimed.make({ session: "ses_root", startedAt: 1_000, endedAt: 6_000, waitedMs: 0, computeMs: 5_000, cut: false, description: "Run the gate" }),
      )
      yield* times.save(session, state)
      expect(yield* times.load(session)).toEqual(state)
      data.set("kernel-time:ses_bad", { latest: "no" })
      expect(yield* times.load(KernelSessionId.make("ses_bad"))).toEqual(CellTime.initial)
      expect(yield* times.load(KernelSessionId.make("ses_none"))).toEqual(CellTime.initial)
      yield* times.drop(session)
      expect(data.has("kernel-time:ses_root")).toBe(false)
    }),
  )
})

describe("the notices", () => {
  const told: Array<string> = []
  const host = (tell: OpenCodeCellTimes.Host["tell"]): OpenCodeCellTimes.Host => ({
    parentOf: (id) => Effect.succeed(Option.liftPredicate("ses_root", () => id === "ses_child")),
    tell,
  })
  it.effect.layer(OpenCodeCellTimes.notices(host((id) => Effect.sync(() => void told.push(id)))))("tell a root and never a subagent", () =>
    Effect.gen(function* () {
      const notices = yield* Notices
      yield* notices.tell(session, notice)
      yield* notices.tell(KernelSessionId.make("ses_child"), notice)
      expect(told).toEqual(["ses_root"])
    }),
  )
  it.effect.layer(OpenCodeCellTimes.notices(host(() => Effect.fail("down"))))("of a host that fails to tell fail nothing", () =>
    Effect.gen(function* () {
      yield* (yield* Notices).tell(session, notice)
    }),
  )
})
