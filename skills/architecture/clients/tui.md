# Terminal UI (TUI) Client

TUI client using @opentui/solid for terminal rendering.

## Package Setup

```json
// apps/tui/package.json
{
  "name": "@my-app/tui",
  "type": "module",
  "scripts": {
    "dev": "bun run src/main.tsx",
    "build": "bun build src/main.tsx --outdir dist --target bun"
  },
  "dependencies": {
    "@my-app/api": "workspace:*",
    "@my-app/shared": "workspace:*",
    "@opentui/solid": "^0.1.0",
    "effect": "catalog:",
    "solid-js": "^1.9.0"
  }
}
```

## Entry Point

```typescript
// apps/tui/src/main.tsx
import { render } from "@opentui/solid"
import { App } from "./app"

render(() => <App />)
```

## App Structure

```typescript
// apps/tui/src/app.tsx
import { createSignal, Show, For } from "solid-js"
import { Box, Text, Input } from "@opentui/solid"
import { ApiProvider, useApi } from "./context/api"
import { SyncProvider } from "./context/sync"

export function App() {
  return (
    <ApiProvider baseUrl="http://localhost:3000">
      <SyncProvider>
        <MainLayout />
      </SyncProvider>
    </ApiProvider>
  )
}

function MainLayout() {
  const [view, setView] = createSignal<"sessions" | "editor">("sessions")

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <Box flexGrow={1}>
        <Show when={view() === "sessions"}>
          <SessionList onSelect={() => setView("editor")} />
        </Show>
        <Show when={view() === "editor"}>
          <Editor onBack={() => setView("sessions")} />
        </Show>
      </Box>
      <StatusBar />
    </Box>
  )
}
```

## API Context

```typescript
// apps/tui/src/context/api.tsx
import { createContext, useContext, type JSX } from "solid-js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpApiClient } from "effect/unstable/http"
import { AppApi } from "@my-app/api"

interface ApiContextValue {
  client: HttpApiClient.Client<typeof AppApi>
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
}

const ApiContext = createContext<ApiContextValue>()

export function ApiProvider(props: { baseUrl: string; children: JSX.Element }) {
  const ClientLive = Layer.effect(
    HttpApiClient.Client<typeof AppApi>,
    HttpApiClient.make(AppApi, { baseUrl: props.baseUrl })
  ).pipe(Layer.provide(FetchHttpClient.layer))

  const runtime = ManagedRuntime.make(ClientLive)

  const runEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
    runtime.runPromise(effect)

  const client = Effect.runSync(
    Effect.gen(function* () {
      return yield* HttpApiClient.make(AppApi, { baseUrl: props.baseUrl })
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )

  return (
    <ApiContext.Provider value={{ client, runEffect }}>
      {props.children}
    </ApiContext.Provider>
  )
}

export function useApi() {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error("useApi must be used within ApiProvider")
  return ctx
}
```

## SSE Sync Context

```typescript
// apps/tui/src/context/sync.tsx
import { createContext, useContext, onMount, onCleanup, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Session } from "@my-app/shared"

interface SyncState {
  sessions: Session[]
  connected: boolean
}

interface SyncContextValue {
  state: SyncState
  refresh: () => void
}

const SyncContext = createContext<SyncContextValue>()

export function SyncProvider(props: { children: JSX.Element }) {
  const { client, runEffect } = useApi()
  const [state, setState] = createStore<SyncState>({
    sessions: [],
    connected: false,
  })

  let eventSource: EventSource | null = null

  const connect = () => {
    eventSource = new EventSource("http://localhost:3000/v1/events")

    eventSource.onopen = () => {
      setState("connected", true)
    }

    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data)

      switch (payload.type) {
        case "session.created":
          setState("sessions", (prev) => [...prev, payload.data])
          break
        case "session.updated":
          setState(
            "sessions",
            (s) => s.id === payload.data.id,
            payload.data
          )
          break
        case "session.deleted":
          setState("sessions", (prev) =>
            prev.filter((s) => s.id !== payload.data.id)
          )
          break
      }
    }

    eventSource.onerror = () => {
      setState("connected", false)
      // Reconnect after delay
      setTimeout(connect, 3000)
    }
  }

  const refresh = async () => {
    const result = await runEffect(
      client.sessions.list({ urlParams: { limit: 100 } })
    )
    setState("sessions", result.data)
  }

  onMount(() => {
    refresh()
    connect()
  })

  onCleanup(() => {
    eventSource?.close()
  })

  return (
    <SyncContext.Provider value={{ state, refresh }}>
      {props.children}
    </SyncContext.Provider>
  )
}

export function useSync() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSync must be used within SyncProvider")
  return ctx
}
```

