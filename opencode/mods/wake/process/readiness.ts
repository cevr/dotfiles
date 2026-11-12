/**
 * Test-only waits on a live boundary (a file a child writes, a pid that goes away): the condition
 * and the deadline decide the outcome, never a timer guess. A wait probes at once, then again on
 * an explicit schedule, each recurrence clamped so one probe lands on the deadline, and the
 * deadline wins at equality: a probe that would run at or past it times out instead, naming the
 * state it observed last. Ready is only what a probe observed before the deadline; an interrupted
 * wait stops probing at once.
 */
import { Clock, Data, Duration, Effect, Predicate, Ref, Result, Schedule } from "effect"

/** A wait that reached its deadline: what it waited for, how long, and the state its last probe saw. */
export class ReadinessTimeout extends Data.TaggedError("ReadinessTimeout")<{
  readonly label: string
  readonly waitedMs: number
  readonly last: string
}> {}

/** One probe that did not see the condition yet: the state it saw. */
class Pending extends Data.TaggedError("Pending")<{ readonly last: string }> {}

/** How long a wait may take, and how long it leaves between two probes. */
export interface Policy {
  readonly within: Duration.Input
  readonly every: Duration.Input
}

/** What a probe reports: the ready value, or the state it saw instead. */
export type Observation<A> = Result.Result<A, string>

/** Ready with `value`. */
export const ready = <A,>(value: A): Observation<A> => Result.succeed(value)

/** Not ready: `state` is what the probe saw, named in a timeout. */
export const notYet = (state: string): Observation<never> => Result.fail(state)

/** The last state a wait saw before any probe ran. */
export const NEVER_PROBED = "never probed"

interface Attempt<A, R> {
  readonly label: string
  readonly probe: Effect.Effect<Observation<A>, never, R>
  readonly start: number
  readonly deadline: number
  readonly last: Ref.Ref<string>
}

const attempt = Effect.fn("Readiness.attempt")(function* <A, R>(wait: Attempt<A, R>) {
  const now = yield* Clock.currentTimeMillis
  if (now >= wait.deadline) return yield* new ReadinessTimeout({ label: wait.label, waitedMs: now - wait.start, last: yield* Ref.get(wait.last) })
  const seen = yield* wait.probe
  if (Result.isSuccess(seen)) return seen.success
  yield* Ref.set(wait.last, seen.failure)
  return yield* new Pending({ last: seen.failure })
})

/** The delay to the next probe: the policy's spacing, cut short so a probe lands on the deadline. */
const untilDeadline = (deadline: number) => (metadata: { readonly duration: Duration.Duration }) =>
  Effect.map(Clock.currentTimeMillis, (now) => Duration.millis(Math.max(0, Math.min(Duration.toMillis(metadata.duration), deadline - now))))

/**
 * Probes until `probe` reports ready, and fails with `ReadinessTimeout` at the deadline. Every
 * probe after the first waits the policy's spacing, so a wait of `within` probes at most
 * `within / every` times more; the attempt cap only backs the deadline, which ends it first.
 */
export const waitFor = Effect.fn("Readiness.waitFor")(function* <A, R>(label: string, probe: Effect.Effect<Observation<A>, never, R>, policy: Policy) {
  const start = yield* Clock.currentTimeMillis
  const within = Duration.toMillis(policy.within)
  const every = Math.max(1, Duration.toMillis(policy.every))
  const deadline = start + within
  const last = yield* Ref.make(NEVER_PROBED)
  const schedule = Schedule.spaced(Duration.millis(every)).pipe(Schedule.modifyDelay(untilDeadline(deadline)))
  return yield* attempt({ label, probe, start, deadline, last }).pipe(
    Effect.retry({ schedule, times: Math.ceil(within / every) + 1, while: Predicate.isTagged("Pending") }),
    Effect.catchTag("Pending", (pending) => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.fail(new ReadinessTimeout({ label, waitedMs: now - start, last: pending.last })))),
  )
})
