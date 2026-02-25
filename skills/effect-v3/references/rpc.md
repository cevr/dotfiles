# RPC

Effect v3 RPC patterns using `@effect/rpc`.

## Define Requests

```typescript
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema as S } from "effect"

// Simple request
const GetUser = Rpc.make("GetUser", {
  payload: S.Struct({ id: S.String }),
  success: User,
  error: UserNotFound,
})

// Request with no payload
const ListUsers = Rpc.make("ListUsers", {
  success: S.Array(User),
})

// Streaming request
const WatchUsers = Rpc.make("WatchUsers", {
  payload: S.Struct({ filter: S.optional(S.String) }),
  success: User,
  error: S.Never,
  stream: true,
})
```

## Group Requests

```typescript
const UserRpcs = RpcGroup.make("Users")
  .add(GetUser)
  .add(ListUsers)
  .add(WatchUsers)

// Merge groups
const AllRpcs = RpcGroup.merge(UserRpcs, SessionRpcs)

// Prefix
const PrefixedRpcs = UserRpcs.prefix("v1")
```

## Implement Handlers

```typescript
// Handler layer
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

## Serve via HTTP

```typescript
import { RpcSerialization } from "@effect/rpc"
import { HttpRpcGroup } from "@effect/rpc-http"
import { BunHttpServer } from "@effect/platform-bun"

const ServerLive = HttpRpcGroup.toHttpApp(UserRpcs).pipe(
  Layer.provide(UserHandlers),
  Layer.provide(UserService.Live),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
)
```

## Client

```typescript
import { HttpRpcClient } from "@effect/rpc-http"
import { FetchHttpClient } from "@effect/platform"

const client = HttpRpcClient.make(UserRpcs, {
  baseUrl: "http://localhost:3000",
}).pipe(
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(FetchHttpClient.layer),
)

// Usage
const user = yield* GetUser({ id: "123" }).pipe(
  Effect.provide(client)
)
```

## Key Points

- **Rpc.make** — define request schema (payload, success, error, stream)
- **RpcGroup.make** — group related requests
- **group.toLayer** — implement handlers as a Layer
- **stream: true** — handler returns a Stream instead of a single value
- **RpcSerialization** — MsgPack or JSON serialization
