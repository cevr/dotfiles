# Testing

Effect testing patterns with @effect/vitest.

## Quick Reference

| Pattern          | Use Case                   | Example                              |
| ---------------- | -------------------------- | ------------------------------------ |
| `it.effect`      | Test effectful code        | `it.effect("name", () => effect)`    |
| `it.scoped`      | Test with scoped resources | `it.scoped("name", () => effect)`    |
| `it.live`        | Test with real services    | `it.live("name", () => effect)`      |
| `Layer.succeed`  | Mock with fixed value      | `Layer.succeed(Tag, mockImpl)`       |
| `Effect.provide` | Inject test layer          | `effect.pipe(Effect.provide(layer))` |

## Setup

Install @effect/vitest:

```bash
bun add -d @effect/vitest vitest
```

Configure vitest.config.ts:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
  },
})
```

## Basic Test Structure

```typescript
import { Effect, Layer } from "effect"
import { describe, it, expect } from "@effect/vitest"
import { UserRepo } from "./UserRepo"

describe("UserRepo", () => {
  it.effect("finds user by id", () =>
    Effect.gen(function* () {
      const repo = yield* UserRepo
      const user = yield* repo.findById("user-123")
      expect(user.name).toBe("Alice")
    }).pipe(Effect.provide(TestUserRepo)),
  )
})
```

## Test Layer Patterns

### Simple Mock Layer

```typescript
const TestUserRepo = Layer.succeed(UserRepo, {
  findById: (id) => Effect.succeed({ id, name: "Test User", email: "test@example.com" }),
  create: (data) => Effect.succeed({ id: "new-id", ...data }),
  delete: () => Effect.void,
})
```

### Mock with State

```typescript
const TestUserRepoWithState = Layer.effect(
  UserRepo,
  Effect.sync(() => {
    const users = new Map<string, User>()

    return {
      findById: (id) =>
        Effect.fromNullable(users.get(id)).pipe(Effect.mapError(() => new UserNotFound({ id }))),
      create: (data) =>
        Effect.sync(() => {
          const user = { id: crypto.randomUUID(), ...data }
          users.set(user.id, user)
          return user
        }),
      delete: (id) => Effect.sync(() => users.delete(id)).pipe(Effect.asVoid),
    }
  }),
)
```

### Failing Mock

```typescript
const FailingUserRepo = Layer.succeed(UserRepo, {
  findById: () => Effect.fail(new UserNotFound({ id: "any" })),
  create: () => Effect.fail(new DatabaseError({ message: "Connection failed" })),
  delete: () => Effect.fail(new DatabaseError({ message: "Connection failed" })),
})
```

## Testing with Dependencies

### Composing Test Layers

```typescript
// Service depends on other services
const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const email = yield* EmailService
    return {
      register: (data) =>
        Effect.gen(function* () {
          const user = yield* repo.create(data)
          yield* email.send(user.email, "Welcome!")
          return user
        }),
    }
  }),
)

// Test layer with all dependencies
const TestLayer = UserServiceLive.pipe(Layer.provide(TestUserRepo), Layer.provide(TestEmailService))

it.effect("registers user and sends email", () =>
  Effect.gen(function* () {
    const service = yield* UserService
    const user = yield* service.register({ name: "Alice", email: "alice@example.com" })
    expect(user.name).toBe("Alice")
  }).pipe(Effect.provide(TestLayer)),
)
```

### Shared Test Layer

```typescript
// test/layers.ts
export const TestDatabaseLayer = Layer.succeed(Database, mockDatabase)
export const TestEmailLayer = Layer.succeed(EmailService, mockEmailService)

export const TestLayer = Layer.mergeAll(TestDatabaseLayer, TestEmailLayer)

