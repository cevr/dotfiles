# v3 → v4 Migration

Condensed diff for migrating Effect v3 codebases to v4.

## Package Changes

- All `@effect/*` packages share a single version number with `effect`
- Many packages merged into `effect` under `effect/unstable/*` paths
- Platform-specific packages remain separate (`@effect/platform-bun`, etc.)
- Remove `@effect/cli` and `@effect/platform` from deps (merged into core)
- Remove any `@effect/cli` patches from `patchedDependencies`
- Add `"prepare": "effect-language-service patch && lefthook install"` to scripts

## Import Rewrite Table

| v3 | v4 |
|----|----|
| `import { HttpClient } from "@effect/platform"` | `import { HttpClient } from "effect/unstable/http"` |
| `import { HttpApi, HttpApiBuilder } from "@effect/platform"` | `import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"` |
| `import { FileSystem, Path } from "@effect/platform"` | `import { FileSystem, Path } from "effect"` |
| `import { Headers } from "@effect/platform"` | `import { Headers } from "effect/unstable/http"` |
| `import { Rpc, RpcGroup } from "@effect/rpc"` | `import { Rpc, RpcGroup } from "effect/unstable/rpc"` |
| `import { Command } from "@effect/cli"` | `import { Command } from "effect/unstable/cli"` |
| `import { SqlClient } from "@effect/sql"` | `import { SqlClient } from "effect/unstable/sql"` |
| `import { Socket } from "@effect/platform"` | `import { Socket } from "effect/unstable/socket"` |
| `import { BunContext } from "@effect/platform-bun"` | `import { BunServices } from "@effect/platform-bun"` |
| `import { NodeContext } from "@effect/platform-node"` | `import { NodeServices } from "@effect/platform-node"` |
| `import { ConfigError } from "effect"` | Use `Config.ConfigError` (nested type) |
| `import type { PlatformError } from "@effect/platform/Error"` | `import type { PlatformError } from "effect/PlatformError"` |

**After rewriting:** merge duplicate `from 'effect'` imports (linter will flag `import/no-duplicates`).

## Mechanical Rename Table

