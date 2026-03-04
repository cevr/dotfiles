---
name: effect-v3
description: Effect v3 patterns for production TypeScript. Use when writing Effect v3 code — services, layers, errors, HttpApi, RPC, CLI, testing, concurrency, streams, config. Covers Context.Tag, Schema.TaggedError, Effect.fn, Layer composition, client wrappers, and CLI testing patterns.
allowed-tools: Bash, Read, Grep, Glob
---

# Effect v3

Production patterns for Effect TypeScript v3 codebases.

## Navigation

```
What are you working on?
├─ New to Effect / basics         → `primer effect basics`
├─ Defining a service             → §Services + references/services.md
├─ Wrapping a 3rd-party SDK       → references/client-wrapper.md
├─ Data modeling / Schema          → `primer effect data-modeling`
├─ Error handling                  → §Errors + `primer effect errors`
├─ HTTP API (server)               → references/http-api.md
├─ RPC                             → references/rpc.md
├─ Config / secrets                → references/config.md
├─ Concurrency / fibers            → references/concurrency.md
├─ Streams                         → references/streams.md
├─ Testing                         → §Testing + references/cli-testing.md
├─ CLI (@effect/cli)               → `primer effect cli`
└─ Something else                  → §Source Code (search Effect repo)
```

## Topic Index

| Topic | Resource | When to Read |
|-------|----------|--------------|
| Services | `references/services.md` | Defining Context.Tag, Layer, Live/Test statics |
| Client wrapper | `references/client-wrapper.md` | Wrapping Stripe/Sentry/any Promise SDK |
| HTTP API | `references/http-api.md` | HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiBuilder |
| RPC | `references/rpc.md` | Rpc.make, RpcGroup, handlers |
| CLI testing | `references/cli-testing.md` | SequenceRef, runCli, expectSequence, mock services |
| Concurrency | `references/concurrency.md` | FiberSet, FiberMap, FiberHandle, Deferred, Semaphore |
| Config | `references/config.md` | Config providers, redacted, nested |
| Streams | `references/streams.md` | Stream creation, transformation, consumption |
| Basics | `primer effect basics` | Effect.fn, Effect.gen, pipe |
| Data modeling | `primer effect data-modeling` | Schema.Class, branded types, variants |
| Errors | `primer effect errors` | Schema.TaggedError, catchTag, defects |
| Testing | `primer effect testing` | @effect/vitest, test layers, TestClock |
| CLI | `primer effect cli` | @effect/cli commands, options, args |

## Pre-Implementation (mandatory)

Before writing Effect code:

1. **Read types** — find relevant Context.Tags, TaggedErrors, Schema classes
2. **Run primer** — `primer effect <topic>` for the pattern you need
3. **Read sibling code** — match existing patterns in the codebase
4. **Only then implement**

Skipping step 1 causes multi-cycle type fixes.

## Core Rules

### 1. Always `Effect.fn` — never `function x() { return Effect.gen(...) }`

```typescript
// BAD
export function getUser(id: string) {
  return Effect.gen(function* () {
    const db = yield* Database
    return yield* db.findUser(id)
  })
}

// GOOD — traced, named, pipeable
export const getUser = Effect.fn("getUser")(function* (id: string) {
  const db = yield* Database
  return yield* db.findUser(id)
})

// GOOD — with pipe transforms
export const getUser = Effect.fn("getUser")(
  function* (id: string) {
    const db = yield* Database
    return yield* db.findUser(id)
  },
  Effect.withSpan("getUser")
)
```

### 2. `Context.Tag` is canonical — NOT `Effect.Service`

`Effect.Service` is experimental. Always use `Context.Tag`:

```typescript
// BAD
class MyService extends Effect.Service<MyService>()("MyService", { ... }) {}

// GOOD
export class MyService extends Context.Tag("MyService")<
  MyService,
  MyServiceShape
>() {
  static Live = Layer.effect(MyService, ...)
  static Test = Layer.succeed(MyService, ...)
}
```

### 3. Services for everything side-effectful

No free-floating effectful functions. No inline unrelated side-effects.

```typescript
// BAD — standalone side-effectful function
export const fetchUser = (id: string) =>
  Effect.tryPromise(() => fetch(`/users/${id}`))

// GOOD — service with testable layers
export class UserApi extends Context.Tag("UserApi")<
  UserApi,
  { readonly fetchUser: (id: string) => Effect.Effect<User, ApiError> }
>() {
  static Live = Layer.succeed(UserApi, { ... })
  static Test = (users: Map<string, User>) =>
    Layer.succeed(UserApi, { ... })
}
```

### 4. Bubble service requirements up

