// The nudge over OpenCode's `session.synthetic`: a steered synthetic message
// whose text the root reads and whose description the TUI draws as a `◈`
// notice row, both the one line. It carries `MARK` in its metadata, so its
// arrival in the inbox is told apart from new input; and it wakes the root,
// which has gone idle.
import { Cause, Effect, Layer } from "effect"
import { MARK } from "../idle.ts"
import { NudgeRefused, Remind, Steer, Tell } from "../service.ts"
import { DRIFT_MARK } from "../skill-drift.ts"

/** What the nudge asks of the host's `session.synthetic`. */
export interface Synthetic {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly delivery: "steer"
  /** False puts it in the context without starting a turn. */
  readonly resume: boolean
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause))

/**
 * The skill-drift note over the same `session.synthetic`: a steered message
 * marked `DRIFT_MARK`, its description the notice row. It is new input, so
 * it ends the root's idle period like any other message.
 */
export const tellLayer = (synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(Tell, {
    tell: (sessionID, note) =>
      Effect.suspend(() =>
        synthetic({ sessionID, text: note.text, description: note.description, metadata: { [DRIFT_MARK]: true }, delivery: "steer", resume: true }),
      ).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.fail(new NudgeRefused({ message: messageOf(Cause.squash(cause)) }))),
        Effect.withSpan("Tell.tell"),
      ),
  })

export const layer = (synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(Steer, {
    nudge: (sessionID, line) =>
      Effect.suspend(() => synthetic({ sessionID, text: line, description: line, metadata: { [MARK]: true }, delivery: "steer", resume: true })).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.fail(new NudgeRefused({ message: messageOf(Cause.squash(cause)) }))),
        Effect.withSpan("Steer.nudge"),
      ),
  })

/** The brief's metadata key: its arrival is not new input to an idle root. */
export const BRIEF_MARK = "dotfiles-opencode.orchestrate.brief"

/**
 * The brief a root gets after its compaction (model.ts `Machines`), over the
 * same `session.synthetic`: steered, marked `BRIEF_MARK`, and with `resume:
 * false`, so it rides on the root's next request and never starts a turn.
 */
export const remindLayer = (synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(Remind, {
    remind: (sessionID, note) =>
      Effect.suspend(() =>
        synthetic({ sessionID, text: note.text, description: note.description, metadata: { [BRIEF_MARK]: true }, delivery: "steer", resume: false }),
      ).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.fail(new NudgeRefused({ message: messageOf(Cause.squash(cause)) }))),
        Effect.withSpan("Remind.remind"),
      ),
  })
