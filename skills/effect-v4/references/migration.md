# v3 → v4 Migration

Condensed diff for migrating Effect v3 codebases to v4.

## Package Changes

- All `@effect/*` packages share a single version number with `effect`
- Many packages merged into `effect` under `effect/unstable/*` paths
- Platform-specific packages remain separate (`@effect/platform-bun`, etc.)

## Import Rewrite Table

| v3 | v4 |
|----|----|
| `import { HttpClient } from "@effect/platform"` | `import { HttpClient } from "effect/unstable/http"` |
| `import { HttpApi, HttpApiBuilder } from "@effect/platform"` | `import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"` |
| `import { Rpc, RpcGroup } from "@effect/rpc"` | `import { Rpc, RpcGroup } from "effect/unstable/rpc"` |
| `import { Command } from "@effect/cli"` | `import { Command } from "effect/unstable/cli"` |
| `import { SqlClient } from "@effect/sql"` | `import { SqlClient } from "effect/unstable/sql"` |
| `import { Socket } from "@effect/platform"` | `import { Socket } from "effect/unstable/socket"` |
| `import { BunContext } from "@effect/platform-bun"` | `import { BunServices } from "@effect/platform-bun"` |
| `import { NodeContext } from "@effect/platform-node"` | `import { NodeServices } from "@effect/platform-node"` |

## Mechanical Rename Table

| v3 | v4 | Category |
|----|----|----|
| `Context.Tag("id")<Self, Shape>()` | `ServiceMap.Service<Self, Shape>()("id")` | Services |
| `Context.GenericTag<Shape>("id")` | `ServiceMap.Service<Shape>("id")` | Services |
| `static Live` | `static layer` | Convention |
| `static Test` | `static layerTest` | Convention |
| `Either` | `Result` | Data |
| `Either.right(v)` | `Result.succeed(v)` | Data |
| `Either.left(e)` | `Result.fail(e)` | Data |
| `Either.isRight` | `Result.isSuccess` | Data |
| `Either.isLeft` | `Result.isFailure` | Data |
| `FiberRef` | `ServiceMap.Reference` / `References.*` | State |
| `Effect.fork` | `Effect.forkChild` | Forking |
| `Effect.forkDaemon` | `Effect.forkDetach` | Forking |
| `Effect.catchAll` | `Effect.catch` | Errors |
| `Effect.catchAllCause` | `Effect.catchCause` | Errors |
| `Effect.catchAllDefect` | `Effect.catchDefect` | Errors |
| `Effect.catchSome` | `Effect.catchIf` | Errors |
| `Effect.catchSomeCause` | `Effect.catchCauseIf` | Errors |
| `Effect.ignore` | `Effect.ignore` (unchanged; gains `{ log }` option) | Errors |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` | Schema |
| `.annotations({...})` | `.annotate({...})` | Schema |
| `.pipe(Schema.int())` | `.check(Schema.isInt())` | Schema |
| `Schema.Literal("a","b")` | `Schema.Literals(["a","b"])` | Schema |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` | Schema |
| `Schema.decodeUnknown(S)` | `Schema.decodeUnknownEffect(S)` | Schema |
| `Schema.encodeUnknown(S)` | `Schema.encodeUnknownEffect(S)` | Schema |
| `Schema.parseJson(S)` | `Schema.fromJsonString(S)` | Schema |
| `Schema.Record({ key: K, value: V })` | `Schema.Record(K, V)` | Schema |
| `decodeUnknownEither` | `decodeUnknownResult` | Schema |
| `ParseResult.ParseError` | `Schema.SchemaError` | Schema |
| `Option.fromNullable(v)` | `Option.fromNullishOr(v)` | Option |
| `Args.text({ name: "x" })` | `Argument.string("x")` | CLI |
| `Options.text("name")` | `Flag.string("name")` | CLI |
| `Options.withAlias` / `withDescription` / `optional` | `Flag.withAlias` / `withDescription` / `Flag.optional` | CLI |
| `Command.run(cmd, { name, version })` | `Command.run(cmd, { version })` (args from Stdio) | CLI |
| `Layer.setConfigProvider(ConfigProvider.fromMap(...))` | `ConfigProvider.layer(ConfigProvider.fromUnknown(...))` | Config |
| `Effect.gen(this, fn)` | `Effect.gen({ self: this }, fn)` | Generator |
| `BunContext.layer` | `BunServices.layer` | Platform |
| `NodeContext.layer` | `NodeServices.layer` | Platform |
| `Runtime<R>` | Removed; use `ServiceMap<R>` | Runtime |
| `Layer.scoped(tag, eff)` | Removed → `Layer.effect(tag, eff)` (auto-strips Scope) | Layer |

## Structural Changes

### Cause is Flat
```typescript
// v3: Recursive tree (Fail, Die, Sequential, Parallel, ...)
// v4: Flat { reasons: Reason[] } where Reason = Fail | Die | Interrupt
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
```

## Top Gotchas

1. **`ServiceMap` not `Effect` for service definitions** — `ServiceMap.Service`, not `Effect.Service`
2. **`.annotations` → `.annotate`** — Schema method renamed
3. **`catchAll` → `catch`** — watch for this in every error handler
4. **`catchSome` → `catchIf`** — and `catchSomeCause` → `catchCauseIf`
5. **`fork` → `forkChild`** — and `forkDaemon` → `forkDetach`
6. **`Either` → `Result`** — everywhere, including Schema decode returns
7. **Import paths** — `@effect/platform` → `effect/unstable/http` etc.
8. **`Layer.scoped` removed** — use `Layer.effect` which auto-strips `Scope`
9. **`Effect.ignore` expanded** — still exists but now accepts `{ log?: boolean | Severity }` option
10. **Config is Yieldable but not Effect** — `Config.pipe(Effect.orDie)` breaks; use `yield* config` directly or `Effect.orDie(Effect.gen(function*() { return yield* config }))`
11. **`Effect.flatMap(ServiceTag, fn)` removed** — use `Effect.gen` + `yield* ServiceTag` instead
12. **`FileSystem`, `Path` moved to `effect`** — no longer from `@effect/platform`
13. **`FetchHttpClient` from `effect/unstable/http`** — not `@effect/platform`
14. **`@effect/language-service` has no v4 beta** — keep at `^0.79.0`, it's a transitive dep of effect
15. **CLI `Command.run` reads args from `Stdio`** — no longer pass `process.argv`; `BunServices`/`NodeServices` provide `Stdio`

## Full Migration Guides

For detailed per-topic guides, read files in `~/.claude/repos/Effect-TS/effect-smol/migration/`:
- `services.md` — Context.Tag → ServiceMap.Service
- `error-handling.md` — catch* renames
- `forking.md` — fork renames
- `fiberref.md` — FiberRef → References
- `cause.md` — flattened Cause
- `runtime.md` — Runtime<R> removal
- `scope.md` — Scope changes
- `yieldable.md` — Effect subtyping changes

Schema v4 full guide: `~/.claude/repos/Effect-TS/effect-smol/packages/effect/SCHEMA.md`
