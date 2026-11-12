// The subagent calls orchestrate's call log records, folded by caller and
// call id: tool call ids can repeat across sessions. A `call` line starts a
// call; a `done` line adds its child and how it ended. A background call's
// `done` with status `running` means its child still owns work, so it stays
// live. The log is another program's, so its lines arrive here already
// decoded (filestore/call-log.ts); the fold keeps the order calls first appeared in.
import { HashMap, Option, Schema } from "effect"
import type { Fold } from "@dotfiles/decider/decider"
import type { AgentCall } from "./status.ts"

/** A `call` line: a subagent call started. */
export const AgentCalled = Schema.TaggedStruct("AgentCalled", {
  sessionID: Schema.String,
  callID: Schema.String,
  agent: Schema.String,
  description: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
})
export interface AgentCalled extends Schema.Schema.Type<typeof AgentCalled> {}

/** A `done` line: a subagent call returned, with its child and status when the line names them. */
export const AgentReturned = Schema.TaggedStruct("AgentReturned", {
  sessionID: Schema.String,
  callID: Schema.String,
  child: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
})
export interface AgentReturned extends Schema.Schema.Type<typeof AgentReturned> {}

export type Event = AgentCalled | AgentReturned

/** Each call by `sessionID/callID`, with the place it first appeared in. */
export interface AgentCallsState {
  readonly calls: HashMap.HashMap<string, { readonly order: number; readonly call: AgentCall }>
  readonly next: number
}

const keyOf = (event: Event) => `${event.sessionID}/${event.callID}`

export const AgentCalls: Fold<AgentCallsState, Event> = {
  initial: { calls: HashMap.empty(), next: 0 },
  evolve: (state, event) => {
    const key = keyOf(event)
    const known = HashMap.get(state.calls, key)
    switch (event._tag) {
      case "AgentCalled": {
        const call: AgentCall = {
          sessionID: event.sessionID,
          callID: event.callID,
          agent: event.agent,
          ...(event.description === undefined ? {} : { description: event.description }),
          ...(event.child === undefined ? {} : { child: event.child }),
        }
        // A call seen again starts over, in its first place.
        return Option.isSome(known)
          ? { ...state, calls: HashMap.set(state.calls, key, { order: known.value.order, call }) }
          : { calls: HashMap.set(state.calls, key, { order: state.next, call }), next: state.next + 1 }
      }
      case "AgentReturned": {
        if (Option.isNone(known)) return state
        const call: AgentCall = {
          ...known.value.call,
          ...(event.child === undefined ? {} : { child: event.child }),
          ...(event.status === undefined ? {} : { status: event.status }),
        }
        return { ...state, calls: HashMap.set(state.calls, key, { order: known.value.order, call }) }
      }
    }
  },
}

/** The calls still live, in the order they first appeared: every call that has not completed or failed. */
export const live = (state: AgentCallsState): ReadonlyArray<AgentCall> =>
  HashMap.toValues(state.calls)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.call)
    .filter((call) => call.status !== "completed" && call.status !== "error")

/** `<role> <unit> r<N>`: the hand-back form. */
const ROLE_FIRST = /^(?:planner|implementor|verifier) (\S+)/
/** `<unit>[ rN] <role>[ rN][ (note)]`: a one-word lowercase slug, the role, and only a round and a note after it. */
const ROLE_AFTER = /^([a-z0-9#][a-z0-9._#/-]*)(?: r\d+)? (?:planner|implementor|verifier)(?: r\d+)?(?: \([^()]*\))?$/
const ROUND = /^r\d+$/

/** The first group `pattern` captures in `text`, if it matches. */
const captured = (pattern: RegExp, text: string): Option.Option<string> => Option.fromNullishOr(pattern.exec(text)?.[1])

/**
 * The unit an orchestrate step's description names, in the skill's two forms:
 * `<role> <unit> r<N>`, or `<unit>[ rN] <role>[ rN][ (note)]`. The same
 * reading as orchestrate's described.ts, which the status domain may not
 * import; prose that only mentions a role names none.
 */
export const stepUnit = (description: string): Option.Option<string> => {
  const text = description.trim().replace(/\s+/g, " ")
  return Option.orElse(captured(ROLE_FIRST, text), () => Option.filter(captured(ROLE_AFTER, text), (unit) => !ROUND.test(unit)))
}

/**
 * The session that owns a run: the one that started the latest step of one of
 * its `units` (a root owns a run once it starts one of its steps, as
 * orchestrate's idle.ts reads it), over every call the log recorded, live or
 * returned. None when no step of the run was started.
 */
export const runSession = (state: AgentCallsState, units: ReadonlyArray<string>): Option.Option<string> => {
  const names = new Set(units)
  const steps = HashMap.toValues(state.calls)
    .filter(({ call }) => Option.exists(stepUnit(call.description ?? ""), (unit) => names.has(unit)))
    .toSorted((left, right) => left.order - right.order)
  return Option.map(Option.fromNullishOr(steps.at(-1)), ({ call }) => call.sessionID)
}
