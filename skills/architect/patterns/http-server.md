# HttpApiBuilder Server

Implementing HttpApi schemas with HttpApiBuilder and HttpLayerRouter.

## Handler Implementation

```typescript
// apps/server/src/handlers/SessionGroupLive.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { AppApi, SessionNotFound } from "@my-app/api/definition"
import { SessionService } from "@my-app/core"

export const SessionGroupLive = HttpApiBuilder.group(
  AppApi,
  "sessions",
  (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* SessionService

      return handlers
        .handle("list", ({ urlParams }) =>
          Effect.gen(function* () {
            const result = yield* sessions.list({
              limit: urlParams.limit,
              afterId: urlParams.afterId,
              beforeId: urlParams.beforeId,
            })
            return {
              data: result.items,
              hasMore: result.hasMore,
            }
          })
        )
        .handle("get", ({ path }) =>
          sessions.get(path.id)
        )
        .handle("create", ({ payload }) =>
          sessions.create(payload.title)
        )
        .handle("update", ({ path, payload }) =>
          sessions.update(path.id, payload)
        )
        .handle("delete", ({ path }) =>
          sessions.delete(path.id)
        )
    })
)
```

## Middleware Implementation

```typescript
// apps/server/src/middleware/AuthMiddlewareLive.ts
import { Effect, Layer, Redacted } from "effect"
import { AuthMiddleware, AuthContext, Unauthorized } from "@my-app/api/definition"
import { AuthService } from "@my-app/core"

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
              new Unauthorized({ message: "Missing authorization token" })
            )
          }

          const user = yield* auth.verifyToken(tokenValue).pipe(
            Effect.catchAll(() =>
              Effect.fail(new Unauthorized({ message: "Invalid token" }))
            )
          )

          return AuthContext.of({
            userId: user.id,
            roles: user.roles,
          })
        }),
    }
  })
)
```

## Handler Groups Composition

```typescript
// apps/server/src/handlers/index.ts
import { Layer } from "effect"
import { SessionGroupLive } from "./SessionGroupLive"
import { UserGroupLive } from "./UserGroupLive"
import { HealthGroupLive } from "./HealthGroupLive"
import { AuthMiddlewareLive } from "../middleware/AuthMiddlewareLive"

export const HandlersLive = Layer.mergeAll(
  SessionGroupLive,
  UserGroupLive,
  HealthGroupLive
).pipe(Layer.provide(AuthMiddlewareLive))
```

## Server Entry Point

```typescript
// apps/server/src/main.ts
import { HttpLayerRouter, OpenApi } from "@effect/platform"
import { HttpApiScalar } from "@effect/platform/HttpApiScalar"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { AppApi } from "@my-app/api/definition"
import { HandlersLive } from "./handlers"
import { ServicesLive } from "./services"
import { SqlLive } from "./db/SqlLive"

// Add API routes from schema
const ApiRoutes = HttpLayerRouter.addHttpApi(AppApi).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(ServicesLive),
  Layer.provide(SqlLive),
)

// Add Swagger documentation
const DocsRoute = HttpApiScalar.layerHttpLayerRouter({
  api: AppApi,
  path: "/docs",
})

// Add OpenAPI JSON endpoint
const OpenApiRoute = HttpLayerRouter.add(
  "GET",
  "/docs/openapi.json",
  Effect.sync(() => OpenApi.fromApi(AppApi)).pipe(
    Effect.flatMap((spec) => HttpServerResponse.json(spec))
  )
).pipe(Layer.provide(HttpLayerRouter.layer))

// Merge all routes with CORS
const AllRoutes = Layer.mergeAll(
  ApiRoutes,
  DocsRoute,
  OpenApiRoute
).pipe(Layer.provide(HttpLayerRouter.cors()))

// Start server
const ServerLive = HttpLayerRouter.serve(AllRoutes).pipe(
  Layer.provide(
    BunHttpServer.layer({
      port: 3000,
    })
  )
)

BunRuntime.runMain(Layer.launch(ServerLive))
```

## Services Layer

```typescript
// apps/server/src/services/index.ts
import { Layer } from "effect"
import { SessionService, UserService, AuthService } from "@my-app/core"
import { StorageService, BusService, ConfigService } from "@my-app/core"

export const ServicesLive = Layer.mergeAll(
  SessionService.Live,
  UserService.Live,
  AuthService.Live
).pipe(
  Layer.provide(StorageService.Live),
  Layer.provide(BusService.Live),
  Layer.provide(ConfigService.Live)
)
```

## Database Layer

```typescript
// apps/server/src/db/SqlLive.ts
import { Config, Context, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as Client from "@effect/sql/SqlClient"

const PgLive = Layer.scopedContext(
  Effect.gen(function* () {
    const host = yield* Config.string("DB_HOST")
    const port = yield* Config.number("DB_PORT")
    const database = yield* Config.string("DB_NAME")
    const username = yield* Config.string("DB_USERNAME")
    const password = yield* Config.redacted("DB_PASSWORD")

    const client = yield* PgClient.make({
      host,
      port,
      database,
      username,
      password,
    })

    return Context.make(PgClient.PgClient, client).pipe(
      Context.add(Client.SqlClient, client)
    )
  })
)

const DrizzleLive = PgDrizzle.layerWithConfig({
  casing: "snake_case",
}).pipe(Layer.provide(PgLive))

export const SqlLive = Layer.mergeAll(PgLive, DrizzleLive)
```

## Key Points

1. **HttpApiBuilder.group**: Implements handlers for an HttpApiGroup
2. **Type-safe handlers**: Must match schema definition
3. **Effect return**: Handlers return Effect, not raw values
4. **Layer composition**: Services injected via layers
5. **Auto OpenAPI**: Generated from schema definition
6. **CORS built-in**: HttpLayerRouter.cors() handles CORS
