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

### 13. No `withX` scope wrappers — use `Effect.scoped` or `it.scoped` directly

Don't create helper functions that just acquire a scoped resource and pass it to a callback. Use `Effect.scoped` directly in production code, or `it.scoped` in tests.

```typescript
// BAD — withX wrapper that's just a scope
const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    return yield* fn(dir)
  }).pipe(Effect.scoped)

// BAD — withX in tests doing Effect.scoped + runPromise manually
const withDb = <A, E>(fn: (db: Db) => Effect.Effect<A, E, Mongo>): Promise<A> =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* fn(db)
  }).pipe(Effect.scoped, Effect.provide(TestDb), Effect.runPromise)

// GOOD — use it.scoped in tests, acquire resource inline
it.scoped("uses temp dir", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    // ... test logic using dir
  }).pipe(Effect.provide(FileSystem.layer))
)

// GOOD — use Effect.scoped directly in production code
const program = Effect.gen(function* () {
  const fs = yield* FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  // ... use dir
}).pipe(Effect.scoped)

// OK — wrapper adds real value (acquire + release + transform)
const withConnection = Effect.acquireRelease(
  connect(),
  (conn) => Effect.sync(() => conn.close())
)
```

### 14. Never Node/browser builtins — use Effect platform

Don't reach for `fs`, `path`, `child_process`, `crypto`, `fetch`, or other Node/browser builtins. Effect has platform-agnostic services (`FileSystem`, `HttpClient`, `Path`, `Command`) that are testable, traceable, and compose with the Effect ecosystem.

```typescript
// BAD — Node builtins
import fs from "node:fs"

const readConfig = Effect.fn("readConfig")(function* () {
  const text = fs.readFileSync("config.json", "utf-8")  // ← untraced, untestable
  return JSON.parse(text)
})

// GOOD — Effect platform services (v4: FileSystem from "effect")
import { FileSystem } from "effect"

const readConfig = Effect.fn("readConfig")(function* () {
  const fs = yield* FileSystem
  const text = yield* fs.readFileString("config.json")
  return yield* Schema.decodeUnknown(ConfigSchema)(JSON.parse(text))
})

// BAD — raw fetch
const getUser = (id: string) =>
  Effect.tryPromise(() => fetch(`/users/${id}`).then(r => r.json()))

// GOOD — HttpClient (v4: from "effect/unstable/http")
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const getUser = Effect.fn("getUser")(function* (id: string) {
  const client = yield* HttpClient
  return yield* client.get(`/users/${id}`).pipe(
    HttpClientResponse.schemaBodyJson(User)
  )
})
```

| Instead of | Use (v4 import) |
|-----------|-----------------|
| `node:fs` | `FileSystem` from `"effect"` |
| `node:path` | `Path` from `"effect"` |
| `node:child_process` | `Command` from `"effect"` |
| `fetch` / `node:http` | `HttpClient` from `"effect/unstable/http"` |
| `node:crypto` randomness | `Effect.sync(() => crypto.randomUUID())` wrapped in a service |

### 15. Never escape to plain JS for callbacks — use Effect.async / Effect.callback

Don't drop out of Effect to work with callback/event-based APIs (Node streams, sockets, EventEmitter). Use `Effect.async`, `Effect.callback`, or `Stream.async` to bring them into the Effect world with proper interruption and resource safety.

```typescript
// BAD — escaping to plain JS, losing Effect guarantees
const readStream = (stream: NodeStream.Readable) =>
  Effect.promise(() => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
    // ← no cleanup on interruption, no fiber safety
  }))

// GOOD — Effect.async with cleanup
const readStream = (stream: NodeStream.Readable) =>
  Effect.async<Buffer, StreamError>((resume) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))))
    stream.on("error", (err) => resume(Effect.fail(new StreamError({ cause: err }))))
    return Effect.sync(() => {
      stream.removeAllListeners()
      stream.destroy()
    })
  })

// GOOD — Effect.callback for simple node-style callbacks (err, result)
const readFile = (path: string) =>
  Effect.callback<Buffer, NodeError>((done) => {
    fs.readFile(path, (err, data) => {
      if (err) done(Effect.fail(new NodeError({ cause: err })))
      else done(Effect.succeed(data))
    })
  })

// GOOD — for streams, prefer Effect Stream
const fromReadable = (stream: NodeStream.Readable) =>
  Stream.async<Buffer, StreamError>((emit) => {
    stream.on("data", (chunk) => emit.single(chunk))
    stream.on("end", () => emit.end())
    stream.on("error", (err) => emit.fail(new StreamError({ cause: err })))
  })
```

Key APIs for callback interop:

| API | When |
|-----|------|
| `Effect.callback` | Simple callback → Effect (v4 only) |
| `Effect.async` | Single async result with cleanup on interruption |
| `Effect.asyncEffect` | Need to run effects during setup before registering callbacks |
| `Stream.async` | Multiple values from event emitter / readable stream |
| `Stream.asyncScoped` | Stream + scoped resource cleanup |

