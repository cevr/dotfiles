// The pool's pace over OpenCode's RPC: the pool mod reads provider quota, so
// OpenCode's own spend counts. No pool, a failure, a timeout or an answer
// that is not a pace all fail open, as an unreachable host does.
import { Effect, Layer, Schema } from "effect"
import { Pace } from "../domain/Pace.ts"
import { PoolPace } from "../domain/ToolCall/PoolPace.external.ts"

/** The pool's `pace` method, as the plugin's RPC client calls it. */
export type Ask = (input: { readonly providerID: string }) => Effect.Effect<unknown, unknown>

/** How long the pool has to answer. */
const TIMEOUT = "8 seconds"

const decode = Schema.decodeUnknownOption(Pace)

export const layer = (ask: Ask) =>
  Layer.succeed(PoolPace, {
    pace: Effect.fn("PoolPace.pace")(function* (providerID: string) {
      const answer = yield* ask({ providerID }).pipe(Effect.timeoutOption(TIMEOUT))
      if (answer._tag === "None") return undefined
      const pace = decode(answer.value)
      return pace._tag === "Some" ? pace.value : undefined
    }, Effect.catchCause(() => Effect.succeed(undefined))),
  })

/** The pool's answer per provider; a provider it has none for is unpaced. */
export const layerTest = (answers: Readonly<Record<string, Pace>>) =>
  Layer.succeed(PoolPace, { pace: (providerID: string) => Effect.succeed(answers[providerID]) })
