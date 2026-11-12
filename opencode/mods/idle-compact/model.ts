// The idle compactor's handlers: one timer per session, set for the moment
// `due` names, and the compaction when it fires and the session's facts still
// say so. The plugin calls these from the host's hooks and events and nothing
// else.
//
// - A request starts (`requestStarted`): the timer is cancelled, and the time
//   is kept as the cache's last refresh.
// - Input arrives or an execution starts (`woke`): the timer is cancelled.
// - An execution ends (`settled`), or the recent sessions are looked at again
//   (`resume`: once the plugin starts, and when the catalog changes): the
//   facts are read and the timer set. A catalog change looks again only when
//   what the decisions read of it (`Sessions.catalog`) differs from the last
//   look's: the host publishes every Location's catalog again whenever
//   another Location opens.
// - A decision reads the session's record first (`Sessions.standing`): a
//   subagent's session (unless the policy says so) or one that runs is skipped
//   at debug there, without reading its context or children, the costly
//   reads an orchestrator's hundreds of subagent ends would each make.
// - The timer fires: the facts are read again, and the session compacts only
//   if nothing woke it while they were read.
// - Background work as the session goes idle (`background`) is kept to log
//   with the decision; it does not hold the timer back (idle.ts). Its notice
//   wakes the session (`woke`), which cancels the timer if it comes first.
//
// Each decision is one line: scheduled (in how long, the lifetime, the
// prompt's tokens), compacting, or not compacting and why, with the trigger,
// the background work still running, and the price check: what compacting
// costs, what it avoids, the verdict and the break-even prompt (price.ts).
// Scheduled, compacting, and not compacting a session above the threshold are
// at info; not compacting one that never could (no request, too small,
// uncached), or one at or below the threshold, is at debug, so a resume over
// every recent session logs only the ones that matter.
//
// A cache compacts once: the start of the request that wrote it is kept, and
// a second decision for it reads as already compacted.
//
// One copy decides: the host runs a copy of the plugin per location, and every
// copy hears every session's events. Each decision first asks whether the
// session is this copy's (`Sessions.standing`); one of another location is
// dropped without a word, so a session's idle window gets one decision, one
// line and at most one compaction, from the copy its hooks reach.
import { Clock, Context, Effect, Fiber, Layer, Option, Scope } from "effect"
import { billFor, Decision, due, type Facts, type Policy, type Reason, ruledOut, thresholdOf } from "./idle.ts"
import { Sessions } from "./service.ts"

