---
name: effect-v4
description: Effect v4 (effect-smol) patterns for production TypeScript. Use when writing Effect v4 code — ServiceMap.Service, layers, errors, HttpApi, RPC, CLI, testing, concurrency, streams, config, transactions. Covers v4 API changes from v3 including Schema.TaggedErrorClass, Result, References, TxRef, and unstable module imports.
allowed-tools: Bash, Read, Grep, Glob
---

# Effect v4

Production patterns for Effect TypeScript v4 (effect-smol) codebases.

## Navigation

```
What are you working on?
├─ New to Effect / basics         → `primer effect basics` (concepts same as v3)
├─ Defining a service             → §Services + references/services.md
├─ Wrapping a 3rd-party SDK       → references/client-wrapper.md
├─ Data modeling / Schema          → references/schema.md
├─ Error handling                  → §Errors
├─ HTTP API (server)               → references/http-api.md
├─ RPC                             → references/rpc.md
├─ Config / secrets                → references/config.md
├─ Concurrency / fibers            → references/concurrency.md
├─ Transactions (TxRef)            → references/concurrency.md §Transactions
├─ Streams                         → references/streams.md
├─ Testing                         → §Testing + references/cli-testing.md
├─ CLI (effect/unstable/cli)       → `primer effect cli` (adapted for v4 imports)
├─ Migrating from v3               → references/migration.md
└─ Something else                  → §Source Code (search effect-smol repo)
```

## Topic Index

| Topic | Resource | When to Read |
|-------|----------|--------------|
| Services | `references/services.md` | ServiceMap.Service, Layer, layer/layerTest statics |
| Client wrapper | `references/client-wrapper.md` | Wrapping Promise SDKs |
| Schema v4 | `references/schema.md` | .check(), .annotate(), Codec, TaggedErrorClass |
| HTTP API | `references/http-api.md` | HttpApi from effect/unstable/httpapi |
| RPC | `references/rpc.md` | RPC from effect/unstable/rpc |
| CLI testing | `references/cli-testing.md` | SequenceRef, runCli, mock services |
| Concurrency | `references/concurrency.md` | FiberSet, FiberMap, Deferred, Semaphore, TxRef |
| Config | `references/config.md` | Config, Config.schema, Redacted |
| Streams | `references/streams.md` | Stream (minor v4 changes) |
| Migration | `references/migration.md` | v3→v4 rename table, import map |

## v4 Import Map

| v3 Package | v4 Import |
|------------|-----------|
| `@effect/platform` (HttpClient, etc.) | `effect/unstable/http` |
| `@effect/platform` (HttpApi, etc.) | `effect/unstable/httpapi` |
| `@effect/rpc` | `effect/unstable/rpc` |
| `@effect/cli` | `effect/unstable/cli` |
| `@effect/sql` | `effect/unstable/sql` |
| `@effect/cluster` | `effect/unstable/cluster` |
| `@effect/ai` | `effect/unstable/ai` |
| `@effect/platform-bun` | `@effect/platform-bun` (still separate) |
| `@effect/platform-node` | `@effect/platform-node` (still separate) |
| `@effect/vitest` | `@effect/vitest` (still separate) |

## Pre-Implementation (mandatory)

Before writing Effect v4 code:

1. **Read types** — find relevant ServiceMap.Service, TaggedErrorClass, Schema classes
2. **Check import paths** — v4 uses `effect/unstable/*` for platform/rpc/cli
3. **Read sibling code** — match existing patterns
4. **Check migration** — `references/migration.md` for v3→v4 renames

## Core Rules

### 1. Always `Effect.fn` — never `function x() { return Effect.gen(...) }`

Same as v3. `Effect.fn` is unchanged in v4.

```typescript
// BAD
export function getUser(id: string) {
  return Effect.gen(function* () { ... })
}

// GOOD
export const getUser = Effect.fn("getUser")(function* (id: string) {
  const db = yield* Database
  return yield* db.findUser(id)
})
```

### 2. `ServiceMap.Service` is canonical — NOT `Effect.Service`

```typescript
import { ServiceMap } from "effect"

// BAD
class MyService extends Effect.Service<MyService>()("MyService", { ... }) {}

// GOOD — function style
const Database = ServiceMap.Service<{ query: (sql: string) => string }>("Database")

// GOOD — class style
class Database extends ServiceMap.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string, DbError>
}>()("Database") {
  static layer = Layer.effect(Database, ...)
  static layerTest = Layer.succeed(Database, ...)
}
```

### 3. Services for everything side-effectful

Same as v3. No free-floating effectful functions.

### 4. Bubble service requirements up

Same as v3. Don't provide layers deep inside.

### 5. Never pass context as parameters — yield it

