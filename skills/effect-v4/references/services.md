# Services

Effect v4 service patterns using `Context.Service`.

## Canonical Pattern: Context.Service with Static Layers

```typescript
import { Context, Effect, Layer, Ref } from "effect"

// Function style (anonymous service)
const Database = Context.Service<{
  readonly query: (sql: string) => Effect.Effect<string, DbError>
}>("Database")

// Class style (named service)
class FileService extends Context.Service<FileService, {
  readonly readFile: (path: string) => Effect.Effect<string, FileError>
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, FileError>
}>()("FileService") {
  // Production — note: "layer" not "Live"
  static layer = Layer.succeed(FileService, {
    readFile: (path) =>
      Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (e) => new FileError({ path, cause: String(e) }),
      }),
    writeFile: (path, content) =>
      Effect.tryPromise({
        try: () => Bun.write(path, content),
        catch: (e) => new FileError({ path, cause: String(e) }),
      }).pipe(Effect.asVoid),
  })

  // Test — note: "layerTest" not "Test"
  static layerTest = (files: Record<string, string> = {}) =>
    Layer.effect(
      FileService,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(Object.entries(files)))
        return {
          readFile: (path) =>
            Ref.get(store).pipe(
              Effect.flatMap((m) =>
                m.has(path)
                  ? Effect.succeed(m.get(path)!)
                  : Effect.fail(new FileError({ path, cause: "Not found" }))
              )
            ),
          writeFile: (path, content) =>
            Ref.update(store, (m) => new Map([...m, [path, content]])),
        }
      })
    )

  static layerNoop = Layer.succeed(FileService, {
    readFile: () => Effect.succeed(""),
    writeFile: () => Effect.void,
  })
}
```

## Context.Service with `make` Option

v4 supports inline `make` for auto-generating Layer:

```typescript
class Logger extends Context.Service<Logger>()("Logger", {
  make: Effect.gen(function* () {
    const config = yield* AppConfig
    return {
      log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`),
    }
  })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(AppConfig.layer)
  )
}
```

## Context.Reference (replaces FiberRef/Context.Reference)

Fiber-local state with a default value:

```typescript
import { Context, Effect } from "effect"

const CurrentLogLevel = Context.Reference<"info" | "warn" | "error">(
  "CurrentLogLevel",
  { defaultValue: () => "info" as const }
)

const program = Effect.gen(function* () {
  const level = yield* CurrentLogLevel // reads current fiber-local value
  yield* Effect.log(`Level: ${level}`)
})

// Override for a scope
const withDebug = Effect.provideService(program, CurrentLogLevel, "warn")
```

## CLI Option Service (option → config → prompt fallback)

Same pattern as v3, adapted for Context.Service:

```typescript
class OrgService extends Context.Service<OrgService, {
  readonly get: () => Effect.Effect<string, ConfigError | ApiError>
}>()("OrgService") {
  static make = (orgOption: Option.Option<string>) =>
    Layer.effect(OrgService, Effect.gen(function* () {
      const api = yield* SentryApi
      const cache = yield* Ref.make<Option.Option<string>>(Option.none())

      return {
        get: () => Effect.gen(function* () {
          const cached = yield* Ref.get(cache)
          if (Option.isSome(cached)) return cached.value

          const value = Option.getOrUndefined(orgOption)
          if (value) {
            yield* Ref.set(cache, Option.some(value))
            return value
          }

          const orgs = yield* api.listOrganizations()
          const selected = orgs[0].slug
          yield* Ref.set(cache, Option.some(selected))
          return selected
        })
      }
    }))

  static layerTest = (org: string) =>
    Layer.succeed(OrgService, {
      get: () => Effect.succeed(org)
    })
}
```

## v3 → v4 Service Migration

| v3 | v4 |
|----|----|
| `Context.Tag("id")<Self, Shape>()` | `Context.Service<Self, Shape>()("id")` |
| `Context.GenericTag<Shape>("id")` | `Context.Service<Shape>("id")` |
| `static Live = ...` | `static layer = ...` |
| `static Test = ...` | `static layerTest = ...` |
| `Context.make(tag, impl)` | `Context.make(tag, impl)` (same module name, new semantics) |
| `Context.get(ctx, tag)` | `Context.get(ctx, tag)` (unchanged) |
| `FiberRef` / `Context.Reference` (v3) | `Context.Reference` |

## Layer Quick Reference

| Constructor | When |
|-------------|------|
| `Layer.succeed(tag, value)` | Sync value, no deps |
| `Layer.sync(tag, () => value)` | Lazy sync, no deps |
| `Layer.effect(tag, effect)` | Async/effectful (auto-strips Scope in v4) |
| `Layer.merge(a, b)` | Combine independent layers |
| `Layer.provide(target, dep)` | Wire dep into target |
| `Layer.provideMerge(target, dep)` | Wire + keep dep in output |
| `Layer.mergeAll(a, b, c)` | Combine many layers |
| `Layer.launch(layer)` | Run as long-lived service |

Note: `Layer.scoped` is mostly replaced by `Layer.effect` in v4 (auto Scope handling).

## ManagedRuntime

Same as v3. Use when calling Effect from non-Effect code:

```typescript
const runtime = ManagedRuntime.make(
  Layer.mergeAll(UserService.layer, DatabaseService.layer)
)

const user = await runtime.runPromise(
  Effect.gen(function* () {
    const svc = yield* UserService
    return yield* svc.getUser("123")
  })
)

await runtime.dispose()
```
