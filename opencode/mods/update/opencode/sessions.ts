import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, HashSet, Layer, Option, Ref, Stream } from "effect"
import type { SessionView } from "../gate.ts"
import { Sessions, UpdateFailed } from "../service.ts"

type SessionInfo = Effect.Success<ReturnType<Plugin.Context["session"]["list"]>>["data"][number]

/**
 * How many sessions, newest first, the gate reads, subagents among them (`rootsOf` keeps the roots):
 * a session at work was updated lately.
 */
export const SESSIONS_READ = 500

const millis = (time: Option.Option<DateTime.Utc>): number => Option.match(time, { onNone: () => 0, onSome: DateTime.toEpochMillis })

/**
 * Whether the session's data says a turn of it runs: its latest execution started (`time.busy`)
 * after the last one ended (`time.idle`). The fork sets both (packages/schema/src/session.ts).
 */
export const running = (busy: Option.Option<DateTime.Utc>, idle: Option.Option<DateTime.Utc>): boolean =>
  Option.isSome(busy) && millis(busy) > millis(idle)

/** The compaction events: a compaction of the session starts, ends or fails. */
const COMPACTION = ["session.compaction.started", "session.compaction.ended", "session.compaction.failed"] as const

/**
 * The host's sessions through the plugin context: every location's sessions (`session.list` with no
 * directory reads them all), each busy as its data says, compacting while a compaction
 * started and has not ended. Compactions are heard from the events, which reach every copy.
 */
export const layer = (ctx: Plugin.Context) =>
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const compacting = yield* Ref.make(HashSet.empty<string>())
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: [...COMPACTION] }).pipe(
          Stream.runForEach((event) =>
            Ref.update(compacting, (set) => {
              const id: string = event.data.sessionID
              if (event.type === "session.compaction.started") return HashSet.add(set, id)
              return HashSet.remove(set, id)
            }),
          ),
          Effect.catchCause((cause) => Effect.logWarning("update: the compaction events stopped", cause)),
        ),
      )
      const view = (session: SessionInfo, set: HashSet.HashSet<string>): SessionView => ({
        id: session.id,
        parentID: Option.fromNullishOr(session.parentID),
        busy: running(Option.fromNullishOr(session.time.busy), Option.fromNullishOr(session.time.idle)),
        compacting: HashSet.has(set, session.id),
      })
      return Sessions.of({
        all: Effect.gen(function* () {
          const page = yield* ctx.session.list({ order: "desc", limit: SESSIONS_READ }).pipe(
            Effect.mapError((cause) => new UpdateFailed({ step: "list the sessions", message: String(cause) })),
          )
          const set = yield* Ref.get(compacting)
          return page.data.map((session) => view(session, set))
        }),
      })
    }),
  )
