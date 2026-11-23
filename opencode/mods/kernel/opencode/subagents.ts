// The `subagents` tool: a session lists, reads and stops its own
// subagents (../subagents.ts), through the host's sessions. A direct tool, so
// a session without the kernel has it too, and a kernel cell reaches it as
// `tools.subagents`; a cell's subagent handle (../worker/subagent-handle.ts)
// calls it underneath.
//
// A stop is the host's own session stop (`ctx.session.stop`, the fork's
// addition to the plugin API; upstream has only `interrupt`, which leaves the
// session's shells and queued input to wake it): it ends the subagent's turn,
// its background shells and its queued prompts, and the host settles it as
// cancelled and tells its parent once, never later that it finished.
//
// Every answer is `{ subagents }`: the session's subagents for a list, the one
// it named for the other actions.
//
// It has no wait: a subagent reports when it is done, as a message to its
// parent, so a parent never blocks on one (a blocked parent queues the
// owner's messages behind the wait).
//
// At run time a plugin gets only `effect` and `@opencode/plugin` from
// OpenCode; any other package comes from the checkout's own node_modules,
// links that point nowhere in a copy of it. So this file imports
// `@opencode/schema` for its types only and brands a session id itself, as
// the queue's host does (mods/queue/opencode/host.ts).
import { type Plugin, Tool } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionID as HostSessionID } from "@opencode/schema/session-id"
import { DateTime, Effect, Match, Option, Schema } from "effect"
import type { Observation, Phase } from "../child-lifecycle.ts"
import { Listed, make, type Host, type Session, type Subagents, type View } from "../subagents.ts"
import type { ChildLifecycle } from "./child-lifecycle.ts"

export const name = "subagents"

/** A session id as the host's calls take it, branded here (see the header). */
const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const sessionIDOf = (sessionID: string): HostSessionID => SessionID.make(sessionID)

/** Why there is no wait, as the tool says it: a finished subagent's report arrives on its own. */
export const NO_WAIT = "A finished subagent's report arrives as your next message. Keep working or end your turn; don't wait."

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "get", "stop"]).annotate({
    description: 'What to do: "list" this session\'s subagents, "get" one (its state and last message), or "stop" one.',
    message: `Expected "list", "get" or "stop"; there is no "wait". ${NO_WAIT}`,
  }),
  sessionID: Schema.optionalKey(SessionID).annotate({ description: "Get, stop: the subagent's sessionID, as the subagent tool returned it." }),
})
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Output = Listed

export const description = [
  "List, read and stop this session's descendants.",
  '{ action: "list" } lists them. { action: "get", sessionID } reads one\'s observation and last message. A notice is not settlement.',
  '{ action: "stop", sessionID } stops its descendants first, then its turn, shells and queued prompts. Cancel a latch with wake_cancel.',
  NO_WAIT,
  "To give a subagent more work, call subagent with its sessionID.",
].join("\n")

const isAssistant = (message: SessionMessage.Info): message is SessionMessage.Assistant => message.type === "assistant"
const isText = (part: SessionMessage.AssistantContent): part is SessionMessage.AssistantText => part.type === "text"

/** The text of a session's newest assistant message that has some. */
export const wordsOf = (messages: ReadonlyArray<SessionMessage.Info>): string => {
  const said = messages
    .values()
    .filter(isAssistant)
    .map((message) => message.content.values().filter(isText).map((part) => part.text).filter((text) => text.trim() !== "").toArray())
    .filter((parts) => parts.length > 0)
    .toArray()
    .at(-1)
  return Option.match(Option.fromNullishOr(said), { onNone: () => "", onSome: (parts) => parts.join("\n") })
}

type Info = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>

const millis = (time: Info["time"]["busy"]) => Option.map(Option.fromNullishOr(time), DateTime.toEpochMillis)

/** A host session as the subagents tool reads it: its title is its description. */
export const sessionOf = (info: Info, observation?: Observation): Session => {
  const base = {
    id: info.id,
    parentID: Option.fromNullishOr(info.parentID),
    agent: Option.getOrElse(Option.fromNullishOr(info.agent), () => "subagent"),
    description: Option.getOrElse(Option.fromNullishOr(info.title), () => "Subagent"),
    outcome: Option.fromNullishOr(info.outcome),
    busy: millis(info.time.busy),
    idle: millis(info.time.idle),
  }
  if (observation) return { ...base, observation }
  return base
}

