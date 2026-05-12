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

## STM / Transactions

Effect v3 ships Software Transactional Memory as a **separate monad** `STM<A, E, R>`. STM expressions are built up purely, then run as an `Effect` via `STM.commit`. Every `T*` primitive (TRef, TQueue, TMap, …) exposes operations that return `STM<...>`, not `Effect<...>`.

```typescript
import { Effect, STM, TRef } from "effect"

const program = Effect.gen(function* () {
  // TRef.make returns STM — must be committed or used inside STM.gen
  const balance = yield* STM.commit(TRef.make(100))
  const savings = yield* STM.commit(TRef.make(0))

  // Build the transfer as an STM, then commit atomically
  const transfer = STM.gen(function* () {
    const current = yield* TRef.get(balance)
    yield* TRef.set(balance, current - 50)
    yield* TRef.update(savings, (s) => s + 50)
  })

  yield* STM.commit(transfer)

  console.log(yield* STM.commit(TRef.get(balance)))   // 50
  console.log(yield* STM.commit(TRef.get(savings)))   // 50
})
```

**Key APIs:**

| API | What it does |
|-----|--------------|
| `STM.commit(stm)` | Run an STM as an `Effect` — atomic commit, automatic retry on conflict |
| `STM.gen(function* () { ... })` | Compose STM operations in generator form |
| `STM.retry` | Suspend until any accessed `T*` value changes; then re-run the block |
| `STM.orElse(a, b)` | Try `a`; on retry/failure, run `b` |
| `STM.orTry(a, () => b)` | Like `orElse` but only on `retry`, not failure |
| `STM.all([...])` | Run STMs as one atomic block |
| `STM.check(predicate)` | `retry` when predicate is false (guard) |
| `STM.fail` / `STM.succeed` / `STM.die` | Same shapes as `Effect.*` but inside STM |

**Retry-as-wait pattern** (the STM idiom for blocking on a condition):

```typescript
// Wait until balance is at least 10, then withdraw — atomically
const withdraw10 = STM.gen(function* () {
  const value = yield* TRef.get(balance)
  if (value < 10) yield* STM.retry            // suspend until balance changes
  yield* TRef.set(balance, value - 10)
})

yield* STM.commit(withdraw10)
```

**T* primitive catalog (all return `STM<...>`):**

| Primitive | Use |
|-----------|-----|
| `TRef` | Transactional cell (one mutable value) |
| `TArray` | Transactional array (fixed length) |
| `TMap` | Transactional keyed map |
| `TSet` | Transactional set |
| `TQueue` | Transactional FIFO queue (bounded/unbounded/dropping/sliding) |
| `TPriorityQueue` | Transactional queue ordered by `Order<A>` |
| `TPubSub` | Transactional publish/subscribe hub |
| `TSemaphore` | Transactional permits |
| `TReentrantLock` | Read/write lock; multiple readers OR one writer; writer can reenter |
| `TDeferred` | Transactional write-once cell |
| `TSubscriptionRef` | `TRef` that streams committed changes (since 3.10) |
| `TRandom` | Transactional pseudo-random source |

**When to reach for STM vs other primitives:**

- **One value, one writer**: plain `Ref` is enough — no transaction needed.
- **Multiple refs that must agree** (transfer, swap, multi-field invariant): `TRef` + `STM.commit`.
- **Wait until a condition** (queue non-empty, balance ≥ X, permit free): `STM.retry` inside the block — cleaner than polling.
- **Subscribe to changes**: `TSubscriptionRef`.
- **Read-heavy with rare writes**: `TReentrantLock`.

**v4 note:** v4 (effect-smol) removes the `STM<A, E, R>` monad entirely. Every primitive returns a regular `Effect`, and `Effect.tx(...)` marks the atomic boundary; `Effect.txRetry` replaces `STM.retry`. The `T*` family is renamed to `Tx*` (e.g. `TRef → TxRef`, `TQueue → TxQueue`). See the `effect-v4` skill if you're migrating.

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
| `STM` + `T*` | Atomic multi-ref updates | Composable transactions, condition-wait via `STM.retry` |
