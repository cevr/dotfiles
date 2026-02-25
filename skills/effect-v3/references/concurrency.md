# Concurrency

Effect v3 concurrency primitives.

## FiberSet (unkeyed collection)

Run multiple fibers, track them as a group. Auto-cleanup on scope close.

```typescript
import { FiberSet } from "effect"

const program = Effect.gen(function* () {
  const set = yield* FiberSet.make<void, Error>()

  // Add fibers to the set
  yield* FiberSet.run(set, processItem("a"))
  yield* FiberSet.run(set, processItem("b"))
  yield* FiberSet.run(set, processItem("c"))

  // Wait for all
  yield* FiberSet.join(set)
})
```

## FiberMap (keyed collection)

Like FiberSet but keyed — adding a fiber with an existing key interrupts the previous one.

```typescript
import { FiberMap } from "effect"

const program = Effect.gen(function* () {
  const map = yield* FiberMap.make<string, void, Error>()

  // Start a fiber for each user
  yield* FiberMap.run(map, "user-1", watchUser("user-1"))
  yield* FiberMap.run(map, "user-2", watchUser("user-2"))

  // Replace — interrupts previous fiber for "user-1"
  yield* FiberMap.run(map, "user-1", watchUser("user-1-v2"))

  // Remove a specific entry
  yield* FiberMap.remove(map, "user-2")
})
```

## FiberHandle (single slot)

One fiber at a time. Starting a new one interrupts the previous.

```typescript
import { FiberHandle } from "effect"

const program = Effect.gen(function* () {
  const handle = yield* FiberHandle.make<void, Error>()

  // Start a fiber
  yield* FiberHandle.run(handle, longRunningTask)

  // Replace — interrupts previous
  yield* FiberHandle.run(handle, differentTask)

  // Wait for current
  yield* FiberHandle.join(handle)
})
```

## Deferred (single-use async signal)

A promise-like value that can be set once.

```typescript
import { Deferred } from "effect"

const program = Effect.gen(function* () {
  const deferred = yield* Deferred.make<string, Error>()

  // Consumer — blocks until value is available
  const consumer = Effect.gen(function* () {
    const value = yield* Deferred.await(deferred)
    yield* Console.log(`Got: ${value}`)
  })

  // Producer — sets the value
  const producer = Effect.gen(function* () {
    yield* Effect.sleep("1 second")
    yield* Deferred.succeed(deferred, "hello")
  })

  yield* Effect.all([consumer, producer], { concurrency: 2 })
})
```

## Semaphore (permits)

Limit concurrent access to a resource.

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const semaphore = yield* Effect.makeSemaphore(3) // 3 permits

  // Each withPermit acquires 1 permit, releases on completion
  const tasks = Array.from({ length: 10 }, (_, i) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* Effect.log(`Task ${i} running`)
        yield* Effect.sleep("1 second")
      })
    )
  )

  yield* Effect.all(tasks, { concurrency: "unbounded" })
})
```

## Effect.all / Effect.forEach (concurrent combinators)

```typescript
// Concurrent execution
const results = yield* Effect.all(
  [fetchUser("1"), fetchUser("2"), fetchUser("3")],
  { concurrency: 3 }
)

// Concurrent forEach
yield* Effect.forEach(
  userIds,
  (id) => processUser(id),
  { concurrency: 5 }
)

// Unbounded concurrency
yield* Effect.all(tasks, { concurrency: "unbounded" })

// With discard (don't collect results)
yield* Effect.forEach(items, process, {
  concurrency: 10,
  discard: true,
})
```

## Quick Reference

| Primitive | Key Feature | When to Use |
|-----------|-------------|-------------|
| `FiberSet` | Unkeyed collection | Track N independent fibers |
| `FiberMap` | Keyed, auto-interrupt | One fiber per key, replaceable |
| `FiberHandle` | Single slot, auto-interrupt | One active fiber at a time |
| `Deferred` | Single-use signal | Producer/consumer coordination |
| `Semaphore` | Permits | Rate limiting, resource pooling |
| `Effect.all` | Batch combinator | Run array of effects together |
| `Effect.forEach` | Map combinator | Transform items concurrently |