### 16. Never null/undefined — use Option

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

Use `/repo-explorer` to fetch and explore the Effect v4 codebase:

```bash
repo fetch effect-ts/effect-smol    # fetch/update
repo path effect-ts/effect-smol     # get local path
```

| Location | What |
|----------|------|
| `packages/effect/src/` | Core: Effect, Schema, ServiceMap, Layer, Stream, TxRef |
| `packages/effect/src/unstable/` | Unstable: http, httpapi, rpc, cli, sql, ai, etc. |
| `MIGRATION.md` | Migration guide index |
| `migration/` | Per-topic migration guides |
| `packages/effect/SCHEMA.md` | Full Schema v4 docs |

Then search with Grep/Read on the local path:

```bash
# Get the path, then search
rg "ServiceMap.Service" $(repo path -q effect-ts/effect-smol)/packages --glob "*.ts" -C 2
rg "TaggedErrorClass" $(repo path -q effect-ts/effect-smol)/packages --glob "*.ts" -C 3
```

Also useful: `repo fetch effect-ts/language-service` for the Effect LSP plugin source (all diagnostic rules, config options).

## LSP Diagnostics

The `@effect/language-service` plugin provides diagnostics beyond `tsc`. Use `@effect/language-service@^0.80.0` with v4. Patch TypeScript to get them in CLI:

```sh
# Add to package.json scripts
"prepare": "effect-language-service patch && lefthook install"
```

Required tsconfig plugin fields for v4:

```jsonc
"plugins": [{
  "name": "@effect/language-service",
  "transform": "@effect/language-service/transform",
  "namespaceImportPackages": ["effect", "@effect/*"],
  // ... diagnosticSeverity overrides
}]
```

Suppress diagnostics with comments:

```typescript
// @effect-diagnostics-next-line effect/strictEffectProvide:off   (single line)
// @effect-diagnostics effect/strictEffectProvide:off              (rest of file)
// @effect-diagnostics *:off                                       (all diagnostics, rest of file)
```

## Gotchas

### Services & Layer
- **`ServiceMap.Service` not `Context.Tag`** — Context.Tag removed
- **`Effect.flatMap(ServiceTag, fn)` removed** — use `ServiceTag.use(fn)` or `yield* ServiceTag` in gen
- **`Layer.effect` auto-strips Scope** — `Layer.scoped` removed
- **`Layer.scopedContext` removed** — use `Layer.effect(tag, eff)` or `Layer.effectServices(eff)`
- **`Layer.unwrapEffect` → `Layer.unwrap`**
- **`static layer`/`static layerTest`** not `static Live`/`static Test`
- **Deterministic keys** — `@scope/pkg/path/Name` format for service identifiers
- **Never pass context as parameters** — yield services/refs/config directly

### Errors & Cause
- **`Effect.catch`** not `Effect.catchAll` — renamed
- **`Effect.catchCause`** not `Effect.catchAllCause`**
- **`Effect.catchIf`** not `Effect.catchSome`**
- **`Effect.dieMessage(msg)` removed** — use `Effect.die(new Error(msg))`
- **`Cause.UnknownException` → `Cause.UnknownError`**
- **`Cause` is flat** — `{ reasons: Reason[] }` not recursive tree
- **`Cause.isEmpty` removed** — use `cause.reasons.length === 0`
- **`Cause.isInterruptedOnly` → `Cause.hasInterruptsOnly`**
- **`Cause.pretty(cause, opts)` → `Cause.pretty(cause)`** — no options arg
- **`ConfigError` barrel import removed** — use `Config.ConfigError`

### Schema
- **`Schema.TaggedErrorClass`** not `Schema.TaggedError`
- **`.check()` not pipe filters** — `Schema.Number.check(Schema.isInt())`
- **`.annotate()` not `.annotations()`**
- **`Schema.Record(K, V)`** not `Schema.Record({ key, value })`
- **`Schema.fromJsonString`** not `Schema.parseJson`; `{ space: 2 }` option removed
- **`Schema.optionalWith` removed** — use `Schema.optionalKey(Schema.OptionFromUndefinedOr(T))` for `{ as: 'Option' }`, `Schema.optionalKey(Schema.NullishOr(T))` for `{ nullable: true }`
- **`Schema.Config` removed** — use `Config.schema(codec, "name")`
- **`Schema.pick` removed** — destructure `.fields` into new `Schema.Struct`
- **`Schema.typeSchema` → `Schema.toType`**
- **`Schema.transformOrFail` restructured** — use `Schema.decodeTo` + `SchemaGetter.transformOrFail`
- **`Schema.disableValidation` option removed** — just remove it
- **`Schema.Schema.AnyNoContext` → `Schema.Any`** or `Schema.Top`
- **`Schema.decodeUnknown` → `Schema.decodeUnknownEffect`**
- **`ParseResult.ParseError` → `Schema.SchemaError`**
- **`Schema.mutable` only for arrays** — structs already mutable

