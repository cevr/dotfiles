# Streams

Use `Stream<A, E, R>` for effectful sources that emit many values over time and need pull, backpressure, interruption, or transformation. Use an ordinary `Effect<Array<A>, ...>` for finite all-at-once results.

## Sources

```ts
Stream.fromIterable(values)
Stream.fromEffect(loadOne)
Stream.fromQueue(queue)
Stream.fromPubSub(pubsub)
Stream.fromAsyncIterable(iterable, mapError)
Stream.paginate(initialState, nextPage)
```

Wrap event emitters and callback sources with scoped constructors that unregister listeners on interruption. Convert queue/pubsub boundaries to streams for downstream composition rather than exposing receive loops throughout the application.

## Transform and consume

```ts
const program = source.pipe(
  Stream.mapEffect(parseEvent),
  Stream.filter(isRelevant),
  Stream.groupedWithin(100, "1 second"),
  Stream.runForEach(writeBatch)
)
```

- `mapEffect`: one effectful operation per element.
- `flatMap`: each element expands to another stream.
- `grouped` / `groupedWithin`: batch by count or count-and-time.
- `runForEach`: effectful consumer.
- `runCollect`: collect only when the result is known to be bounded.
- `runDrain`: execute for effects and discard values.

## Ownership and backpressure

Start long-lived consumers with `Effect.forkScoped` in the layer that owns the source. Choose queue capacity and overflow strategy from the domain:

- Bounded queue: slow producers when consumers lag.
- Dropping/sliding queue: accept explicit data loss for telemetry or latest-state workloads.
- Unbounded queue: only when growth is independently bounded.

## Errors and retries

Map source-specific failures near the source. Retry only the smallest idempotent segment: retrying an entire stream can replay elements already consumed. For pagination, keep the cursor in stream state and make page persistence idempotent before retrying page fetches.

Use `Stream.retry(schedule)` for a restartable source. Use `Effect.retry` inside `mapEffect` when only one element's operation should retry.
