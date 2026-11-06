// The call log: one JSON line per started, latched or finished subagent and
// per refused call, which a status pane reads. Its key order is the format.
import type { Reason } from "./role.ts"
import type { Hold, Status, SubagentFinished, SubagentLatched, SubagentStarted, ToolCallId } from "./tool-call.ts"

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
      /** It runs on the Codex fallback, and why: `<first model> held: <reason>`. */
      readonly fallback?: string
    }
  | {
      readonly kind: "done"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly child?: string
      readonly status: Status
    }
  | {
      readonly kind: "latched"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly from: string
      readonly asked?: string
      readonly agent: string
      readonly reason: Reason
      readonly model?: string
      readonly child?: string
      readonly description?: string
      /** It latched on the Codex fallback, which opens first, and why. */
      readonly fallback?: string
      readonly hold: Hold
      readonly why: string
      /** ISO 8601: when the hold says it opens. */
      readonly opens: string
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
  ...(event.fallback === undefined ? {} : { fallback: event.fallback }),
})

/** A latched subagent's line: what holds it, why, and when it opens. */
export const latched = (event: SubagentLatched, at: string): CallLine => ({
  kind: "latched",
  at,
  sessionID: event.call.sessionID,
  callID: event.call.callID,
  from: event.from,
  ...(event.asked === undefined ? {} : { asked: event.asked }),
  agent: event.agent,
  reason: event.reason,
  ...(event.model === undefined ? {} : { model: event.model }),
  ...(event.child === undefined ? {} : { child: event.child }),
  ...(event.description === undefined ? {} : { description: event.description }),
  ...(event.fallback === undefined ? {} : { fallback: event.fallback }),
  hold: event.hold,
  why: event.why,
  opens: new Date(event.opensAt).toISOString(),
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
