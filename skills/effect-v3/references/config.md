# Config

Effect v3 configuration patterns.

## Primitives

```typescript
import { Config } from "effect"

const port = Config.number("PORT")                    // number
const host = Config.string("HOST")                    // string
const debug = Config.boolean("DEBUG")                 // boolean
const secret = Config.redacted("API_KEY")             // Redacted<string>
```

## Composition

```typescript
// Optional with default
const port = Config.withDefault(Config.number("PORT"), 3000)

// Optional (returns Option)
const debugFlag = Config.option(Config.boolean("DEBUG"))

// Nested (reads DB_HOST, DB_PORT, DB_NAME)
const dbConfig = Config.all({
  host: Config.string("HOST"),
  port: Config.number("PORT"),
  name: Config.string("NAME"),
}).pipe(Config.nested("DB"))

// Map/transform
const logLevel = Config.string("LOG_LEVEL").pipe(
  Config.map((s) => s.toUpperCase())
)
```

## Using Config in Effects

```typescript
const program = Effect.gen(function* () {
  const port = yield* Config.number("PORT")
  const secret = yield* Config.redacted("API_KEY")

  // Access redacted value
  const keyValue = Redacted.value(secret)
  // ...
})
```

## Config in Services

```typescript
export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  {
    readonly port: number
    readonly host: string
    readonly apiKey: Redacted.Redacted<string>
  }
>() {
  static Live = Layer.effect(
    AppConfig,
    Effect.all({
      port: Config.withDefault(Config.number("PORT"), 3000),
      host: Config.withDefault(Config.string("HOST"), "localhost"),
      apiKey: Config.redacted("API_KEY"),
    })
  )

  static Test = (overrides: Partial<{ port: number; host: string }> = {}) =>
    Layer.succeed(AppConfig, {
      port: overrides.port ?? 8080,
      host: overrides.host ?? "test-host",
      apiKey: Redacted.make("test-key"),
    })
}
```

## ConfigProvider

```typescript
import { ConfigProvider } from "effect"

// From env (default)
const fromEnv = ConfigProvider.fromEnv()

// From a map (testing)
const fromMap = ConfigProvider.fromMap(
  new Map([
    ["PORT", "3000"],
    ["DB_HOST", "localhost"],
  ])
)

// From JSON
const fromJson = ConfigProvider.fromJson({
  PORT: 3000,
  DB: { HOST: "localhost", PORT: 5432 },
})

// Override provider in tests
const testProgram = program.pipe(
  Effect.provide(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["PORT", "8080"]]))
    )
  )
)
```

## Redacted (secrets)

```typescript
import { Config, Redacted } from "effect"

const program = Effect.gen(function* () {
  const secret = yield* Config.redacted("API_KEY")

  // Redacted.value to access — only when needed
  const rawKey = Redacted.value(secret)

  // Redacted logs as "<redacted>" — safe to log
  yield* Effect.log(`Using key: ${secret}`) // logs: Using key: <redacted>

  // Create from raw string
  const manual = Redacted.make("my-secret")
})
```

## Quick Reference

| API | What |
|-----|------|
| `Config.string(name)` | String env var |
| `Config.number(name)` | Number env var |
| `Config.boolean(name)` | Boolean env var |
| `Config.redacted(name)` | Secret (Redacted<string>) |
| `Config.withDefault(config, val)` | Fallback value |
| `Config.option(config)` | Optional (Option) |
| `Config.nested(config, prefix)` | Prefix: `PREFIX_NAME` |
| `Config.all({ a, b })` | Combine configs |
| `Config.map(config, fn)` | Transform value |
| `ConfigProvider.fromMap(map)` | Test provider |
| `ConfigProvider.fromJson(obj)` | JSON provider |
| `Redacted.value(r)` | Unwrap secret |
| `Redacted.make(s)` | Create secret |
