// The handlers: each host fact about a session goes through the rules in
// `retitle.ts`, its track is kept through `Tracks`, and a session that is due
// is retitled through `Sessions`, one title request at a time per host.
import { Clock, Context, Effect, Layer, Option, type Scope, type Semaphore } from "effect"
import { due, evolve, Fact, fresh, type Marks, noMarks, type Policy, renamedBy, setBy, type Track } from "./retitle.ts"
import { Sessions, Tracks } from "./service.ts"

/** The plugin's handlers, one per host fact. */
export class AutoTitle extends Context.Service<
  AutoTitle,
  {
    /** An execution ended with the model's reply: a turn. */
    readonly replied: (sessionID: string) => Effect.Effect<void>
    /** An execution ended failed or interrupted: no turn, but the session is idle. */
    readonly stopped: (sessionID: string) => Effect.Effect<void>
    /** A compaction ended. */
    readonly compacted: (sessionID: string) => Effect.Effect<void>
    /** The host started a title request for the session (the `title` hook). */
    readonly generating: (sessionID: string) => Effect.Effect<void>
    /** An agent's rename tool is about to set this title (`execute.before`). */
    readonly agentRenaming: (sessionID: string, title: string) => Effect.Effect<void>
    /** The session's title changed (`session.renamed`). */
    readonly renamed: (sessionID: string, title: string) => Effect.Effect<void>
    /** The session was deleted. */
    readonly forget: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/auto-title/AutoTitle") {}

/**
 * The handlers on `policy`. `lock` is the host's one title request at a time, shared by every copy of the plugin;
 * the retitles run on fibers of `scope`, so no event waits for a title.
 */
export const layer = (policy: Policy, lock: Semaphore.Semaphore, scope: Scope.Scope) =>
  Layer.effect(
    AutoTitle,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const tracks = yield* Tracks
      const marks = new Map<string, Marks>()
      /** Sessions with a retitle waiting for the lock or running, so one idle after another asks once. */
      const pending = new Set<string>()

      /** The session's seat when it is this copy's root session. */
      const ours = (sessionID: string) =>
        sessions.seat(sessionID).pipe(
          Effect.option,
          Effect.map(Option.filter((seat) => seat.serves && !seat.child)),
        )

      /** The session's track after `fact`, kept; none when it is not this copy's root session. */
      const follow = Effect.fn("AutoTitle.follow")(function* (sessionID: string, fact: Fact) {
        if (Option.isNone(yield* ours(sessionID))) return Option.none<Track>()
        const now = yield* Clock.currentTimeMillis
        const before = Option.getOrElse(yield* tracks.get(sessionID), () => fresh(now))
        const after = evolve(before, fact, now)
        yield* tracks.put(sessionID, after)
        return Option.some(after)
      })

      const attempt = Effect.fn("AutoTitle.attempt")(function* (sessionID: string) {
        const seat = yield* ours(sessionID)
        const track = yield* tracks.get(sessionID)
        if (Option.isNone(seat) || Option.isNone(track)) return
        const now = yield* Clock.currentTimeMillis
        const verdict = due(track.value, seat.value, now, policy)
        if (verdict._tag === "Keep") return yield* Effect.logDebug("auto-title: keeping the title", { sessionID, because: verdict.because })
        // The attempt counts as the session's last title even when it fails: the old title stays until the next window.
        yield* tracks.put(sessionID, evolve(track.value, Fact.Titled(), now))
        yield* Effect.logInfo("auto-title: generating the title again", { sessionID, because: verdict.because, turns: track.value.turns })
        yield* sessions.retitle(sessionID).pipe(
          Effect.catchTag("TitleFailed", (error) => Effect.logDebug("auto-title: the title request failed", { sessionID, message: error.message })),
        )
      })

      /** Retitles the session if it is due, on its own fiber, once the host's lock is free; decided again then. */
      const consider = Effect.fn("AutoTitle.consider")(function* (sessionID: string) {
        if (pending.has(sessionID)) return
        pending.add(sessionID)
        yield* lock.withPermits(1)(attempt(sessionID)).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(sessionID))),
          Effect.forkIn(scope),
        )
      })

      const marked = (sessionID: string) => Option.getOrElse(Option.fromUndefinedOr(marks.get(sessionID)), () => noMarks)

      return AutoTitle.of({
        replied: Effect.fn("AutoTitle.replied")(function* (sessionID) {
          if (Option.isSome(yield* follow(sessionID, Fact.TurnEnded()))) yield* consider(sessionID)
        }),
        stopped: (sessionID) => consider(sessionID),
        compacted: Effect.fn("AutoTitle.compacted")(function* (sessionID) {
          if (Option.isSome(yield* follow(sessionID, Fact.Compacted()))) yield* consider(sessionID)
        }),
        generating: Effect.fn("AutoTitle.generating")(function* (sessionID) {
          const now = yield* Clock.currentTimeMillis
          marks.set(sessionID, { ...marked(sessionID), generating: Option.some(now) })
          const track = Option.filter(yield* tracks.get(sessionID), (kept) => kept.pinned)
          if (Option.isNone(track)) return
          yield* tracks.put(sessionID, evolve(track.value, Fact.Generating(), now))
          yield* Effect.logInfo("auto-title: the owner asked for a generated title: unpinned", { sessionID })
        }),
        agentRenaming: Effect.fn("AutoTitle.agentRenaming")(function* (sessionID, title) {
          const now = yield* Clock.currentTimeMillis
          marks.set(sessionID, { ...marked(sessionID), agent: Option.some({ title, at: now }) })
        }),
        renamed: Effect.fn("AutoTitle.renamed")(function* (sessionID, title) {
          const now = yield* Clock.currentTimeMillis
          const by = renamedBy(marked(sessionID), title, now)
          marks.delete(sessionID)
          const track = yield* follow(sessionID, setBy[by])
          if (by === "owner" && Option.isSome(track)) yield* Effect.logInfo("auto-title: the owner set the title: pinned", { sessionID })
        }),
        forget: Effect.fn("AutoTitle.forget")(function* (sessionID) {
          marks.delete(sessionID)
          yield* tracks.remove(sessionID)
        }),
      })
    }),
  )