## Components

```typescript
// apps/tui/src/components/header.tsx
import { Box, Text } from "@opentui/solid"
import { useSync } from "../context/sync"

export function Header() {
  const { state } = useSync()

  return (
    <Box
      borderStyle="single"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text bold>My App</Text>
      <Text color={state.connected ? "green" : "red"}>
        {state.connected ? "●" : "○"}
      </Text>
    </Box>
  )
}

// apps/tui/src/components/session-list.tsx
import { For, createSignal } from "solid-js"
import { Box, Text } from "@opentui/solid"
import { useSync } from "../context/sync"

export function SessionList(props: { onSelect: (id: string) => void }) {
  const { state } = useSync()
  const [selected, setSelected] = createSignal(0)

  const handleKey = (key: string) => {
    const sessions = state.sessions
    if (key === "up" && selected() > 0) {
      setSelected((s) => s - 1)
    } else if (key === "down" && selected() < sessions.length - 1) {
      setSelected((s) => s + 1)
    } else if (key === "enter" && sessions[selected()]) {
      props.onSelect(sessions[selected()].id)
    }
  }

  return (
    <Box flexDirection="column" onKeyPress={handleKey}>
      <For each={state.sessions}>
        {(session, i) => (
          <Box
            paddingX={1}
            backgroundColor={i() === selected() ? "blue" : undefined}
          >
            <Text>{session.title}</Text>
          </Box>
        )}
      </For>
    </Box>
  )
}

// apps/tui/src/components/status-bar.tsx
import { Box, Text } from "@opentui/solid"

export function StatusBar() {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text dimColor>q: quit | n: new | d: delete | enter: select</Text>
    </Box>
  )
}
```

## Keyboard Handling

```typescript
// apps/tui/src/hooks/use-input.ts
import { onMount, onCleanup } from "solid-js"

type KeyHandler = (key: string, ctrl: boolean, meta: boolean) => void

export function useInput(handler: KeyHandler) {
  onMount(() => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    const onData = (data: string) => {
      // Handle special keys
      if (data === "\u0003") {
        // Ctrl+C
        process.exit()
      }

      const ctrl = data.charCodeAt(0) < 27
      const meta = data.startsWith("\u001b")

      // Arrow keys
      if (data === "\u001b[A") handler("up", false, false)
      else if (data === "\u001b[B") handler("down", false, false)
      else if (data === "\u001b[C") handler("right", false, false)
      else if (data === "\u001b[D") handler("left", false, false)
      else if (data === "\r") handler("enter", false, false)
      else if (data === "\u001b") handler("escape", false, false)
      else handler(data, ctrl, meta)
    }

    stdin.on("data", onData)

    onCleanup(() => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
    })
  })
}
```

## Focus Management

```typescript
// apps/tui/src/context/focus.tsx
import { createContext, useContext, createSignal, type JSX } from "solid-js"

interface FocusContextValue {
  focusedId: () => string | null
  setFocus: (id: string) => void
  isFocused: (id: string) => boolean
}

const FocusContext = createContext<FocusContextValue>()

export function FocusProvider(props: { children: JSX.Element }) {
  const [focusedId, setFocusedId] = createSignal<string | null>(null)

  return (
    <FocusContext.Provider
      value={{
        focusedId,
        setFocus: setFocusedId,
        isFocused: (id) => focusedId() === id,
      }}
    >
      {props.children}
    </FocusContext.Provider>
  )
}

export function useFocus(id: string) {
  const ctx = useContext(FocusContext)
  if (!ctx) throw new Error("useFocus must be used within FocusProvider")

  return {
    isFocused: () => ctx.isFocused(id),
    focus: () => ctx.setFocus(id),
  }
}
```

## Key Points

1. **@opentui/solid**: SolidJS primitives for terminal rendering
2. **Same patterns as web**: Provider pattern, stores, derived state
3. **SSE for real-time**: EventSource works in Node.js/Bun
4. **Keyboard-driven**: No mouse, full keyboard navigation
5. **Focus management**: Track which component handles input
