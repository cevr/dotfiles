# Gotchas

Common mistakes and anti-patterns in Effect architecture.

## Quick Reference

| Problem                   | Symptom                        | Solution                          |
| ------------------------- | ------------------------------ | --------------------------------- |
| Missing service           | "Service not found" at runtime | Check Layer.provide order         |
| Circular layer deps       | Stack overflow, hang           | Extract shared deps               |
| Generator without yield\* | Value is Effect, not result    | Use yield\* not yield             |
| Catching defects          | Silent failures                | Use catchAll, not catchAllCause   |
| Forgetting to run         | Nothing happens                | Add Effect.runPromise             |
| Config at wrong time      | Undefined config values        | Read config in Layer.effect       |
| Mixing sync/async         | Type errors                    | Use Effect.sync vs Effect.promise |

## Missing Service at Runtime

### Symptom

```
Error: Service not found: UserRepo
```

### Cause

Layer not provided, or provided in wrong order.

```typescript
// Missing UserRepo layer
const program = Effect.gen(function* () {
  const repo = yield* UserRepo // Fails here
  return yield* repo.findById(id)
})

Effect.runPromise(program) // Error: Service not found
```

### Solution

Provide all required layers:

```typescript
Effect.runPromise(
  program.pipe(
    Effect.provide(UserRepo.Live),
    Effect.provide(Database.Live), // UserRepo depends on this
  ),
)
```

**Tip:** Check the `R` type parameter - it shows required services:

```typescript
// Effect<User, UserNotFoundError, UserRepo | Database>
//                                 ^^^^^^^^^^^^^^^^^ these must be provided
```

---

## Circular Layer Dependencies

### Symptom

- Stack overflow
- Program hangs
- "Maximum call stack size exceeded"

### Cause

Layer A depends on B, B depends on A (directly or transitively).

```typescript
// A needs B
const ALive = Layer.effect(A, Effect.gen(function* () {
  const b = yield* B
  return { ... }
}))

// B needs A - circular!
const BLive = Layer.effect(B, Effect.gen(function* () {
  const a = yield* A
  return { ... }
}))
```

### Solution

Extract shared dependency:

```typescript
// C contains shared logic
const CLive = Layer.effect(C, ...)

// A and B both depend on C
const ALive = Layer.effect(A, Effect.gen(function* () {
  const c = yield* C
  return { ... }
}))

const BLive = Layer.effect(B, Effect.gen(function* () {
  const c = yield* C
  return { ... }
}))
```

---

## Generator Without yield\*

### Symptom

Value is an Effect, not the result.

```typescript
const program = Effect.gen(function* () {
  const user = yield UserRepo // Missing *
  // user is Effect<UserRepo>, not UserRepo
  user.findById(id) // Type error!
})
```

### Solution

Always use `yield*` for Effects:

```typescript
const program = Effect.gen(function* () {
  const repo = yield* UserRepo // Correct
  const user = yield* repo.findById(id) // Correct
  return user
})
```

---

## Catching Defects Silently

### Symptom

Bugs disappear, no errors logged.

### Cause

Using `catchAllCause` without re-throwing defects:

```typescript
// Bad - swallows bugs
const program = riskyOperation().pipe(
  Effect.catchAllCause(
    (cause) => Effect.succeed(fallbackValue), // Bug silently ignored
  ),
)
```

### Solution

Only catch expected errors, let defects crash:

```typescript
// Good - only catch expected errors
const program = riskyOperation().pipe(Effect.catchAll((error) => Effect.succeed(fallbackValue)))

// Or handle defects explicitly
const program = riskyOperation().pipe(
  Effect.catchAllCause((cause) => {
    if (Cause.isFailure(cause)) {
      return Effect.succeed(fallbackValue)
    }
    // Re-throw defects
    return Effect.failCause(cause)
  }),
)
```

---

## Forgetting to Run

### Symptom

Nothing happens. No output, no errors.

### Cause

Effect is lazy - must be explicitly run:

