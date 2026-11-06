// The pool's pace over OpenCode's RPC: the pool mod reads provider quota, so
// OpenCode's own spend counts. No pool, a failure, a timeout or an answer
// that is not a pace all fail open, as an unreachable host does, and the
// reply says which, for the call log. Each new agent is told to the pool's
// `started`; a tell that fails is lost.
import { Cause, Effect, Layer, Schema } from "effect"
import { Answered, FailedOpen, Pace } from "../pace.ts"
import { PoolPace } from "../service.ts"

/** The pool's `pace` method, as the plugin's RPC client calls it. */
export type Ask = (input: { readonly providerID: string }) => Effect.Effect<unknown, unknown>

/** The pool's `started` method. */
export type Tell = (input: { readonly providerID: string }) => Effect.Effect<unknown, unknown>

/** How long the pool has to answer. */
const TIMEOUT = "8 seconds"

/** The host's RPC failures that mean no plugin answers the method: the pool is not loaded. */
const ABSENT = new Set(["rpc.unavailable", "rpc.method_not_found"])

/** The longest cause the log keeps of a failure. */
const MAX_WHY = 200

const decode = Schema.decodeUnknownOption(Pace)

export const layer = (ask: Ask, tell: Tell) =>
  Layer.succeed(PoolPace, {
    pace: Effect.fn("PoolPace.pace")(
      function* (providerID: string) {
        const answer = yield* ask({ providerID }).pipe(Effect.timeoutOption(TIMEOUT))
        if (answer._tag === "None") return FailedOpen.make({ why: `timeout: no answer in ${TIMEOUT}` })
        const pace = decode(answer.value)
        return pace._tag === "Some" ? Answered.make({ pace: pace.value }) : FailedOpen.make({ why: `undecodable: ${clip(JSON.stringify(answer.value) ?? String(answer.value))}` })
      },
      Effect.catchCause((cause) => Effect.succeed(FailedOpen.make({ why: whyOf(cause) }))),
    ),
    started: Effect.fn("PoolPace.started")(
      function* (providerID: string) {
        yield* tell({ providerID }).pipe(Effect.timeoutOption(TIMEOUT))
      },
      Effect.catchCause(() => Effect.void),
    ),
  })

/** Why an ask failed, in a few words: no pool, the host's RPC failure, or the error's message. */
const whyOf = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const error = Cause.squash(cause)
  const defect = cause.reasons.some((reason) => reason._tag === "Die") ? "defect: " : "error: "
  if (typeof error === "object" && error !== null && "type" in error && typeof error.type === "string") {
    const message = "message" in error && typeof error.message === "string" ? error.message : ""
    return clip(ABSENT.has(error.type) ? `no pool: ${error.type}${message ? ` (${message})` : ""}` : `error: ${error.type}${message ? `: ${message}` : ""}`)
  }
  return clip(defect + (error instanceof Error ? error.message : typeof error === "string" ? error : String(error)))
}

const clip = (text: string) => (text.length > MAX_WHY ? `${text.slice(0, MAX_WHY - 1)}…` : text)
