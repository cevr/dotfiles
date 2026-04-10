# Services & Dependency Injection

Effect patterns for services, layers, and composition.

## Decision Tree

```
Defining a service?
├─ Simple value/config          → Layer.succeed
├─ Lazy initialization          → Layer.sync
├─ Async initialization         → Layer.effect
├─ Resource with cleanup        → Layer.effect (v4 auto-strips Scope)
└─ From existing service        → Layer.effect + yield* dependency

Note: Layer.scoped is removed in v4. Use Layer.effect — it auto-strips Scope.

Composing layers?
├─ A needs B                    → A.pipe(Layer.provide(B))
├─ A and B independent          → Layer.merge(A, B)
├─ Multiple deps                → Layer.provide([A, B, C])
└─ Test override                → Layer.provide(TestImpl)
```

## Core Principle

**Services are interfaces, layers are implementations.** Define what you need with `Context.Service`, provide how it works with `Layer`.

## Patterns

### 1. Context.Service Definition

Define service interface:

```typescript
import { Context, Effect, Layer } from "effect"

// Service with methods
class UserRepo extends Context.Service<UserRepo, {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
  readonly create: (data: CreateUserInput) => Effect.Effect<User>
  readonly delete: (id: UserId) => Effect.Effect<void>
}>()("UserRepo") {}

// Service with single value
class CurrentUser extends Context.Service<CurrentUser, User>()("CurrentUser") {}

// Service with config
class DatabaseConfig extends Context.Service<DatabaseConfig, {
  readonly host: string
  readonly port: number
  readonly database: string
}>()("DatabaseConfig") {}
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
class Logger extends Context.Service<Logger, {
  log: (msg: string) => Effect.Effect<void>
}>()("Logger") {
  static layer = Layer.succeed(this, {
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

#### Layer.effect - Resource with Cleanup

```typescript
// Acquire resource, release on scope close (v4 auto-strips Scope)
const DatabaseLive = Layer.effect(
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
const UserRepoLive = Layer.effect(/* UserRepo, Effect.gen(...) */).pipe(
  Layer.provide(DatabaseLive),
)

// Multiple dependencies
const AppLive = Layer.effect(/* App, Effect.gen(...) */).pipe(
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

### 4. Static layer Pattern

Define implementation alongside service:

```typescript
class UserRepo extends Context.Service<UserRepo, {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
  readonly create: (data: CreateUserInput) => Effect.Effect<User>
}>()('UserRepo') {
  // Implementation as static property
  static layer = Layer.effect(
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
  static layerTest = Layer.succeed(this, {
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
  Effect.provide(UserRepo.layer),
  Effect.provide(Database.layer),
))

// Run with test
Effect.runPromise(program.pipe(
  Effect.provide(UserRepo.layerTest),
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
).pipe(Layer.provide([UserRepo.layer, AuthService.layer]))
```

### 6. Middleware as Service

```typescript
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

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

### 7. Dual Export Pattern (CLI Commands)

Export both unprovided (for tests) and provided (for CLI) versions:

```typescript
// commands/deploy.ts
import { Command } from "@effect/cli"

// Unprovided - tests inject their own layers
export const deployCommand = Command.make("deploy", { env: Args.text() }, ({ env }) =>
  Effect.gen(function* () {
    const git = yield* GitService
    yield* git.ensureClean()
    const deploy = yield* DeployService
    yield* deploy.push(env)
  })
)

// Provided - CLI uses this
export const deployCommandLive = deployCommand.pipe(Command.provide(AppLayer))
```

### 8. Test Factory Pattern

Services expose test helpers with call tracking:

```typescript
class GitService extends Context.Service<GitService, {
  readonly ensureClean: () => Effect.Effect<void, DirtyWorkingTree>
  readonly getCurrentBranch: () => Effect.Effect<string>
}>()("GitService") {
  static layer = Layer.effect(...)

  static Test(config: { branch?: string; dirty?: boolean } = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = []

    const layer = Layer.succeed(GitService, GitService.of({
      ensureClean: () => {
        calls.push({ method: "ensureClean", args: [] })
        return config.dirty ? Effect.fail(new DirtyWorkingTree()) : Effect.void
      },
      getCurrentBranch: () => {
        calls.push({ method: "getCurrentBranch", args: [] })
        return Effect.succeed(config.branch ?? "main")
      },
    }))

    return { layer, getCalls: () => calls }
  }
}
```

### 9. Sequence-Based Testing

Test orchestration, not just outputs:

```typescript
it.effect("checks clean before deploying", () =>
  Effect.gen(function* () {
    const git = GitService.Test()
    const deploy = DeployService.Test()

    yield* deployCommand.pipe(
      Effect.provide(git.layer),
      Effect.provide(deploy.layer)
    )

    // Verify call sequence
    expect(git.getCalls()[0]).toMatchObject({ method: "ensureClean" })
    expect(deploy.getCalls()[0]).toMatchObject({ method: "push" })
  })
)
```

### 10. Lazy Layer Provision

Pay layer cost only when needed:

```typescript
// Heavy layer - DB connection
const DbLayer = Layer.effect(SqlClient, /* expensive connection */)

// Wrapper for lazy provision
function withDb<A, E>(
  effect: Effect.Effect<A, E, SqlClient>
): Effect.Effect<A, E | DbConnectionError> {
  return Effect.provide(effect, DbLayer)
}

// In command: only connects if path taken
const command = Command.make("cmd", { query: Args.optional(Args.text()) }, ({ query }) =>
  Option.match(query, {
    onNone: () => showHelp(), // No DB needed
    onSome: (q) => withDb(runQuery(q)), // DB only when querying
  })
)
```

### 11. Testing Services

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

### 12. Layer Dependencies Visualization

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
