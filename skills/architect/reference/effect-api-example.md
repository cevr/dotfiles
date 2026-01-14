# Effect API Example Reference

Key patterns from TeamWarp/effect-api-example for Effect-native HTTP APIs.

## Project Overview

Demonstrates:
- **Schema-first API design**: Define API shape, generate everything else
- **HttpApi/HttpApiBuilder split**: Schema in one package, implementation in another
- **Auto-generated client**: Type-safe client from API schema
- **Layer-based architecture**: All dependencies injected via Effect layers

## Package Structure

```
packages/
├── api/                   # Schema-only (shareable)
│   ├── src/
│   │   ├── definition/
│   │   │   ├── groups/    # HttpApiGroup definitions
│   │   │   ├── middleware/# HttpApiMiddleware schemas
│   │   │   ├── Api.ts     # Main HttpApi composition
│   │   │   └── Pagination.ts
│   │   └── index.ts
│   └── package.json       # Only effect, @effect/platform
│
├── shared/                # Branded types
│   └── src/
│       └── index.ts       # SessionId, UserId, etc.
│
apps/
├── server/                # Implementation
│   ├── src/
│   │   ├── handlers/      # HttpApiBuilder.group
│   │   ├── middleware/    # Middleware implementations
│   │   ├── db/            # Drizzle schema + migrations
│   │   └── main.ts
│   └── package.json
│
└── web/                   # Client (uses packages/api)
    └── ...
```

## API Schema Definition

```typescript
// packages/api/src/definition/groups/SessionGroup.ts
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema as S } from "effect"
import { SessionIdSchema, Session, CreateSessionPayload } from "@my-app/shared"

// Tagged error with HTTP status
export class SessionNotFound extends S.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: S.String, message: S.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

// Group definition
export const SessionGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(PaginationParams)
      .addSuccess(PaginatedResponse(Session))
  )
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .addSuccess(Session)
      .addError(SessionNotFound)
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateSessionPayload)
      .addSuccess(Session, { status: 201 })
  )
  .add(
    HttpApiEndpoint.patch("update", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .setPayload(UpdateSessionPayload)
      .addSuccess(Session)
      .addError(SessionNotFound)
  )
  .add(
    HttpApiEndpoint.del("delete", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .addSuccess(S.Void)
      .addError(SessionNotFound)
  )
  .prefix("/sessions")
```

## API Composition

```typescript
// packages/api/src/definition/Api.ts
import { HttpApi } from "@effect/platform"
import { SessionGroup } from "./groups/SessionGroup"
import { UserGroup } from "./groups/UserGroup"
import { AuthMiddleware } from "./middleware/AuthMiddleware"

export class AppApi extends HttpApi.make("AppApi")
  .add(SessionGroup)
  .add(UserGroup)
  .addError(AuthMiddleware.failure)  // Global error
  .prefix("/v1")
{}
```

## Auth Middleware Schema

```typescript
// packages/api/src/definition/middleware/AuthMiddleware.ts
import { Context, Schema as S } from "effect"
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "@effect/platform"

export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

export class AuthContext extends Context.Tag("AuthContext")<
  AuthContext,
  {
    readonly userId: string
    readonly roles: ReadonlyArray<string>
  }
>() {}

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    failure: Unauthorized,
    provides: AuthContext,
    security: {
      bearer: HttpApiSecurity.bearer,
    },
  }
) {}
```

## Server Implementation

