// One tool call, keyed by session and call id: its id, its four commands
// (StartSubagent, OpenLatch, UseTool, FinishSubagent) with their events and
// rejections, and the ToolCall decider. Its history is the call log
// (call-line.ts): the subagent it started or latched, and how that ended.
//
// A new subagent the Sabbath or the pace holds latches (SubagentLatched): the
// call answers at once, the wakes keep the latch (mods/wake latch.ts), and at
// its time OpenLatch decides it again, to latch once more or to start.
//
// Opus first, Codex second: a new start the pace holds on its model, with a
// Codex fallback whose pace admits it, starts at once on the fallback and says
// why (`fallback`). Only when both are held does it latch, on whichever opens
// first. The Sabbath holds both: it latches on the first model.
//
// `decide` never reads the state. A kernel cell's tool calls share the cell's
// call id, so one call can start several subagents, and a finish can arrive
// for a start the log never saw (the plugin loaded mid-call). Every command is
// decided on its own inputs; the state is what the history says happened.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { PaceHold, Whose } from "./pace.ts"
import { Reason, route, unspecific } from "./role.ts"
import { explain, Place, resumesAt, SabbathRest } from "./sabbath.ts"

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
// Starting a subagent: a new one latches over the Sabbath or when the pace
// has no room on its model nor on its fallback, a follow-up is refused over the Sabbath or while its child is
// still latched, and otherwise it runs as the agent the guard routes it to.

/**
 * The model a held start falls back to: the newest Codex model for its role,
 * and the Codex pace's hold on it, if any.
 */
export const Fallback = Schema.Struct({
  model: Schema.String,
  hold: Schema.optionalKey(PaceHold),
})
export interface Fallback extends Schema.Schema.Type<typeof Fallback> {}

/**
 * A subagent call, with what the guard gathered for it: the follow-up's child,
 * its agent and its latch, the model it runs on, the pace's hold, if any, and
 * the fallback gathered when the pace holds a new agent.
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
  /** The Codex model to start on when the pace holds `model`; gathered only for a held new agent that named no model. */
  fallback: Schema.optionalKey(Fallback),
  /** When the follow-up's child, still latched, opens (epoch ms). */
  childLatched: Schema.optionalKey(Schema.Number),
})
export interface StartSubagent extends Schema.Schema.Type<typeof StartSubagent> {}

/** The subagent runs: the agent the guard routed it to and why, on its model; on the fallback, why it moved. */
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
  /** It runs on the Codex fallback: `<first model> held: <its hold's reason>`. */
  fallback: Schema.optionalKey(Schema.String),
})
export interface SubagentStarted extends Schema.Schema.Type<typeof SubagentStarted> {}

/** What holds a latched start: an account's pace, or the Sabbath. */
export const Hold = Schema.Literals(["pace", "sabbath"])
export type Hold = typeof Hold.Type

/**
 * A new subagent is held, and latches: the agent it was routed to, on its
 * model, what holds it and why, when it opens and when it is decided again.
 * Its child is the latch's, once the wakes keep it.
 */
export const SubagentLatched = Schema.TaggedStruct("SubagentLatched", {
  call: ToolCallId,
  from: Schema.String,
  asked: Schema.optionalKey(Schema.String),
  agent: Schema.String,
  reason: Reason,
  model: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.Literal(true)),
  description: Schema.optionalKey(Schema.String),
  /** It latched on the Codex fallback, which opens first: `<first model> held: <its hold's reason>`. */
  fallback: Schema.optionalKey(Schema.String),
  hold: Hold,
  /** The pace's owner, for a pace hold. */
  whose: Schema.optionalKey(Whose),
  /** Why it is held, in the hold's own words. */
  why: Schema.String,
  /** Epoch ms: when the hold says it opens. */
  opensAt: Schema.Number,
  /** Epoch ms: when it is decided again, at or before `opensAt`. */
  recheckAt: Schema.Number,
})
export interface SubagentLatched extends Schema.Schema.Type<typeof SubagentLatched> {}

