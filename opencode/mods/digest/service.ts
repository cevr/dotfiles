// The digest's own store: the lines of its log on this host, as its plugin keeps them. A writer never reaches it:
// writers go through `DigestLog` (event.ts), which the plugin's RPC answers by appending here.
import { Context, type Effect, Schema } from "effect"

/** The log could not be written. */
export class DigestUnwritable extends Schema.TaggedError<DigestUnwritable>()("DigestUnwritable", { message: Schema.String }) {}

/** The log could not be read. */
export class DigestUnreadable extends Schema.TaggedError<DigestUnreadable>()("DigestUnreadable", { message: Schema.String }) {}

export class DigestLines extends Context.Service<
  DigestLines,
  {
    /** Append one line (no newline in it) as one write, in the month file of `t` (epoch ms). */
    readonly append: (line: string, t: number) => Effect.Effect<void, DigestUnwritable>
    /** Every line written, the month files in order. */
    readonly read: Effect.Effect<string, DigestUnreadable>
  }
>()("dotfiles-opencode/digest/DigestLines") {}
