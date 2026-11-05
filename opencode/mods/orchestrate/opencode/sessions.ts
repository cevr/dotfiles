// Sessions as OpenCode reports them. A session it cannot read answers
// undefined: the guard then treats it as a main session with no agent.
// A latched child's state is the wakes' mark in its metadata (mods/wake
// latch.ts), which only the wakes write.
import { Effect, Layer, Schema } from "effect"
import { Mark } from "@dotfiles/opencode-wake/latch"
import { Sessions } from "../service.ts"

/** What the guard reads of a session. */
export interface Session {
  readonly parentID?: string
  readonly agent?: string
  /** It has run a turn, or runs one: the host's `time.busy` or `outcome` is set. */
  readonly started?: boolean
  /** The wakes' latch mark, as the session's metadata carries it. */
  readonly latch?: unknown
}

/** OpenCode's session lookup, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<Session, unknown>

const orNone = Effect.catchCause(() => Effect.succeed(undefined))
const markOf = Schema.decodeUnknownOption(Mark)

export const layer = (get: Get) =>
  Layer.succeed(Sessions, {
    parentOf: Effect.fn("Sessions.parentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).parentID || undefined
    }, orNone),
    agentOf: Effect.fn("Sessions.agentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).agent || undefined
    }, orNone),
    startedOf: Effect.fn("Sessions.startedOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).started === true
    }, Effect.catchCause(() => Effect.succeed(false))),
    latchOf: Effect.fn("Sessions.latchOf")(function* (sessionID: string) {
      const mark = markOf((yield* get(sessionID)).latch)
      if (mark._tag === "None" || mark.value.cancelledAt !== undefined || mark.value.failed !== undefined) return undefined
      return mark.value.opensAt
    }, orNone),
  })
