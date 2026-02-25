# RPC

Effect v4 RPC patterns using `effect/unstable/rpc`.

## Imports

```typescript
// v4 — from effect/unstable/rpc
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc"
```

## Define Requests

```typescript
import { Schema as S } from "effect"

const GetUser = Rpc.make("GetUser", {
  payload: S.Struct({ id: S.String }),
  success: User,
  error: UserNotFound,
})

const ListUsers = Rpc.make("ListUsers", {
  success: S.Array(User),
})

// Streaming
const WatchUsers = Rpc.make("WatchUsers", {
  payload: S.Struct({ filter: S.optional(S.String) }),
  success: User,
  stream: true,
})
```

## Group and Implement

```typescript
const UserRpcs = RpcGroup.make(GetUser, ListUsers, WatchUsers)

const UserHandlers = UserRpcs.toLayer({
  GetUser: Effect.fn("GetUser")(function* ({ id }) {
    const svc = yield* UserService
    return yield* svc.get(id)
  }),
  ListUsers: Effect.fn("ListUsers")(function* () {
    const svc = yield* UserService
    return yield* svc.list()
  }),
  WatchUsers: ({ filter }) =>
    Stream.fromEffect(UserService).pipe(
      Stream.flatMap((svc) => svc.watch(filter)),
    ),
})
```

## Serve

```typescript
import { RpcSerialization } from "effect/unstable/rpc"
import { BunHttpServer } from "@effect/platform-bun"

const { handler } = RpcServer.toWebHandler(UserRpcs, {
  layer: Layer.mergeAll(
    UserHandlers,
    UserService.layer,
    RpcSerialization.layerNdjsonStream,
  ),
})
```

## Key Differences from v3

| v3 | v4 |
|----|----|
| `import from "@effect/rpc"` | `import from "effect/unstable/rpc"` |
| `import from "@effect/rpc-http"` | `import from "effect/unstable/rpc"` (merged) |

API shape (Rpc.make, RpcGroup, toLayer) is the same.
