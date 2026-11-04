// Any other tool call: over the Sabbath a running subagent's next call is
// refused so it ends its turn. The main session answers as always.
import { Effect, Schema } from "effect"
import { Place, resumesAt } from "../Sabbath.ts"
import { SabbathRest } from "./SabbathRest.rejection.ts"
import { ToolCallId } from "./ToolCall.id.ts"

/** A tool call other than `subagent`, and whether its session is a subagent's (it has a parent). */
export const UseTool = Schema.TaggedStruct("UseTool", {
  call: ToolCallId,
  tool: Schema.String,
  inSubagent: Schema.Boolean,
  place: Place,
})
export interface UseTool extends Schema.Schema.Type<typeof UseTool> {}

export declare namespace UseTool {
  export type Rejections = SabbathRest
}

/** Records nothing: the call runs, or the rest refuses it. */
export const decide = (command: UseTool, now: number): Effect.Effect<ReadonlyArray<never>, UseTool.Rejections> => {
  const resumes = command.inSubagent ? resumesAt(now, command.place) : undefined
  return resumes === undefined ? Effect.succeed([]) : Effect.fail(new SabbathRest({ resumesAt: resumes, place: command.place }))
}
