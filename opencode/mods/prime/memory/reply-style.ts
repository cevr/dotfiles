// Each session's kept reply-style section in memory, for the tests: what the
// plugin's storage keeps (../opencode/reply-style.ts), held in a map.
import { Effect, Layer, Option } from "effect"
import { ReplyStyles } from "../reply-style.ts"

export const make = Effect.sync(() => {
  const entries = new Map<string, string>()
  return ReplyStyles.of({
    kept: (sessionID) => Effect.sync(() => Option.fromNullishOr(entries.get(sessionID))),
    keep: (sessionID, text) =>
      Effect.sync(() => {
        const kept = Option.fromNullishOr(entries.get(sessionID))
        if (Option.isSome(kept)) return kept.value
        entries.set(sessionID, text)
        return text
      }),
    forget: (sessionID) => Effect.sync(() => void entries.delete(sessionID)),
  })
})

export const layer = Layer.effect(ReplyStyles, make)
