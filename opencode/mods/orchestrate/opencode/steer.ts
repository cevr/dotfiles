// The nudge over OpenCode's `session.synthetic`: a steered synthetic message
// whose text the root reads and whose description the TUI draws as a `◈`
// notice row, both the one line. It carries `MARK` in its metadata, so its
// arrival in the inbox is told apart from new input; and it wakes the root,
// which has gone idle.
import { Cause, Effect, Layer } from "effect"
import { MARK } from "../idle.ts"
import { NudgeRefused, Steer } from "../service.ts"

/** What the nudge asks of the host's `session.synthetic`. */
export interface Synthetic {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly delivery: "steer"
  readonly resume: true
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause))

export const layer = (synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(Steer, {
    nudge: (sessionID, line) =>
      Effect.suspend(() => synthetic({ sessionID, text: line, description: line, metadata: { [MARK]: true }, delivery: "steer", resume: true })).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.fail(new NudgeRefused({ message: messageOf(Cause.squash(cause)) }))),
        Effect.withSpan("Steer.nudge"),
      ),
  })