/** A follow-up to a child that is still latched: it starts by itself at `opensAt`. */
export class StillLatched extends Schema.TaggedError<StillLatched>()("StillLatched", {
  child: Schema.String,
  opensAt: Schema.Number,
}) {}

export declare namespace StartSubagent {
  export type Rejections = SabbathRest | StillLatched
}

/** A held agent asks again no sooner than this after now. */
const MIN_WAIT_MS = 1_000
/** When the pace names no time, ask again this long after now. */
const DEFAULT_WAIT_MS = 60_000
/** A pace may open before the time it names (an agent ends, spend shows): a latch on it is decided again at least this often. */
export const PACE_POLL_MS = 120_000

/** When a pace hold opens: the time it names, no sooner than a second from now; a minute from now when it names none. */
const opensOf = (hold: PaceHold, now: number) =>
  hold.retryAt !== undefined && Number.isFinite(hold.retryAt) ? Math.max(now + MIN_WAIT_MS, hold.retryAt) : now + DEFAULT_WAIT_MS

type Routed = Omit<SubagentStarted, "_tag" | "fallback">

/** The latch a pace hold makes of a routed start: until it opens, asked again every PACE_POLL_MS. */
const pacedOf = (fields: Routed & { readonly fallback?: string }, hold: PaceHold, now: number) => {
  const opensAt = opensOf(hold, now)
  return SubagentLatched.make({ ...fields, hold: "pace", whose: hold.whose, why: hold.reason, opensAt, recheckAt: Math.min(opensAt, now + PACE_POLL_MS) })
}

/**
 * Where a routed start goes. The Sabbath latches it on its model until work
 * resumes. No hold starts it on its model. A hold with a fallback the Codex
 * pace admits starts it on the fallback, saying why. Held on both, it latches
 * on whichever opens first, its own model on a tie; with no fallback, on its own.
 */
const admit = (
  fields: Routed,
  now: number,
  rests: { readonly resumes: number; readonly place: Place } | undefined,
  hold: PaceHold | undefined,
  fallback: Fallback | undefined,
): SubagentStarted | SubagentLatched => {
  if (rests !== undefined)
    return SubagentLatched.make({ ...fields, hold: "sabbath", why: explain(rests.resumes, rests.place), opensAt: rests.resumes, recheckAt: rests.resumes })
  if (hold === undefined) return SubagentStarted.make(fields)
  if (fallback === undefined) return pacedOf(fields, hold, now)
  const moved = { ...fields, model: fallback.model, fallback: `${fields.model ?? "its model"} held: ${hold.reason}` }
  if (fallback.hold === undefined) return SubagentStarted.make(moved)
  return opensOf(fallback.hold, now) < opensOf(hold, now) ? pacedOf(moved, fallback.hold, now) : pacedOf(fields, hold, now)
}

/**
 * Whether a call continues its child naming no particular agent (none, a
 * general one, or the worker; role.ts `unspecific`); such a call keeps the
 * child's agent, so a resume asked of `general` never moves a verifier to the worker.
 */
export const continues = (command: Pick<StartSubagent, "asked" | "child">) =>
  command.child !== undefined && (typeof command.asked !== "string" || unspecific(command.asked))

/**
 * The agent a call runs as and why: a follow-up naming no particular agent
 * keeps its child's; otherwise the guard's route (role.ts), which reads the
 * description only for a new subagent: a follow-up never changes agent by it.
 */
export const routeOf = (
  command: Pick<StartSubagent, "asked" | "child" | "childAgent" | "fullAgent" | "description">,
): { readonly agent: string; readonly reason: Reason } =>
  continues(command) && command.childAgent
    ? { agent: command.childAgent, reason: "continued" }
    : route(command.asked, command.fullAgent, command.child === undefined ? command.description : undefined)

