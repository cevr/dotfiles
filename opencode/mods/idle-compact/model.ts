// The idle compactor's handlers: one timer per session, set for the moment
// `due` names, and the compaction when it fires and the session's facts still
// say so. The plugin calls these from the host's hooks and events and nothing
// else.
//
// - A request starts (`requestStarted`): the timer is cancelled, and the time
//   is kept as the cache's last refresh.
// - Input arrives or an execution starts (`woke`): the timer is cancelled.
// - An execution ends (`settled`), or the plugin starts (`resume`): the facts
//   are read and the timer set.
// - The timer fires: the facts are read again, and the session compacts only
//   if nothing woke it while they were read.
//
// A cache compacts once: the start of the request that wrote it is kept, and
// a second decision for it reads as already compacted.
import { Clock, Context, Effect, Fiber, Layer, Option, Scope } from "effect"
import { Decision, due, type Facts, type Policy } from "./idle.ts"
import { Sessions } from "./service.ts"

export class IdleCompactor extends Context.Service<
  IdleCompactor,
  {
    /** A model request of the session starts: it refreshes the cache. */
    readonly requestStarted: (sessionID: string) => Effect.Effect<void>
    /** Input was queued for the session or an execution started: no compaction now. */
    readonly woke: (sessionID: string) => Effect.Effect<void>
    /** The session's background work as it went idle, described; empty when none runs. */
    readonly background: (sessionID: string, jobs: ReadonlyArray<string>) => Effect.Effect<void>
    /** An execution of the session ended: decide, and set the timer. */
    readonly settled: (sessionID: string) => Effect.Effect<void>
    /** The session is gone. */
    readonly forget: (sessionID: string) => Effect.Effect<void>
    /** At start: decide for the recent sessions, already idle before the plugin ran. */
    readonly resume: Effect.Effect<void>
  }
>()("dotfiles-opencode/idle-compact/IdleCompactor") {}

/** What the plugin saw of one session. */
interface Watch {
  /** Counts every wake, so a decision that read the facts across one is dropped. */
  generation: number
  timer: Fiber.Fiber<void> | undefined
  /** Start of the last model request it saw, in epoch ms. */
  startedAt: number | undefined
  jobs: ReadonlyArray<string>
}

const seconds = (ms: number) => Math.round(ms / 1_000)

