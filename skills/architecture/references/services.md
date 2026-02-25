# Services & Dependency Injection

Effect patterns for services, layers, and composition.

## Decision Tree

```
Defining a service?
├─ Simple value/config          → Layer.succeed
├─ Lazy initialization          → Layer.sync
├─ Async initialization         → Layer.effect
├─ Resource with cleanup        → Layer.scoped
└─ From existing service        → Layer.effect + yield* dependency

Composing layers?
├─ A needs B                    → A.pipe(Layer.provide(B))
├─ A and B independent          → Layer.merge(A, B)
├─ Multiple deps                → Layer.provide([A, B, C])
└─ Test override                → Layer.provide(TestImpl)
```

## Core Principle

**Services are interfaces, layers are implementations.** Define what you need with `Context.Tag`, provide how it works with `Layer`.

## Patterns

### 1. Context.Tag Definition

Define service interface:

```typescript
import { Context, Effect, Layer } from "effect"

// Service with methods
class UserRepo extends Context.Tag("UserRepo")<
  UserRepo,
  {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly create: (data: CreateUserInput) => Effect.Effect<User>
    readonly delete: (id: UserId) => Effect.Effect<void>
  }
>() {}

// Service with single value
class CurrentUser extends Context.Tag("CurrentUser")<CurrentUser, User>() {}

// Service with config
class DatabaseConfig extends Context.Tag("DatabaseConfig")<
  DatabaseConfig,
  {
    readonly host: string
    readonly port: number
    readonly database: string
  }
>() {}
```

### 2. Layer Constructors

#### Layer.succeed - Static Value

```typescript
// Provide a static value
const DatabaseConfigLive = Layer.succeed(DatabaseConfig, {
  host: "localhost",
  port: 5432,
  database: "myapp",
})

// Inline static implementation
class Logger extends Context.Tag("Logger")<
  Logger,
  { log: (msg: string) => Effect.Effect<void> }
>() {
  static Live = Layer.succeed(this, {
    log: (msg) => Effect.sync(() => console.log(msg)),
  })
}
```

#### Layer.sync - Lazy Initialization

```typescript
// Defer creation until layer is built
const ConfigLive = Layer.sync(AppConfig, () => ({
  port: parseInt(process.env.PORT ?? "3000"),
  env: process.env.NODE_ENV ?? "development",
}))
```

#### Layer.effect - Async Initialization

```typescript
// Create from Effect (can fail, can use other services)
const UserRepoLive = Layer.effect(
  UserRepo,
  Effect.gen(function* () {
    const db = yield* Database // Depend on Database service

    return {
      findById: (id) =>
        Effect.gen(function* () {
          const row = yield* db.query("SELECT * FROM users WHERE id = ?", [id])
          if (!row) yield* Effect.fail(new UserNotFoundError({ userId: id }))
          return row as User
        }),
      create: (data) =>
        Effect.gen(function* () {
          const id = newUserId()
          yield* db.query("INSERT INTO users ...", [id, data.name, data.email])
          return { id, ...data, createdAt: new Date() }
        }),
      delete: (id) => db.query("DELETE FROM users WHERE id = ?", [id]).pipe(Effect.asVoid),
    }
  }),
)
```

#### Layer.scoped - Resource with Cleanup

```typescript
// Acquire resource, release on scope close
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const config = yield* DatabaseConfig

    // Acquire
    const pool = yield* Effect.tryPromise(() =>
      createPool({
        host: config.host,
        port: config.port,
        database: config.database,
      }),
    )

    // Register cleanup
    yield* Effect.addFinalizer(() => Effect.sync(() => pool.end()))

    return {
      query: (sql, params) => Effect.tryPromise(() => pool.query(sql, params)),
    }
  }),
)
```

### 3. Layer Composition

#### Provide Dependencies

```typescript
// Single dependency
const UserRepoLive = Layer.effect(UserRepo /* needs Database */).pipe(Layer.provide(DatabaseLive))

// Multiple dependencies
const AppLive = Layer.effect(App /* needs UserRepo, Logger, Config */).pipe(
  Layer.provide([UserRepoLive, Logger.Live, ConfigLive]),
)

// Chain provides
const FullStack = HttpServerLive.pipe(
  Layer.provide(ApiLive),
  Layer.provide(UserRepoLive),
  Layer.provide(DatabaseLive),
  Layer.provide(ConfigLive),
)
```

#### Merge Independent Layers

