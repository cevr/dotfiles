// Starting a subagent: the call is refused over the Sabbath, held when the
// pace has no room, and otherwise runs as the agent the guard routes it to.
import { Effect, Schema } from "effect"
import { PaceHold, Whose } from "../Pace.ts"
import { Reason, route } from "../Role.ts"
import { Place, resumesAt } from "../Sabbath.ts"
import { SabbathRest } from "./SabbathRest.rejection.ts"
import { ToolCallId } from "./ToolCall.id.ts"

/**
 * A subagent call, with what the guard gathered for it: the follow-up's child
 * and its agent, the model it runs on, and the pace's hold, if any.
 */
export const StartSubagent = Schema.TaggedStruct("StartSubagent", {
  call: ToolCallId,
  /** The agent making the call. */
  from: Schema.String,
  /** The input's `agent`, as the model passed it. */
  asked: Schema.Unknown,
  /** The session a follow-up continues. */
  child: Schema.optionalKey(Schema.String),
  /** The follow-up's child's agent, gathered when the call names none. */
  childAgent: Schema.optionalKey(Schema.String),
  /** The model it runs on: the input's, else the role's at its effort, when that model offers it. */
  model: Schema.optionalKey(Schema.String),
  background: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  /** The full-agent escape: an untyped or general call runs as asked. */
  fullAgent: Schema.Boolean,
  place: Place,
  /** The pace's answer when it holds a new agent; a follow-up is never paced. */
  hold: Schema.optionalKey(PaceHold),
})
export interface StartSubagent extends Schema.Schema.Type<typeof StartSubagent> {}

/** The subagent runs: the agent the guard routed it to and why, on its model. */
export const SubagentStarted = Schema.TaggedStruct("SubagentStarted", {
  call: ToolCallId,
  from: Schema.String,
  asked: Schema.optionalKey(Schema.String),
  agent: Schema.String,
  reason: Reason,
  model: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.Literal(true)),
  description: Schema.optionalKey(Schema.String),
})
export interface SubagentStarted extends Schema.Schema.Type<typeof SubagentStarted> {}

/** The pace holds a new subagent: whose pace, why, and when to ask again (epoch ms). */
export class PaceHeld extends Schema.TaggedError<PaceHeld>()("PaceHeld", {
  whose: Whose,
  reason: Schema.String,
  retryAt: Schema.Number,
}) {}

export declare namespace StartSubagent {
  export type Rejections = SabbathRest | PaceHeld
}

/** A held agent asks again no sooner than this after now. */
const MIN_WAIT_MS = 1_000
/** When the pace names no time, ask again this long after now. */
const DEFAULT_WAIT_MS = 60_000

/** Whether a call continues its child with no agent named; such a call keeps the child's agent. */
export const continues = (command: Pick<StartSubagent, "asked" | "child">) =>
  command.child !== undefined && (typeof command.asked !== "string" || command.asked === "")

/**
 * The agent a call runs as and why: a follow-up naming no agent keeps its
 * child's; otherwise the guard's route (Role.ts).
 */
export const routeOf = (
  command: Pick<StartSubagent, "asked" | "child" | "childAgent" | "fullAgent">,
): { readonly agent: string; readonly reason: Reason } =>
  continues(command) && command.childAgent
    ? { agent: command.childAgent, reason: "continued" }
    : route(command.asked, command.fullAgent)

export const decide = (command: StartSubagent, now: number): Effect.Effect<ReadonlyArray<SubagentStarted>, StartSubagent.Rejections> => {
  const resumes = resumesAt(now, command.place)
  if (resumes !== undefined) return Effect.fail(new SabbathRest({ resumesAt: resumes, place: command.place }))
  const { agent, reason } = routeOf(command)
  if (command.hold !== undefined) {
    const { whose, reason: why, retryAt } = command.hold
    return Effect.fail(
      new PaceHeld({
        whose,
        reason: why,
        retryAt: retryAt !== undefined && Number.isFinite(retryAt) ? Math.max(now + MIN_WAIT_MS, retryAt) : now + DEFAULT_WAIT_MS,
      }),
    )
  }
  return Effect.succeed([
    SubagentStarted.make({
      call: command.call,
      from: command.from,
      ...(typeof command.asked === "string" ? { asked: command.asked } : {}),
      agent,
      reason,
      ...(command.model === undefined ? {} : { model: command.model }),
      ...(command.child === undefined ? {} : { child: command.child }),
      ...(command.background ? { background: true as const } : {}),
      ...(command.description === undefined ? {} : { description: command.description }),
    }),
  ])
}