| v3 | v4 | Category |
|----|----|----|
| `Context.Tag("id")<Self, Shape>()` | `ServiceMap.Service<Self, Shape>()("id")` | Services |
| `Context.GenericTag<Shape>("id")` | `ServiceMap.Service<Shape>("id")` | Services |
| `Context.make(tag, impl)` | `ServiceMap.make(tag, impl)` | Services |
| `Effect.flatMap(ServiceTag, fn)` | `ServiceTag.use(fn)` or `yield* ServiceTag` in gen | Services |
| `static Live` | `static layer` | Convention |
| `static Test` | `static layerTest` | Convention |
| `Either` | `Result` | Data |
| `Either.right(v)` / `Either.left(e)` | `Result.succeed(v)` / `Result.fail(e)` | Data |
| `Either.isRight` / `Either.isLeft` | `Result.isSuccess` / `Result.isFailure` | Data |
| `Effect.either(eff)` | `Effect.result(eff)` | Data |
| `.left` / `.right` (on Either) | `.failure` / `.success` (on Result) | Data |
| `FiberRef` | `ServiceMap.Reference` / `References.*` | State |
| `Effect.fork` | `Effect.forkChild` | Forking |
| `Effect.forkDaemon` | `Effect.forkDetach` | Forking |
| `Effect.scheduleForked(schedule)` | `Effect.repeat({ schedule }).pipe(Effect.fork)` | Forking |
| `Effect.catchAll` | `Effect.catch` | Errors |
| `Effect.catchAllCause` | `Effect.catchCause` | Errors |
| `Effect.catchAllDefect` | `Effect.catchDefect` | Errors |
| `Effect.catchSome` | `Effect.catchIf` | Errors |
| `Effect.catchSomeCause` | `Effect.catchCauseIf` | Errors |
| `Effect.ignore` | `Effect.ignore` (unchanged; gains `{ log }` option) | Errors |
| `Effect.dieMessage(msg)` | `Effect.die(new Error(msg))` | Errors |
| `Effect.tapErrorCause(Effect.logError)` | `Effect.tapError(Effect.logError)` | Errors |
| `Cause.UnknownException` | `Cause.UnknownError` | Errors |
| `Cause.isEmpty(cause)` | `cause.reasons.length === 0` | Cause |
| `Cause.isInterruptedOnly(cause)` | `Cause.hasInterruptsOnly(cause)` | Cause |
| `Cause.pretty(cause, opts)` | `Cause.pretty(cause)` (no options) | Cause |
| `Effect.fromNullable(v)` | `Effect.fromNullishOr(v)` | Effect |
| `Option.fromNullable(v)` | `Option.fromNullishOr(v)` | Option |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` | Schema |
| `.annotations({...})` | `.annotate({...})` | Schema |
| `.pipe(Schema.int())` | `.check(Schema.isInt())` | Schema |
| `.pipe(Schema.positive())` | `.check(Schema.isGreaterThan(0))` | Schema |
| `.pipe(Schema.nonNegative())` | `.check(Schema.isGreaterThanOrEqualTo(0))` | Schema |
| `.pipe(Schema.nonEmpty())` | `.check(Schema.isNonEmpty())` | Schema |
| `.pipe(Schema.between(a,b))` | `.check(Schema.isBetween({ minimum: a, maximum: b }))` | Schema |
| `Schema.Literal("a","b")` | `Schema.Literals(["a","b"])` | Schema |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` | Schema |
| `Schema.Record({ key: K, value: V })` | `Schema.Record(K, V)` | Schema |
| `Schema.parseJson(S)` | `Schema.fromJsonString(S)` | Schema |
| `Schema.fromJsonString(S, { space: 2 })` | Removed — use `JSON.stringify(data, null, 2)` | Schema |
| `Schema.decodeUnknown(S)` | `Schema.decodeUnknownEffect(S)` | Schema |
| `Schema.encodeUnknown(S)` | `Schema.encodeUnknownEffect(S)` | Schema |
| `Schema.decode(S)` | `Schema.decodeEffect(S)` | Schema |
| `Schema.encode(S)` | `Schema.encodeEffect(S)` | Schema |
| `decodeUnknownEither` | `decodeUnknownResult` | Schema |
| `ParseResult.ParseError` | `Schema.SchemaError` | Schema |
| `Schema.typeSchema(S)` | `Schema.toType(S)` | Schema |
| `Schema.Schema.AnyNoContext` | `Schema.Any` or `Schema.Top` | Schema |
| `Schema.Config("name", codec)` | `Config.schema(codec, "name")` | Config |
| `ConfigError` (barrel import) | `Config.ConfigError` (nested type) | Config |
| `Layer.scoped(tag, eff)` | Removed → `Layer.effect(tag, eff)` (auto-strips Scope) | Layer |
| `Layer.scopedContext(eff)` | `Layer.effect(tag, eff)` or `Layer.effectServices(eff)` | Layer |
| `Layer.unwrapEffect(eff)` | `Layer.unwrap(eff)` | Layer |
| `Stream.fromChunk(chunk)` | `Stream.fromIterable(chunk)` or `Stream.fromArray(arr)` | Stream |
| `Stream.paginateEffect(s, f)` | `Stream.paginate(s, f)` (returns `[Array<A>, Option<S>]`) | Stream |
| `Chunk.toReadonlyArray(c)` | v4 `Stream.runCollect` returns `Array` directly | Stream |
| `Fiber.interruptFork(fiber)` | `Fiber.interrupt(fiber)` | Fiber |
| `Fiber.RuntimeFiber<A, E>` | `Fiber.Fiber<A, E>` | Fiber |
| `Runtime.Runtime<R>` | Removed; use `ManagedRuntime` or `ServiceMap<R>` | Runtime |
| `Runtime.runFork(runtime)(eff)` | `Effect.runForkWith(services)(eff)` | Runtime |
| `Runtime.runPromise(runtime)(eff)` | `Effect.runPromiseWith(services)(eff)` | Runtime |
| `Runtime.runSync(runtime)(eff)` | `runtime.runSync(eff)` (ManagedRuntime) | Runtime |
| `Effect.runtime()` | `Effect.services()` (returns ServiceMap, not Runtime) | Runtime |
| `Logger.remove(Logger.defaultLogger)` | `Logger.layer([])` (empty loggers) | Logger |
| `Logger.replace(defaultLogger, custom)` | `Logger.layer([custom])` | Logger |
| `Logger.withMinimumLogLevel(LogLevel.X)` | `References.MinimumLogLevel` + `"Debug"` / `"Info"` strings | Logger |
| `Args.text({ name: "x" })` | `Argument.string("x")` | CLI |
| `Args.integer({ name: "x" })` | `Argument.integer("x")` | CLI |
| `Args.repeated` | `Argument.variadic()` (**must call with `()`** when piping) | CLI |
| `Options.text("name")` | `Flag.string("name")` | CLI |
| `Options.file("name")` | `Flag.file("name")` | CLI |
| `Options.boolean("name")` | `Flag.boolean("name")` | CLI |
| `Options.repeated` | `Flag.atLeast(0)` (0+) or `Flag.atLeast(1)` (1+) | CLI |
| `Options.withAlias` / `withDescription` / `optional` | `Flag.withAlias` / `withDescription` / `Flag.optional` | CLI |
| `Command.run(cmd, { name, version })` | `Command.run(cmd, { version })` (args from Stdio) | CLI |
| `Command.transformHandler` | Removed — use `Command.provideEffect` | CLI |
| `cli(process.argv)` | `cli.pipe(Effect.provide(...), BunRuntime.runMain)` | CLI |
| `BunContext.layer` | `BunServices.layer` | Platform |
| `NodeContext.layer` | `NodeServices.layer` | Platform |
| `Effect.gen(this, fn)` | `Effect.gen({ self: this }, fn)` | Generator |
| `Effect.zipRight(a, b)` | `a.pipe(Effect.andThen(b))` | Combinators |
| `Effect.makeSemaphore(n)` | `Semaphore.make(n)` (import from `effect/Semaphore`) | Concurrency |
| `Ref.unsafeMake(val)` | `Ref.makeUnsafe(val)` | Ref |
| `Console.log(msg)` (returns Effect) | `Console.log(msg)` (returns void — sync in v4) | Console |

