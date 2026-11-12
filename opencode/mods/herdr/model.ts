// The reporter: it takes the activities the TUI shows and tells herdr about
// them in the background, for the scope's lifetime. Only the newest activity
// waits (a sliding queue of one), an activity herdr already knows is dropped,
// each request is tried twice, and a failure is logged at debug level, never
// raised. The labels are refreshed before their ttl runs out. `release`
// stops it and releases the pane, once: the TUI runs it as soon as it is told
// to stop, ahead of its own teardown, and closing the scope runs it too.
import { Clock, Deferred, Effect, Exit, Fiber, Option, Queue, type Scope } from "effect"
import { sameActivity, type Activity } from "./activity.ts"
import { agentParams, changes, METADATA_REFRESH_MS, metadataParams, nextSeq, releaseParams } from "./report.ts"
import { Herdr, type HerdrFailure } from "./service.ts"

export interface Reporter {
  /** Tells herdr about `activity` soon, unless it is the one told last. Never blocks or fails. */
  readonly show: (activity: Activity) => void
  /**
   * Stops reporting and releases the pane, the first time it runs; a later run
   * waits for that one. Nothing is reported after it. Never fails.
   */
  readonly release: Effect.Effect<void>
}

export interface Target {
  /** herdr's id for our pane: `HERDR_PANE_ID`. */
  readonly paneId: string
  /** How long the labels go unrefreshed while nothing changes. */
  readonly refreshMillis?: number
}

export const reporter: (target: Target) => Effect.Effect<Reporter, never, Herdr | Scope.Scope> = Effect.fn("Herdr.reporter")(function* (target) {
  const herdr = yield* Herdr
  const activities = yield* Queue.sliding<Activity>(1)
  let closed = false
  let offered: Activity | undefined
  // The newest activity taken, and what herdr accepted last of its state and of its labels.
  let wanted: Activity | undefined
  let agentSent: Activity | undefined
  let seq = 0

  const stamp = Effect.map(Clock.currentTimeMillis, (now) => {
    seq = nextSeq(seq, now)
    return seq
  })
  const attempt = (method: string, request: Effect.Effect<void, HerdrFailure>) =>
    request.pipe(
      Effect.retry({ times: 1 }),
      Effect.as(true),
      Effect.catch((error) => Effect.as(Effect.logDebug(`herdr ${method} failed`).pipe(Effect.annotateLogs({ error: error.message })), false)),
    )
  const sendAgent = (activity: Activity) =>
    Effect.gen(function* () {
      const accepted = yield* attempt("pane.report_agent", herdr.report(agentParams(target.paneId, activity, yield* stamp)))
      if (accepted) agentSent = activity
      return accepted
    })
  const sendLabels = (activity: Activity) =>
    Effect.gen(function* () {
      return yield* attempt("pane.report_metadata", herdr.reportMetadata(metadataParams(target.paneId, activity, yield* stamp)))
    })

  let labelsSent: Activity | undefined
  const sync = (refresh: boolean) =>
    Effect.gen(function* () {
      if (wanted === undefined) return
      const next = wanted
      // The labels apply only while we hold the pane, so the state goes first.
      if (changes(agentSent, next).agent && !(yield* sendAgent(next))) return
      if ((refresh || changes(labelsSent, next).metadata) && (yield* sendLabels(next))) labelsSent = next
    })

  const worker = yield* Effect.forever(
    Effect.gen(function* () {
      const next = yield* Queue.take(activities).pipe(Effect.timeoutOption(target.refreshMillis ?? METADATA_REFRESH_MS))
      if (Option.isSome(next)) wanted = next.value
      yield* sync(Option.isNone(next))
    }),
  ).pipe(Effect.forkScoped)

  // The first run releases; a run after it waits for that one to end.
  const released = yield* Deferred.make<void>()
  const release = Effect.suspend(() => {
    if (closed) return Deferred.await(released)
    closed = true
    return Effect.gen(function* () {
      yield* Fiber.interrupt(worker)
      yield* Queue.shutdown(activities)
      yield* attempt("pane.release_agent", herdr.release(releaseParams(target.paneId, yield* stamp)))
    }).pipe(Effect.ensuring(Deferred.done(released, Exit.void)), Effect.uninterruptible)
  })
  yield* Effect.addFinalizer(() => release)

  return {
    release,
    show: (activity) => {
      if (closed) return
      if (offered !== undefined && sameActivity(offered, activity)) return
      offered = activity
      Queue.offerUnsafe(activities, activity)
    },
  }
})