```typescript
const program = Effect.gen(function* () {
  console.log("This never prints")
  return 42
})

// Nothing happens - program is just a description
```

### Solution

Run the effect:

```typescript
// Run and get result
Effect.runPromise(program).then(console.log)

// Or with sync
Effect.runSync(program)

// Or in Node with proper exit
NodeRuntime.runMain(program)
```

---

## Config Read at Wrong Time

### Symptom

Config values are undefined or wrong.

### Cause

Reading config outside of Effect context:

```typescript
// Bad - reads at module load time
const port = process.env.PORT // Might not be set yet

const ServerLive = Layer.succeed(Server, {
  port: parseInt(port ?? "3000"), // Wrong!
})
```

### Solution

Read config inside Layer.effect:

```typescript
const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const port = yield* Config.number("PORT").pipe(Config.withDefault(3000))
    return { port }
  }),
)
```

---

## Mixing Sync and Async

### Symptom

Type errors about Promise vs Effect.

### Cause

Using wrong Effect constructor:

```typescript
// Wrong - Effect.sync for async
const bad = Effect.sync(() => fetch(url)) // Returns Promise, not value

// Wrong - Effect.promise for sync
const alsoBad = Effect.promise(() => 42) // 42 is not a Promise
```

### Solution

Match constructor to operation:

```typescript
// Sync operation
const sync = Effect.sync(() => JSON.parse(json))

// Async operation
const async = Effect.promise(() => fetch(url))

// Async that might throw
const tryAsync = Effect.tryPromise({
  try: () => fetch(url),
  catch: (e) => new FetchError({ cause: e }),
})
```

---

## Layer Ordering

### Symptom

"Service not found" even though layer is provided.

### Cause

Layers provided in wrong order:

```typescript
// UserRepo needs Database
// But Database provided after UserRepo
const wrong = program.pipe(
  Effect.provide(UserRepo.Live), // Fails - no Database yet
  Effect.provide(Database.Live),
)
```

### Solution

Provide dependencies first, or use Layer.provide:

```typescript
// Option 1: Correct order
const correct = program.pipe(Effect.provide(Database.Live), Effect.provide(UserRepo.Live))

// Option 2: Layer composition (better)
const UserRepoWithDeps = UserRepo.Live.pipe(Layer.provide(Database.Live))

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  return yield* repo.findById(id)
}).pipe(Effect.provide(UserRepoWithDeps))
```

---

## Schema Decode vs DecodeUnknown

### Symptom

Type errors or runtime decode failures.

### Cause

Using wrong decode function:

```typescript
// decode expects the exact input type
S.decode(UserSchema)(data) // data must be Schema.Encoded<typeof UserSchema>

// decodeUnknown accepts unknown
S.decodeUnknown(UserSchema)(data) // data can be anything
```

### Solution

Use `decodeUnknown` for external data:

```typescript
// API input - use decodeUnknown
const handler = (req: Request) =>
  Effect.gen(function* () {
    const input = yield* S.decodeUnknown(CreateUserSchema)(req.body)
    return yield* createUser(input)
  })

// Internal transformation - use decode
const transform = (encoded: Schema.Encoded<typeof UserSchema>) => S.decode(UserSchema)(encoded)
```

---

## Effect.all vs Effect.forEach

### Symptom

Running effects sequentially when parallel is needed, or vice versa.

### Cause

Wrong combinator choice:

```typescript
// Effect.all runs in parallel by default
Effect.all([effect1, effect2, effect3])

// But you might want sequential
Effect.all([effect1, effect2, effect3], { concurrency: 1 })
```

### Solution

Be explicit about concurrency:

```typescript
// Parallel (default)
Effect.all(effects)
Effect.all(effects, { concurrency: "unbounded" })

// Sequential
Effect.all(effects, { concurrency: 1 })

// Limited parallelism
Effect.all(effects, { concurrency: 5 })

// For transforming arrays
Effect.forEach(items, (item) => processItem(item), { concurrency: 5 })
```

