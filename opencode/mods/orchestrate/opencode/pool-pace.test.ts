// The pool's pace over a stand-in for the pool's RPC: the laws, and the
// answers that fail open (no pool, a failure, an answer that is not a pace).
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { poolPaceLaws } from "../laws.ts"
import { PoolPace } from "../service.ts"
import * as OpenCodePoolPace from "./pool-pace.ts"

poolPaceLaws("OpenCode's PoolPace", (world) =>
  OpenCodePoolPace.layer(
    ({ providerID }) =>
      Object.hasOwn(world, providerID) ? Effect.succeed(world[providerID]) : Effect.fail(new Error(`no pool for ${providerID}`)),
    ({ providerID }) => (Object.hasOwn(world, providerID) ? Effect.succeed({}) : Effect.fail(new Error(`no pool for ${providerID}`))),
  ),
)

const told = () => Effect.succeed({})

test("an answer that is not a pace, or a failed ask, fails open", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pace = PoolPace.use((pool) => pool.pace("anthropic"))
      expect(yield* pace.pipe(Effect.provide(OpenCodePoolPace.layer(() => Effect.succeed({ ok: "yes" }), told)))).toBeUndefined()
      expect(yield* pace.pipe(Effect.provide(OpenCodePoolPace.layer(() => Effect.fail("no pool"), told)))).toBeUndefined()
      expect(yield* pace.pipe(Effect.provide(OpenCodePoolPace.layer(() => Effect.die("broken"), told)))).toBeUndefined()
    }),
  ))
