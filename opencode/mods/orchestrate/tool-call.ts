// One tool call, keyed by session and call id: its id, its three commands
// (StartSubagent, UseTool, FinishSubagent) with their events and rejections,
// and the ToolCall decider. Its history is the call log (call-line.ts): the
// subagent it started and how that ended.
//
// `decide` never reads the state. A kernel cell's tool calls share the cell's
// call id, so one call can start several subagents, and a finish can arrive
// for a start the log never saw (the plugin loaded mid-call). Every command is
// decided on its own inputs; the state is what the history says happened.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { PaceHeld, PaceHold } from "./pace.ts"
import { Reason, route } from "./role.ts"
import { Place, resumesAt, SabbathRest } from "./sabbath.ts"

// ── The id ──

/** One tool call: the session that made it and the host's call id. A kernel cell's calls share its id. */
export const ToolCallId = Schema.Struct({
  sessionID: Schema.String,
  callID: Schema.String,
})
export interface ToolCallId extends Schema.Schema.Type<typeof ToolCallId> {}

/** The call's stream key, `sessionID/callID`. */
export const streamOf = (id: ToolCallId) => `${id.sessionID}/${id.callID}`

// ── StartSubagent ──
// Starting a subagent: the call is refused over the Sabbath, held when the
// pace has no room, and otherwise runs as the agent the guard routes it to.

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
 * child's; otherwise the guard's route (role.ts).
 */
export const routeOf = (
  command: Pick<StartSubagent, "asked" | "child" | "childAgent" | "fullAgent">,
): { readonly agent: string; readonly reason: Reason } =>
  continues(command) && command.childAgent
    ? { agent: command.childAgent, reason: "continued" }
    : route(command.asked, command.fullAgent)

const decideStart = (
  command: StartSubagent,
  now: number,
): Effect.Effect<ReadonlyArray<SubagentStarted>, StartSubagent.Rejections> => {
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

// ── UseTool ──
// Any other tool call: over the Sabbath a running subagent's next call is
// refused so it ends its turn. The main session answers as always.

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
const decideUse = (command: UseTool, now: number): Effect.Effect<ReadonlyArray<never>, UseTool.Rejections> => {
  const resumes = command.inSubagent ? resumesAt(now, command.place) : undefined
  return resumes === undefined ? Effect.succeed([]) : Effect.fail(new SabbathRest({ resumesAt: resumes, place: command.place }))
}

// ── FinishSubagent ──
// A subagent call returned: its child session, and whether it finished, is
// still running in the background, or failed.

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

const decideFinish = (command: FinishSubagent): Effect.Effect<ReadonlyArray<SubagentFinished>> =>
  Effect.succeed([
    SubagentFinished.make({
      call: command.call,
      ...(command.child === undefined ? {} : { child: command.child }),
      status: command.status,
    }),
  ])

// ── The ToolCall decider ──

export const Idle = Schema.TaggedStruct("Idle", {})
export const Started = Schema.TaggedStruct("Started", { agent: Schema.String })
export const Finished = Schema.TaggedStruct("Finished", { status: Status })
export const Stage = Schema.Union([Idle, Started, Finished])
export type Stage = typeof Stage.Type

export type Command = StartSubagent | UseTool | FinishSubagent
export type Event = SubagentStarted | SubagentFinished
export type Rejection = SabbathRest | PaceHeld

export const ToolCall: Decider<Stage, Command, Event, Rejection> = {
  initial: Idle.make({}),
  decide: (_state, command, now) => {
    switch (command._tag) {
      case "StartSubagent":
        return decideStart(command, now)
      case "UseTool":
        return decideUse(command, now)
      case "FinishSubagent":
        return decideFinish(command)
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
