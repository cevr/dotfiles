// Each session's last hour in cells (../cell-time.ts) in the plugin's storage
// under `kernel-time:<sessionID>`, so a restart keeps it; and the notice a root
// gets when its hour is over the bound, as a message that waits for its next
// turn (`resume: false`).
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionID as HostSessionID } from "@opencode/schema/session-id"
import { Effect, Layer, Option, Schema } from "effect"
import { CellTime, CellTimeState } from "../cell-time.ts"
import { CellTimes, Notices } from "../service.ts"
import type { Store } from "./snapshots.ts"

export const STORAGE_PREFIX = "kernel-time:"

const decodeState = Schema.decodeUnknownOption(CellTimeState)

export const layer = (store: Store) =>
  Layer.succeed(
    CellTimes,
    CellTimes.of({
      load: (session) =>
        store.get(STORAGE_PREFIX + session).pipe(
          Effect.map((value) => Option.getOrElse(decodeState(value), () => CellTime.initial)),
          // A store that cannot be read, or holds something else, holds the empty view.
          Effect.catchCause(() => Effect.succeed(CellTime.initial)),
          Effect.withSpan("CellTimes.load"),
        ),
      save: (session, state) => store.set(STORAGE_PREFIX + session, state).pipe(Effect.withSpan("CellTimes.save")),
      drop: (session) => store.remove(STORAGE_PREFIX + session).pipe(Effect.withSpan("CellTimes.drop")),
    }),
  )

// A plugin gets `@opencode/schema` for its types only, so the id is branded here, as ./subagents.ts does.
const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const sessionIDOf = (sessionID: string): HostSessionID => SessionID.make(sessionID)

/** The host's two reads and writes a notice needs. */
export interface Host {
  /** The session's parent, none for a root. */
  readonly parentOf: (session: string) => Effect.Effect<Option.Option<string>, unknown>
  readonly tell: (session: string, notice: { readonly text: string; readonly description: string }) => Effect.Effect<void, unknown>
}

export const notices = (host: Host) =>
  Layer.succeed(
    Notices,
    Notices.of({
      tell: (session, notice) =>
        host.parentOf(session).pipe(
          // A subagent is never told: its parent reads its time.
          Effect.flatMap(Option.match({ onNone: () => host.tell(session, notice), onSome: () => Effect.void })),
          Effect.catchCause((cause) => Effect.logWarning("kernel: could not tell a root its time in cells", { session, cause })),
          Effect.withSpan("Notices.tell"),
        ),
    }),
  )

/** Notices through the plugin context. */
export const noticesFromContext = (ctx: Plugin.Context) =>
  notices({
    parentOf: (session) =>
      ctx.session.get({ sessionID: sessionIDOf(session) }).pipe(Effect.map((info) => Option.fromNullishOr(info.parentID))),
    tell: (session, notice) =>
      ctx.session
        .synthetic({ sessionID: sessionIDOf(session), text: notice.text, description: notice.description, delivery: "steer", resume: false })
        .pipe(Effect.asVoid),
  })