## Schema optionalWith → v4

```typescript
// v3: { as: 'Option' }
Schema.optionalWith(MySchema, { as: 'Option' })
// v4: optionalKey + OptionFromUndefinedOr
Schema.optionalKey(Schema.OptionFromUndefinedOr(MySchema))

// v3: { nullable: true }
Schema.optionalWith(MySchema, { nullable: true })
// v4: optionalKey + NullishOr
Schema.optionalKey(Schema.NullishOr(MySchema))

// v3: { default: () => value }
Schema.optionalWith(MySchema, { default: () => 0 })
// v4: withConstructorDefault
Schema.optional(MySchema).pipe(Schema.withConstructorDefault(() => 0))
```

## Schema.pick → v4

```typescript
// v3
const Picked = Schema.pick(MyStruct, ["name", "age"])

// v4 — destructure .fields
const { name, age } = MyStruct.fields
const Picked = Schema.Struct({ name, age })
```

## Schema.transformOrFail → v4

```typescript
// v3
Schema.transformOrFail(FromSchema, ToSchema, {
  decode: (from, _, ast) => ...,
  encode: (to) => ...,
})

// v4 — two-step: decode with FromSchema, then transform result
// Often simpler to just do a two-step decode:
const decoded = yield* Schema.decodeEffect(FromSchema)(raw)
const result = transformToTarget(decoded)
```

## Schema.disableValidation

Removed in v4. Just remove the `{ disableValidation: true }` option from `new MySchemaClass(...)` calls.

## HttpApi Changes

```typescript
// v3 — chained mutation
HttpApiEndpoint.get("getUser").pipe(
  HttpApiEndpoint.setPath("/users/:id"),
  HttpApiEndpoint.setUrlParams(Schema.Struct({ q: Schema.String })),
  HttpApiEndpoint.addSuccess(UserSchema),
  HttpApiEndpoint.addError(NotFoundError),
)

// v4 — inline options at construction
HttpApiEndpoint.get("getUser", "/users/:id", {
  params: { id: Schema.String },
  query: { q: Schema.String },
  success: UserSchema,
  error: NotFoundError,
})

// v3 — HttpApiSchema.annotate({ status: 201 })
// v4 — HttpApiSchema.status(201), or { httpApiStatus: 201 } in TaggedErrorClass
HttpApiSchema.status(201)
// Pre-built: HttpApiSchema.Created, HttpApiSchema.NoContent

// v3 — HttpApiBuilder.api(api)
// v4 — HttpApiBuilder.layer(api)

// v3 — HttpApiScalar.layer()
// v4 — HttpApiScalar.layer(api) (api arg required)

// v3 — { path: { id } } in handler
// v4 — { params: { id } } in handler

// v3 — { urlParams: { q } } in handler
// v4 — { query: { q } } in handler
```

## HttpServer.serve (v4 pattern)

```typescript
// v3
const HttpLive = ApiLive.pipe(
  Layer.provideMerge(HttpServer.serve(middleware)),
  Layer.provide(BunHttpServer.layer({ port })),
)

// v4 — serve takes (middleware)(httpEffect), need HttpRouter.toHttpEffect
const HttpLive = Layer.unwrap(
  HttpRouter.toHttpEffect(AppLayer).pipe(
    Effect.map((httpApp) =>
      HttpServer.serve(middleware)(httpApp).pipe(
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port })),
      ),
    ),
  ),
)
// Provide Etag.layer, HttpPlatform.layer, BunServices.layer at launch
```

