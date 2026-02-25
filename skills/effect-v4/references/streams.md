# Streams

Effect v4 Stream patterns. Minor changes from v3.

## Creation

```typescript
import { Stream, Effect, Option } from "effect"

Stream.make(1, 2, 3)
Stream.fromIterable([1, 2, 3])
Stream.fromEffect(Effect.succeed(42))
Stream.unfold(0, (n) => n < 10 ? Option.some([n, n + 1] as const) : Option.none())
Stream.iterate(1, (n) => n + 1)
Stream.fromQueue(queue)
Stream.range(1, 10)

// Async callback
Stream.async<string, Error>((emit) => {
  ws.on("message", (data) => emit.single(data))
  ws.on("error", (err) => emit.fail(new MyError({ message: err.message })))
  ws.on("close", () => emit.end())
})
```

## Transformation

```typescript
stream.pipe(Stream.map((n) => n * 2))
stream.pipe(Stream.filter((n) => n > 5))
stream.pipe(Stream.mapEffect((n) => fetchUser(n)))
stream.pipe(Stream.flatMap((n) => Stream.make(n, n * 10)))
stream.pipe(Stream.take(5))
stream.pipe(Stream.drop(3))
stream.pipe(Stream.scan(0, (acc, n) => acc + n))
stream.pipe(Stream.tap((n) => Effect.log(`Processing: ${n}`)))
Stream.merge(streamA, streamB)
```

## Consumption

```typescript
const chunk = yield* Stream.runCollect(stream)
yield* Stream.runForEach(stream, (n) => Console.log(n))
const sum = yield* Stream.runFold(stream, 0, (acc, n) => acc + n)
yield* Stream.runDrain(stream)
const first = yield* Stream.runHead(stream)
```

## Chunking & Batching

```typescript
stream.pipe(Stream.grouped(100))
stream.pipe(Stream.groupedWithin(100, "5 seconds"))
stream.pipe(Stream.debounce("500 millis"))
```

## v4 Changes

Streams are largely unchanged in v4. Key difference:
- Stream implements Yieldable protocol (not an Effect subtype)
- `yield*` still works the same way
- Import remains `import { Stream } from "effect"`

## Quick Reference

| Category | APIs |
|----------|------|
| Create | `make`, `fromIterable`, `fromEffect`, `unfold`, `iterate`, `async`, `fromQueue` |
| Transform | `map`, `filter`, `mapEffect`, `flatMap`, `take`, `drop`, `scan`, `tap` |
| Combine | `concat`, `merge`, `zip`, `interleave` |
| Consume | `runCollect`, `runForEach`, `runFold`, `runDrain`, `runHead`, `runLast` |
| Batch | `grouped`, `groupedWithin`, `debounce`, `throttle` |
| Bridge | `toQueue`, `fromQueue`, `toPubSub`, `broadcast` |
