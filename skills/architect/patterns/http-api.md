# HttpApi Schema Definition

Schema-first API definition using @effect/platform HttpApi.

## API Definition Package

The `packages/api` package contains ONLY schema definitions - no runtime code.

## Endpoint Definition

```typescript
// packages/api/src/definition/groups/SessionGroup.ts
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema as S } from "effect"
import { SessionIdSchema, SessionSchema } from "@my-app/shared"

// Define errors with HTTP status
export class SessionNotFound extends S.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {
    sessionId: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

// Define the endpoint group
export const SessionGroup = HttpApiGroup.make("sessions")
  // GET /sessions - List all
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(S.Array(SessionSchema))
  )
  // GET /sessions/:id - Get one
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .addSuccess(SessionSchema)
      .addError(SessionNotFound)
  )
  // POST /sessions - Create
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(
        S.Struct({
          title: S.String.pipe(S.minLength(1), S.maxLength(100)),
        })
      )
      .addSuccess(SessionSchema, { status: 201 })
  )
  // PATCH /sessions/:id - Update
  .add(
    HttpApiEndpoint.patch("update", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .setPayload(
        S.Struct({
          title: S.optional(S.String),
        })
      )
      .addSuccess(SessionSchema)
      .addError(SessionNotFound)
  )
  // DELETE /sessions/:id - Delete
  .add(
    HttpApiEndpoint.del("delete", "/:id")
      .setPath(S.Struct({ id: SessionIdSchema }))
      .addSuccess(S.Void)
      .addError(SessionNotFound)
  )
  .prefix("/sessions")
```

## Query Parameters

```typescript
// packages/api/src/definition/Pagination.ts
import { Schema as S } from "effect"

export const PaginationParams = <Id extends S.Schema.Any>(idSchema: Id) =>
  S.Struct({
    limit: S.optional(
      S.NumberFromString.pipe(
        S.int(),
        S.greaterThanOrEqualTo(1),
        S.lessThanOrEqualTo(100)
      )
    ).pipe(S.withDecodingDefault(() => 25)),
    afterId: S.optional(idSchema),
    beforeId: S.optional(idSchema),
  })

export const PaginatedResponse = <A extends S.Schema.Any>(itemSchema: A) =>
  S.Struct({
    data: S.Array(itemSchema),
    hasMore: S.Boolean,
  })

// Usage in endpoint
export const SessionGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(PaginationParams(SessionIdSchema))
      .addSuccess(PaginatedResponse(SessionSchema))
  )
```

## Middleware Schema

```typescript
// packages/api/src/definition/middleware/AuthMiddleware.ts
import { Context, Schema as S } from "effect"
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "@effect/platform"

// Error for unauthorized requests
export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

// Context provided by middleware
export class AuthContext extends Context.Tag("AuthContext")<
  AuthContext,
  {
    readonly userId: string
    readonly roles: ReadonlyArray<string>
  }
>() {}

// Middleware definition
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

## Main API Composition

```typescript
// packages/api/src/definition/Api.ts
import { HttpApi } from "@effect/platform"
import { SessionGroup } from "./groups/SessionGroup"
import { UserGroup } from "./groups/UserGroup"
import { HealthGroup } from "./groups/HealthGroup"

export class AppApi extends HttpApi.make("AppApi")
  .add(HealthGroup)
  .add(SessionGroup)
  .add(UserGroup)
  .prefix("/v1")
{}
```

## Attaching Middleware

```typescript
// Apply middleware to entire group
export const SessionGroup = HttpApiGroup.make("sessions")
  .add(/* endpoints */)
  .middleware(AuthMiddleware)  // All endpoints require auth
  .prefix("/sessions")

// Or selectively (not middleware, but security on endpoint)
export const SessionGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(S.Array(SessionSchema))
    // No auth required
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateSessionSchema)
      .addSuccess(SessionSchema, { status: 201 })
    // Will require auth when middleware is on group
  )
  .middleware(AuthMiddleware)
  .prefix("/sessions")
```

## Export Structure

```typescript
// packages/api/src/definition/index.ts
export * from "./Api"
export * from "./groups/SessionGroup"
export * from "./groups/UserGroup"
export * from "./groups/HealthGroup"
export * from "./middleware/AuthMiddleware"
export * from "./Pagination"

// packages/api/src/index.ts
export * from "./definition"
```

## Key Points

1. **No runtime code**: This package is pure schema definitions
2. **Shareable**: Can be published to npm for client consumption
3. **Auto-generates**: OpenAPI docs, TypeScript client types
4. **Error mapping**: HttpApiSchema.annotations maps errors to HTTP status
5. **Security**: HttpApiSecurity defines auth schemes (bearer, apiKey, etc.)
