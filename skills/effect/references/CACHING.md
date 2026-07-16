# Caching and Batching

Choose the smallest abstraction that owns the required lifecycle. Cache policy is domain behavior: define capacity, TTL, failure retention, invalidation, and ownership deliberately.

## One effect result

Use `Effect.cached` to memoize one effect result for the lifetime of the returned effect, or `Effect.cachedWithTTL` when it must expire.

```ts
const getSnapshot = yield* loadSnapshot.pipe(Effect.cachedWithTTL("1 minute"))

const first = yield* getSnapshot
const second = yield* getSnapshot
```

Create the cached effect once in a layer or scoped owner. Creating it inside the public method creates a new cache on every call.

## Keyed lookups

```ts
import { Cache, Effect } from "effect"

const cache = yield* Cache.make({
  capacity: 1_000,
  timeToLive: "10 minutes",
  lookup: Effect.fn("Users.lookup")(function*(id: UserId) {
    const users = yield* UsersRepository
    return yield* users.get(id)
  })
})

const user = yield* Cache.get(cache, id)
```

`Cache.get` deduplicates concurrent misses for the same key. It caches the lookup `Exit`, so failures remain cached until expiry, invalidation, or refresh. Use `Cache.makeWith(lookup, options)` when TTL must depend on the key or success/failure exit.

Place the cache in the layer that owns its policy. Invalidate or refresh it in the same service that performs authoritative writes.

## Request batching

Use `Effect.request` and `RequestResolver` only when the backend exposes a real batch operation or requests should be coalesced by a defined resolver policy.

```ts
interface GetUser extends Request.Request<User, UserNotFound> {
  readonly _tag: "GetUser"
  readonly id: UserId
}

const GetUser = Request.tagged<GetUser>("GetUser")
const getUser = (id: UserId) => Effect.request(GetUser({ id }), resolver)
```

Complete every resolver entry exactly once, including missing keys and provider failures. Keep batch size limits and grouping in the resolver (`RequestResolver.batchN`, `makeGrouped`) rather than at callers.

## Selection

- One shared computation: `Effect.cached*`.
- Many keyed lookups with TTL/eviction/deduplication: `Cache`.
- True N-to-one backend call: `RequestResolver`.
- Resource pool with acquisition/release: `Pool`, not `Cache`.

Use `TestClock` to verify expiry and a `Deferred` or `Ref` counter to prove concurrent misses invoke the lookup once.
