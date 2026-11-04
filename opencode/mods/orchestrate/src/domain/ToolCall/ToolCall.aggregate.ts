// One tool call, keyed by session and call id. Its history is the call log
// (CallLine.ts): the subagent it started and how that ended.
//
// `decide` never reads the state. A kernel cell's tool calls share the cell's
// call id, so one call can start several subagents, and a finish can arrive
// for a start the log never saw (the plugin loaded mid-call). Every command is
// decided on its own inputs; the state is what the history says happened.
import { Schema } from "effect"
import type { Decider } from "../../../../../lib/decider.ts"
import * as FinishSubagent from "./FinishSubagent.command.ts"
import type { SabbathRest } from "./SabbathRest.rejection.ts"
import * as StartSubagent from "./StartSubagent.command.ts"
import * as UseTool from "./UseTool.command.ts"

export const Idle = Schema.TaggedStruct("Idle", {})
export const Started = Schema.TaggedStruct("Started", { agent: Schema.String })
export const Finished = Schema.TaggedStruct("Finished", { status: FinishSubagent.Status })
export const Stage = Schema.Union([Idle, Started, Finished])
export type Stage = typeof Stage.Type

export type Command = StartSubagent.StartSubagent | UseTool.UseTool | FinishSubagent.FinishSubagent
export type Event = StartSubagent.SubagentStarted | FinishSubagent.SubagentFinished
export type Rejection = SabbathRest | StartSubagent.PaceHeld

export const ToolCall: Decider<Stage, Command, Event, Rejection> = {
  initial: Idle.make({}),
  decide: (_state, command, now) => {
    switch (command._tag) {
      case "StartSubagent":
        return StartSubagent.decide(command, now)
      case "UseTool":
        return UseTool.decide(command, now)
      case "FinishSubagent":
        return FinishSubagent.decide(command)
    }
  },
  evolve: (_state, event) => {
    switch (event._tag) {
      case "SubagentStarted":
        return Started.make({ agent: event.agent })
      case "SubagentFinished":
        return Finished.make({ status: event.status })
    }
  },
}
