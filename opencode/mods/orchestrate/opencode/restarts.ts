// The restart's reads and acts over OpenCode. `layer` reads plain views of
// the host's records, so the laws run it over a stand-in host; `fromContext`
// takes them from the plugin context.
//
// Where each fact comes from, in the fork:
// - the children: `session.list` with no `parentID` (both kinds), newest
//   `time.updated` first (packages/core/src/session/store.ts list); kept are
//   those with a parent, of this copy's location, updated since `since`.
//   The host runs one copy of the plugin per location and hands a session's
//   hooks to its own location's copy (see mods/idle-compact/opencode/
//   sessions.ts), so each copy resumes its own location's children only.
// - a transcript: `session.get` and `session.context` (the messages since the
//   latest compaction, packages/schema/src/session-message.ts `Info`):
//   `user` is a prompt; `synthetic` with `metadata.notice: "restart"` is
//   OpenCode's own resume (packages/core/src/session/execution/restart.ts),
//   any other synthetic a notice that starts no turn by itself; `assistant`
//   ended aborted when `error.type` is `aborted`, and its `subagent` tool
//   parts name their child by `metadata.sessionID` (`input.sessionID` for a
//   follow-up, else the `(sessionID: …)` an interrupted call's error names,
//   packages/core/src/session/runner/publish-llm-event.ts failTool); `idle`
//   ends a turn with its `outcome`.
// - resume: the subagent tool's own execute, run in the background on the
//   existing child (the plugin hands it in, as for a latch): the child is
//   prompted with the prompt as given, a job is kept, and its result wakes
//   the parent (packages/core/src/tool/plugin/subagent.ts).
// - tell: `session.synthetic` with `delivery: "steer"`, as the mail and wake
//   mods deliver notices: read at a running parent's next step, or, with
//   `resume: false`, at its next turn.
import type { Plugin } from "@opencode/plugin/effect"
import { Cause, DateTime, Effect, Layer } from "effect"
import type { Entry, SubagentCall } from "../restart.ts"
import { Restarts, type ResumeStart, type SessionCard, StartFailed } from "../service.ts"

/** Where a session runs, or which sessions a copy of the plugin serves. */
export interface Place {
  readonly directory: string
  readonly workspaceID?: string | undefined
}

/** A session as the host lists it. Times in epoch ms. */
export interface SessionView extends Place {
  readonly id: string
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly agent?: string | undefined
  readonly updated: number
}

/** A tool part as the restart reads it. */
export interface ToolView {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input?: unknown
    readonly metadata?: unknown
    readonly error?: { readonly type: string; readonly message: string }
  }
}

/** A message of a session's context, as the restart reads it. Times in epoch ms. */
export type MessageView =
  | { readonly type: "user"; readonly created: number; readonly text: string }
  | { readonly type: "synthetic"; readonly created: number; readonly metadata?: unknown }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly agent: string
      readonly created: number
      readonly completed?: number | undefined
      readonly error?: { readonly type: string } | undefined
      readonly content: ReadonlyArray<ToolView | { readonly type: string }>
    }
  | { readonly type: "idle"; readonly created: number; readonly outcome: "succeeded" | "failed" | "interrupted" }
  | { readonly type: "other" }

/** A notice as the host's `session.synthetic` takes it. */
export interface Synthetic {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: { readonly source: "orchestrate"; readonly notice: "resumed"; readonly children: ReadonlyArray<string> }
  readonly delivery: "steer"
  readonly resume: boolean
}

/** The host's reads and acts, as one copy of the plugin sees them. */
export interface Host {
  /** The location this copy of the plugin runs for. */
  readonly location: Place
  /** The recent sessions of the location, both kinds, newest first; others may be among them. */
  readonly list: Effect.Effect<ReadonlyArray<SessionView>, unknown>
  readonly get: (sessionID: string) => Effect.Effect<SessionView, unknown>
  readonly context: (sessionID: string) => Effect.Effect<ReadonlyArray<MessageView>, unknown>
  /** The subagent tool, run in the background on the child. */
  readonly run: (start: ResumeStart) => Effect.Effect<void, unknown>
  readonly synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>
}

const canonical = (directory: string) => (directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory)

/** Whether two places are one location, as the fork keys them. */
export const samePlace = (a: Place, b: Place) => canonical(a.directory) === canonical(b.directory) && (a.workspaceID ?? undefined) === (b.workspaceID ?? undefined)

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const NAMED = /\(sessionID: (ses_[A-Za-z0-9]+)\)/

/** The child a subagent tool part ran, if it names one. */
export const childOf = (tool: ToolView): string | undefined => {
  const { metadata, input, error } = tool.state
  if (isObject(metadata) && typeof metadata.sessionID === "string") return metadata.sessionID
  if (isObject(input) && typeof input.sessionID === "string" && input.sessionID !== "") return input.sessionID
  return error === undefined ? undefined : NAMED.exec(error.message)?.[1]
}

