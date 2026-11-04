import { Schema } from "effect"

/** One tool call: the session that made it and the host's call id. A kernel cell's calls share its id. */
export const ToolCallId = Schema.Struct({
  sessionID: Schema.String,
  callID: Schema.String,
})
export interface ToolCallId extends Schema.Schema.Type<typeof ToolCallId> {}

/** The call's stream key, `sessionID/callID`. */
export const streamOf = (id: ToolCallId) => `${id.sessionID}/${id.callID}`
