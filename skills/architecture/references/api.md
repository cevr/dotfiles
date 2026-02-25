# API Design

Effect patterns for declarative APIs using @effect/platform.

## Decision Tree

```
Defining API?
├─ Single endpoint              → HttpApiEndpoint.*
├─ Group of related endpoints   → HttpApiGroup.make
├─ Full API                     → HttpApi.make
└─ Compose multiple APIs        → HttpApi.addHttpApi

Endpoint needs?
├─ Path parameters              → template literal + setPath
├─ Query parameters             → setUrlParams
├─ Headers                      → setHeaders
├─ Request body                 → setPayload
├─ Authentication               → middleware with security
└─ Multiple success types       → addSuccess (can call multiple times)

Pagination?
├─ Stable ordering required     → cursor-based
├─ Simple lists                 → offset-based
└─ Real-time data               → keyset pagination
```

## Core Principle

**Definition separate from implementation.** API contract lives in schema definitions; handlers implement behavior elsewhere.

## Patterns

### 1. HttpApiEndpoint - Single Endpoint

```typescript
import { HttpApiEndpoint, HttpApiSchema } from "@effect/platform"
import { Schema as S } from "effect"

// GET /users/:id
const getUser = HttpApiEndpoint.get("get", "/users/:id")
  .setPath(S.Struct({ id: UserIdSchema }))
  .addSuccess(User)
  .addError(UserNotFoundError)

// POST /users
const createUser = HttpApiEndpoint.post("create", "/users")
  .setPayload(
    S.Struct({
      name: S.String,
      email: Email,
    }),
  )
  .addSuccess(User, { status: 201 })
  .addError(ValidationError)

// GET /users (with query params)
const listUsers = HttpApiEndpoint.get("list", "/users")
  .setUrlParams(
    S.Struct({
      limit: S.optional(S.NumberFromString.pipe(S.int(), S.between(1, 100))),
      cursor: S.optional(S.String),
    }),
  )
  .addSuccess(PaginatedUsers)

// DELETE /users/:id
const deleteUser = HttpApiEndpoint.del("delete", "/users/:id")
  .setPath(S.Struct({ id: UserIdSchema }))
  .addSuccess(S.Void, { status: 204 })
  .addError(UserNotFoundError)
```

### 2. Path Parameters with Template Literals

```typescript
// Dynamic path with schema validation
const getUser = HttpApiEndpoint.get("get")`/users/${HttpApiSchema.param("id", UserIdSchema)}`
  .addSuccess(User)
  .addError(UserNotFoundError)

// Multiple path params
const getOrderItem = HttpApiEndpoint.get(
  "getItem",
)`/orders/${HttpApiSchema.param("orderId", OrderIdSchema)}/items/${HttpApiSchema.param("itemId", S.NumberFromString)}`.addSuccess(
  OrderItem,
)
```

### 3. HttpApiGroup - Related Endpoints

```typescript
import { HttpApiGroup } from "@effect/platform"

class UsersApi extends HttpApiGroup.make("users")
  .add(getUser)
  .add(createUser)
  .add(listUsers)
  .add(deleteUser)
  .prefix("/users") // All endpoints prefixed
  .addError(ValidationError) // Shared error for group
  .middleware(Authorization) {
  // Auth for all endpoints
}

class OrdersApi extends HttpApiGroup.make("orders")
  .add(getOrder)
  .add(createOrder)
  .add(listOrders)
  .prefix("/orders")
  .middleware(Authorization) {}
```

### 4. HttpApi - Full API

```typescript
import { HttpApi } from "@effect/platform"

class Api extends HttpApi.make("api")
  .add(UsersApi)
  .add(OrdersApi)
  .add(HealthApi)
  .prefix("/v1") // Version prefix
  .addError(InternalError, { status: 500 }) // Global error
  .annotateContext(
    OpenApi.annotations({
      title: "My API",
      version: "1.0.0",
      description: "API description",
    }),
  ) {}
```

### 5. Handler Implementation

```typescript
import { HttpApiBuilder } from "@effect/platform"

const UsersApiLive = HttpApiBuilder.group(Api, "users", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const auth = yield* AuthService

    return handlers
      .handle("get", ({ path }) => repo.findById(path.id))
      .handle("create", ({ payload }) => repo.create(payload))
      .handle("list", ({ urlParams }) =>
        repo.list({
          limit: urlParams.limit ?? 20,
          cursor: urlParams.cursor,
        }),
      )
      .handle("delete", ({ path }) => repo.delete(path.id))
  }),
).pipe(Layer.provide([UserRepo.Live, AuthService.Live]))
```

### 6. Middleware Definition

```typescript
import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"

// Bearer token auth
class Authorization extends HttpApiMiddleware.Tag<Authorization>()("Authorization", {
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  provides: CurrentUser,
  failure: UnauthorizedError,
}) {}

// API key auth (header)
class ApiKeyAuth extends HttpApiMiddleware.Tag<ApiKeyAuth>()("ApiKeyAuth", {
  security: {
    apiKey: HttpApiSecurity.apiKey({
      in: "header",
      key: "x-api-key",
    }),
  },
  provides: ApiKeyContext,
  failure: UnauthorizedError,
}) {}

// Cookie auth
class CookieAuth extends HttpApiMiddleware.Tag<CookieAuth>()("CookieAuth", {
  security: {
    cookie: HttpApiSecurity.apiKey({
      in: "cookie",
      key: "session",
    }),
  },
  provides: SessionContext,
  failure: UnauthorizedError,
}) {}
```

