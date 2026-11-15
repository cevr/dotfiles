// What tests/auto-title/run.ts and tests/auto-title.test.ts share: the
// sessions' words, the model's titles and the run's result.
import { Schema } from "effect"

/** The words that name the run's sessions in their prompts. */
export const WORDS = ["alpha", "beta"] as const
export type Word = (typeof WORDS)[number]

/** The model's n-th title for the session named by `word`. */
export const titleOf = (word: Word, n: number) => `Title ${word} ${n}`

/** What the run writes to `<base>/result.json`. */
export const Result = Schema.Struct({
  /** Each session's title after each step, by step. */
  titles: Schema.Record(Schema.String, Schema.String),
  /** The title requests the model got, per session word. */
  requests: Schema.Struct({ alpha: Schema.Int, beta: Schema.Int }),
  /** The plugin's log lines. */
  log: Schema.Array(Schema.String),
})
export type Result = typeof Result.Type
