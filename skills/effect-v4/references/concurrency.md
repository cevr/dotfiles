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

## Transactions / STM (NEW in v4)

v4 replaces v3's separate `STM<A, E, R>` monad with a unified model: every Tx primitive returns a normal `Effect`, and `Effect.tx` marks a block as transactional. Inside the block, reads are tracked, writes are journaled, and the whole block commits atomically or retries.

### Effect.tx

`Effect.tx(effect)` runs `effect` as a transaction. **Auto-joins** the outer transaction when nested — there is no separate "isolated transaction" combinator in v4. The journal commits at the outermost `Effect.tx` boundary only.

```typescript
import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const balance = yield* TxRef.make(100)
  const savings = yield* TxRef.make(0)

  // Atomic transfer — both writes commit together, or neither does
  yield* Effect.tx(Effect.gen(function* () {
    const current = yield* TxRef.get(balance)
    yield* TxRef.set(balance, current - 50)
    yield* TxRef.update(savings, (s) => s + 50)
  }))

  console.log(yield* TxRef.get(balance))  // 50
  console.log(yield* TxRef.get(savings))  // 50
})
```

If any accessed `Tx*` value changes between read and commit, the transaction restarts automatically (optimistic concurrency).

### Effect.txRetry

Explicitly retry the current transaction. The fiber suspends until **any** accessed `Tx*` value changes, then re-runs the block. Use this to wait for a condition.

```typescript
// Wait until balance is at least 10, then withdraw
yield* Effect.tx(Effect.gen(function* () {
  const value = yield* TxRef.get(balance)
  if (value < 10) yield* Effect.txRetry          // suspend + re-run on change
  yield* TxRef.set(balance, value - 10)
}))
```

There is **no** `Effect.atomic`, `Effect.transaction`, or `Effect.retryTransaction` in v4. Only `Effect.tx` and `Effect.txRetry`.

### TxRef API

```typescript
TxRef.make(initial)               // Effect<TxRef<A>>
TxRef.makeUnsafe(initial)         // TxRef<A>           (sync, outside Effect)
TxRef.get(ref)                    // Effect<A>          (transactional)
TxRef.set(ref, value)             // Effect<void>
TxRef.update(ref, f)              // Effect<void>
TxRef.modify(ref, f)              // Effect<B> where f: A => [B, A]
```

All `Tx*` operations are plain `Effect`s — they can be used outside `Effect.tx` (each becomes a single-step transaction), but the atomicity guarantees only span what you wrap in `Effect.tx`.

### Tx Collections

```typescript
import { TxQueue, TxSemaphore, TxHashMap, TxHashSet, TxPubSub, TxSubscriptionRef } from "effect"

// TxQueue — transactional queue with strategies
const q = yield* TxQueue.bounded<string>(100)     // bounded(capacity)
// also: TxQueue.unbounded(), TxQueue.dropping(cap), TxQueue.sliding(cap)
yield* Effect.tx(Effect.gen(function* () {
  yield* TxQueue.offer(q, "a")
  yield* TxQueue.offer(q, "b")
  // both visible atomically to other fibers
}))
const item = yield* TxQueue.take(q)               // suspends if empty (txRetry)

// TxSemaphore — transactional permits
const sem = yield* TxSemaphore.make(3)
yield* TxSemaphore.withPermit(sem)(myEffect)      // not curried — direct call
yield* TxSemaphore.withPermits(sem, 2)(myEffect)
```

### Tx Primitive Catalog

| Primitive | Use |
|-----------|-----|
| `TxRef` | Transactional cell (one mutable value) |
| `TxChunk` | Transactional `Chunk<A>` (ordered sequence) |
| `TxHashMap` | Transactional keyed map |
| `TxHashSet` | Transactional set |
| `TxQueue` | Transactional queue (bounded/unbounded/dropping/sliding); has Open/Closing/Done lifecycle |
| `TxPriorityQueue` | Transactional queue ordered by `Order<A>` |
| `TxPubSub` | Transactional publish/subscribe; subscribers each receive every message |
| `TxSubscriptionRef` | `TxRef` that streams committed changes to subscribers |
| `TxSemaphore` | Transactional permits; `withPermit`/`withPermits`/`tryAcquire` |
| `TxReentrantLock` | Read/write lock; multiple readers OR one writer; writer can reenter |
| `TxDeferred` | Write-once cell; readers `txRetry` until set |

### When to reach for Tx vs other primitives

- **One value, one fiber writing**: `Ref` is fine — no transaction needed.
- **Multiple refs that must agree** (transfer between accounts, swap, multi-field invariant): `TxRef` + `Effect.tx`.
- **Wait until a condition** (queue non-empty, balance ≥ X, permit available): `Effect.txRetry` inside `Effect.tx` is cleaner than polling with `Deferred`.
- **Subscribe to changes**: `TxSubscriptionRef` (current value + every commit as a `Stream`).
- **Read-heavy with rare writes**: `TxReentrantLock` lets readers proceed concurrently.

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
| `STM<A, E, R>` monad | Removed — Tx primitives return `Effect` |
| `STM.commit` | Removed — wrap in `Effect.tx` instead |
| `STM.retry` | → `Effect.txRetry` |
| `TRef` | → `TxRef` |
| `TArray` | → `TxChunk` (or `TxHashMap` for keyed) |
| `TMap` | → `TxHashMap` |
| `TSet` | → `TxHashSet` |
| `TQueue` | → `TxQueue` |
| `TPriorityQueue` | → `TxPriorityQueue` |
| `TPubSub` | → `TxPubSub` |
| `TSemaphore` | → `TxSemaphore` |
| `TReentrantLock` | → `TxReentrantLock` |
| `TDeferred` | → `TxDeferred` |
| `TSubscriptionRef` | → `TxSubscriptionRef` |
| `TRandom` | Removed — use `Random` service with `TxRef`-backed seed if needed |
