# Services

Effect v3 service patterns using `Context.Tag`.

## Canonical Pattern: Context.Tag with Static Layers

```typescript
import { Context, Effect, Layer, Ref } from "effect"

// 1. Define shape
export interface FileServiceShape {
  readonly readFile: (path: string) => Effect.Effect<string, FileError>
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, FileError>
}

// 2. Define tag with static layers
export class FileService extends Context.Tag("FileService")<
  FileService,
  FileServiceShape
>() {
  // Production implementation
  static Live = Layer.succeed(FileService, {
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

  // Test implementation — in-memory
  static Test = (files: Record<string, string> = {}) =>
    Layer.effect(
      FileService,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(Object.entries(files)))
        return FileService.of({
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
        })
      })
    )

  // Noop — for when you don't care about the output
  static Noop = Layer.succeed(FileService, {
    readFile: () => Effect.succeed(""),
    writeFile: () => Effect.void,
  })
}
```

## CLI Option Service (option → config → prompt fallback)

For required CLI options, create services that resolve via fallback chain and cache the result.

```typescript
export class OrgService extends Context.Tag("OrgService")<
  OrgService,
  { readonly get: () => Effect.Effect<string, ConfigError | ApiError | Terminal.QuitException, Terminal.Terminal> }
>() {
  static make = (orgOption: Option.Option<string>) =>
    Layer.effect(OrgService, Effect.gen(function* () {
      const api = yield* SentryApi
      const config = yield* SentryConfig
      const cache = yield* Ref.make<Option.Option<string>>(Option.none())

      return OrgService.of({
        get: () => Effect.gen(function* () {
          const cached = yield* Ref.get(cache)
          if (Option.isSome(cached)) return cached.value

          // 1. CLI option
          // 2. Config file
          const value = Option.getOrUndefined(orgOption)
            ?? Option.getOrUndefined(config.defaultOrg)
          if (value) {
            yield* Ref.set(cache, Option.some(value))
            return value
          }

          // 3. Interactive prompt
          if (!process.stdout.isTTY) {
            return yield* Effect.fail(new ConfigError({ message: "Org required" }))
          }

          const orgs = yield* api.listOrganizations()
          if (orgs.length === 1) {
            yield* Ref.set(cache, Option.some(orgs[0].slug))
            return orgs[0].slug
          }

          const selected = yield* Prompt.select({
            message: "Select organization",
            choices: orgs.map(o => ({ title: o.name, value: o.slug }))
          })
          yield* Ref.set(cache, Option.some(selected))
          return selected
        })
      })
    }))

  // Test — no prompting, returns fixed value
  static test = (org: string) =>
    Layer.succeed(OrgService, OrgService.of({
      get: () => Effect.succeed(org)
    }))
}
```

**Usage in commands:**

```typescript
export const myCommand = Command.make(
  "cmd",
  { org: orgOption },
  ({ org }) =>
    Effect.gen(function* () {
      const orgSlug = yield* (yield* OrgService).get()
      // ...
    }).pipe(Effect.provide(OrgService.make(org)))
)
```

## Dependent Layers

When ServiceB needs ServiceA:

```typescript
// Compose with Layer.provide
export const myCommand = Command.make(
  "cmd",
  { org: orgOption, project: projectOption },
  ({ org, project }) =>
    Effect.gen(function* () {
      const orgSlug = yield* (yield* OrgService).get()
      const projectSlug = yield* (yield* ProjectService).get()
    }).pipe(
      Effect.provide(
        Layer.merge(
          OrgService.make(org),
          Layer.provide(ProjectService.make(project), OrgService.make(org))
        )
      )
    )
)
```

## Layer Quick Reference

| Constructor | Use Case |
|-------------|----------|
| `Layer.succeed(tag, value)` | Sync value, no deps |
| `Layer.sync(tag, () => value)` | Lazy sync, no deps |
| `Layer.effect(tag, effect)` | Async/effectful construction |
| `Layer.scoped(tag, effect)` | Needs cleanup (Scope) |
| `Layer.merge(a, b)` | Combine independent layers |
| `Layer.provide(target, dep)` | Wire dep into target |
| `Layer.provideMerge(target, dep)` | Wire + keep dep in output |
| `Layer.mergeAll(a, b, c)` | Combine many layers |
| `Layer.launch(layer)` | Run as long-lived service |

## ManagedRuntime for Non-Effect Contexts

When you need to call Effect from non-Effect code (React, Express, etc.):

```typescript
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    UserService.Live,
    DatabaseService.Live,
  )
)

// In non-Effect code
const user = await runtime.runPromise(
  Effect.gen(function* () {
    const svc = yield* UserService
    return yield* svc.getUser("123")
  })
)

// Cleanup
await runtime.dispose()
```