---

## Forgetting pipe in Chains

### Symptom

Original effect returned, not transformed.

### Cause

Missing pipe:

```typescript
// Wrong - just returns original effect
findUser(id)
Effect.map((user) => user.name) // This line does nothing!

// Also wrong
findUser(id).map((user) => user.name) // Effect doesn't have .map
```

### Solution

Use pipe:

```typescript
// Correct
findUser(id).pipe(Effect.map((user) => user.name))

// Or pipe function
pipe(
  findUser(id),
  Effect.map((user) => user.name),
)
```

---

## HttpApi Handler Return Type

### Symptom

Handler doesn't match expected return type.

### Cause

Returning wrong type from handler:

```typescript
.handle('get', ({ path }) =>
  // Wrong - returning User | undefined
  db.findUser(path.id)
)
```

### Solution

Return Effect with correct success/error types:

```typescript
.handle('get', ({ path }) =>
  Effect.gen(function* () {
    const user = yield* db.findUser(path.id)
    if (!user) {
      yield* Effect.fail(new UserNotFoundError({ userId: path.id }))
    }
    return user
  })
)
```

---

## Testing Without Layers

### Symptom

Tests fail with "Service not found".

### Cause

Not providing test layers:

```typescript
// Fails - no UserRepo
test("finds user", async () => {
  const result = await Effect.runPromise(findUser("123"))
})
```

### Solution

Provide test layers:

```typescript
const TestUserRepo = Layer.succeed(UserRepo, {
  findById: () => Effect.succeed(testUser),
})

test("finds user", async () => {
  const result = await Effect.runPromise(findUser("123").pipe(Effect.provide(TestUserRepo)))
  expect(result).toEqual(testUser)
})

// Or with @effect/vitest
it.effect("finds user", () =>
  Effect.gen(function* () {
    const user = yield* findUser("123")
    expect(user).toEqual(testUser)
  }).pipe(Effect.provide(TestUserRepo)),
)
```

**See `testing.md`** for comprehensive test layer patterns.

---

## Barrel File Imports

### Symptom

Slow startup, large bundle, poor tree-shaking.

### Cause

Importing from index files loads entire library:

```typescript
// BAD: Loads entire UI library
import { Button, Input } from "@ui/components"

// BAD: Loads all date-fns (~100KB)
import { format, parse } from "date-fns"
```

### Solution

Import directly from source modules:

```typescript
// GOOD: Only loads Button
import { Button } from "@ui/components/Button"

// GOOD: Only loads format
import format from "date-fns/format"
```

**Common offenders:** lucide-react, @mui/material, lodash, date-fns, react-icons, @radix-ui/react-\*

Check library docs for direct import paths.

---

## Sequential Async in Parallel Context

### Symptom

Slow response times despite parallel-capable operations.

### Cause

Awaiting immediately instead of batching:

```typescript
// BAD: Sequential, 3 round trips
async function handler() {
  const user = await getUser(id)
  const posts = await getPosts(id)
  const prefs = await getPrefs(id)
  return { user, posts, prefs }
}
```

### Solution

Start early, await late:

```typescript
// GOOD: Parallel, 1 round trip
async function handler() {
  const [user, posts, prefs] = await Promise.all([getUser(id), getPosts(id), getPrefs(id)])
  return { user, posts, prefs }
}

// GOOD: Start early, await late
async function handler() {
  const userP = getUser(id)
  const postsP = getPosts(id)

  // Do other work...

  const user = await userP
  const posts = await postsP
  return { user, posts }
}
```

In Effect, use `Effect.all` with concurrency:

```typescript
const result =
  yield * Effect.all([getUser(id), getPosts(id), getPrefs(id)], { concurrency: "unbounded" })
```

## See Also

- `services.md` - layer patterns
- `errors.md` - error handling
- `config.md` - configuration
- `testing.md` - test layers and mocking
- `../code-style/performance.md` - general performance patterns
