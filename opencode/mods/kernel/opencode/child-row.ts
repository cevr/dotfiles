import { Schema } from "effect"
import { MarkRead } from "../../wake/latch.ts"
import { RowFact } from "../child-row.ts"

const Row = Schema.Struct({ child: Schema.String, mark: MarkRead, fact: RowFact })
const Read = Schema.Struct({ children: Schema.Array(Schema.String).check(Schema.isMaxLength(512)) })
const Reply = Schema.Struct({ rows: Schema.Array(Row) })
const Changed = Schema.Struct({ child: Schema.String })
const segment = "dotfiles-opencode.kernel.rows"

export const CHILD_ROWS = {
  id: segment,
  methods: { read: { input: Schema.toStandardSchemaV1(Read), output: Schema.toStandardSchemaV1(Reply) } },
  events: { changed: { schema: Schema.toStandardSchemaV1(Changed) } },
} as const

export const readRows = Schema.decodeUnknownOption(Reply)
export const rowsChanged = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal(`rpc.${segment}.changed`), data: Changed }))
