# HTTP API

Effect v4 HttpApi patterns using `effect/unstable/httpapi`.

## Imports

```typescript
// v4 — from effect/unstable/httpapi and effect/unstable/http
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpClient, HttpServer } from "effect/unstable/http"
// Platform-specific still separate
import { BunHttpServer } from "@effect/platform-bun"
```

## API Definition

```typescript
import { Schema as S } from "effect"

// v4: TaggedErrorClass (not TaggedError)
export class UserNotFound extends S.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  { userId: S.String, message: S.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

export const UserGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(S.Struct({ limit: S.NumberFromString }))
      .addSuccess(S.Array(User))
  )
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(S.Struct({ id: UserId }))
      .addSuccess(User)
      .addError(UserNotFound)
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateUserPayload)
      .addSuccess(User, { status: 201 })
  )
  .prefix("/users")
```

## API Composition

```typescript
export class AppApi extends HttpApi.make("AppApi")
  .add(UserGroup)
  .add(SessionGroup)
  .prefix("/v1")
{}
```

## Handler Implementation

```typescript
export const UserGroupLive = HttpApiBuilder.group(
  AppApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      const users = yield* UserService

      return handlers
        .handle("list", ({ urlParams }) => users.list(urlParams))
        .handle("get", ({ path: { id } }) => users.get(id))
        .handle("create", ({ payload }) => users.create(payload))
    })
)
```

## Server Entry Point

```typescript
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"

const ServerLive = HttpApiBuilder.serve(api).pipe(
  Layer.provide(UserGroupLive),
  Layer.provide(UserService.layer),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
)

BunRuntime.runMain(Layer.launch(ServerLive))
```

## Key Differences from v3

| v3 | v4 |
|----|----|
| `import from "@effect/platform"` | `import from "effect/unstable/httpapi"` |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `.annotations({...})` | `.annotate({...})` |
| `BunContext.layer` | `BunServices.layer` |

Everything else (HttpApiGroup, HttpApiEndpoint, HttpApiBuilder.group) works the same.
