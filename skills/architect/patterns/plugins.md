# Plugin System Pattern

Hook-based extensibility without forking. Users customize auth, tools, events, etc.

## Plugin Interface

```typescript
import { Effect, Schema as S } from "effect"

// Plugin definition
export interface Plugin {
  readonly name: string
  readonly version: string
  readonly hooks?: PluginHooks
}

// Available hooks
export interface PluginHooks {
  // Authentication customization
  auth?: AuthHook
  // Event interception
  event?: EventHook
  // Tool registration/modification
  tools?: ToolsHook
  // Config transformation
  config?: ConfigHook
  // Lifecycle
  init?: InitHook
  shutdown?: ShutdownHook
}

// Hook type definitions
type AuthHook = (
  input: AuthInput
) => Effect.Effect<AuthOutput, AuthError>

type EventHook = (
  event: BusEvent
) => Effect.Effect<BusEvent | null> // null = suppress event

type ToolsHook = (
  tools: Tool[]
) => Effect.Effect<Tool[]>

type ConfigHook = (
  config: AppConfig
) => Effect.Effect<AppConfig>

type InitHook = () => Effect.Effect<void>

type ShutdownHook = () => Effect.Effect<void>
```

## Plugin Service

```typescript
import { Context, Effect, Layer, Ref } from "effect"

export class PluginService extends Context.Tag("PluginService")<
  PluginService,
  {
    readonly register: (plugin: Plugin) => Effect.Effect<void>
    readonly unregister: (name: string) => Effect.Effect<void>
    readonly trigger: <K extends keyof PluginHooks>(
      hook: K,
      input: Parameters<NonNullable<PluginHooks[K]>>[0],
      defaultFn: NonNullable<PluginHooks[K]>
    ) => Effect.Effect<ReturnType<NonNullable<PluginHooks[K]>>>
    readonly list: () => Effect.Effect<readonly Plugin[]>
  }
>() {
  static Live = Layer.effect(
    PluginService,
    Effect.gen(function* () {
      const plugins = yield* Ref.make<Map<string, Plugin>>(new Map())

      return PluginService.of({
        register: (plugin) =>
          Ref.update(plugins, (map) => new Map(map).set(plugin.name, plugin)),

        unregister: (name) =>
          Ref.update(plugins, (map) => {
            const updated = new Map(map)
            updated.delete(name)
            return updated
          }),

        trigger: (hook, input, defaultFn) =>
          Effect.gen(function* () {
            const registered = yield* Ref.get(plugins)

            // Chain through plugins that implement this hook
            let result = input
            for (const plugin of registered.values()) {
              const hookFn = plugin.hooks?.[hook]
              if (hookFn) {
                result = yield* (hookFn as any)(result)
                if (result === null) break // Hook suppressed
              }
            }

            // If no plugin handled it, use default
            if (result !== null) {
              return yield* (defaultFn as any)(result)
            }
            return result
          }),

        list: () => Ref.get(plugins).pipe(Effect.map((m) => [...m.values()])),
      })
    })
  )
}
```

## Usage: Auth Hook

```typescript
// Default auth implementation
const defaultAuth = (input: AuthInput): Effect.Effect<AuthOutput, AuthError> =>
  Effect.gen(function* () {
    const apiKey = yield* Config.string("API_KEY")
    return { token: apiKey, type: "bearer" }
  })

// In service that needs auth
const callApi = (request: ApiRequest) =>
  Effect.gen(function* () {
    const plugins = yield* PluginService

    // Trigger auth hook - plugins can override
    const auth = yield* plugins.trigger("auth", { request }, defaultAuth)

    return yield* httpClient.request({
      ...request,
      headers: { Authorization: `${auth.type} ${auth.token}` },
    })
  })

// Custom auth plugin
const oauthPlugin: Plugin = {
  name: "oauth-auth",
  version: "1.0.0",
  hooks: {
    auth: (input) =>
      Effect.gen(function* () {
        const tokens = yield* OAuthService
        const token = yield* tokens.getAccessToken()
        return { token, type: "Bearer" }
      }),
  },
}
```

## Usage: Tools Hook

