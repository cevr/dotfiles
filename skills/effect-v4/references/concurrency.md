# Concurrency

Effect v4 concurrency primitives.

## FiberSet, FiberMap, FiberHandle

Same API as v3. See effect-v3 skill for patterns.

## Fork Renames

| v3 | v4 |
|----|----|
| `Effect.fork` | `Effect.forkChild` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.forkScoped` | `Effect.forkScoped` (unchanged) |
| `Effect.forkIn` | `Effect.forkIn` (unchanged) |

All fork variants accept options:

```typescript
yield* Effect.forkChild(myEffect, { startImmediately: true })
// or pipe style:
yield* myEffect.pipe(Effect.forkChild({ startImmediately: true }))
```

## Deferred, Semaphore

Unchanged from v3.

## Effect.all / Effect.forEach

Unchanged from v3.

## Transactions (NEW in v4)

### TxRef

Transactional references — atomic updates across multiple refs.

```typescript
import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const balance = yield* TxRef.make(100)
  const savings = yield* TxRef.make(0)

  // Atomic transfer — both updates succeed or neither does
  yield* Effect.atomic(Effect.gen(function* () {
    const current = yield* TxRef.get(balance)
    yield* TxRef.set(balance, current - 50)
    yield* TxRef.update(savings, (s) => s + 50)
  }))

  console.log(yield* TxRef.get(balance))  // 50
  console.log(yield* TxRef.get(savings))  // 50
})
```

### Effect.atomic vs Effect.transaction

| API | Behavior |
|-----|----------|
| `Effect.atomic(effect)` | Composable — joins parent transaction if nested |
| `Effect.transaction(effect)` | Isolated — always starts fresh transaction |

```typescript
// Nested atomic — inner composes with outer
yield* Effect.atomic(Effect.gen(function* () {
  yield* TxRef.set(ref1, 10)
  // This inner atomic joins the outer transaction
  yield* Effect.atomic(Effect.gen(function* () {
    yield* TxRef.set(ref2, 20)
  }))
  // Both ref1 and ref2 commit together
}))

// Retry within transaction
yield* Effect.atomic(Effect.gen(function* () {
  const value = yield* TxRef.get(ref)
  if (value < 10) yield* Effect.retryTransaction
  yield* TxRef.set(ref, value - 10)
}))
```

### TxRef API

```typescript
TxRef.make(initialValue)          // Effect<TxRef<A>>
TxRef.makeUnsafe(initialValue)    // TxRef<A> (sync, outside Effect)
TxRef.get(ref)                    // Effect<A>
TxRef.set(ref, value)             // Effect<void>
TxRef.update(ref, f)              // Effect<void>
TxRef.modify(ref, f)              // Effect<B> where f: A => [B, A]
```

### Tx Collections

```typescript
import { TxChunk, TxHashMap, TxHashSet, TxQueue, TxSemaphore } from "effect"

// TxQueue — transactional FIFO queue
const q = yield* TxQueue.make<string>()
yield* Effect.atomic(Effect.gen(function* () {
  yield* TxQueue.offer(q, "a")
  yield* TxQueue.offer(q, "b")
}))

// TxSemaphore — transactional semaphore
const sem = yield* TxSemaphore.make(3)
yield* Effect.atomic(
  TxSemaphore.withPermit(sem)(myEffect)
)
```

## Quick Reference

| Primitive | v3 → v4 Change |
|-----------|----------------|
| `FiberSet` | Unchanged |
| `FiberMap` | Unchanged |
| `FiberHandle` | Unchanged |
| `Deferred` | Unchanged |
| `Semaphore` | Unchanged |
| `Effect.fork` | → `Effect.forkChild` |
| `Effect.forkDaemon` | → `Effect.forkDetach` |
| `TxRef` | NEW — transactional refs |
| `Effect.atomic` | NEW — composable transactions |
| `Effect.transaction` | NEW — isolated transactions |
