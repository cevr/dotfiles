# Exhaustive Type Pattern

Compile-time exhaustiveness checks. Add new variant → compiler tells you everywhere to update.

## The Problem

```typescript
type Provider = "anthropic" | "openai" | "bedrock"

// Easy to forget to update when adding new provider
function getBaseUrl(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com"
    case "openai":
      return "https://api.openai.com"
    // Forgot bedrock! Runtime error waiting to happen
  }
}
```

## Exhaustive Switch with never

```typescript
type Provider = "anthropic" | "openai" | "bedrock"

function getBaseUrl(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com"
    case "openai":
      return "https://api.openai.com"
    case "bedrock":
      return "https://bedrock.amazonaws.com"
    default:
      // Compile error if switch isn't exhaustive
      return assertNever(provider)
  }
}

function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`)
}
```

## Exhaustive Record Type

```typescript
type Provider = "anthropic" | "openai" | "bedrock"

// Must have entry for every Provider - compiler enforces
const providerBaseUrls: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  bedrock: "https://bedrock.amazonaws.com",
}

// Usage
function getBaseUrl(provider: Provider): string {
  return providerBaseUrls[provider]
}
```

## Exhaustive Map Type for Complex Values

```typescript
type Provider = "anthropic" | "openai" | "bedrock"

interface ProviderConfig {
  baseUrl: string
  authHeader: string
  models: readonly string[]
}

// Compile-time check: every Provider must be in map
type ProviderConfigMap = {
  [K in Provider]: ProviderConfig
}

const providerConfigs: ProviderConfigMap = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    authHeader: "x-api-key",
    models: ["claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  openai: {
    baseUrl: "https://api.openai.com",
    authHeader: "Authorization",
    models: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  bedrock: {
    baseUrl: "https://bedrock.amazonaws.com",
    authHeader: "Authorization",
    models: ["amazon.titan-text-premier-v1:0", "meta.llama3-1-70b-instruct-v1:0"],
  },
}
```

## Bidirectional Exhaustiveness Check

Ensure map keys match union AND union matches map keys:

```typescript
type Provider = "anthropic" | "openai" | "bedrock"

interface ProviderOptionsMap {
  anthropic: { apiKey: string }
  openai: { apiKey: string; organization?: string }
  bedrock: { region: string; profile?: string }
}

// Compile-time bidirectional check
type _CheckExhaustive = ProviderOptionsMap extends Record<Provider, unknown>
  ? Record<Provider, unknown> extends ProviderOptionsMap
    ? true
    : ["Missing provider in ProviderOptionsMap", Exclude<Provider, keyof ProviderOptionsMap>]
  : ["Invalid ProviderOptionsMap key", Exclude<keyof ProviderOptionsMap, Provider>]

// This line causes compile error if check fails
const _exhaustive: _CheckExhaustive = true

// Type-safe options getter
function getProviderOptions<P extends Provider>(
  provider: P,
  options: ProviderOptionsMap[P]
): ProviderOptionsMap[P] {
  return options
}
```

## Pattern: Discriminated Union Handler

```typescript
type AppEvent =
  | { type: "session.created"; sessionId: string; title: string }
  | { type: "session.deleted"; sessionId: string }
  | { type: "message.added"; sessionId: string; content: string }
  | { type: "message.updated"; messageId: string; content: string }

// Handler map must cover all event types
type EventHandlers = {
  [E in AppEvent as E["type"]]: (event: E) => void
}

const handlers: EventHandlers = {
  "session.created": (e) => console.log(`Created: ${e.title}`),
  "session.deleted": (e) => console.log(`Deleted: ${e.sessionId}`),
  "message.added": (e) => console.log(`Message: ${e.content}`),
  "message.updated": (e) => console.log(`Updated: ${e.messageId}`),
}

// Dispatcher with exhaustive check
function dispatch(event: AppEvent): void {
  const handler = handlers[event.type]
  // TypeScript knows handler exists for all event types
  ;(handler as (e: AppEvent) => void)(event)
}
```

## Pattern: Effect Match

Effect's `Match` module provides exhaustive pattern matching:

```typescript
import { Match } from "effect"

type Provider = "anthropic" | "openai" | "bedrock"

const getBaseUrl = Match.type<Provider>().pipe(
  Match.when("anthropic", () => "https://api.anthropic.com"),
  Match.when("openai", () => "https://api.openai.com"),
  Match.when("bedrock", () => "https://bedrock.amazonaws.com"),
  Match.exhaustive // Compile error if not exhaustive
)

// Usage
const url = getBaseUrl("anthropic") // "https://api.anthropic.com"
```

## Pattern: Schema-Driven Exhaustiveness

```typescript
import { Schema as S } from "effect"

// Define union via Schema
const ProviderSchema = S.Literal("anthropic", "openai", "bedrock")
type Provider = S.Schema.Type<typeof ProviderSchema>

// Config schema per provider
const ProviderConfigSchemas = {
  anthropic: S.Struct({ apiKey: S.String }),
  openai: S.Struct({ apiKey: S.String, organization: S.optional(S.String) }),
  bedrock: S.Struct({ region: S.String, profile: S.optional(S.String) }),
} satisfies Record<Provider, S.Schema<any>>

// Type-safe config decoder
function decodeProviderConfig<P extends Provider>(
  provider: P,
  raw: unknown
): S.Schema.Type<(typeof ProviderConfigSchemas)[P]> {
  return S.decodeUnknownSync(ProviderConfigSchemas[provider])(raw)
}
```

## Pattern: Assertion Helper

```typescript
// Reusable exhaustive check function
export function exhaustive<T extends never>(
  _value: T,
  message = "Unhandled case"
): never {
  throw new Error(`${message}: ${JSON.stringify(_value)}`)
}

// Usage in switch
function handleProvider(provider: Provider): void {
  switch (provider) {
    case "anthropic":
      // ...
      break
    case "openai":
      // ...
      break
    case "bedrock":
      // ...
      break
    default:
      exhaustive(provider, "Unknown provider")
  }
}
```

## Adding a New Variant

When you add a new provider:

```typescript
// 1. Add to union
type Provider = "anthropic" | "openai" | "bedrock" | "google"

// 2. Compiler errors appear at:
//    - Record<Provider, ...> definitions missing "google"
//    - switch statements without "google" case
//    - ProviderOptionsMap without "google" key
//    - Match.exhaustive calls

// 3. Fix all locations - compiler guides you
```

## Key Benefits

1. **Compile-time safety**: No runtime surprises from missing cases
2. **Refactor confidence**: Add variant, fix all red squiggles
3. **Self-documenting**: Type system shows all valid values
4. **Zero runtime cost**: Checks happen at compile time

## Best Practices

1. **Prefer `satisfies`**: Use `satisfies Record<...>` for object literals
2. **Use `assertNever`**: Always have a default case that's unreachable
3. **Bidirectional checks**: Ensure map ↔ union correspondence
4. **Effect Match**: Prefer `Match.exhaustive` for functional style
5. **Schema literals**: Define unions via Schema for runtime validation too