export const layer = (policy: Policy) =>
  Layer.effect(
    IdleCompactor,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const scope = yield* Scope.Scope
      const watches = new Map<string, Watch>()
      /** The caches already compacted: session id and the start of the request that wrote it. */
      const compacted = new Set<string>()

      const watch = (sessionID: string): Watch => {
        const found = watches.get(sessionID)
        if (found !== undefined) return found
        const made: Watch = { generation: 0, timer: undefined, startedAt: undefined, jobs: [] }
        watches.set(sessionID, made)
        return made
      }

      const cancel = Effect.fn("IdleCompactor.cancel")(function* (state: Watch) {
        const timer = state.timer
        state.timer = undefined
        if (timer !== undefined) yield* Fiber.interrupt(timer)
      })

      const wake = (sessionID: string) =>
        Effect.suspend(() => {
          const state = watch(sessionID)
          state.generation += 1
          // The next time it goes idle says what still runs.
          state.jobs = []
          return cancel(state)
        })

      /** The data's facts with what the plugin saw on top. */
      const merge = (sessionID: string, state: Watch, read: Facts): Facts => {
        const last = Option.map(read.last, (request) => ({ ...request, startedAt: state.startedAt ?? request.startedAt }))
        const key = Option.map(last, (request) => `${sessionID}@${request.startedAt}`)
        return {
          ...read,
          last,
          busy: [...read.busy, ...state.jobs],
          compacted: read.compacted || (Option.isSome(key) && compacted.has(key.value)),
        }
      }

      const decide: (sessionID: string, trigger: "settled" | "timer" | "resume") => Effect.Effect<void> = Effect.fn(
        "IdleCompactor.decide",
      )(function* (sessionID, trigger) {
        const state = watch(sessionID)
        const generation = state.generation
        const read = yield* Effect.result(sessions.facts(sessionID))
        if (read._tag === "Failure") {
          yield* Effect.logDebug("idle-compact: cannot read the session").pipe(
            Effect.annotateLogs({ sessionID, trigger, error: read.failure.message }),
          )
          return
        }
        // Something woke the session while its facts were read: the next settle decides.
        if (watch(sessionID).generation !== generation) return
        const facts = merge(sessionID, state, read.success)
        const now = yield* Clock.currentTimeMillis
        const decision = due(facts, now, policy)
        const tokens = Option.match(facts.last, { onNone: () => 0, onSome: (request) => request.prompt })
        const cacheAge = Option.match(facts.last, { onNone: () => undefined, onSome: (request) => seconds(now - request.startedAt) })
        yield* Decision.$match(decision, {
          Skip: ({ reason }) =>
            cancel(state).pipe(
              Effect.andThen(
                Effect.logDebug("idle-compact: not compacting").pipe(
                  Effect.annotateLogs({ sessionID, trigger, reason, tokens, cacheAgeSeconds: cacheAge }),
                ),
              ),
            ),
          Due: (when) =>
            when.at > now
              ? schedule(sessionID, state, when.at - now).pipe(
                  Effect.andThen(
                    Effect.logDebug("idle-compact: compaction scheduled").pipe(
                      Effect.annotateLogs({
                        sessionID,
                        trigger,
                        tokens,
                        threshold: when.threshold,
                        cacheAgeSeconds: cacheAge,
                        ttlSeconds: seconds(when.ttl),
                        inSeconds: seconds(when.at - now),
                      }),
                    ),
                  ),
                )
              : compact(sessionID, state, facts, now, when.ttl),
        })
      })

      const compact = Effect.fn("IdleCompactor.compact")(function* (
        sessionID: string,
        state: Watch,
        facts: Facts,
        now: number,
        ttl: number,
      ) {
        yield* cancel(state)
        if (Option.isNone(facts.last)) return
        const last = facts.last.value
        compacted.add(`${sessionID}@${last.startedAt}`)
        yield* Effect.logInfo("idle-compact: compacting the idle session before its cache expires").pipe(
          Effect.annotateLogs({
            sessionID,
            tokens: last.prompt,
            cacheAgeSeconds: seconds(now - last.startedAt),
            ttlSeconds: seconds(ttl),
          }),
        )
        yield* sessions.compact(sessionID).pipe(
          Effect.catchTag("CompactionRefused", (error) =>
            Effect.logWarning("idle-compact: the host refused the compaction").pipe(
              Effect.annotateLogs({ sessionID, error: error.message }),
            ),
          ),
        )
      })

      const schedule = (sessionID: string, state: Watch, delay: number) =>
        Effect.gen(function* () {
          yield* cancel(state)
          state.timer = yield* Effect.sleep(delay).pipe(
            // The timer leaves the map before it decides, so a wake its own compaction causes cannot interrupt it.
            Effect.andThen(Effect.sync(() => void (state.timer = undefined))),
            Effect.andThen(decide(sessionID, "timer")),
            Effect.forkIn(scope),
          )
        })

      return IdleCompactor.of({
        requestStarted: (sessionID) =>
          Effect.gen(function* () {
            const state = watch(sessionID)
            state.startedAt = yield* Clock.currentTimeMillis
            yield* wake(sessionID)
          }),
        woke: wake,
        background: (sessionID, jobs) => Effect.sync(() => void (watch(sessionID).jobs = jobs)),
        settled: (sessionID) => decide(sessionID, "settled"),
        forget: (sessionID) =>
          Effect.suspend(() => {
            const state = watches.get(sessionID)
            watches.delete(sessionID)
            return state === undefined ? Effect.void : cancel(state)
          }),
        resume: sessions.recent.pipe(
          Effect.flatMap((ids) => Effect.forEach(ids, (sessionID) => decide(sessionID, "resume"), { discard: true })),
          Effect.catchTag("SessionUnreadable", (error) =>
            Effect.logDebug("idle-compact: cannot list the sessions").pipe(Effect.annotateLogs({ error: error.message })),
          ),
        ),
      })
    }),
  )