Don't provide layers deep inside. Let the caller compose layers at the edge.

**Exception**: dynamically-provided services (CLI option services per-command).

### 5. Never pass context as parameters — yield it

Don't thread services/refs through function arguments. Yield them from context directly and let requirements bubble through the type system.

```typescript
// BAD — threading context as parameters
const processOrder = Effect.fn("processOrder")(function* (
  order: Order,
  db: DatabaseShape,      // ← passing context as param
  logger: LoggerShape,    // ← passing context as param
) {
  yield* logger.info(`Processing ${order.id}`)
  yield* db.save(order)
})

// caller has to manually thread services
const program = Effect.fn("program")(function* () {
  const db = yield* Database
  const logger = yield* Logger
  yield* processOrder(order, db, logger)
})

// GOOD — yield context directly, requirements bubble
const processOrder = Effect.fn("processOrder")(function* (order: Order) {
  const db = yield* Database
  const logger = yield* Logger
  yield* logger.info(`Processing ${order.id}`)
  yield* db.save(order)
})

// caller just calls — no threading
const program = Effect.fn("program")(function* () {
  yield* processOrder(order)
})
```

This applies to any yieldable context: services, refs, config, etc. If you can `yield*` it, don't pass it.

### 6. Never raw errors — always tagged

```typescript
// BAD
throw new Error("not found")
Effect.fail(new Error("not found"))

// GOOD
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { id: Schema.String }
) {}
Effect.fail(new NotFound({ id }))
```

### 7. Never standalone exported functions with side effects

Wrap in services with static `Live`/`Test`. See `references/services.md`.

### 8. Never try/catch in Effect generators

The `@effect/language-service` flags `tryCatchInEffectGen`. Use `Effect.try` or `Effect.tryPromise` instead.

```typescript
// BAD
const load = Effect.fn("load")(function* () {
  try {
    const data = yield* Effect.promise(() => file.text())
    return JSON.parse(data)
  } catch {
    return defaultValue
  }
})

// GOOD
const load = Effect.fn("load")(function* () {
  const data = yield* Effect.promise(() => file.text())
  return yield* Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: () => new ParseError({ message: "invalid json" }),
  })
})
```

### 9. Never JSON.parse/JSON.stringify — use Schema

The LSP flags `preferSchemaOverJson`. Use `Schema.parseJson` for type-safe JSON parsing/encoding.

```typescript
// BAD
const data = JSON.parse(text) as MyType

// GOOD
const MySchema = Schema.Struct({ name: Schema.String, count: Schema.Number })
const decode = Schema.decodeUnknownSync(Schema.parseJson(MySchema))
const encode = Schema.encodeSync(Schema.parseJson(MySchema))

const data = decode(text)                    // string → MyType
const json = encode(data)                    // MyType → string

// GOOD — effectful
const decodeEffect = Schema.decodeUnknown(Schema.parseJson(MySchema))
const data = yield* decodeEffect(text)
```

### 10. No unnecessary Effect.gen

The LSP flags `unnecessaryEffectGen` for generators with a single yield/return. Flatten these.

```typescript
// BAD — single yield, unnecessary gen
const getName = (id: string) =>
  Effect.gen(function* () {
    yield* recorder.record({ service: "User", method: "getName", args: { id } })
  })

// GOOD — direct call
const getName = (id: string) =>
  recorder.record({ service: "User", method: "getName", args: { id } })

// BAD — single yield + return
const getCount = () =>
  Effect.gen(function* () {
    yield* recorder.record({ service: "Counter", method: "get" })
    return 42
  })

// GOOD — pipe with Effect.as
const getCount = () =>
  recorder.record({ service: "Counter", method: "get" }).pipe(Effect.as(42))
```

## Services (quick ref)

Canonical pattern: `Context.Tag` with static `Live`/`Test`/`Noop`.

```typescript
export interface ConsoleServiceShape {
  readonly log: (msg: string) => Effect.Effect<void>
  readonly error: (msg: string) => Effect.Effect<void>
}

export class ConsoleService extends Context.Tag("ConsoleService")<
  ConsoleService,
  ConsoleServiceShape
>() {
  static Live = Layer.succeed(ConsoleService, {
    log: (msg) => Effect.sync(() => console.log(msg)),
    error: (msg) => Effect.sync(() => console.error(msg)),
  })

  static Test = (ref: Ref.Ref<Array<string>>) =>
    Layer.succeed(ConsoleService, {
      log: (msg) => Ref.update(ref, (arr) => [...arr, msg]),
      error: (msg) => Ref.update(ref, (arr) => [...arr, `[ERROR] ${msg}`]),
    })

  static Noop = Layer.succeed(ConsoleService, {
    log: () => Effect.void,
    error: () => Effect.void,
  })
}
```