```typescript
// Combine layers that don't depend on each other
const InfraLive = Layer.merge(Logger.Live, MetricsLive, TracingLive)

// MergeAll for many
const AllServices = Layer.mergeAll(UserRepoLive, OrderRepoLive, ProductRepoLive, NotificationLive)
```

### 4. Static Live Pattern

Define implementation alongside service:

```typescript
class UserRepo extends Context.Tag('UserRepo')<
  UserRepo,
  {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly create: (data: CreateUserInput) => Effect.Effect<User>
  }
>() {
  // Implementation as static property
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const db = yield* Database
      return {
        findById: (id) => /* ... */,
        create: (data) => /* ... */,
      }
    })
  )

  // Test implementation
  static Test = Layer.succeed(this, {
    findById: () => Effect.succeed(testUser),
    create: (data) => Effect.succeed({ ...testUser, ...data }),
  })
}

// Usage
const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  return yield* repo.findById(userId)
})

// Run with live
Effect.runPromise(program.pipe(
  Effect.provide(UserRepo.Live),
  Effect.provide(Database.Live),
))

// Run with test
Effect.runPromise(program.pipe(
  Effect.provide(UserRepo.Test),
))
```

### 5. Handler Pattern (HttpApi)

Services in HTTP handlers:

```typescript
const UsersApiLive = HttpApiBuilder.group(Api, "users", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const auth = yield* AuthService

    return handlers
      .handle("findById", ({ path }) => repo.findById(path.id))
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* auth.getCurrentUser
          yield* auth.requireRole(user, "admin")
          return yield* repo.create(payload)
        }),
      )
      .handle("list", ({ urlParams }) =>
        repo.list({
          limit: urlParams.limit ?? 20,
          cursor: urlParams.cursor,
        }),
      )
  }),
).pipe(Layer.provide([UserRepo.Live, AuthService.Live]))
```

### 6. Middleware as Service

```typescript
import { HttpApiMiddleware, HttpApiSecurity } from '@effect/platform'

// Define middleware service
class Authorization extends HttpApiMiddleware.Tag<Authorization>()(
  'Authorization',
  {
    security: {
      bearer: HttpApiSecurity.bearer,
    },
    provides: CurrentUser,  // What this middleware provides
    failure: UnauthorizedError,
  }
) {}

// Implement middleware
const AuthorizationLive = Layer.succeed(
  Authorization,
  Authorization.of({
    bearer: (token) =>
      Effect.gen(function* () {
        const decoded = yield* verifyJwt(token)
        if (!decoded) yield* Effect.fail(new UnauthorizedError({}))
        return new User({ id: decoded.sub, name: decoded.name, ... })
      }),
  })
)

// Apply to group
class UsersApi extends HttpApiGroup.make('users')
  .add(getUser)
  .add(createUser)
  .middleware(Authorization)  // All endpoints require auth
{}
```

### 7. Testing Services

```typescript
import { it, expect } from "@effect/vitest"

// Test layer
const TestUserRepo = Layer.succeed(UserRepo, {
  findById: (id) =>
    id === "usr_test123"
      ? Effect.succeed(testUser)
      : Effect.fail(new UserNotFoundError({ userId: id })),
  create: (data) => Effect.succeed({ id: newUserId(), ...data, createdAt: new Date() }),
})

// Test with layer
it.effect("finds user by id", () =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const user = yield* repo.findById("usr_test123" as UserId)
    expect(user.name).toBe("Test User")
  }).pipe(Effect.provide(TestUserRepo)),
)

// Test failure
it.effect("returns error for missing user", () =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const result = yield* repo.findById("usr_missing" as UserId).pipe(Effect.either)
    expect(Either.isLeft(result)).toBe(true)
  }).pipe(Effect.provide(TestUserRepo)),
)
```

### 8. Layer Dependencies Visualization

```
                    ┌─────────────┐
                    │  HttpServer │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   ApiLive   │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  UserRepo   │  │  OrderRepo  │  │   Logger    │
   └──────┬──────┘  └──────┬──────┘  └─────────────┘
          │                │
          └────────┬───────┘
                   │
            ┌──────▼──────┐
            │   Database  │
            └──────┬──────┘
                   │
            ┌──────▼──────┐
            │   Config    │
            └─────────────┘
```

## See Also

- `boundaries.md` - service isolation
- `config.md` - configuration as service
- `errors.md` - error handling in services
- `api.md` - HTTP handlers with services
