// The `subagents` tool: a session lists, reads, waits on and stops its own
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
import { type Plugin, Tool } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SessionID } from "@opencode/schema/session-id"
import { DateTime, Effect, Match, Option, Schema } from "effect"
import { Listed, make, type Host, type Session, type Subagents, type View } from "../subagents.ts"

/** How long a wait without `ms` waits: the shell's own foreground limit. */
export const DEFAULT_WAIT_MS = 10 * 60 * 1_000

export const name = "subagents"

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "get", "wait", "stop"]).annotate({
    description:
      'What to do: "list" this session\'s subagents, "get" one (its state and last message), "wait" up to ms for one to go idle, or "stop" one.',
  }),
  sessionID: Schema.optionalKey(SessionID).annotate({ description: "Get, wait, stop: the subagent's sessionID, as the subagent tool returned it." }),
  ms: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
    description: "Wait: the most milliseconds to wait; default 600000 (10 min).",
  }),
})
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Output = Listed

export const description = [
  "List, read, wait on and stop this session's own subagents (the sessions the subagent tool started, and theirs).",
  '{ action: "list" } lists them with their state: running, done, stopped or failed. { action: "get", sessionID } gives one\'s state and last message. { action: "wait", sessionID, ms? } waits up to ms (default 10 min) for it to go idle.',
  '{ action: "stop", sessionID } stops it, and its own subagents first: it ends its turn, its background shells and its queued prompts; you hear once that it was cancelled, never that it finished. A second stop changes nothing.',
  "Only this session's own subagents are reachable; any other session is refused. To give a subagent more work, call subagent with its sessionID.",
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
export const sessionOf = (info: Info): Session => ({
  id: info.id,
  parentID: Option.fromNullishOr(info.parentID),
  agent: Option.getOrElse(Option.fromNullishOr(info.agent), () => "subagent"),
  description: Option.getOrElse(Option.fromNullishOr(info.title), () => "Subagent"),
  outcome: Option.fromNullishOr(info.outcome),
  busy: millis(info.time.busy),
  idle: millis(info.time.idle),
})

/** The host's sessions, through the plugin context. A session it cannot read is none; a list it cannot read is empty. */
export const hostOf = (ctx: Plugin.Context): Host => ({
  get: (sessionID) =>
    ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
      Effect.map((info) => Option.some(sessionOf(info))),
      Effect.catchCause(() => Effect.succeed(Option.none<Session>())),
    ),
  children: (sessionID) =>
    ctx.session.list({ parentID: SessionID.make(sessionID), order: "desc", limit: 100 }).pipe(
      Effect.map((page) => page.data.map(sessionOf)),
      Effect.catchCause(() => Effect.succeed<ReadonlyArray<Session>>([])),
    ),
  stop: (sessionID) =>
    ctx.session.stop({ sessionID: SessionID.make(sessionID) }).pipe(
      Effect.map((result) => result.interrupted),
      Effect.catchCause((cause) => Effect.as(Effect.logWarning("subagents: a stop of a session failed", { sessionID, cause }), false)),
    ),
  wait: (sessionID) =>
    ctx.session
      .wait({ sessionID: SessionID.make(sessionID) })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("subagents: a wait on a session failed", { sessionID, cause }))),
  lastWords: (sessionID) =>
    ctx.session.context({ sessionID: SessionID.make(sessionID) }).pipe(
      Effect.map(wordsOf),
      Effect.catchCause(() => Effect.succeed("")),
    ),
})

/** One subagent as the model reads it: its sessionID, state, agent and description, what the call did. */
const lineOf = (view: View) => [`${view.sessionID} ${view.state} (${view.agent}: ${view.description})`, view.note].filter((part) => part !== "").join(": ")

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
        Match.when("wait", () => one(refused(subagents.wait(caller, target, Option.getOrElse(Option.fromNullishOr(input.ms), () => DEFAULT_WAIT_MS))))),
        Match.orElse(() => one(refused(subagents.stop(caller, target)))),
      ),
  })
}

/** The tool, over the plugin context's sessions. */
export const tool = (ctx: Plugin.Context): Tool.Info<typeof Input, typeof Output> => {
  const subagents = make(hostOf(ctx))
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