### 7. Middleware Implementation

```typescript
const AuthorizationLive = Layer.succeed(
  Authorization,
  Authorization.of({
    bearer: (token) =>
      Effect.gen(function* () {
        const decoded = yield* verifyJwt(Redacted.value(token))
        if (!decoded) {
          yield* Effect.fail(new UnauthorizedError({ message: "Invalid token" }))
        }
        return new User({
          id: decoded.sub as UserId,
          name: decoded.name,
          email: decoded.email as Email,
          role: decoded.role,
          createdAt: DateTime.unsafeNow(),
          updatedAt: DateTime.unsafeNow(),
        })
      }),
  }),
)

// Apply middleware to group
class UsersApi extends HttpApiGroup.make("users")
  .add(getUser)
  .add(createUser)
  .middleware(Authorization) {}
```

### 8. Cursor-Based Pagination

```typescript
// Schema
const PaginatedResponse = <T extends S.Schema.Any>(itemSchema: T) =>
  S.Struct({
    items: S.Array(itemSchema),
    cursor: S.optional(S.String),
    hasMore: S.Boolean,
  })

const PaginatedUsers = PaginatedResponse(User)

// Endpoint
const listUsers = HttpApiEndpoint.get("list", "/users")
  .setUrlParams(
    S.Struct({
      limit: S.optional(S.NumberFromString.pipe(S.int(), S.between(1, 100))).pipe(
        S.withDefault(() => 20),
      ),
      cursor: S.optional(S.String),
    }),
  )
  .addSuccess(PaginatedUsers)

  // Handler
  .handle("list", ({ urlParams: { limit, cursor } }) =>
    Effect.gen(function* () {
      const db = yield* Database

      // Decode cursor
      const afterId = cursor ? decodeCursor(cursor) : undefined

      // Query limit + 1 to detect hasMore
      const rows = yield* db.query(
        `
      SELECT * FROM users
      WHERE ($1::text IS NULL OR id > $1)
      ORDER BY id
      LIMIT $2
    `,
        [afterId, limit + 1],
      )

      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, -1) : rows
      const nextCursor = hasMore ? encodeCursor(items.at(-1).id) : undefined

      return { items, cursor: nextCursor, hasMore }
    }),
  )

// Cursor helpers
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url")
const decodeCursor = (cursor: string) => Buffer.from(cursor, "base64url").toString()
```

### 9. OpenAPI Annotations

```typescript
import { OpenApi } from "@effect/platform"

const listUsers = HttpApiEndpoint.get("list", "/users")
  .setUrlParams(
    S.Struct({
      limit: S.NumberFromString.pipe(S.int(), S.between(1, 100)).annotations({
        description: "Maximum number of items to return",
        default: 20,
      }),
    }),
  )
  .addSuccess(PaginatedUsers)
  .annotate(OpenApi.Summary, "List all users")
  .annotate(OpenApi.Description, "Returns a paginated list of users")
  .annotate(OpenApi.Deprecated, false)

class UsersApi extends HttpApiGroup.make("users").add(listUsers).annotate(OpenApi.Tag, {
  name: "Users",
  description: "User management endpoints",
}) {}
```

### 10. Server Setup

```typescript
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"

// Combine all group implementations
const HttpApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(UsersApiLive),
  Layer.provide(OrdersApiLive),
  Layer.provide(AuthorizationLive),
)

// Build server
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiLive),
  Layer.provide(NodeHttpServer.layer({ port: 3000 })),
)

// Run
NodeRuntime.runMain(Layer.launch(HttpLive))
```

### 11. OpenAPI Spec Generation

```typescript
import { OpenApi } from '@effect/platform'

// Generate spec
const spec = OpenApi.fromApi(Api)

// Serve spec endpoint
const docsEndpoint = HttpApiEndpoint.get('openapi', '/openapi.json')
  .addSuccess(S.Unknown)

// Add to API
class DocsApi extends HttpApiGroup.make('docs')
  .add(docsEndpoint)
{}

// Handler returns spec
.handle('openapi', () => Effect.succeed(spec))
```

### 12. Request/Response Types

Handler receives structured `_` with typed access:

```typescript
.handle('create', (_) =>
  Effect.gen(function* () {
    // _.path - path parameters
    // _.urlParams - query parameters
    // _.headers - request headers
    // _.payload - request body
    // All fully typed from endpoint definition

    const { name, email } = _.payload
    const { limit } = _.urlParams
    const { authorization } = _.headers
  })
)
```

## HTTP Methods & Status Codes

| Method | Default Success | Use For              |
| ------ | --------------- | -------------------- |
| GET    | 200             | Retrieve resource(s) |
| POST   | 201             | Create resource      |
| PUT    | 200             | Replace resource     |
| PATCH  | 200             | Partial update       |
| DELETE | 204             | Remove resource      |

Override with `addSuccess(Schema, { status: 201 })`.

## See Also

- `errors.md` - error types and HTTP mapping
- `domain.md` - schema definitions
- `services.md` - handler dependency injection
