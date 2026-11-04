import { Context, type Effect, Schema } from "effect"

/** The runs directory could not be listed, or the status script failed on a run. */
export class RunsUnreadable extends Schema.TaggedError<RunsUnreadable>()("RunsUnreadable", {
  message: Schema.String,
}) {}

/** One orchestrate run's directory name and the table the status script printed for it. */
export interface RunTable {
  readonly name: string
  readonly table: string
}

/**
 * The orchestrate runs of the repository holding `directory`
 * (`tmp/orchestrate/<run>` at its main checkout), each with the table the
 * orchestrate skill's status script derives from its units' logs. Outside a
 * repository, or with no runs directory, there are none.
 */
export class RunTables extends Context.Service<
  RunTables,
  { readonly list: (directory: string) => Effect.Effect<ReadonlyArray<RunTable>, RunsUnreadable> }
>()("dotfiles-opencode/status/RunTables") {}
