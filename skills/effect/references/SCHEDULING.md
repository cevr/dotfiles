# Scheduling

Use `Schedule` to make retry and repetition policy explicit, composable, bounded, and testable.

## Retry failures

```ts
import { Effect, Schedule } from "effect"

const transient = Schedule.exponential("100 millis").pipe(
  Schedule.jittered
)
const boundedTransient = Schedule.max([transient, Schedule.recurs(4)])

const result = yield* operation.pipe(
  Effect.retry({
    schedule: boundedTransient,
    while: (error) => error._tag === "TemporarilyUnavailable"
  })
)
```

- Bound retries by attempts, elapsed time, or both.
- Filter on the typed error before applying delay policy.
- Preserve the final failure unless the boundary has a truthful fallback.
- Retry side effects only when idempotency is established by operation semantics or an idempotency key.
- Read provider retry metadata at the adapter boundary and incorporate it into the policy when available.

## Repeat successes

`Effect.retry` reacts to failure. `Effect.repeat` schedules another run after success.

```ts
const worker = runPass().pipe(
  Effect.catchTags({
    RecoverablePassError: (error) => Effect.logWarning(error.message)
  }),
  Effect.repeat(Schedule.spaced("30 seconds"))
)
```

Handle expected pass failures before `repeat` when the worker should continue. Leave fatal or unknown failures visible so the owning scope can stop and report them.

## Polling

Separate one pass from the loop:

```ts
const runPass = Effect.fn("Indexer.runPass")(function*() {
  const cursor = yield* loadCursor
  const page = yield* fetchPage(cursor)
  yield* persistPage(page)
  return page.nextCursor
})

const poll = runPass().pipe(Effect.repeat(Schedule.spaced("5 seconds")))
```

This gives tests a finite unit and keeps scheduling out of domain logic. Start a long-lived poller with `Effect.forkScoped` in the layer that owns it.

## Policy selection

- Fixed pacing: `Schedule.spaced(duration)`.
- Increasing delay: `Schedule.exponential(base)`.
- Thundering-herd protection: add `Schedule.jittered`.
- Attempt bound: intersect with `Schedule.recurs(n)` or use retry options with `times`.
- Provider-aware HTTP retry: prefer `HttpClient.retryTransient(...)` and pass a bounded schedule.

Test schedule behavior with `TestClock`; advance virtual time instead of sleeping.
