# Streams

Effect v3 Stream patterns.

## Creation

```typescript
import { Stream, Effect, Option } from "effect"

// From values
Stream.make(1, 2, 3)

// From iterable
Stream.fromIterable([1, 2, 3])

// From effect (single value)
Stream.fromEffect(Effect.succeed(42))

// Unfold (stateful generation)
Stream.unfold(0, (n) =>
  n < 10 ? Option.some([n, n + 1] as const) : Option.none()
)

// Infinite with iterate
Stream.iterate(1, (n) => n + 1)

// From Queue
Stream.fromQueue(queue)

// From PubSub
Stream.fromPubSub(pubsub)

// Async callback (push-based)
Stream.async<string, Error>((emit) => {
  ws.on("message", (data) => emit.single(data))
  ws.on("error", (err) => emit.fail(new MyError({ message: err.message })))
  ws.on("close", () => emit.end())
})

// Repeat an effect
Stream.repeatEffect(Effect.random)

// Range
Stream.range(1, 10) // 1..10 inclusive
```

## Transformation

```typescript
// Map
stream.pipe(Stream.map((n) => n * 2))

// Filter
stream.pipe(Stream.filter((n) => n > 5))

// MapEffect (effectful transform)
stream.pipe(Stream.mapEffect((n) => fetchUser(n)))

// FlatMap (one-to-many)
stream.pipe(Stream.flatMap((n) => Stream.make(n, n * 10)))

// Take / Drop
stream.pipe(Stream.take(5))
stream.pipe(Stream.drop(3))

// Scan (running accumulator)
stream.pipe(Stream.scan(0, (acc, n) => acc + n))

// MapAccum (scan that also emits)
stream.pipe(Stream.mapAccum(0, (acc, n) => [acc + n, acc + n]))

// Tap (side-effect without transforming)
stream.pipe(Stream.tap((n) => Effect.log(`Processing: ${n}`)))

// Concat
Stream.concat(streamA, streamB)

// Merge (interleave, concurrent)
Stream.merge(streamA, streamB)

// Zip
Stream.zip(streamA, streamB)
```

## Consumption

```typescript
// Collect all into Chunk
const chunk = yield* Stream.runCollect(stream)

// Run for each element
yield* Stream.runForEach(stream, (n) => Console.log(n))

// Fold to single value
const sum = yield* Stream.runFold(stream, 0, (acc, n) => acc + n)

// Run (discard output, execute effects)
yield* Stream.run(stream, Sink.drain)

// First element
const first = yield* Stream.runHead(stream)

// Last element
const last = yield* Stream.runLast(stream)
```

## Chunking & Batching

```typescript
// Group into fixed-size chunks
stream.pipe(Stream.grouped(100))

// Group by time window
stream.pipe(Stream.groupedWithin(100, "5 seconds"))

// Debounce
stream.pipe(Stream.debounce("500 millis"))

// Throttle
stream.pipe(Stream.throttle({ units: 1, duration: "1 second" }))
```

## Integration

```typescript
// Stream → Queue
const queue = yield* Stream.toQueue(stream)

// Queue → Stream
const fromQ = Stream.fromQueue(queue)

// Stream → PubSub
const pubsub = yield* Stream.toPubSub(stream)

// Broadcast (one stream, multiple consumers)
yield* stream.pipe(
  Stream.broadcast(2, 16),
  Effect.flatMap(([s1, s2]) =>
    Effect.all([
      Stream.runForEach(s1, processA),
      Stream.runForEach(s2, processB),
    ], { concurrency: 2 })
  )
)
```

## Quick Reference

| Category | APIs |
|----------|------|
| Create | `make`, `fromIterable`, `fromEffect`, `unfold`, `iterate`, `async`, `fromQueue` |
| Transform | `map`, `filter`, `mapEffect`, `flatMap`, `take`, `drop`, `scan`, `tap` |
| Combine | `concat`, `merge`, `zip`, `interleave` |
| Consume | `runCollect`, `runForEach`, `runFold`, `run`, `runHead`, `runLast` |
| Batch | `grouped`, `groupedWithin`, `debounce`, `throttle` |
| Bridge | `toQueue`, `fromQueue`, `toPubSub`, `broadcast` |