/** A message as the restart's rules read it. */
export const entryOf = (message: MessageView): Entry => {
  switch (message.type) {
    case "user":
      return { type: "prompt", at: message.created, text: message.text }
    case "synthetic": {
      const metadata = isObject(message.metadata) ? message.metadata : {}
      if (metadata.notice === "restart") return { type: "restarted", at: message.created }
      if (metadata.source === "orchestrate" && metadata.notice === "resumed" && Array.isArray(metadata.children))
        return { type: "told", at: message.created, children: metadata.children.filter((child): child is string => typeof child === "string") }
      return { type: "other" }
    }
    case "idle":
      return { type: "idle", at: message.created, outcome: message.outcome }
    case "assistant": {
      const calls = message.content.flatMap((part): Array<SubagentCall> => {
        if (part.type !== "tool" || !("name" in part) || part.name !== "subagent") return []
        const child = childOf(part)
        return child === undefined ? [] : [{ id: part.id, child, interrupted: part.state.status === "error" && part.state.error?.type === "aborted" }]
      })
      return { type: "assistant", id: message.id, agent: message.agent, at: message.completed ?? message.created, aborted: message.error?.type === "aborted", calls }
    }
    default:
      return { type: "other" }
  }
}

const cardOf = (session: SessionView): SessionCard => ({
  id: session.id,
  ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
  ...(session.title === undefined ? {} : { title: session.title }),
  ...(session.agent === undefined ? {} : { agent: session.agent }),
})

export const layer = (host: Host) =>
  Layer.succeed(
    Restarts,
    Restarts.of({
      children: (since) =>
        host.list.pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.parentID !== undefined && session.updated >= since && samePlace(session, host.location)).map(cardOf),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrate: the sessions a restart may have cut cannot be listed", { message: messageOf(Cause.squash(cause)) }).pipe(Effect.as([])),
          ),
        ),
      transcript: (sessionID) =>
        Effect.all([host.get(sessionID), host.context(sessionID)], { concurrency: 2 }).pipe(
          Effect.map(([session, messages]) => ({ session: cardOf(session), entries: messages.map(entryOf) })),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      resume: (start) =>
        Effect.suspend(() => host.run(start)).pipe(Effect.catchCause((cause) => Effect.fail(new StartFailed({ message: messageOf(Cause.squash(cause)) })))),
      tell: (notice) =>
        Effect.suspend(() =>
          host.synthetic({
            sessionID: notice.parent,
            text: notice.text,
            description: notice.description,
            metadata: { source: "orchestrate", notice: "resumed", children: notice.children },
            delivery: "steer",
            resume: notice.wake,
          }),
        ).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrate: a parent could not be told of its resumed subagents", { parent: notice.parent, message: messageOf(Cause.squash(cause)) }),
          ),
        ),
    }),
  )

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SessionInfo = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
type HostMessage = Effect.Success<ReturnType<Plugin.Context["session"]["context"]>>[number]
type Directory = NonNullable<Parameters<Plugin.Context["session"]["list"]>[0]>["directory"]

/** How many of the location's newest sessions a start looks at. */
const RECENT = 200

const millis = (time: DateTime.Utc) => DateTime.toEpochMillis(time)

const viewOf = (session: SessionInfo): SessionView => ({
  id: session.id,
  parentID: session.parentID,
  title: session.title,
  agent: session.agent,
  directory: session.location.directory,
  workspaceID: session.location.workspaceID,
  updated: millis(session.time.updated),
})

const messageView = (message: HostMessage): MessageView => {
  switch (message.type) {
    case "user":
      return { type: "user", created: millis(message.time.created), text: message.text }
    case "synthetic":
      return { type: "synthetic", created: millis(message.time.created), metadata: message.metadata }
    case "idle":
      return { type: "idle", created: millis(message.time.created), outcome: message.outcome }
    case "assistant":
      return {
        type: "assistant",
        id: message.id,
        agent: message.agent,
        created: millis(message.time.created),
        completed: message.time.completed === undefined ? undefined : millis(message.time.completed),
        error: message.error,
        content: message.content.map((part) =>
          part.type === "tool"
            ? {
                type: "tool",
                id: part.id,
                name: part.name,
                state: {
                  status: part.state.status,
                  ...("input" in part.state ? { input: part.state.input } : {}),
                  ...("metadata" in part.state ? { metadata: part.state.metadata } : {}),
                  ...(part.state.status === "error" ? { error: part.state.error } : {}),
                },
              }
            : { type: part.type },
        ),
      }
    default:
      return { type: "other" }
  }
}

/** The restart's host through the plugin context; `run` is the subagent tool's execute on the child. */
export const fromContext = (ctx: Plugin.Context, run: Host["run"]) =>
  layer({
    location: { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID },
    list: ctx.session
      .list({ directory: ctx.location.directory as Directory, archived: false, order: "desc", limit: RECENT })
      .pipe(Effect.map((page) => page.data.map(viewOf))),
    get: (sessionID) => ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map(viewOf)),
    context: (sessionID) => ctx.session.context({ sessionID: sessionID as SessionID }).pipe(Effect.map((messages) => messages.map(messageView))),
    run,
    synthetic: (input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as SessionID }),
  })
