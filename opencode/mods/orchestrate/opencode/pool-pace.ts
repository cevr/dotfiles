// The pool's pace over OpenCode's RPC: the pool mod reads provider quota, so
// OpenCode's own spend counts. No pool, a failure, a timeout or an answer
// that is not a pace all fail open, as an unreachable host does. Each new agent
// is told to the pool's `started`; a tell that fails is lost.
import { Effect, Layer, Schema } from "effect"
import { Pace } from "../pace.ts"
import { PoolPace } from "../service.ts"

/** The pool's `pace` method, as the plugin's RPC client calls it. */
export type Ask = (input: { readonly providerID: string }) => Effect.Effect<unknown, unknown>

/** The pool's `started` method. */
export type Tell = (input: { readonly providerID: string }) => Effect.Effect<unknown, unknown>

/** How long the pool has to answer. */
const TIMEOUT = "8 seconds"

const decode = Schema.decodeUnknownOption(Pace)

export const layer = (ask: Ask, tell: Tell) =>
  Layer.succeed(PoolPace, {
    pace: Effect.fn("PoolPace.pace")(function* (providerID: string) {
      const answer = yield* ask({ providerID }).pipe(Effect.timeoutOption(TIMEOUT))
      if (answer._tag === "None") return undefined
      const pace = decode(answer.value)
      return pace._tag === "Some" ? pace.value : undefined
    }, Effect.catchCause(() => Effect.succeed(undefined))),
    started: Effect.fn("PoolPace.started")(
      function* (providerID: string) {
        yield* tell({ providerID }).pipe(Effect.timeoutOption(TIMEOUT))
      },
      Effect.catchCause(() => Effect.void),
    ),
  })
