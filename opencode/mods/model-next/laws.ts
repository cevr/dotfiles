// What every implementation of the Sessions contract owes, as a shared test
// suite. The memory implementation runs it beside itself (memory/sessions.test.ts);
// the OpenCode one is held to the same by the simulated host's laws
// (sim/host-laws.ts: switchModel, sessions) and cmd/model-next's sim test.
import { expect, test } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { Sessions } from "./service.ts"

/** An implementation with one session `ses_a` on `sim/old`, metadata `{ latch: "kept" }`, and no session `ses_gone`. */
export interface Bench {
  readonly layer: Layer.Layer<Sessions>
}

const run = <A, E>(bench: Bench, effect: Effect.Effect<A, E, Sessions>) => Effect.runPromise(effect.pipe(Effect.provide(bench.layer)))

export const laws = (name: string, make: () => Bench) => {
  test(`${name}: a session the host lacks reads as none`, async () => {
    const found = await run(make(), Sessions.use((sessions) => sessions.record("ses_gone")))
    expect(Option.isNone(found)).toBe(true)
  })

  test(`${name}: metadata written is what the record reads, whole`, async () => {
    const read = await run(
      make(),
      Effect.gen(function* () {
        const sessions = yield* Sessions
        yield* sessions.setMetadata("ses_a", { latch: "kept", modelNext: { x: 1 } })
        return yield* sessions.record("ses_a")
      }),
    )
    expect(Option.getOrThrow(read).metadata).toEqual({ latch: "kept", modelNext: { x: 1 } })
  })

  test(`${name}: a switch is the model the record reads after it`, async () => {
    const read = await run(
      make(),
      Effect.gen(function* () {
        const sessions = yield* Sessions
        yield* sessions.switchModel("ses_a", { providerID: "other", id: "new" })
        return yield* sessions.record("ses_a")
      }),
    )
    expect(Option.getOrThrow(read).model).toMatchObject({ providerID: "other", id: "new" })
  })
}