/** The host's sessions, through the plugin context. A session it cannot read is none; a list it cannot read is empty. */
export const hostOf = (ctx: Plugin.Context, lifecycle: ChildLifecycle): Host => ({
  get: (sessionID) =>
    Effect.map(lifecycle.read(sessionID), Option.map(({ info, observation }) => sessionOf(info, Option.getOrUndefined(observation)))),
  children: (sessionID) =>
    ctx.session.list({ parentID: sessionIDOf(sessionID), order: "desc", limit: 100 }).pipe(
      Effect.flatMap((page) => Effect.forEach(page.data, (child) => lifecycle.read(child.id))),
      Effect.map((children) => children.flatMap((child) => Option.toArray(Option.map(
        Option.filter(child, ({ info }) => info.parentID === sessionID),
        ({ info, observation }) => sessionOf(info, Option.getOrUndefined(observation)),
      )))),
      Effect.orElseSucceed((): ReadonlyArray<Session> => []),
    ),
  stop: (sessionID) =>
    ctx.session.stop({ sessionID: sessionIDOf(sessionID) }).pipe(
      Effect.map((result) => Option.some(result.interrupted)),
      Effect.orElseSucceed(() => Option.none<boolean>()),
    ),
  lastWords: (sessionID) =>
    ctx.session.context({ sessionID: sessionIDOf(sessionID) }).pipe(
      Effect.map(wordsOf),
      Effect.orElseSucceed(() => ""),
    ),
  stopUncertain: lifecycle.stopUncertain,
})

const phaseOf = Match.type<Phase>().pipe(Match.tagsExhaustive({
  Latched: (phase) => {
    const recheck = Option.flatMap(Option.fromUndefinedOr(phase.recheckAt), DateTime.make)
    const time = Option.match(recheck, { onNone: () => "", onSome: (at) => `; recheck ${DateTime.formatIso(at)}` })
    return `latched (${phase.hold._tag.toLowerCase()}${time})`
  },
  Continuing: ({ on }) => {
    if (on === "Wake") return "continuing (awaiting host wake)"
    return `continuing (${on.toLowerCase()} still running)`
  },
  Recovering: () => "recovering",
  Unknown: ({ reason }) => {
    if (reason) return "undetermined (background command ended after a failed step; the host does not say whether a result is still to be delivered)"
    return "unknown (no current settlement)"
  },
  Running: () => "running",
  Settled: ({ outcome, cause }) => {
    if (cause === "Unknown") return `settled: ${outcome}`
    return `settled: ${outcome} (${cause})`
  },
}))

const diagnosticOf = Match.type<NonNullable<Observation["diagnostic"]>>().pipe(Match.tagsExhaustive({
  StepError: ({ cause }) => `step ended in error (${cause})`,
  RetryScheduled: ({ cause, attempt }) => `host scheduled retry ${attempt} (${cause})`,
}))

/** One subagent as the model reads it: its sessionID, state, agent and description, what the call did. */
const lineOf = (view: View) => {
  const observation = Option.fromUndefinedOr(view.observation)
  const step = Option.getOrElse(Option.map(Option.flatMap(observation, (value) => Option.fromUndefinedOr(value.diagnostic)), diagnosticOf), () => "")
  const phase = Option.getOrElse(Option.map(observation, (value) => phaseOf(value.phase)), () => view.state)
  return [`${view.sessionID} ${phase} (${view.agent}: ${view.description})`, step, view.note].filter((part) => part !== "").join(": ")
}

/** An answer as the model reads it: a line per subagent, and the last message of one the call named. */
export const textOf = (answer: Listed): string => {
  if (answer.subagents.length === 0) return "No subagents."
  return answer.subagents.map((view) => [lineOf(view), view.message].filter((part) => part !== "").join("\n\n")).join("\n")
}

const one = (view: Effect.Effect<View, Tool.Error>) => Effect.map(view, (found): Listed => ({ subagents: [found] }))

/** Runs one call of the tool for `caller`. */
export const run = (subagents: Subagents, caller: string, input: Input): Effect.Effect<Listed, Tool.Error> => {
  const refused = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, (failure) => new Tool.Error({ message: failure.message, error: failure }))
  if (input.action === "list") return refused(subagents.list(caller))
  return Option.match(Option.fromNullishOr(input.sessionID), {
    onNone: () => Effect.fail(new Tool.Error({ message: `Give the sessionID of the subagent to ${input.action}.` })),
    onSome: (target) =>
      Match.value(input.action).pipe(
        Match.when("get", () => one(refused(subagents.get(caller, target)))),
        Match.orElse(() => one(refused(subagents.stop(caller, target)))),
      ),
  })
}

/** The tool, over the plugin context's sessions. */
export const tool = (ctx: Plugin.Context, lifecycle: ChildLifecycle): Tool.Info<typeof Input, typeof Output> => {
  const subagents = make(hostOf(ctx, lifecycle))
  return {
    name,
    description,
    input: Input,
    output: Output,
    // A direct tool beside the others, so it is offered without code mode and reached from a kernel cell.
    options: { codemode: false },
    execute: (input, context) =>
      run(subagents, context.sessionID, input).pipe(Effect.map((answer) => ({ output: answer, content: textOf(answer) }))),
  }
}