const decideStart = (
  command: StartSubagent,
  now: number,
): Effect.Effect<ReadonlyArray<SubagentStarted | SubagentLatched>, StartSubagent.Rejections> => {
  const resumes = resumesAt(now, command.place)
  // A follow-up continues a child the parent already has: over the Sabbath it is refused, not latched.
  if (resumes !== undefined && command.child !== undefined) return Effect.fail(new SabbathRest({ resumesAt: resumes, place: command.place }))
  if (command.child !== undefined && command.childLatched !== undefined)
    return Effect.fail(new StillLatched({ child: command.child, opensAt: command.childLatched }))
  const { agent, reason } = routeOf(command)
  const fields = {
    call: command.call,
    from: command.from,
    ...(typeof command.asked === "string" ? { asked: command.asked } : {}),
    agent,
    reason,
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.child === undefined ? {} : { child: command.child }),
    ...(command.background ? { background: true as const } : {}),
    ...(command.description === undefined ? {} : { description: command.description }),
  }
  const rests = resumes === undefined ? undefined : { resumes, place: command.place }
  return Effect.succeed([admit(fields, now, rests, command.hold, command.child === undefined ? command.fallback : undefined)])
}

// ── OpenLatch ──
// A latch's time came: the start is decided again on its own terms, its first
// model before its fallback. Still held, it latches again with the new reason
// and time; admitted, it starts in the background on its child, on the model
// that admitted it. A child that already ran records nothing.

/** A latched start at its time, with the pace's hold now, if any, on its first model and on its fallback. */
export const OpenLatch = Schema.TaggedStruct("OpenLatch", {
  call: ToolCallId,
  from: Schema.String,
  agent: Schema.String,
  reason: Reason,
  /** Its first model, the one it latched on unless the fallback opened first. */
  model: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  child: Schema.String,
  place: Place,
  hold: Schema.optionalKey(PaceHold),
  fallback: Schema.optionalKey(Fallback),
  /** The child has run already: an earlier open started it. */
  started: Schema.Boolean,
})
export interface OpenLatch extends Schema.Schema.Type<typeof OpenLatch> {}

export declare namespace OpenLatch {
  export type Rejections = never
}

const decideOpen = (command: OpenLatch, now: number): Effect.Effect<ReadonlyArray<SubagentStarted | SubagentLatched>> => {
  if (command.started) return Effect.succeed([])
  const resumes = resumesAt(now, command.place)
  const fields = {
    call: command.call,
    from: command.from,
    agent: command.agent,
    reason: command.reason,
    ...(command.model === undefined ? {} : { model: command.model }),
    child: command.child,
    background: true as const,
    ...(command.description === undefined ? {} : { description: command.description }),
  }
  const rests = resumes === undefined ? undefined : { resumes, place: command.place }
  return Effect.succeed([admit(fields, now, rests, command.hold, command.fallback)])
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
// still running in the background, latched, or failed.

export const Status = Schema.Literals(["completed", "running", "latched", "error"])
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
export const Latched = Schema.TaggedStruct("Latched", { agent: Schema.String, opensAt: Schema.Number })
export const Finished = Schema.TaggedStruct("Finished", { status: Status })
export const Stage = Schema.Union([Idle, Started, Latched, Finished])
export type Stage = typeof Stage.Type

export type Command = StartSubagent | OpenLatch | UseTool | FinishSubagent
export type Event = SubagentStarted | SubagentLatched | SubagentFinished
export type Rejection = SabbathRest | StillLatched

export const ToolCall: Decider<Stage, Command, Event, Rejection> = {
  initial: Idle.make({}),
  decide: (_state, command, now) => {
    switch (command._tag) {
      case "StartSubagent":
        return decideStart(command, now)
      case "OpenLatch":
        return decideOpen(command, now)
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
      case "SubagentLatched":
        return Latched.make({ agent: event.agent, opensAt: event.opensAt })
      case "SubagentFinished":
        return Finished.make({ status: event.status })
    }
  },
}
