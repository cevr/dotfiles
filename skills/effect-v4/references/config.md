# Config

Effect v4 configuration patterns. Largely unchanged from v3.

## Primitives

```typescript
import { Config, Redacted } from "effect"

const port = Config.number("PORT")
const host = Config.string("HOST")
const debug = Config.boolean("DEBUG")
const secret = Config.redacted("API_KEY")
```

## Composition

```typescript
const port = Config.withDefault(Config.number("PORT"), 3000)
const debugFlag = Config.option(Config.boolean("DEBUG"))
const dbConfig = Config.all({
  host: Config.string("HOST"),
  port: Config.number("PORT"),
  name: Config.string("NAME"),
}).pipe(Config.nested("DB"))
```

## Config in Services (v4 naming)

```typescript
import { Context, Layer, Effect, Config, Redacted } from "effect"

class AppConfig extends Context.Service<AppConfig, {
  readonly port: number
  readonly host: string
  readonly apiKey: Redacted.Redacted<string>
}>()("AppConfig") {
  static layer = Layer.effect(
    AppConfig,
    Effect.all({
      port: Config.withDefault(Config.number("PORT"), 3000),
      host: Config.withDefault(Config.string("HOST"), "localhost"),
      apiKey: Config.redacted("API_KEY"),
    })
  )

  static layerTest = (overrides: Partial<{ port: number; host: string }> = {}) =>
    Layer.succeed(AppConfig, {
      port: overrides.port ?? 8080,
      host: overrides.host ?? "test-host",
      apiKey: Redacted.make("test-key"),
    })
}
```

## ConfigProvider

```typescript
import { ConfigProvider, Layer } from "effect"

// From map (testing)
const testProgram = program.pipe(
  Effect.provide(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["PORT", "8080"]]))
    )
  )
)

// From JSON
const fromJson = ConfigProvider.fromJson({ PORT: 3000, DB: { HOST: "localhost" } })
```

## Redacted

```typescript
const secret = yield* Config.redacted("API_KEY")
const rawKey = Redacted.value(secret)  // unwrap only when needed
yield* Effect.log(`Key: ${secret}`)    // logs: Key: <redacted>
```

## Quick Reference

Same as v3. No API changes to Config or ConfigProvider in v4.
