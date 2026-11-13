// The server's sessions as OpenCode's plugin context holds them. `layer`
// reads them from plain views of the host's records, so the laws run it over a
// stand-in host; `fromContext` takes the views from the plugin context.
//
// Where each fact comes from, in the fork:
// - a session: `ctx.session.get` and `ctx.session.list` (packages/plugin/src/effect/session.ts
//   SessionDomain; core packages/core/src/plugin/host.ts:594 and :611). `list` runs
//   packages/core/src/session/store.ts:145-185: newest `time.updated` first,
//   `parentID: null` for main sessions only, `archived: false` leaves archived ones out.
//   It reaches only this server's database, so a message never crosses servers.
// - no such session: `get` fails with `Session.NotFoundError` (packages/core/src/session/error.ts:10).
// - running: `Session.Info.time.busy` is the start of the latest execution,
//   `time.idle` the end of the last completed one (packages/schema/src/session.ts:46-50);
//   it runs while busy is later than idle.
// - title, agent, parent, directory, last activity: `Session.Info.title`,
//   `.agent`, `.parentID`, `.location.directory`, `.time.updated` (session.ts:32-63).
// - delivery: `ctx.session.synthetic` (host.ts:628 → packages/core/src/session/session.ts:287-327):
//   it admits a synthetic inbox item with the given delivery and wakes the
//   session unless `resume: false`. A steer is read at a running execution's
//   next step; the TUI draws a synthetic message's description as a `◈`
//   notice row (packages/tui/src/routes/session/index.tsx:2160-2197).
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Layer, Option } from "effect"
import type { SessionCard } from "../directory.ts"
import type { Letter } from "../letter.ts"
import { DeliveryRefused, Sessions, SessionsUnreadable } from "../service.ts"

/** A session, as mail reads it from the host. Times in epoch ms. */
export interface SessionView {
  readonly id: string
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly agent?: string | undefined
  readonly directory: string
  readonly busy?: number | undefined
  readonly idle?: number | undefined
  readonly updated: number
}

/** A synthetic message, as the host's `session.synthetic` takes it. */
export interface Synthetic {
  /** The inbox id; the host mints one when none is given. */
  readonly id?: string
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly delivery: "steer"
  readonly resume: boolean
}

/** The host's reads and its inbox. `get` fails with a `Session.NotFoundError` for a session it does not have. */
export interface Host {
  readonly get: (sessionID: string) => Effect.Effect<SessionView, unknown>
  readonly list: (input: { readonly children: boolean; readonly limit: number }) => Effect.Effect<ReadonlyArray<SessionView>, unknown>
  readonly synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>
}

/** How many recent sessions a listing or a title match reads. */
export const RECENT = 200

export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") return cause._tag
  return String(cause)
}

/** Whether the host's failure says it has no such session. */
export const notFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Session.NotFoundError"

/** Whether an execution of the session runs. */
export const running = (session: SessionView): boolean =>
  session.busy !== undefined && (session.idle === undefined || session.busy > session.idle)

export const cardOf = (session: SessionView): SessionCard => ({
  id: session.id,
  title: session.title,
  directory: session.directory,
  agent: session.agent,
  running: running(session),
  parentID: session.parentID,
  updated: session.updated,
})

export const layer = (host: Host) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      get: (sessionID) =>
        host.get(sessionID).pipe(
          Effect.map((session) => Option.some(cardOf(session))),
          Effect.catchIf(notFound, () => Effect.succeed(Option.none<SessionCard>())),
          Effect.mapError((cause) => new SessionsUnreadable({ message: messageOf(cause) })),
        ),
      list: (scope) =>
        host.list({ children: scope.children, limit: RECENT }).pipe(
          Effect.map((sessions) => sessions.map(cardOf)),
          Effect.mapError((cause) => new SessionsUnreadable({ message: messageOf(cause) })),
        ),
      deliver: (sessionID, letter: Letter, wake) =>
        host
          .synthetic({
            ...Option.match(Option.fromNullishOr(letter.id), { onNone: () => ({}), onSome: (id) => ({ id }) }),
            sessionID,
            text: letter.text,
            description: letter.description,
            metadata: { ...letter.metadata },
            delivery: "steer",
            resume: wake,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new DeliveryRefused({ sessionID, message: notFound(cause) ? "no such session" : messageOf(cause) })),
          ),
    }),
  )

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type MessageID = NonNullable<Parameters<Plugin.Context["session"]["synthetic"]>[0]["id"]>
/** A host message id: one that starts `msg_` (packages/schema/src/session-message.ts `ID`). */
const isMessageID = (id: string): id is MessageID => id.startsWith("msg_")
type SessionInfo = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>

const millis = (time: DateTime.Utc | undefined) => (time === undefined ? undefined : DateTime.toEpochMillis(time))

const viewOf = (session: SessionInfo): SessionView => ({
  id: session.id,
  parentID: session.parentID,
  title: session.title,
  agent: session.agent,
  directory: session.location.directory,
  busy: millis(session.time.busy),
  idle: millis(session.time.idle),
  updated: DateTime.toEpochMillis(session.time.updated),
})

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    get: (sessionID) => ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map(viewOf)),
    list: ({ children, limit }) =>
      ctx.session
        .list({ ...(children ? {} : { parentID: null }), archived: false, order: "desc", limit })
        .pipe(Effect.map((page) => page.data.map(viewOf))),
    synthetic: ({ id, ...input }) =>
      ctx.session.synthetic({
        ...input,
        ...Option.match(Option.filter(Option.fromNullishOr(id), isMessageID), { onNone: () => ({}), onSome: (given) => ({ id: given }) }),
        sessionID: input.sessionID as SessionID,
      }),
  })