Don't thread services/refs through function arguments. Yield them from context directly and let requirements bubble through the type system.

```typescript
// BAD — threading context as parameters
const processOrder = Effect.fn("processOrder")(function* (
  order: Order,
  db: DatabaseService,    // ← passing context as param
  logger: LoggerService,  // ← passing context as param
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
// v4: Schema.TaggedErrorClass (renamed from TaggedError)
export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { id: Schema.String }
) {}
```

### 7. Never standalone exported functions with side effects

Same as v3. Wrap in services with static `layer`/`layerTest`.

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

The LSP flags `preferSchemaOverJson`. Use `Schema.fromJsonString` for type-safe JSON parsing/encoding.

```typescript
// BAD
const data = JSON.parse(text) as MyType

// GOOD
const MySchema = Schema.Struct({ name: Schema.String, count: Schema.Number })
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MySchema))
const encode = Schema.encodeEffect(Schema.fromJsonString(MySchema))

const data = yield* decode(text)                    // string → MyType
const json = yield* encode(data)                    // MyType → string
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

### 11. No pointless wrapper functions

If a function just delegates to a single effect call without adding logic, don't create the function — use the effect directly at the call site.

```typescript
// BAD — wrapper adds nothing
const getUser = (id: string) => userService.findUser(id)
const deleteAll = () => repository.clear()

// GOOD — call the effect directly where you need it
yield* userService.findUser(id)
yield* repository.clear()

// OK — wrapper adds real value (transforms, combines, or adds context)
const getActiveUser = (id: string) =>
  userService.findUser(id).pipe(Effect.filterOrFail(
    (u) => u.active,
    () => new InactiveUser({ id })
  ))
```

### 12. Deterministic service keys

The LSP flags `deterministicKeys`. Use `@scope/package/path/ServiceName` format.

```typescript
// BAD
class MyService extends ServiceMap.Service<...>()("MyService") {}

// GOOD
class MyService extends ServiceMap.Service<...>()("@myorg/mypackage/services/MyService") {}
```

### 13. Never null/undefined — use Option

Effect has `Option<A>` for representing optional values. Don't leak nullish types into Effect code.

```typescript
// BAD — nullish in Effect code
const findUser = Effect.fn("findUser")(function* (id: string) {
  const db = yield* Database
  const row = yield* db.query(id)
  return row ?? null  // ← null leaking into Effect
})
// return type: Effect<User | null, ...>

// BAD — null checks inside Effect code
const getName = Effect.fn("getName")(function* (id: string) {
  const user = yield* findUser(id)
  if (user === null) {
    return yield* Effect.fail(new UserNotFound({ id }))
  }
  return user.name
})

// GOOD — Option throughout
const findUser = Effect.fn("findUser")(function* (id: string) {
  const db = yield* Database
  const row = yield* db.query(id)
  return Option.fromNullable(row)  // ← convert at boundary
})
// return type: Effect<Option<User>, ...>

// GOOD — Option composes with Effect combinators
const getName = Effect.fn("getName")(function* (id: string) {
  const user = yield* findUser(id)
  return Option.map(user, (u) => u.name)
})

// GOOD — fail on None
const getUser = Effect.fn("getUser")(function* (id: string) {
  return yield* findUser(id).pipe(
    Effect.flatMap(Effect.fromOption(() => new UserNotFound({ id })))
  )
})
```

**Boundary rule:** convert nullish → `Option` at the system boundary (3rd-party SDK, DB driver, DOM API), then use `Option` everywhere inside Effect code. Key conversions:

| From | To | How |
|------|----|-----|
| `T \| null \| undefined` | `Option<T>` | `Option.fromNullable(value)` |
| `Option<T>` | `T \| undefined` | `Option.getOrUndefined(opt)` (at exit boundary) |
| `Effect<T, Err>` | `Effect<Option<T>>` | `Effect.option(effect)` |
| `Effect<Option<T>>` | `Effect<T, Err>` | `Effect.flatMap(Effect.fromOption(() => err))` |

## Services (quick ref)

v4 uses `ServiceMap.Service` instead of `Context.Tag`. Static layers use `layer`/`layerTest` naming.

```typescript
import { ServiceMap, Effect, Layer, Ref } from "effect"

