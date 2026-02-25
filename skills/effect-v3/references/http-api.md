# HTTP API

Effect v3 HttpApi patterns using `@effect/platform`.

## API Definition

```typescript
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema as S } from "effect"

// Tagged error with HTTP status
export class UserNotFound extends S.TaggedError<UserNotFound>()(
  "UserNotFound",
  { userId: S.String, message: S.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

// Group definition
export const UserGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(S.Struct({ limit: S.NumberFromString, offset: S.NumberFromString }))
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
  .add(
    HttpApiEndpoint.del("delete", "/:id")
      .setPath(S.Struct({ id: UserId }))
      .addSuccess(S.Void)
      .addError(UserNotFound)
  )
  .prefix("/users")
```

## API Composition

```typescript
export class AppApi extends HttpApi.make("AppApi")
  .add(UserGroup)
  .add(SessionGroup)
  .addError(Unauthorized)  // Global error
  .prefix("/v1")
{}
```

## Handler Implementation

```typescript
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"

export const UserGroupLive = HttpApiBuilder.group(
  AppApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      const users = yield* UserService

      return handlers
        .handle("list", ({ urlParams }) =>
          users.list(urlParams)
        )
        .handle("get", ({ path: { id } }) =>
          users.get(id)
        )
        .handle("create", ({ payload }) =>
          users.create(payload)
        )
        .handle("delete", ({ path: { id } }) =>
          users.delete(id)
        )
    })
)
```

## Auth Middleware

```typescript
import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"

// Middleware provides AuthContext to handlers
export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    failure: Unauthorized,
    provides: AuthContext,
    security: { bearer: HttpApiSecurity.bearer },
  }
) {}

// Implementation
export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const auth = yield* AuthService
    return {
      bearer: (token) =>
        Effect.gen(function* () {
          const payload = yield* auth.verifyToken(Redacted.value(token))
          return AuthContext.of({
            userId: payload.userId,
            roles: payload.roles,
          })
        }).pipe(
          Effect.catchAll(() =>
            Effect.fail(new Unauthorized({ message: "Invalid token" }))
          )
        ),
    }
  })
)
```

## Server Entry Point

```typescript
import { HttpApiBuilder } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

// Serve
const ServerLive = HttpApiBuilder.serve(api).pipe(
  Layer.provide(UserGroupLive),
  Layer.provide(SessionGroupLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(UserService.Live),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
)

BunRuntime.runMain(Layer.launch(ServerLive))
```

## toWebHandler (serverless)

```typescript
import { HttpApiBuilder } from "@effect/platform"

const handler = HttpApiBuilder.toWebHandler(
  HttpApiBuilder.api(AppApi).pipe(
    Layer.provide(UserGroupLive),
    Layer.provide(UserService.Live),
  )
)

// Use in serverless context
export default { fetch: handler }
```

## Auto-Generated Client

```typescript
import { HttpApiClient, FetchHttpClient } from "@effect/platform"

const client = Effect.gen(function* () {
  return yield* HttpApiClient.make(AppApi, { baseUrl: "/api" })
}).pipe(Effect.provide(FetchHttpClient.layer))

// Usage — fully type-safe, matches group/endpoint names
const users = yield* client.pipe(
  Effect.flatMap((c) => c.users.list({ urlParams: { limit: 10, offset: 0 } }))
)
```

## Key Points

- **Schema-first**: API schema defines types, routes, errors — generate everything else
- **HttpApiSchema.annotations({ status })**: maps TaggedError to HTTP status codes
- **HttpApiMiddleware.Tag**: middleware provides Context to handlers
- **HttpApiClient.make**: auto-generates type-safe client from schema
- **Separate schema from impl**: schema package is shareable, impl is server-only
