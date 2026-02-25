# Configuration Management

Effect patterns for typed config, secrets, and fail-fast initialization.

## Decision Tree

```
Config source?
├─ Environment variables         → Config.string, Config.number, etc.
├─ Multiple env vars grouped     → Config.all({ ... })
├─ With defaults                 → Config.withDefault
├─ Optional value                → Config.option
├─ Sensitive value               → Config.redacted
└─ Nested config                 → Config.nested

Config usage?
├─ In layer initialization       → yield* Config.* in Layer.effect
├─ At app startup                → Effect.gen with Config.*
├─ Service-specific config       → dedicated config service
└─ Runtime-changeable            → Ref or config service
```

## Core Principle

**Config fails fast.** Missing or invalid config = startup failure, not runtime surprise. Use `Config.*` in layer initialization.

## Patterns

### 1. Config Primitives

```typescript
import { Config, Effect } from "effect"

// Basic types
const port = Config.number("PORT") // number
const host = Config.string("HOST") // string
const debug = Config.boolean("DEBUG") // boolean
const timeout = Config.duration("TIMEOUT") // Duration
const logLevel = Config.logLevel("LOG_LEVEL") // LogLevel
const url = Config.url("DATABASE_URL") // URL
const count = Config.integer("WORKER_COUNT") // integer (validated)

// Constrained
const portNumber = Config.number("PORT").pipe(
  Config.validate({
    message: "Port must be between 1 and 65535",
    validation: (n) => n >= 1 && n <= 65535,
  }),
)
```

### 2. Config.all - Grouped Config

```typescript
// Combine multiple config values
const DbConfig = Config.all({
  host: Config.string("DB_HOST"),
  port: Config.number("DB_PORT"),
  database: Config.string("DB_NAME"),
  username: Config.string("DB_USERNAME"),
  password: Config.redacted("DB_PASSWORD"),
})

// Use in Effect
Effect.gen(function* () {
  const config = yield* DbConfig
  // config.host, config.port, config.database, etc.
})
```

### 3. Config.redacted - Sensitive Values

```typescript
import { Config, Redacted } from "effect"

// Password won't appear in logs
const password = Config.redacted("DB_PASSWORD")

Effect.gen(function* () {
  const secret = yield* password
  // secret is Redacted<string>

  // Explicitly unwrap when needed
  const actualPassword = Redacted.value(secret)

  // Logging safe - shows "Redacted(<redacted>)"
  console.log(secret) // Safe
  console.log(actualPassword) // Dangerous!
})
```

### 4. Config.withDefault - Default Values

```typescript
const port = Config.number("PORT").pipe(Config.withDefault(3000))

const env = Config.string("NODE_ENV").pipe(Config.withDefault("development"))

const workers = Config.integer("WORKERS").pipe(Config.withDefault(4))
```

### 5. Config.option - Optional Values

```typescript
// Returns Option<T> instead of failing
const apiKey = Config.string("OPTIONAL_API_KEY").pipe(Config.option)

Effect.gen(function* () {
  const maybeKey = yield* apiKey
  // maybeKey is Option<string>

  if (Option.isSome(maybeKey)) {
    // Use the key
  }
})
```

### 6. Config.nested - Prefixed Config

```typescript
// Read DB_HOST, DB_PORT, DB_NAME
const dbConfig = Config.nested("DB")(
  Config.all({
    host: Config.string("HOST"),
    port: Config.number("PORT"),
    name: Config.string("NAME"),
  }),
)

// Read REDIS_HOST, REDIS_PORT
const redisConfig = Config.nested("REDIS")(
  Config.all({
    host: Config.string("HOST"),
    port: Config.number("PORT"),
  }),
)
```

### 7. Config in Layer Initialization

```typescript
// Database layer reads config at creation
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    // Config read here - fails fast if missing
    const config = yield* Config.all({
      host: Config.string("DB_HOST"),
      port: Config.number("DB_PORT"),
      database: Config.string("DB_NAME"),
      password: Config.redacted("DB_PASSWORD"),
    })

    const pool = yield* Effect.tryPromise(() =>
      createPool({
        host: config.host,
        port: config.port,
        database: config.database,
        password: Redacted.value(config.password),
      }),
    )

    yield* Effect.addFinalizer(() => Effect.sync(() => pool.end()))

    return { query: (sql) => Effect.tryPromise(() => pool.query(sql)) }
  }),
)

// If DB_HOST is missing, layer creation fails immediately
```

