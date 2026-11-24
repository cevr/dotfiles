import { Schema } from "effect"

/** A presentation read of the persisted child facts: not an execution receipt. */
export const RowFact = Schema.TaggedUnion({
  NoFact: {},
  Failed: { at: Schema.Finite },
  ShellResultUndetermined: { at: Schema.Finite },
})
export type RowFact = typeof RowFact.Type
