// Sessions as OpenCode holds them. `layer` reads them through a plain view of
// the host, so a test can run it over a stand-in; `fromContext` takes the view
// from the plugin context.
//
// Where each fact comes from, in the fork (packages/schema/src):
// - running: `Session.Info.time.busy` is the start of the latest execution,
//   `time.idle` the end of the last completed one (session.ts); it runs while
//   busy is later than idle.
// - child: `Session.Info.parentID`.
// - serves: the session's `location` is this copy's (`ctx.location`), compared
//   as the fork compares them: the directory without a trailing separator, in
//   the same workspace.
// - retitle: `session.update({ title: "" })`, which the fork's plugin context
//   answers as its HTTP route does: `SessionTitle.generate` in the session's
//   location (packages/core/src/plugin/host.ts), from the original request and
//   the recent conversation (packages/core/src/session/title.ts). A host
//   without that (before the fork's `feat/plugin-title-regenerate`) renames to
//   "" instead: the title is put back and the attempt fails, and the two
//   renames read as the owner's, so the session is pinned and not tried again.
import type { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { Sessions, SessionUnreadable, TitleFailed } from "../service.ts"

/** Where a session runs, or which sessions a copy of the plugin serves. */
export interface Place {
  readonly directory: string
  readonly workspaceID: Option.Option<string>
}

/** A directory as the fork keys a location by it: without a trailing separator. */
const canonical = (directory: string) => directory.replace(/(.)\/$/, "$1")

/** Whether two places are one location. */
export const samePlace = (a: Place, b: Place): boolean =>
  canonical(a.directory) === canonical(b.directory) && Option.getOrUndefined(a.workspaceID) === Option.getOrUndefined(b.workspaceID)

/** A session, as auto-title reads it. Times in epoch ms. */
export interface SessionView extends Place {
  readonly child: boolean
  readonly busy: Option.Option<number>
  readonly idle: Option.Option<number>
}

/** The host's reads and its title request, as one copy of the plugin sees them. */
export interface Host {
  readonly location: Place
  readonly session: (sessionID: string) => Effect.Effect<SessionView, unknown>
  readonly retitle: (sessionID: string) => Effect.Effect<void, unknown>
}

const Said = Schema.Struct({ message: Schema.String })
const decodeSaid = Schema.decodeUnknownOption(Said)
/** A failure's own message, when it carries one; else its text. */
const messageOf = (cause: unknown): string => Option.match(decodeSaid(cause), { onNone: () => String(cause), onSome: (said) => said.message })

/** An execution runs while its start is later than the last one's end. */
const runs = (session: SessionView) =>
  Option.exists(session.busy, (busy) => Option.match(session.idle, { onNone: () => true, onSome: (idle) => busy > idle }))

export const layer = (host: Host) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      seat: (sessionID) =>
        host.session(sessionID).pipe(
          Effect.map((session) => ({ serves: samePlace(session, host.location), child: session.child, running: runs(session) })),
          Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })),
        ),
      retitle: (sessionID) => host.retitle(sessionID).pipe(Effect.mapError((cause) => new TitleFailed({ sessionID, message: messageOf(cause) }))),
    }),
  )

/** The host renamed the session to "" instead of generating a title: it lacks the fork's hook. */
class NoRegenerate extends Schema.TaggedError<NoRegenerate>()("NoRegenerate", { message: Schema.String }) {}

const millis = (time: Option.Option<DateTime.Utc>) => Option.map(time, DateTime.toEpochMillis)

/** The host through the plugin context. */
export const hostOf = (ctx: Pick<Plugin.Context, "location" | "session">): Host => ({
  location: { directory: ctx.location.directory, workspaceID: Option.fromUndefinedOr(ctx.location.workspaceID) },
  session: (sessionID) =>
    ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
      Effect.map((session) => ({
        child: Option.isSome(Option.fromNullishOr(session.parentID)),
        directory: session.location.directory,
        workspaceID: Option.fromUndefinedOr(session.location.workspaceID),
        busy: millis(Option.fromUndefinedOr(session.time.busy)),
        idle: millis(Option.fromUndefinedOr(session.time.idle)),
      })),
    ),
  retitle: Effect.fn("Sessions.retitle")(function* (sessionID: string) {
    const id = SessionID.make(sessionID)
    const before = (yield* ctx.session.get({ sessionID: id })).title
    yield* ctx.session.update({ sessionID: id, title: "" })
    if ((yield* ctx.session.get({ sessionID: id })).title !== "") return
    // A host without the regenerate hook renamed the session to "": its title goes back.
    yield* ctx.session.update({ sessionID: id, title: before })
    return yield* new NoRegenerate({ message: "this OpenCode renames to an empty title instead of generating one: it lacks the fork's regenerate hook" })
  }),
})

/** The OpenCode sessions through the plugin context. */
export const fromContext = (ctx: Pick<Plugin.Context, "location" | "session">) => layer(hostOf(ctx))