### 8. Config Service Pattern

For config needed across services:

```typescript
// Define config service
class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  {
    readonly port: number
    readonly env: string
    readonly logLevel: LogLevel
    readonly features: {
      readonly enableBeta: boolean
      readonly maxItems: number
    }
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      return {
        port: yield* Config.number("PORT").pipe(Config.withDefault(3000)),
        env: yield* Config.string("NODE_ENV").pipe(Config.withDefault("development")),
        logLevel: yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault(LogLevel.Info)),
        features: {
          enableBeta: yield* Config.boolean("ENABLE_BETA").pipe(Config.withDefault(false)),
          maxItems: yield* Config.integer("MAX_ITEMS").pipe(Config.withDefault(100)),
        },
      }
    }),
  )
}

// Use in other services
const SomeServiceLive = Layer.effect(
  SomeService,
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (config.features.enableBeta) {
      // ...
    }
  }),
)
```

### 9. Config Validation

```typescript
// Custom validation
const email = Config.string("ADMIN_EMAIL").pipe(
  Config.validate({
    message: "Must be a valid email",
    validation: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  }),
)

// Map to different type
const logLevel = Config.string("LOG_LEVEL").pipe(
  Config.map((s) => {
    switch (s.toLowerCase()) {
      case "debug":
        return LogLevel.Debug
      case "info":
        return LogLevel.Info
      case "warn":
        return LogLevel.Warning
      case "error":
        return LogLevel.Error
      default:
        return LogLevel.Info
    }
  }),
)

// Enum-like validation
const env = Config.literal("development", "staging", "production")("NODE_ENV")
```

### 10. Testing Config

```typescript
import { ConfigProvider, Layer } from "effect"

// Test config provider
const TestConfigProvider = ConfigProvider.fromMap(
  new Map([
    ["PORT", "4000"],
    ["DB_HOST", "localhost"],
    ["DB_PORT", "5432"],
    ["DB_NAME", "test_db"],
    ["DB_PASSWORD", "test_password"],
  ]),
)

// Use in tests
const TestConfig = Layer.setConfigProvider(TestConfigProvider)

it.effect("uses test config", () =>
  Effect.gen(function* () {
    const port = yield* Config.number("PORT")
    expect(port).toBe(4000)
  }).pipe(Effect.provide(TestConfig)),
)

// Override specific values
const TestConfigWithOverride = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["PORT", "5000"]]), { parent: TestConfigProvider }),
)
```

### 11. Config Error Handling

```typescript
// Config errors are typed
const program = Effect.gen(function* () {
  const port = yield* Config.number("PORT")
  return port
})

// Handle missing config
const withFallback = program.pipe(
  Effect.catchTag(
    "ConfigError",
    () => Effect.succeed(3000), // Fallback port
  ),
)

// Or let it fail fast (preferred for required config)
Effect.runPromise(program)
// Throws: ConfigError: Missing data at PORT
```

### 12. Secret Resolution Order

For credentials, prefer explicit resolution:

```typescript
const ApiKeyConfig = Config.string("API_KEY").pipe(
  Config.orElse(() => Config.string("FALLBACK_API_KEY")),
  Config.orElse(() => Config.fail("No API key configured")),
)

// Provider-specific keys
const ProviderApiKey = (provider: string) =>
  Config.string(`${provider.toUpperCase()}_API_KEY`).pipe(
    Config.orElse(() => Config.string("API_KEY")),
  )
```

## Environment File Loading

Effect doesn't load `.env` files automatically. Use a loader:

```typescript
// Load .env before running
import "dotenv/config"

// Or in Effect
const loadEnv = Effect.sync(() => {
  require("dotenv").config()
})

const main = loadEnv.pipe(Effect.flatMap(() => program))
```

## See Also

- `services.md` - config in layer initialization
- `errors.md` - config error handling
- `gotchas.md` - config precedence issues