```typescript
// Register custom tools via plugin
const customToolsPlugin: Plugin = {
  name: "custom-tools",
  version: "1.0.0",
  hooks: {
    tools: (existingTools) =>
      Effect.succeed([
        ...existingTools,
        {
          name: "deploy",
          description: "Deploy to production",
          schema: S.Struct({ env: S.Literal("staging", "production") }),
          execute: (input) => DeployService.deploy(input.env),
        },
        {
          name: "rollback",
          description: "Rollback last deployment",
          schema: S.Struct({}),
          execute: () => DeployService.rollback(),
        },
      ]),
  },
}

// Agent uses pluggable tools
const getTools = () =>
  Effect.gen(function* () {
    const plugins = yield* PluginService
    const builtInTools = yield* BuiltInTools

    return yield* plugins.trigger("tools", builtInTools, Effect.succeed)
  })
```

## Usage: Event Hook

```typescript
// Event filtering/transformation plugin
const auditPlugin: Plugin = {
  name: "audit-log",
  version: "1.0.0",
  hooks: {
    event: (event) =>
      Effect.gen(function* () {
        // Log all events to audit service
        yield* AuditService.log(event)

        // Filter sensitive events from certain subscribers
        if (event.type === "user.password_changed") {
          return null // Suppress from bus
        }

        return event
      }),
  },
}

// Redaction plugin
const redactPlugin: Plugin = {
  name: "redact-pii",
  version: "1.0.0",
  hooks: {
    event: (event) =>
      Effect.sync(() => {
        if ("email" in event.data) {
          return {
            ...event,
            data: { ...event.data, email: "[REDACTED]" },
          }
        }
        return event
      }),
  },
}
```

## Plugin Discovery

```typescript
// Load plugins from config
const loadPlugins = () =>
  Effect.gen(function* () {
    const config = yield* ConfigService
    const plugins = yield* PluginService

    for (const pluginPath of config.plugins) {
      const module = yield* Effect.tryPromise(() => import(pluginPath))
      const plugin = module.default as Plugin

      yield* plugins.register(plugin)
      yield* Effect.logInfo(`Loaded plugin: ${plugin.name}@${plugin.version}`)

      // Run init hook if present
      if (plugin.hooks?.init) {
        yield* plugin.hooks.init()
      }
    }
  })

// Graceful shutdown
const shutdownPlugins = () =>
  Effect.gen(function* () {
    const plugins = yield* PluginService
    const registered = yield* plugins.list()

    for (const plugin of registered) {
      if (plugin.hooks?.shutdown) {
        yield* plugin.hooks.shutdown().pipe(
          Effect.catchAll((e) =>
            Effect.logWarning(`Plugin ${plugin.name} shutdown error: ${e}`)
          )
        )
      }
    }
  })
```

## Plugin Schema Validation

```typescript
import { Schema as S } from "effect"

// Validate plugin structure
const PluginSchema = S.Struct({
  name: S.String.pipe(S.minLength(1)),
  version: S.String.pipe(S.pattern(/^\d+\.\d+\.\d+$/)),
  hooks: S.optional(
    S.Struct({
      auth: S.optional(S.Any),
      event: S.optional(S.Any),
      tools: S.optional(S.Any),
      config: S.optional(S.Any),
      init: S.optional(S.Any),
      shutdown: S.optional(S.Any),
    })
  ),
})

const validatePlugin = (plugin: unknown) =>
  S.decodeUnknown(PluginSchema)(plugin).pipe(
    Effect.mapError((e) => new InvalidPluginError({ cause: e }))
  )
```

## Key Benefits

1. **Non-invasive**: Core logic unchanged; plugins hook in
2. **Type-safe**: Hook signatures enforced at compile time
3. **Composable**: Multiple plugins can handle same hook
4. **Testable**: Mock plugins for testing hook behavior
5. **Discoverable**: Load from config, npm, or local paths

## Best Practices

1. **Narrow hooks**: Specific hooks > generic "middleware"
2. **Order matters**: Document plugin execution order
3. **Fail gracefully**: Plugin errors shouldn't crash app
4. **Version compatibility**: Check plugin API version
5. **Lifecycle hooks**: Always provide init/shutdown for cleanup
