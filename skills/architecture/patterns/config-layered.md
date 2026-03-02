# Layered Config Pattern

Priority-based configuration: project > user > remote. Predictable merge semantics.

## Config Hierarchy

```
┌─────────────────────────────────┐
│     Project Config (highest)    │  ./app.config.json
├─────────────────────────────────┤
│     User Config (middle)        │  ~/.config/app/config.json
├─────────────────────────────────┤
│     Remote Config (lowest)      │  https://api.org/config
└─────────────────────────────────┘
```

## Config Schema

```typescript
import { Schema as S } from "effect"

const PluginConfigSchema = S.Struct({
  name: S.String,
  enabled: S.optional(S.Boolean, { default: () => true }),
  options: S.optional(S.Record({ key: S.String, value: S.Unknown })),
})

const AppConfigSchema = S.Struct({
  // Scalar values - higher priority wins
  model: S.optional(S.String),
  temperature: S.optional(S.Number),
  maxTokens: S.optional(S.Number),

  // Arrays - concatenate
  plugins: S.optional(S.Array(S.Union(S.String, PluginConfigSchema))),
  allowedTools: S.optional(S.Array(S.String)),

  // Objects - deep merge
  providers: S.optional(
    S.Record({
      key: S.String,
      value: S.Struct({
        apiKey: S.optional(S.String),
        baseUrl: S.optional(S.String),
        models: S.optional(S.Array(S.String)),
      }),
    })
  ),

  // Feature flags
  features: S.optional(
    S.Struct({
      streaming: S.optional(S.Boolean),
      tools: S.optional(S.Boolean),
      multimodal: S.optional(S.Boolean),
    })
  ),
})

type AppConfig = S.Schema.Type<typeof AppConfigSchema>
```

## Config Service

```typescript
import { Context, Effect, Layer, Config as EffectConfig } from "effect"
import { FileSystem } from "@effect/platform"

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly get: () => Effect.Effect<AppConfig>
    readonly reload: () => Effect.Effect<AppConfig>
  }
>() {
  static Live = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      let cached: AppConfig | null = null

      const loadConfig = () =>
        Effect.gen(function* () {
          // Load from all sources
          const [remote, user, project] = yield* Effect.all([
            loadRemoteConfig(),
            loadUserConfig(fs),
            loadProjectConfig(fs),
          ])

          // Merge with priority
          const merged = mergeConfigs(remote, user, project)

          // Validate
          const validated = yield* S.decodeUnknown(AppConfigSchema)(merged)

          cached = validated
          return validated
        })

      return ConfigService.of({
        get: () => (cached ? Effect.succeed(cached) : loadConfig()),
        reload: () => loadConfig(),
      })
    })
  )
}
```

## Config Loaders

```typescript
const loadRemoteConfig = () =>
  Effect.gen(function* () {
    const orgUrl = yield* EffectConfig.string("ORG_CONFIG_URL").pipe(
      EffectConfig.withDefault("")
    )

    if (!orgUrl) return {}

    const response = yield* Effect.tryPromise(() =>
      fetch(orgUrl).then((r) => r.json())
    ).pipe(
      Effect.catchAll(() => Effect.succeed({})),
      Effect.timeout("5 seconds"),
      Effect.catchAll(() => Effect.succeed({}))
    )

    return response as Partial<AppConfig>
  })

const loadUserConfig = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const home = yield* EffectConfig.string("HOME")
    const configPath = `${home}/.config/app/config.json`

    const exists = yield* fs.exists(configPath)
    if (!exists) return {}

    const content = yield* fs.readFileString(configPath)
    return JSON.parse(content) as Partial<AppConfig>
  }).pipe(Effect.catchAll(() => Effect.succeed({})))

const loadProjectConfig = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const cwd = yield* EffectConfig.string("PWD")

    // Search up directory tree
    const configNames = ["app.config.json", ".apprc.json", ".apprc"]
    let dir = cwd

    while (dir !== "/") {
      for (const name of configNames) {
        const configPath = `${dir}/${name}`
        const exists = yield* fs.exists(configPath)
        if (exists) {
          const content = yield* fs.readFileString(configPath)
          return JSON.parse(content) as Partial<AppConfig>
        }
      }
      dir = yield* Effect.sync(() => require("path").dirname(dir))
    }

    return {}
  }).pipe(Effect.catchAll(() => Effect.succeed({})))
```

## Merge Semantics