**Layer quick ref:**

| Constructor | When |
|-------------|------|
| `Layer.succeed(tag, value)` | Sync, no deps |
| `Layer.sync(tag, () => value)` | Lazy sync, no deps |
| `Layer.effect(tag, effect)` | Async/effectful construction |
| `Layer.scoped(tag, effect)` | Needs Scope (cleanup) |
| `Layer.merge(a, b)` | Combine independent layers |
| `Layer.provide(target, dependency)` | Wire dependency into target |
| `Layer.provideMerge(target, dep)` | Wire + keep dep in output |

Full patterns → `references/services.md`

## Errors (quick ref)

| Type | When |
|------|------|
| `Schema.TaggedError` | Recoverable, serializable, with fields |
| `Data.TaggedError` | Recoverable, not serializable |
| Defect (`Effect.die`) | Bugs, should never happen |

```typescript
export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { userId: Schema.String, message: Schema.String }
) {}

// With HTTP status (for HttpApi)
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 })
) {}
```

Full patterns → `primer effect errors`

## Data Modeling (quick ref)

```typescript
// Branded ID
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

// Data class
export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.DateFromSelf,
}) {}
```

Full patterns → `primer effect data-modeling`

## Testing (quick ref)

```typescript
import { it } from "@effect/vitest"

it.effect("creates a user", () =>
  Effect.gen(function* () {
    const service = yield* UserService
    const user = yield* service.create({ name: "Ada" })
    expect(user.name).toBe("Ada")
  }).pipe(Effect.provide(UserService.Test))
)

// Scoped (auto-cleanup)
it.scoped("connects to DB", () =>
  Effect.gen(function* () {
    const db = yield* Database
    yield* db.query("SELECT 1")
  }).pipe(Effect.provide(Database.TestScoped))
)
```

CLI testing → `references/cli-testing.md`

## Source Code

Effect v3 repo: `~/.claude/repos/Effect-TS/effect`

| Package | Import | What |
|---------|--------|------|
| `effect/` | `effect` | Core: Effect, Schema, Context, Layer, Stream |
| `platform/` | `@effect/platform` | FileSystem, HttpClient, HttpApi, KeyValueStore |
| `platform-bun/` | `@effect/platform-bun` | Bun runtime adapters |
| `platform-node/` | `@effect/platform-node` | Node runtime adapters |
| `cli/` | `@effect/cli` | CLI framework |
| `vitest/` | `@effect/vitest` | Test utilities |
| `rpc/` | `@effect/rpc` | RPC framework |

```bash
# Search for API usage
rg "Context.Tag" ~/.claude/repos/Effect-TS/effect/packages --glob "*.ts" -C 2
rg "HttpApiGroup" ~/.claude/repos/Effect-TS/effect/packages --glob "*.ts" -C 3
```

## LSP Diagnostics

The `@effect/language-service` plugin provides diagnostics beyond `tsc`. Patch TypeScript to get them in CLI:

```sh
# Add to package.json scripts
"prepare": "effect-language-service patch && lefthook install"
```

Suppress diagnostics with comments:

```typescript
// @effect-diagnostics-next-line effect/strictEffectProvide:off   (single line)
// @effect-diagnostics effect/strictEffectProvide:off              (rest of file)
// @effect-diagnostics *:off                                       (all diagnostics, rest of file)
```

## Gotchas

- **`@effect/schema` merged into `effect`** — import `Schema` from `"effect"`, not `"@effect/schema"`
- **Layer memoization = reference identity** — same Layer reference = shared instance. New reference = new instance.
- **`Effect.Service` is experimental** — use `Context.Tag` for production code
- **Never `function` returning `Effect.gen`** — always `Effect.fn` for tracing
- **Never raw `Error`/`throw`** — always `Schema.TaggedError` or `Data.TaggedError`
- **Services for all side effects** — no standalone exported effectful functions
- **`Effect.gen` `this` binding** — `Effect.gen(this, function* () { ... })` when inside a class
- **Schema field order matters for decode** — put required fields before optional
- **`yield*` not `yield`** — `yield*` delegates to the Effect, `yield` just returns the Effect object
- **Never pass context as parameters** — yield services/refs/config directly; don't thread them through function args
- **No `JSON.parse`** — use `Schema.parseJson(schema)` for type-safe JSON string ↔ typed data
- **No try/catch in generators** — use `Effect.try` / `Effect.tryPromise`
- **No unnecessary `Effect.gen`** — single yield? Use pipe + `Effect.as` / `Effect.andThen`