## HttpClientResponse.value

```typescript
// v3 — HttpApiClient returns wrapper with .value
const result = yield* client.getUser({ id })
console.log(result.value)

// v4 — returns decoded value directly
const result = yield* client.getUser({ id })
console.log(result)  // IS the value
```

## CLI Testing

```typescript
// v3 — cli(process.argv)
// v4 — Command.runWith for testing with explicit args
const cli = Command.runWith(command, { version: "test" })
const exit = await Effect.runPromiseExit(
  cli(["--flag", "value"]).pipe(
    Effect.provide(testLayer),
    Effect.provide(BunServices.layer),  // provides Stdio, FileSystem, etc.
    Effect.provide(Logger.layer([])),   // suppress logs
  ),
)
```

## ConfigProvider Caching

`ConfigProvider.fromEnv()` caches values at first read. For test isolation with per-test env vars, create a fresh provider:

```typescript
const provider = ConfigProvider.make(
  (path) => Effect.succeed(
    path.join("_") === "MY_CONFIG" ? ConfigProvider.makeValue(value) : undefined,
  ),
)
const TestLayer = Layer.fresh(MyService.Default).pipe(
  Layer.provide(BunServices.layer),
  Layer.provide(ConfigProvider.layer(provider)),
)
```

## LSP Plugin Config

```jsonc
"plugins": [{
  "name": "@effect/language-service",
  "transform": "@effect/language-service/transform",
  "namespaceImportPackages": ["effect", "@effect/*"],
  "diagnostics": true,
  "diagnosticsName": true,
  "ignoreEffectWarningsInTscExitCode": true,
  "diagnosticSeverity": { /* ... */ }
}]
```

Key: `ignoreEffectWarningsInTscExitCode: true` prevents LSP warnings (importFromBarrel, strictEffectProvide) from making `tsc` exit non-zero. Without this, CI/pre-commit hooks fail on warnings.

Per-file suppression:
```typescript
// @effect-diagnostics nodeBuiltinImport:off            (rest of file)
// @effect-diagnostics-next-line strictEffectProvide:off (single line)
```

## Structural Changes

### Cause is Flat
```typescript
// v3: Recursive tree (Fail, Die, Sequential, Parallel, ...)
// v4: Flat { reasons: Reason[] } where Reason = Fail | Die | Interrupt
// Cause.isEmpty(cause) → cause.reasons.length === 0
```

### Transactions (NEW)
```typescript
import { Effect, TxRef } from "effect"

const ref = yield* TxRef.make(0)
yield* Effect.atomic(Effect.gen(function* () {
  yield* TxRef.update(ref, (n) => n + 1)
}))
// Effect.atomic — composable with parent transactions
// Effect.transaction — always isolated
```

### Effect Subtyping → Yieldable
```typescript
// v3: Effect subtypes (Layer, Stream, etc.) are Effects
// v4: They implement Yieldable protocol instead
// Impact: yield* still works, but type narrowing may differ
// Config is Yieldable but NOT Effect — can't pipe with Effect.* combinators
```

## Migration Strategy

1. **Dependencies first** — update `package.json`, `bun install`
2. **Import rewrites** — mechanical find/replace (~50 files typical)
3. **API renames** — use the table above (~200 call sites typical)
4. **Typecheck-driven** — `tsc --noEmit 2>&1 | grep "error TS" | sort | uniq -c | sort -rn`
5. **Build + smoke test** — verify runtime behavior after types pass
6. **Fix runtime crashes** — some v4 changes are runtime-only (e.g. `Argument.variadic()` needing parens)

## Full Migration Guides

Fetch the effect-smol repo for detailed per-topic guides:

```bash
repo fetch effect-ts/effect-smol
```

Then read files in `$(repo path -q effect-ts/effect-smol)/migration/`:
- `services.md` — Context.Tag → ServiceMap.Service
- `error-handling.md` — catch* renames
- `forking.md` — fork renames
- `fiberref.md` — FiberRef → References
- `cause.md` — flattened Cause
- `runtime.md` — Runtime<R> removal
- `scope.md` — Scope changes
- `yieldable.md` — Effect subtyping changes
- `schema.md` — Schema v4 migration (optionalWith, transforms, filters)
- `generators.md` — Effect.gen self binding

Schema v4 full docs: `$(repo path -q effect-ts/effect-smol)/packages/effect/SCHEMA.md`
