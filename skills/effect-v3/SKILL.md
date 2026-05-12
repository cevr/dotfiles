---
name: effect-v3
description: Effect v3 patterns for production TypeScript. Use when writing Effect v3 code — services, layers, errors, HttpApi, RPC, CLI, testing, concurrency, streams, config, STM. Covers Context.Tag, Schema.TaggedError, Effect.fn, Layer composition, client wrappers, CLI testing patterns, and Software Transactional Memory (STM, TRef, TQueue, TMap, …).
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
├─ STM / Transactions (TRef, …)    → references/concurrency.md §STM
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
| Concurrency | `references/concurrency.md` | FiberSet, FiberMap, FiberHandle, Deferred, Semaphore, STM + T* primitives |
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

### 12. No `withX` scope wrappers — use `Effect.scoped` or `it.scoped` directly

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
  }).pipe(Effect.provide(FileSystem.Live))
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

### 13. Never Node/browser builtins — use Effect platform

Don't reach for `fs`, `path`, `child_process`, `crypto`, `fetch`, or other Node/browser builtins. Effect has platform-agnostic services (`FileSystem`, `HttpClient`, `Path`, `Command`) that are testable, traceable, and compose with the Effect ecosystem.

```typescript
// BAD — Node builtins
import fs from "node:fs"
import { execSync } from "node:child_process"

const readConfig = Effect.fn("readConfig")(function* () {
  const text = fs.readFileSync("config.json", "utf-8")  // ← untraced, untestable
  return JSON.parse(text)
})

// GOOD — Effect platform services
const readConfig = Effect.fn("readConfig")(function* () {
  const fs = yield* FileSystem
  const text = yield* fs.readFileString("config.json")
  return yield* Schema.decodeUnknown(ConfigSchema)(JSON.parse(text))
})

// BAD — raw fetch
const getUser = (id: string) =>
  Effect.tryPromise(() => fetch(`/users/${id}`).then(r => r.json()))

// GOOD — HttpClient
const getUser = Effect.fn("getUser")(function* (id: string) {
  const client = yield* HttpClient.HttpClient
  return yield* client.get(`/users/${id}`).pipe(
    HttpClientResponse.schemaBodyJson(User)
  )
})
```

| Instead of | Use |
|-----------|-----|
| `node:fs` | `FileSystem` from `@effect/platform` |
| `node:path` | `Path` from `@effect/platform` |
| `node:child_process` | `Command` from `@effect/platform` |
| `fetch` / `node:http` | `HttpClient` from `@effect/platform` |
| `node:crypto` randomness | `Effect.sync(() => crypto.randomUUID())` wrapped in a service |

### 14. Never escape to plain JS for callbacks — use Effect.async

Don't drop out of Effect to work with callback/event-based APIs (Node streams, sockets, EventEmitter). Use `Effect.async` or `Effect.asyncEffect` to bring them into the Effect world with proper interruption and resource safety.

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
| `Effect.async` | Single async result from callback/event |
| `Effect.asyncEffect` | Need to run effects during setup before registering callbacks |
| `Stream.async` | Multiple values from event emitter / readable stream |
| `Stream.asyncScoped` | Stream + scoped resource cleanup |

### 15. Never null/undefined — use Option

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

Use the `repo` skill (`skills/repo/SKILL.md`) for fetching/searching external sources. To explore the Effect v3 codebase:

```bash
repo fetch effect-ts/effect    # fetch/update
repo path effect-ts/effect     # get local path
```

| Package | Import | What |
|---------|--------|------|
| `effect/` | `effect` | Core: Effect, Schema, Context, Layer, Stream |
| `platform/` | `@effect/platform` | FileSystem, HttpClient, HttpApi, KeyValueStore |
| `platform-bun/` | `@effect/platform-bun` | Bun runtime adapters |
| `platform-node/` | `@effect/platform-node` | Node runtime adapters |
| `cli/` | `@effect/cli` | CLI framework |
| `vitest/` | `@effect/vitest` | Test utilities |
| `rpc/` | `@effect/rpc` | RPC framework |

Then search with Grep/Read on the local path:

```bash
rg "Context.Tag" $(repo path -q effect-ts/effect)/packages --glob "*.ts" -C 2
rg "HttpApiGroup" $(repo path -q effect-ts/effect)/packages --glob "*.ts" -C 3
```

Also useful: `repo fetch effect-ts/tsgo` for the Effect LSP plugin source (all diagnostic rules, config options — the upstream README explicitly supports both v3 and v4).

## LSP Diagnostics

Use `@effect/tsgo` (bundles tsgo + the Effect language service plugin). It supports v3 — the diagnostics table in the upstream README marks each rule's v3/v4 compatibility, and v3 codebases get the same plugin-based flow as v4. See `skills/project-scaffolding/SKILL.md` and `skills/project-scaffolding/references/migration.md` for the full setup; the short version:

```sh
# package.json
"prepare": "lefthook install && effect-tsgo patch"
```

Plus `@effect/tsgo` + `@typescript/native-preview` as devDependencies, single `tsconfig.json` with the `@effect/language-service` plugin in `compilerOptions.plugins[]` (no separate `tsconfig.lsp.json`). Some rules are v4-only (e.g. `outdatedApi`, `cryptoRandomUUID`); set those to `"off"` in `diagnosticSeverity` for v3 projects.

Suppress diagnostics with comments:

```typescript
// @effect-diagnostics-next-line effect/strictEffectProvide:off   (single line)
// @effect-diagnostics effect/strictEffectProvide:off              (rest of file)
// @effect-diagnostics *:off                                       (all diagnostics, rest of file)
```

For test relaxation, prefer plugin `overrides[].include` in tsconfig over per-file directives.

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
- **No pointless wrapper functions** — if it just delegates to one effect call, use that call directly
- **No `withX` scope wrappers** — use `Effect.scoped` or `it.scoped` directly; don't create `withDb`/`withTempDir` helpers
- **No Node/browser builtins** — use Effect platform (`FileSystem`, `HttpClient`, `Path`, `Command`) not `node:fs`/`fetch`/etc.
- **No plain JS callback escape hatches** — use `Effect.async`/`Stream.async` for event emitters, Node streams, sockets
- **No `null`/`undefined`** — use `Option` from effect; convert nullish → `Option.fromNullable` at boundaries
- **STM is a separate monad** — `STM<A, E, R>` is NOT an `Effect`; build with `STM.gen`/combinators and run with `STM.commit(stm)`. Every `T*` op (`TRef.get`, `TQueue.offer`, …) returns `STM`, not `Effect`.
- **`STM.retry` for condition-wait** — inside `STM.gen`, call `yield* STM.retry` to suspend until any accessed `T*` value changes; cleaner than polling with `Deferred`. v4 renames this to `Effect.txRetry` and folds STM into `Effect.tx`.
