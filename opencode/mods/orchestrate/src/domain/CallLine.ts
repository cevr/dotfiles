// The call log: one JSON line per started or finished subagent and per
// refused call, which a status pane reads. Its key order is the format.
import type { SubagentFinished } from "./ToolCall/FinishSubagent.command.ts"
import type { SubagentStarted } from "./ToolCall/StartSubagent.command.ts"
import type { Reason } from "./Role.ts"
import type { ToolCallId } from "./ToolCall/ToolCall.id.ts"

/** One line of the call log. `asked` is what the model passed; `agent` is what runs. */
export type CallLine =
  | {
      readonly kind: "call"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly from: string
      readonly asked?: string
      readonly agent: string
      readonly reason: Reason
      readonly model?: string
      readonly child?: string
      readonly background?: boolean
      readonly description?: string
    }
  | {
      readonly kind: "done"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly child?: string
      readonly status: "completed" | "running" | "error"
    }
  | {
      readonly kind: "denied"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly tool: string
      readonly why: string
    }

/** A started subagent's line, at `at` (ISO 8601). */
export const started = (event: SubagentStarted, at: string): CallLine => ({
  kind: "call",
  at,
  sessionID: event.call.sessionID,
  callID: event.call.callID,
  from: event.from,
  ...(event.asked === undefined ? {} : { asked: event.asked }),
  agent: event.agent,
  reason: event.reason,
  ...(event.model === undefined ? {} : { model: event.model }),
  ...(event.child === undefined ? {} : { child: event.child }),
  ...(event.background === undefined ? {} : { background: event.background }),
  ...(event.description === undefined ? {} : { description: event.description }),
})

/** A finished subagent's line. */
export const finished = (event: SubagentFinished, at: string): CallLine => ({
  kind: "done",
  at,
  sessionID: event.call.sessionID,
  callID: event.call.callID,
  ...(event.child === undefined ? {} : { child: event.child }),
  status: event.status,
})

/** A refused call's line: the tool and why it was refused. */
export const denied = (call: ToolCallId, tool: string, why: string, at: string): CallLine => ({
  kind: "denied",
  at,
  sessionID: call.sessionID,
  callID: call.callID,
  tool,
  why,
})