// In tests
it.effect("test with shared layer", () =>
  Effect.gen(function* () {
    // ...
  }).pipe(Effect.provide(TestLayer)),
)
```

## Testing Errors

### Expected Failures

```typescript
it.effect("fails when user not found", () =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const result = yield* repo.findById("nonexistent").pipe(Effect.either)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("UserNotFound")
    }
  }).pipe(Effect.provide(TestUserRepo)),
)
```

### Using Effect.exit

```typescript
it.effect("handles database error", () =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const exit = yield* repo.create({ name: "Test" }).pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
  }).pipe(Effect.provide(FailingUserRepo)),
)
```

## Testing with Config

### Override Config in Tests

```typescript
const TestConfig = Layer.succeed(
  Config.string("DATABASE_URL"),
  "postgres://test:test@localhost/test",
)

it.effect("uses test config", () =>
  Effect.gen(function* () {
    const url = yield* Config.string("DATABASE_URL")
    expect(url).toBe("postgres://test:test@localhost/test")
  }).pipe(Effect.provide(TestConfig)),
)
```

### ConfigProvider for Tests

```typescript
const TestConfigProvider = ConfigProvider.fromMap(
  new Map([
    ["DATABASE_URL", "postgres://test@localhost/test"],
    ["API_KEY", "test-key"],
  ]),
)

it.effect("uses test config provider", () =>
  Effect.gen(function* () {
    const url = yield* Config.string("DATABASE_URL")
    expect(url).toContain("test")
  }).pipe(Effect.withConfigProvider(TestConfigProvider)),
)
```

## Testing Scoped Resources

Use `it.scoped` for effects that acquire resources:

```typescript
it.scoped("acquires and releases resource", () =>
  Effect.gen(function* () {
    const connection = yield* Database.connect()
    const result = yield* connection.query("SELECT 1")
    expect(result).toBeDefined()
    // Connection automatically released after test
  }).pipe(Effect.provide(TestDatabaseLayer)),
)
```

## Integration Testing

### Real Services with Test Database

```typescript
const IntegrationLayer = Layer.mergeAll(
  UserRepo.Live,
  Database.Test, // Real impl pointing to test DB
)

describe("Integration", () => {
  it.effect("creates user in database", () =>
    Effect.gen(function* () {
      const repo = yield* UserRepo
      const user = yield* repo.create({ name: "Alice", email: "alice@test.com" })

      const found = yield* repo.findById(user.id)
      expect(found.name).toBe("Alice")
    }).pipe(Effect.provide(IntegrationLayer)),
  )
})
```

### Test Fixtures

```typescript
const withUser = (name: string) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    return yield* repo.create({ name, email: `${name.toLowerCase()}@test.com` })
  })

it.effect("deletes user", () =>
  Effect.gen(function* () {
    const user = yield* withUser("Alice")
    const repo = yield* UserRepo

    yield* repo.delete(user.id)

    const result = yield* repo.findById(user.id).pipe(Effect.either)
    expect(result._tag).toBe("Left")
  }).pipe(Effect.provide(TestLayer)),
)
```

## Decision Tree

```
Testing Effect code?
├─ Pure effect             → it.effect
├─ Scoped resources        → it.scoped
├─ Real services           → it.live
├─ Need mock service       → Layer.succeed / Layer.effect
├─ Test error paths        → Effect.either / Effect.exit
└─ Test config             → ConfigProvider.fromMap
```

## Common Patterns

### Before/After with Layers

```typescript
const SetupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database
    yield* db.query("DELETE FROM users")
  }),
)

const TestWithSetup = TestLayer.pipe(Layer.provideMerge(SetupLayer))
```

### Parameterized Tests

```typescript
const testCases = [
  { input: "alice", expected: "Alice" },
  { input: "bob", expected: "Bob" },
]

for (const { input, expected } of testCases) {
  it.effect(`normalizes ${input} to ${expected}`, () =>
    Effect.gen(function* () {
      const result = yield* normalizeUsername(input)
      expect(result).toBe(expected)
    }),
  )
}
```

## See Also

- `services.md` - Layer patterns for dependency injection
- `errors.md` - Error types for test assertions
- `gotchas.md` - "Testing Without Layers" section