class ConsoleService extends ServiceMap.Service<ConsoleService, {
  readonly log: (msg: string) => Effect.Effect<void>
  readonly error: (msg: string) => Effect.Effect<void>
}>()("ConsoleService") {
  static layer = Layer.succeed(ConsoleService, {
    log: (msg) => Effect.sync(() => console.log(msg)),
    error: (msg) => Effect.sync(() => console.error(msg)),
  })

  static layerTest = (ref: Ref.Ref<Array<string>>) =>
    Layer.succeed(ConsoleService, {
      log: (msg) => Ref.update(ref, (arr) => [...arr, msg]),
      error: (msg) => Ref.update(ref, (arr) => [...arr, `[ERROR] ${msg}`]),
    })

  static layerNoop = Layer.succeed(ConsoleService, {
    log: () => Effect.void,
    error: () => Effect.void,
  })
}
```

Full patterns → `references/services.md`

## Errors (quick ref)

| Type | When |
|------|------|
| `Schema.TaggedErrorClass` | Recoverable, serializable, with fields |
| `Data.TaggedError` | Recoverable, not serializable |
| Defect (`Effect.die`) | Bugs, should never happen |

```typescript
// v4: TaggedErrorClass (not TaggedError)
export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  { userId: Schema.String, message: Schema.String }
) {}

// Catch: v4 renames
// catchAll → catch
// catchAllCause → catchCause
// catchSome → catchIf
// catchSomeCause → catchCauseIf
// catchAllDefect → catchDefect
// catchTag, catchTags — unchanged
```

## Data Modeling (quick ref)

See `references/schema.md` for full v4 Schema changes.

```typescript
// .check() replaces pipe filters
const Age = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 150 }))

// .annotate() replaces .annotations()
const Name = Schema.String.annotate({ description: "User name" })

// Branded
const UserId = Schema.String.pipe(Schema.brand("UserId"))
```

## Testing (quick ref)

```typescript
import { it } from "@effect/vitest"

it.effect("creates a user", () =>
  Effect.gen(function* () {
    const service = yield* UserService
    const user = yield* service.create({ name: "Ada" })
    expect(user.name).toBe("Ada")
  }).pipe(Effect.provide(UserService.layerTest))
)
```

CLI testing → `references/cli-testing.md`

## Source Code

Effect v4 repo: `~/.claude/repos/Effect-TS/effect-smol`

| Location | What |
|----------|------|
| `packages/effect/src/` | Core: Effect, Schema, ServiceMap, Layer, Stream, TxRef |
| `packages/effect/src/unstable/` | Unstable: http, httpapi, rpc, cli, sql, ai, etc. |
| `MIGRATION.md` | Migration guide index |
| `migration/` | Per-topic migration guides |
| `packages/effect/SCHEMA.md` | Full Schema v4 docs |

```bash
rg "ServiceMap.Service" ~/.claude/repos/Effect-TS/effect-smol/packages --glob "*.ts" -C 2
rg "TaggedErrorClass" ~/.claude/repos/Effect-TS/effect-smol/packages --glob "*.ts" -C 3
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

- **`ServiceMap.Service` not `Context.Tag`** — Context.Tag is removed in v4
- **`Schema.TaggedErrorClass`** not `Schema.TaggedError` — renamed
- **`Effect.catch`** not `Effect.catchAll` — renamed
- **`Effect.catchCause`** not `Effect.catchAllCause` — renamed
- **`Effect.forkChild`** not `Effect.fork` — renamed
- **`Effect.forkDetach`** not `Effect.forkDaemon` — renamed
- **`Result`** not `Either` — `Result.succeed`/`Result.fail` instead of `Either.right`/`Either.left`
- **`.check()` not pipe filters** — `Schema.Number.check(Schema.isInt())` not `Schema.Number.pipe(Schema.int())`
- **`.annotate()` not `.annotations()`** — method renamed on Schema
- **`Effect.gen({ self: this }, fn)`** not `Effect.gen(this, fn)` — self binding changed
- **`Layer.effect` auto-strips Scope** — `Layer.scoped` removed; `Layer.effect` handles it
- **`Cause` is flat** — `{ reasons: Reason[] }` not recursive tree
- **Unstable imports** — `effect/unstable/http` not `@effect/platform`
- **`BunServices.layer`** not `BunContext.layer` — platform context renamed
- **`static layer`/`static layerTest`** not `static Live`/`static Test` — naming convention
- **No `Schema.parseJson`** — use `Schema.fromJsonString(schema)` for JSON string ↔ typed data
- **`Schema.Record` takes two args** — `Schema.Record(Schema.String, ValueSchema)` not `Schema.Record({ key, value })`
- **No try/catch in generators** — use `Effect.try` / `Effect.tryPromise`
- **No unnecessary `Effect.gen`** — single yield? Use pipe + `Effect.as` / `Effect.andThen`
- **No pointless wrapper functions** — if it just delegates to one effect call, use that call directly
- **No `null`/`undefined`** — use `Option` from effect; convert nullish → `Option.fromNullable` at boundaries
- **Deterministic keys** — `@scope/pkg/path/Name` format for service identifiers
- **Never pass context as parameters** — yield services/refs/config directly; don't thread them through function args
