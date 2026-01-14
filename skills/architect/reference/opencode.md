# OpenCode Architecture Reference

Key patterns from anomalyco/opencode, a multi-client AI coding assistant.

## Project Overview

OpenCode demonstrates:
- **Multiple clients**: TUI (terminal), Web, Desktop (Tauri), Slack bot
- **Shared core**: Business logic independent of UI
- **Event-driven**: Bus pattern for decoupled communication
- **Server as source of truth**: Clients are thin presentation adapters

## Package Structure

```
packages/
├── opencode/              # Core business logic
│   ├── src/
│   │   ├── app/           # Application state management
│   │   ├── bus/           # Event bus (publish/subscribe)
│   │   ├── storage/       # SQLite database abstraction
│   │   ├── session/       # Session management
│   │   ├── provider/      # LLM provider abstraction
│   │   └── util/          # Shared utilities
│   └── package.json
│
├── web/                   # Web UI (SolidJS)
│   ├── src/
│   │   ├── components/
│   │   ├── context/
│   │   └── app.tsx
│   └── package.json
│
├── tui/                   # Terminal UI (@opentui/solid)
│   └── ...
│
├── desktop/               # Tauri desktop wrapper
│   └── ...
│
└── slack/                 # Slack bot integration
    └── ...
```

## Event Bus Pattern

Central communication hub for decoupled components:

```typescript
// bus-event.ts - Event definitions with Zod schemas
export namespace BusEvent {
  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties
  ) {
    const result = { type, properties }
    registry.set(type, result)
    return result
  }
}

// Define events
const SessionCreated = BusEvent.define("session.created", z.object({
  id: z.string(),
  title: z.string(),
}))

// Publish events
Bus.publish(SessionCreated, { id: "123", title: "New" })

// Subscribe to events
Bus.subscribe(SessionCreated, (event) => {
  console.log(event.properties.title)
})
```

## Instance Pattern

Global state container for the application:

```typescript
// instance.ts
export namespace Instance {
  let current: App | null = null

  export function init(config: Config) {
    current = createApp(config)
    return current
  }

  export function use() {
    if (!current) throw new Error("Instance not initialized")
    return current
  }

  export const directory = () => use().directory
  export const storage = () => use().storage
  export const bus = () => use().bus
}
```

## Storage Abstraction

SQLite-based storage with migration support:

```typescript
// storage/index.ts
export namespace Storage {
  export async function init(directory: string) {
    const db = new Database(path.join(directory, "data.db"))
    await runMigrations(db)
    return createStorageAPI(db)
  }
}

// Usage
const storage = await Storage.init("~/.myapp")
await storage.sessions.create({ title: "New" })
const sessions = await storage.sessions.list()
```

## Provider Pattern

Abstraction for LLM providers:

```typescript
// provider/index.ts
export interface Provider {
  id: string
  name: string
  models: Model[]
  chat(options: ChatOptions): AsyncIterable<ChatChunk>
}

export const providers = {
  anthropic: createAnthropicProvider(),
  openai: createOpenAIProvider(),
  // ...
}

// Usage - provider-agnostic
async function chat(providerId: string, model: string, messages: Message[]) {
  const provider = providers[providerId]
  for await (const chunk of provider.chat({ model, messages })) {
    yield chunk
  }
}
```

## Session Management

```typescript
// session/index.ts
export namespace Session {
  export async function create(title: string) {
    const session = await Storage.sessions.create({ title })
    await Bus.publish(Events.SessionCreated, session)
    return session
  }

  export async function addMessage(sessionId: string, message: Message) {
    await Storage.messages.create({ sessionId, ...message })
    await Bus.publish(Events.MessageAdded, { sessionId, message })
  }
}
```

## Client Architecture

All clients follow the same pattern:

```typescript
// 1. Initialize core
await Instance.init({
  directory: "~/.myapp",
  // ...
})

// 2. Connect to events
Bus.subscribeAll((event) => {
  // Update local UI state
  store.dispatch(event)
})

// 3. Render UI
render(() => (
  <StoreProvider store={store}>
    <App />
  </StoreProvider>
))
```

## TUI-Specific

```typescript
// tui/src/main.tsx
import { render } from "@opentui/solid"
import { App } from "./app"

await Instance.init({ directory: process.env.HOME + "/.myapp" })

render(() => <App />)
```

## Web-Specific

```typescript
// web/src/main.tsx
import { render } from "solid-js/web"
import { App } from "./app"

// Web connects to server via HTTP/SSE
const client = createClient({ baseUrl: "/api" })

render(() => (
  <ClientProvider client={client}>
    <App />
  </ClientProvider>
), document.getElementById("root"))
```

## Key Takeaways

1. **Server is truth**: All state changes go through server
2. **Events for sync**: Clients subscribe to SSE for real-time updates
3. **Shared types**: TypeScript types shared via workspace packages
4. **Platform adapters**: Each client adapts to its environment
5. **Decoupled components**: Bus enables loose coupling
6. **Migration support**: Database schema evolves with migrations
