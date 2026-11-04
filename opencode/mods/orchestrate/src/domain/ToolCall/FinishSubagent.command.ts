// A subagent call returned: its child session, and whether it finished, is
// still running in the background, or failed.
import { Effect, Schema } from "effect"
import { ToolCallId } from "./ToolCall.id.ts"

export const Status = Schema.Literals(["completed", "running", "error"])
export type Status = typeof Status.Type

export const FinishSubagent = Schema.TaggedStruct("FinishSubagent", {
  call: ToolCallId,
  child: Schema.optionalKey(Schema.String),
  status: Status,
})
export interface FinishSubagent extends Schema.Schema.Type<typeof FinishSubagent> {}

export const SubagentFinished = Schema.TaggedStruct("SubagentFinished", {
  call: ToolCallId,
  child: Schema.optionalKey(Schema.String),
  status: Status,
})
export interface SubagentFinished extends Schema.Schema.Type<typeof SubagentFinished> {}

export declare namespace FinishSubagent {
  export type Rejections = never
}

export const decide = (command: FinishSubagent): Effect.Effect<ReadonlyArray<SubagentFinished>> =>
  Effect.succeed([
    SubagentFinished.make({
      call: command.call,
      ...(command.child === undefined ? {} : { child: command.child }),
      status: command.status,
    }),
  ])