### Data & Option
- **`Either` → `Result`** everywhere; `.left`→`.failure`, `.right`→`.success`
- **`Effect.either` → `Effect.result`** — returns `Result` not `Either`
- **`Option.fromNullable` removed** — use `Option.fromNullishOr`
- **`Effect.fromNullable` removed** — use `Effect.fromNullishOr`

### Fiber & Runtime
- **`Effect.forkChild`** not `Effect.fork`
- **`Effect.forkDetach`** not `Effect.forkDaemon`
- **`Effect.scheduleForked` removed** — use `Effect.repeat({ schedule }).pipe(Effect.fork)`
- **`Fiber.interruptFork` → `Fiber.interrupt`**
- **`Fiber.RuntimeFiber` → `Fiber.Fiber`**
- **`Runtime<R>` removed** — use `ManagedRuntime` or `Effect.run*With(services)`
- **`Runtime.runFork/runPromise/runSync` removed** — use `Effect.runForkWith(services)`, `Effect.runPromiseWith(services)`
- **`Effect.runtime()` → `Effect.services()`** — returns `ServiceMap`, not `Runtime`

### Stream
- **`Stream.fromChunk` → `Stream.fromIterable`** or `Stream.fromArray`
- **`Stream.paginateEffect` → `Stream.paginate`** (returns `[Array<A>, Option<S>]`)
- **`Chunk.toReadonlyArray` unnecessary** — `Stream.runCollect` returns `Array` in v4

### Logger
- **`Logger.remove(defaultLogger)` → `Logger.layer([])`** (empty = no loggers)
- **`Logger.replace(default, custom)` → `Logger.layer([custom])`**
- **`Logger.withMinimumLogLevel` removed** — use `References.MinimumLogLevel`

### CLI
- **`Args` → `Argument`**, `Options` → `Flag`
- **`Argument.string("name")`** not `Args.text({ name })`
- **`Flag.string("name")`** not `Options.text("name")`
- **`Argument.variadic()` — must call with `()`** when piping (`.pipe(Argument.variadic())`)
- **`Flag.atLeast(0)`** replaces `Options.repeated` (0+); `Flag.atLeast(1)` for 1+
- **`Command.run` reads from Stdio** — no `process.argv`; use `Command.runWith(cmd, { version })(args)` for tests
- **`Command.transformHandler` removed** — use `Command.provideEffect`

### Config
- **Config is Yieldable but not Effect** — `config.pipe(Effect.orDie)` breaks
- **`ConfigProvider.fromMap` removed** — use `ConfigProvider.fromUnknown(obj)` or `ConfigProvider.make(...)`
- **`ConfigProvider.fromEnv()` caches** — use `ConfigProvider.layer(provider)` for per-test isolation

### HttpApi
- **`HttpApiEndpoint.setPath/setUrlParams` removed** — pass inline at construction
- **`HttpApiSchema.annotate({ status })` → `HttpApiSchema.status(code)`**
- **`HttpApiBuilder.api()` → `HttpApiBuilder.layer()`**
- **`HttpApiScalar.layer()` → `HttpApiScalar.layer(api)`** — api arg required
- **`HttpClientResponse.value` removed** — v4 returns decoded value directly
- **`HttpServer.serve` is curried** — `serve(middleware)(httpEffect)`; use `HttpRouter.toHttpEffect(appLayer)` to get the handler

### Platform & Imports
- **`FileSystem`, `Path` from `"effect"`** — not `@effect/platform`
- **`BunServices.layer`** not `BunContext.layer`
- **Unstable imports** — `effect/unstable/http` not `@effect/platform`
- **Merge duplicate `from 'effect'` imports** — linter flags `import/no-duplicates`

### LSP
- **`@effect/language-service@0.80.0+`** — needs `transform` and `namespaceImportPackages`
- **`ignoreEffectWarningsInTscExitCode: true`** in tsconfig — prevents warnings from failing tsc
- **`// @effect-diagnostics nodeBuiltinImport:off`** — per-file suppression for scripts using node builtins

### Code Style (rules 8-16)
- **No try/catch in generators** — use `Effect.try` / `Effect.tryPromise`
- **No unnecessary `Effect.gen`** — single yield? Use pipe
- **No pointless wrapper functions** — call effects directly
- **No `withX` scope wrappers** — use `Effect.scoped` or `it.scoped` directly
- **No Node/browser builtins** — use Effect platform services
- **No plain JS callback escape** — use `Effect.callback`/`Effect.async`/`Stream.async`
- **No `null`/`undefined`** — use `Option`; convert at boundaries
