import { Schema } from "effect"
import { MarkRead } from "../../wake/latch.ts"
import { RowFact } from "../child-row.ts"
import { Basis, Observation } from "../child-lifecycle.ts"

const Ordered = Schema.Struct({ ...Observation.fields, revision: Schema.Int, basis: Basis })
const Row = Schema.Struct({
  child: Schema.String, mark: MarkRead, observation: Ordered, at: Schema.Finite,
  attention: Schema.optionalKey(Schema.Literals(["permission", "question"])),
  /** Compatibility projection for a round-3 diagnostic client; does not decide the lifecycle. */
  fact: RowFact,
})
export type OwnerAnswer = typeof Row.Type
const Read = Schema.Struct({ children: Schema.Array(Schema.String).check(Schema.isMaxLength(512)) })
const Reply = Schema.Struct({ rows: Schema.Array(Row) })
export type RowsReply = typeof Reply.Type
const Changed = Schema.Struct({ child: Schema.String, revision: Schema.optionalKey(Schema.Int) })
const segment = "dotfiles-opencode.kernel.rows"

export const CHILD_ROWS = {
  id: segment,
  methods: { read: { input: Schema.toStandardSchemaV1(Read), output: Schema.toStandardSchemaV1(Reply) } },
  events: { changed: { schema: Schema.toStandardSchemaV1(Changed) } },
} as const

export const readRows = Schema.decodeUnknownOption(Reply)
export const rowsChanged = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal(`rpc.${segment}.changed`), data: Changed }))
