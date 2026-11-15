// Notices over OpenCode's `session.synthetic`: a steered synthetic message,
// read at the session's next step, whose description the TUI draws as a `◈`
// notice row; `resume` wakes an idle session. A session that cannot take it
// is logged and skipped, as the land it reports on is already done.
import { Cause, Effect, Layer } from "effect"
import { Notices } from "../service.ts"

/** What a notice asks of the host's `session.synthetic`. */
export interface Synthetic {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly delivery: "steer"
  readonly resume: true
}

export const layer = (synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(
    Notices,
    Notices.of({
      wake: (sessionID, notice) =>
        Effect.suspend(() =>
          synthetic({ sessionID, text: notice.text, description: notice.description, metadata: { rift: "land" }, delivery: "steer", resume: true }),
        ).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning(`rift: could not wake ${sessionID}`, Cause.squash(cause))),
          Effect.withSpan("Notices.wake"),
        ),
    }),
  )
