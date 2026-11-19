// What every implementation of the Sessions contract owes, as a shared test
// suite. The memory implementation runs it beside itself (memory/sessions.test.ts);
// the OpenCode one is held to the same by the simulated host's laws
// (sim/host-laws.ts: switchModel, sessions) and cmd/model-next's sim test.
import { expect } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { Sessions } from "./service.ts"

/** An implementation with one session `ses_a` on `sim/old`, metadata `{ latch: "kept" }`, and no session `ses_gone`. */
export interface Bench {
  readonly layer: Layer.Layer<Sessions>
}

const LAW_MS = 5_000

export const laws = (name: string, make: () => Bench) => {
  effectTest(
    `${name}: a session the host lacks reads as none`,
    Effect.gen(function* () {
      const found = yield* Sessions.use((sessions) => sessions.record("ses_gone"))
      expect(Option.isNone(found)).toBe(true)
    }).pipe(Effect.provide(make().layer)),
    LAW_MS,
  )

  effectTest(
    `${name}: metadata written is what the record reads, whole`,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      yield* sessions.setMetadata("ses_a", { latch: "kept", modelNext: { x: 1 } })
      const read = yield* sessions.record("ses_a")
      expect(Option.map(read, (record) => record.metadata)).toEqual(Option.some({ latch: "kept", modelNext: { x: 1 } }))
    }).pipe(Effect.provide(make().layer)),
    LAW_MS,
  )

  effectTest(
    `${name}: a switch is the model the record reads after it`,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      yield* sessions.switchModel("ses_a", { providerID: "other", id: "new" })
      const read = yield* sessions.record("ses_a")
      expect(Option.map(read, (record) => record.model)).toEqual(Option.some({ providerID: "other", id: "new" }))
    }).pipe(Effect.provide(make().layer)),
    LAW_MS,
  )
}
