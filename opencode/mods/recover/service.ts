// The contracts recovery needs from outside: the host's sessions (their
// location switches and a move) and the filesystem (whether a directory
// exists). `laws.ts` states what every Directories owes.
import { Context, type Effect, Schema } from "effect"
import type { Switch } from "./recover.ts"

/** The host could not list a session's location switches. */
export class SwitchesUnreadable extends Schema.TaggedError<SwitchesUnreadable>()("SwitchesUnreadable", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

/** The host refused to move the session. */
export class MoveRefused extends Schema.TaggedError<MoveRefused>()("MoveRefused", {
  sessionID: Schema.String,
  directory: Schema.String,
  message: Schema.String,
}) {}

export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's location-switched messages, newest first. */
    readonly switches: (sessionID: string) => Effect.Effect<ReadonlyArray<Switch>, SwitchesUnreadable>
    /** Moves the session to `directory`, as the host's own "Choose directory" does. */
    readonly move: (sessionID: string, directory: string) => Effect.Effect<void, MoveRefused>
  }
>()("dotfiles-opencode/recover/Sessions") {}

export class Directories extends Context.Service<
  Directories,
  {
    /** Whether `directory` exists and is a directory. */
    readonly exists: (directory: string) => Effect.Effect<boolean>
  }
>()("dotfiles-opencode/recover/Directories") {}