```typescript
type MergeStrategy = "replace" | "concat" | "deep"

const fieldStrategies: Record<keyof AppConfig, MergeStrategy> = {
  model: "replace",
  temperature: "replace",
  maxTokens: "replace",
  plugins: "concat",
  allowedTools: "concat",
  providers: "deep",
  features: "deep",
}

function mergeConfigs(...configs: Partial<AppConfig>[]): Partial<AppConfig> {
  const result: Partial<AppConfig> = {}

  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) continue

      const strategy = fieldStrategies[key as keyof AppConfig] ?? "replace"

      switch (strategy) {
        case "replace":
          result[key as keyof AppConfig] = value as any
          break

        case "concat":
          const existing = result[key as keyof AppConfig] as unknown[] ?? []
          result[key as keyof AppConfig] = [...existing, ...(value as unknown[])] as any
          break

        case "deep":
          result[key as keyof AppConfig] = deepMerge(
            result[key as keyof AppConfig] ?? {},
            value
          ) as any
          break
      }
    }
  }

  return result
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key as keyof T] = deepMerge(
        (result[key as keyof T] ?? {}) as object,
        value
      ) as any
    } else if (value !== undefined) {
      result[key as keyof T] = value as any
    }
  }

  return result
}
```

## Example Configs

```json
// Remote: ~/.config/app/org-defaults.json (fetched from org URL)
{
  "model": "claude-3-sonnet",
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com"
    }
  },
  "features": {
    "streaming": true
  }
}

// User: ~/.config/app/config.json
{
  "model": "claude-3-opus",
  "plugins": ["@company/custom-tools"],
  "providers": {
    "anthropic": {
      "apiKey": "sk-..."
    }
  }
}

// Project: ./app.config.json
{
  "maxTokens": 4096,
  "plugins": ["./local-plugin.ts"],
  "allowedTools": ["read", "write", "bash"],
  "features": {
    "multimodal": true
  }
}

// Merged result:
{
  "model": "claude-3-opus",           // User overrides remote
  "maxTokens": 4096,                  // Project sets
  "plugins": [                        // Concatenated
    "@company/custom-tools",
    "./local-plugin.ts"
  ],
  "allowedTools": ["read", "write", "bash"],
  "providers": {                      // Deep merged
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-..."
    }
  },
  "features": {                       // Deep merged
    "streaming": true,
    "multimodal": true
  }
}
```

## Environment Variable Override

```typescript
const applyEnvOverrides = (config: AppConfig): Effect.Effect<AppConfig> =>
  Effect.gen(function* () {
    const overrides: Partial<AppConfig> = {}

    // APP_MODEL=claude-3-opus
    const model = yield* EffectConfig.string("APP_MODEL").pipe(
      EffectConfig.option
    )
    if (model._tag === "Some") overrides.model = model.value

    // APP_MAX_TOKENS=8192
    const maxTokens = yield* EffectConfig.number("APP_MAX_TOKENS").pipe(
      EffectConfig.option
    )
    if (maxTokens._tag === "Some") overrides.maxTokens = maxTokens.value

    // APP_PLUGINS=plugin1,plugin2
    const plugins = yield* EffectConfig.string("APP_PLUGINS").pipe(
      EffectConfig.option
    )
    if (plugins._tag === "Some") {
      overrides.plugins = plugins.value.split(",").map((p) => p.trim())
    }

    return mergeConfigs(config, overrides) as AppConfig
  })
```

## Config Watch (Hot Reload)

```typescript
const watchConfig = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const config = yield* ConfigService
    const bus = yield* BusService
    const cwd = yield* EffectConfig.string("PWD")

    const configPath = `${cwd}/app.config.json`

    yield* fs.watch(configPath).pipe(
      Stream.tap(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Config changed, reloading...")
          const newConfig = yield* config.reload()
          yield* bus.publish(Events.ConfigReloaded, newConfig)
        })
      ),
      Stream.runDrain,
      Effect.fork
    )
  })
```

## Key Benefits

1. **Predictable**: Clear priority order, documented merge rules
2. **Flexible**: Orgs set defaults, users customize, projects override
3. **Type-safe**: Schema validation catches errors early
4. **Extensible**: Add new config sources without changing consumers
5. **Hot reload**: Watch for changes, emit events

## Best Practices

1. **Document merge strategy**: Make it clear which fields concat vs replace
2. **Validate early**: Schema check on load, not on use
3. **Sensible defaults**: Every field should work without config
4. **Env override**: Always allow env vars for CI/CD
5. **Watch sparingly**: Only watch project config, not user/remote
