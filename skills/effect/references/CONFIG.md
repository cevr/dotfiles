# Configuration

`Config<A>` is a typed recipe interpreted by the active `ConfigProvider`. Read config while constructing layers so application logic receives validated values rather than environment access.

## Define and load

```ts
import { Config, Context, Effect, Layer, Redacted } from "effect"

const AppConfigValue = Config.all({
  port: Config.number("PORT").pipe(Config.withDefault(3000)),
  apiKey: Config.redacted("API_KEY"),
  timeoutMs: Config.number("TIMEOUT_MS").pipe(Config.withDefault(5_000))
})

class AppConfig extends Context.Service<AppConfig, {
  readonly port: number
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
}>()("@acme/app/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.map(AppConfigValue, AppConfig.of)
  )
}
```

- Use `Config.nested(...)` for grouped namespaces.
- Use `Config.option(...)` only when absence is meaningful to the domain.
- Keep secrets as `Redacted` until the adapter must unwrap them.
- Use `Config.schema(codec, path)` when a schema owns the shape or refinement.

## Providers

Install a provider at the composition root:

```ts
import { ConfigProvider } from "effect"

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    PORT: 8080,
    API_KEY: "test-key",
    TIMEOUT_MS: 25
  })
)
```

- `ConfigProvider.fromEnv(...)` reads environment variables.
- `ConfigProvider.fromUnknown(...)` is the default deterministic test provider.
- `ConfigProvider.layer(provider)` replaces the active provider downstream.
- `ConfigProvider.layerAdd(provider)` composes fallback or override values with the active provider.

Prefer provider replacement in tests over mutating `process.env`. Build a fresh service layer when a test needs a distinct config snapshot.

## Boundary

Translate configuration failures only at the executable boundary where a human-facing startup message can be added. Preserve the typed config error underneath so the missing path and parse failure remain observable.
