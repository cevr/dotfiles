// The call log: one JSON line per started, latched or finished subagent and
// per refused call, which a status pane reads. Its key order is the format.
//
// A new subagent's line says what admitted or held it: each pace asked, by
// its answer or by why it failed open, so a start a measured pace admitted
// reads apart from one a broken RPC let through. A follow-up asks no pace.
import type { PaceReply } from "./pace.ts"
import type { Reason } from "./role.ts"
import type { Hold, Status, SubagentFinished, SubagentLatched, SubagentStarted, ToolCallId } from "./tool-call.ts"

/** What one pace said of a new agent, as the log keeps it: its answer, or why it gave none and failed open. */
export type Admission =
  | { readonly ok: boolean; readonly measured: boolean; readonly reason: string }
  | { readonly failOpen: string }

/**
 * The paces asked for a new agent, each only when asked: the pool's (`pace`)
 * and the Codex admission script's (`codex`) on its model, and the same on
 * its Codex fallback when it was offered one.
 */
export interface Asked {
  readonly pace?: PaceReply
  readonly codex?: PaceReply
  readonly fallbackPace?: PaceReply
  readonly fallbackCodex?: PaceReply
}

/** One reply as the log keeps it. */
export const admissionOf = (reply: PaceReply): Admission =>
  reply._tag === "FailedOpen" ? { failOpen: reply.why } : { ok: reply.pace.ok, measured: reply.pace.measured, reason: reply.pace.reason }

/** The line's admission fields, in the format's order; none for a call that asked no pace. */
const admissions = (asked: Asked | undefined) => ({
  ...(asked?.pace === undefined ? {} : { pace: admissionOf(asked.pace) }),
  ...(asked?.codex === undefined ? {} : { codex: admissionOf(asked.codex) }),
  ...(asked?.fallbackPace === undefined ? {} : { fallbackPace: admissionOf(asked.fallbackPace) }),
  ...(asked?.fallbackCodex === undefined ? {} : { fallbackCodex: admissionOf(asked.fallbackCodex) }),
})

/**
 * Why a new planner start runs on the role's chain (its own model, then Codex)
 * instead of the planner's first model (the plugin's `planner` option): that
 * model, and why (`<model> held: <reason>`, `<model> is not offered`). A
 * type, not an interface, so a latch's JSON context can keep it.
 */
export type FirstRecord = {
  readonly model: string
  readonly fellBack: string
}

/** A line's admission fields, and why a new planner start left the planner's first model. */
interface Admissions {
  /** The pool's pace on its model. */
  readonly pace?: Admission
  /** The Codex admission on its model. */
  readonly codex?: Admission
  /** The pool's pace on its Codex fallback. */
  readonly fallbackPace?: Admission
  /** The Codex admission on its Codex fallback. */
  readonly fallbackCodex?: Admission
  /** The planner's first model, and why this planner start does not run on it. */
  readonly first?: FirstRecord
}

const firstOf = (first: FirstRecord | undefined) => (first === undefined ? {} : { first })

/** One line of the call log. `asked` is what the model passed; `agent` is what runs. */
export type CallLine =
  | ({
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
      /** A worker asked for this variant (`max`) and runs at its model's default. */
      readonly lowered?: string
    } & Admissions)
  | {
      readonly kind: "done"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly child?: string
      readonly status: Status
    }
  | ({
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
      /** A worker asked for this variant (`max`) and latched at its model's default. */
      readonly lowered?: string
    } & Admissions & {
      readonly hold: Hold
      readonly why: string
      /** ISO 8601: when the hold says it opens. */
      readonly opens: string
    })
  | {
      readonly kind: "denied"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly tool: string
      readonly why: string
    }

/** A started subagent's line, at `at` (ISO 8601), with the paces `asked` for it and why it left the planner's first model. */
export const started = (event: SubagentStarted, at: string, asked?: Asked, first?: FirstRecord): CallLine => ({
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
  ...(event.lowered === undefined ? {} : { lowered: event.lowered }),
  ...admissions(asked),
  ...firstOf(first),
})

/** A latched subagent's line: the paces `asked` for it, why it left the planner's first model, what holds it, why, and when it opens. */
export const latched = (event: SubagentLatched, at: string, asked?: Asked, first?: FirstRecord): CallLine => ({
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
  ...(event.lowered === undefined ? {} : { lowered: event.lowered }),
  ...admissions(asked),
  ...firstOf(first),
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
