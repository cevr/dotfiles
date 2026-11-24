import { Schema } from "effect"

export const RefreshRequest = Schema.fromJsonString(Schema.Struct({
  dir: Schema.String,
  tokenURL: Schema.String,
  credentialID: Schema.String,
  busyFile: Schema.String,
}))