export class IdleCompactor extends Context.Service<
  IdleCompactor,
  {
    /** A model request of the session starts: it refreshes the cache. */
    readonly requestStarted: (sessionID: string) => Effect.Effect<void>
    /**
     * A compaction request of the session starts: it reads the prefix from cache, so it refreshes it, but it wakes
     * nothing. The host's background summary of an idle session is one, outside any execution, so no settle follows
     * it: a timer set before it is set again from it.
     */
    readonly refreshed: (sessionID: string) => Effect.Effect<void>
    /** Input was queued for the session or an execution started: no compaction now. */
    readonly woke: (sessionID: string) => Effect.Effect<void>
    /** The session's background work as it went idle, described; empty when none runs. */
    readonly background: (sessionID: string, jobs: ReadonlyArray<string>) => Effect.Effect<void>
    /** An execution of the session ended: decide, and set the timer. */
    readonly settled: (sessionID: string) => Effect.Effect<void>
    /** The session is gone. */
    readonly forget: (sessionID: string) => Effect.Effect<void>
    /**
     * Decide for the recent sessions, which may have gone idle before the plugin ran (`resume`), or whose lifetimes
     * the catalog may have changed (`catalog`).
     */
    readonly resume: (trigger: "resume" | "catalog") => Effect.Effect<void>
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
/** USD to a hundredth of a cent. */
const usd = (amount: number) => Math.round(amount * 10_000) / 10_000

/** What made the compactor decide. */
type Trigger = "settled" | "timer" | "resume" | "catalog" | "refresh"

/** Skips of a session that could not compact whatever its cache: logged at debug. */
const QUIET: ReadonlySet<Reason> = new Set<Reason>(["no-request", "too-small", "no-cache"])

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

      /** The session is not this copy's to decide, or not at all: its timer ends and it is forgotten. */
      const drop = (sessionID: string) =>
        Effect.suspend(() => {
          const state = watches.get(sessionID)
          watches.delete(sessionID)
          return state === undefined ? Effect.void : cancel(state)
        })

      const decide: (sessionID: string, trigger: Trigger) => Effect.Effect<void> = Effect.fn("IdleCompactor.decide")(
        function* (sessionID, trigger) {
          // Another location's session is its own copy's to decide.
          const standing = yield* Effect.result(sessions.standing(sessionID))
          // Every copy reads this: at debug, so the info log keeps one line per decision.
          if (standing._tag === "Failure")
            return yield* cancel(watch(sessionID)).pipe(
              Effect.andThen(
                Effect.logDebug("idle-compact: not compacting").pipe(
                  Effect.annotateLogs({ sessionID, trigger, reason: "unreadable", error: standing.failure.message }),
                ),
              ),
            )
          if (!standing.success.serves) return yield* drop(sessionID)
          const state = watch(sessionID)
          // A subagent's session, or one that runs, is told by its record: its context and children are not read.
          const out = ruledOut(standing.success, policy)
          if (Option.isSome(out))
            return yield* cancel(state).pipe(
              Effect.andThen(
                Effect.logDebug("idle-compact: not compacting").pipe(Effect.annotateLogs({ sessionID, trigger, reason: out.value })),
              ),
            )
          const generation = state.generation
          const read = yield* Effect.result(sessions.facts(sessionID))
          // Something woke the session while its facts were read: the next settle decides.
          if (watch(sessionID).generation !== generation) return
          if (read._tag === "Failure") {
            yield* cancel(state)
            return yield* Effect.logInfo("idle-compact: not compacting").pipe(
              Effect.annotateLogs({ sessionID, trigger, reason: "unreadable", error: read.failure.message }),
            )
          }
          const facts = merge(sessionID, state, read.success)
          const now = yield* Clock.currentTimeMillis
          const decision = due(facts, now, policy)
          // One line per decision, at info, so a missed compaction can be explained from the log.
          const bill = Option.flatMap(facts.last, (last) => billFor(last, policy))
          const priced = Option.match(bill, {
            onNone: () => ({ verdict: "unpriced" }),
            onSome: ({ avoided, cost, breakEven }) => ({
              verdict: cost < avoided ? "pays" : "costs-more",
              avoidedUsd: usd(avoided),
              costUsd: usd(cost),
              breakEvenTokens: Option.getOrUndefined(breakEven),
            }),
          })
          const seen = {
            sessionID,
            trigger,
            tokens: Option.match(facts.last, { onNone: () => 0, onSome: (request) => request.prompt }),
            cacheAgeSeconds: Option.match(facts.last, { onNone: () => undefined, onSome: (request) => seconds(now - request.startedAt) }),
            busy: facts.busy.length === 0 ? undefined : facts.busy.join("; "),
            ...priced,
          }
          const unresolved = Option.match(facts.last, {
            onNone: () => ({}),
            onSome: (last) => (last.unresolved === undefined ? {} : { unresolved: last.unresolved }),
          })
          const above = Option.exists(facts.last, (last) => last.prompt > thresholdOf(last.window, policy))
          yield* Decision.$match(decision, {
            Skip: ({ reason }) =>
              cancel(state).pipe(
                Effect.andThen(
                  (above && !QUIET.has(reason) ? Effect.logInfo : Effect.logDebug)("idle-compact: not compacting").pipe(
                    Effect.annotateLogs({ ...seen, reason, ...unresolved }),
                  ),
                ),
              ),
            Due: (when) =>
              when.at > now
                ? schedule(sessionID, state, when.at - now).pipe(
                    Effect.andThen(
                      Effect.logInfo("idle-compact: compaction scheduled").pipe(
                        Effect.annotateLogs({
                          ...seen,
                          threshold: when.threshold,
                          ttlSeconds: seconds(when.ttl),
                          inSeconds: seconds(when.at - now),
                        }),
                      ),
                    ),
                  )
                : compact(sessionID, state, facts, now, when.ttl, seen),
          })
        },
      )

      const compact = Effect.fn("IdleCompactor.compact")(function* (
        sessionID: string,
        state: Watch,
        facts: Facts,
        now: number,
        ttl: number,
        seen: Record<string, unknown>,
      ) {
        yield* cancel(state)
        if (Option.isNone(facts.last)) return
        const last = facts.last.value
        compacted.add(`${sessionID}@${last.startedAt}`)
        yield* Effect.logInfo("idle-compact: compacting the idle session before its cache expires").pipe(
          Effect.annotateLogs({ ...seen, ttlSeconds: seconds(ttl) }),
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

      /** Decide for the recent sessions. */
      const look = (trigger: "resume" | "catalog") =>
        sessions.recent.pipe(
          // The start's look is for sessions idle before the plugin ran. One this copy has seen since (a request,
          // a wake, a settle) has had or will get its own decision, on fresher facts: on a loaded host the look,
          // held back by the catalog's settle, comes after a turn's end and would decide its idle window twice.
          Effect.map((ids) => (trigger === "resume" ? ids.filter((sessionID) => !watches.has(sessionID)) : ids)),
          Effect.flatMap((ids) => Effect.forEach(ids, (sessionID) => decide(sessionID, trigger), { discard: true })),
          Effect.catchTag("SessionUnreadable", (error) =>
            Effect.logInfo("idle-compact: cannot list the sessions").pipe(Effect.annotateLogs({ trigger, error: error.message })),
          ),
        )
      /** The catalog's key at the last look: a catalog change that keeps it is no change. None when it could not be read. */
      let looked: Option.Option<string> = Option.none()

      return IdleCompactor.of({
        requestStarted: (sessionID) =>
          Effect.gen(function* () {
            const state = watch(sessionID)
            state.startedAt = yield* Clock.currentTimeMillis
            yield* wake(sessionID)
          }),
        refreshed: (sessionID) =>
          Effect.gen(function* () {
            const state = watch(sessionID)
            state.startedAt = yield* Clock.currentTimeMillis
            // No timer: the session runs (its settle decides) or was not due; the idle compaction's own request
            // comes after its timer left.
            if (state.timer !== undefined) yield* decide(sessionID, "refresh")
          }),
        woke: wake,
        background: (sessionID, jobs) => Effect.sync(() => void (watch(sessionID).jobs = jobs)),
        settled: (sessionID) => decide(sessionID, "settled"),
        forget: drop,
        resume: (trigger) =>
          Effect.gen(function* () {
            const key = yield* Effect.option(sessions.catalog)
            // The host publishes a Location's catalog again when another Location opens; unchanged, it decides
            // nothing anew. One that cannot be read is looked at again: the decisions say what they could not read.
            if (trigger === "catalog" && Option.exists(key, (read) => Option.contains(looked, read)))
              return yield* Effect.logDebug("idle-compact: the catalog is unchanged, no look").pipe(Effect.annotateLogs({ trigger }))
            looked = key
            yield* look(trigger)
          }),
      })
    }),
  )

