import { Schema } from "effect"

export const Request = Schema.fromJsonString(Schema.Struct({
  base: Schema.String,
  fork: Schema.String,
  bin: Schema.String,
  bare: Schema.Boolean,
  task: Schema.String,
  wake: Schema.optionalKey(Schema.String),
}))