```typescript
// apps/server/src/handlers/SessionGroupLive.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { AppApi, SessionNotFound, AuthContext } from "@my-app/api"
import { SessionService } from "../services/session"

export const SessionGroupLive = HttpApiBuilder.group(
  AppApi,
  "sessions",
  (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* SessionService

      return handlers
        .handle("list", ({ urlParams }) =>
          sessions.list(urlParams)
        )
        .handle("get", ({ path: { id } }) =>
          sessions.get(id).pipe(
            Effect.catchTag("SessionNotFound", (e) =>
              Effect.fail(new SessionNotFound({
                sessionId: id,
                message: e.message,
              }))
            )
          )
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const auth = yield* AuthContext
            return yield* sessions.create({
              ...payload,
              ownerId: auth.userId,
            })
          })
        )
        .handle("update", ({ path: { id }, payload }) =>
          sessions.update(id, payload)
        )
        .handle("delete", ({ path: { id } }) =>
          sessions.delete(id)
        )
    })
)
```

## Middleware Implementation

```typescript
// apps/server/src/middleware/AuthMiddlewareLive.ts
import { Effect, Layer, Redacted } from "effect"
import { AuthMiddleware, AuthContext, Unauthorized } from "@my-app/api"
import { AuthService } from "../services/auth"

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const auth = yield* AuthService

    return {
      bearer: (token) =>
        Effect.gen(function* () {
          const tokenValue = Redacted.value(token)

          if (!tokenValue) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Missing token" })
            )
          }

          const payload = yield* auth.verifyToken(tokenValue).pipe(
            Effect.catchTags({
              AuthTokenExpired: () =>
                Effect.fail(new Unauthorized({ message: "Token expired" })),
              AuthTokenInvalid: () =>
                Effect.fail(new Unauthorized({ message: "Invalid token" })),
            })
          )

          return AuthContext.of({
            userId: payload.userId,
            roles: payload.roles,
          })
        }),
    }
  })
)
```

## Server Entry Point

```typescript
// apps/server/src/main.ts
import { HttpLayerRouter, HttpServer } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { AppApi } from "@my-app/api"
import { SessionGroupLive } from "./handlers/SessionGroupLive"
import { AuthMiddlewareLive } from "./middleware/AuthMiddlewareLive"
import { SessionService } from "./services/session"
import { SqlLive } from "./db/SqlLive"

// Compose all route handlers
const ApiRoutes = HttpLayerRouter.addHttpApi(AppApi).pipe(
  Layer.provide(SessionGroupLive),
  Layer.provide(AuthMiddlewareLive),
)

// Add services
const AppLayer = ApiRoutes.pipe(
  Layer.provide(SessionService.Live),
  Layer.provide(SqlLive),
)

// Create and run server
const ServerLive = HttpLayerRouter.serve(AppLayer).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
)

BunRuntime.runMain(Layer.launch(ServerLive))
```

## Auto-Generated Client

```typescript
// apps/web/src/api/client.ts
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpApiClient, FetchHttpClient } from "@effect/platform"
import { AppApi } from "@my-app/api"

// Create client from API schema
const client = Effect.gen(function* () {
  return yield* HttpApiClient.make(AppApi, {
    baseUrl: "/api",
  })
}).pipe(Effect.provide(FetchHttpClient.layer))

// Usage - fully type-safe
const sessions = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* client
    return yield* api.sessions.list({ urlParams: { limit: 10 } })
  })
)

const session = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* client
    return yield* api.sessions.create({
      payload: { title: "New Session" },
    })
  })
)
```

## Key Benefits

1. **Single source of truth**: API schema defines types, routes, errors
2. **Auto-generated OpenAPI**: From schema, no annotations needed
3. **Type-safe everywhere**: Compiler catches route/type mismatches
4. **Middleware as Context**: Middleware provides services to handlers
5. **Error mapping**: Schema.TaggedError → HTTP status codes
6. **Layer composition**: All dependencies explicit and testable

## Comparison to Hono

| Aspect | Hono | Effect HttpApi |
|--------|------|----------------|
| Schema | Separate (Zod) | Integrated (Effect Schema) |
| Client | Manual or codegen | Auto-generated |
| Errors | Manual mapping | Automatic via annotations |
| Types | Runtime validation | Compile-time + runtime |
| DI | Manual | Layer-based |
| OpenAPI | Plugin | Built-in |
