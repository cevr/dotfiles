# Web Client

SolidJS web application with Vite, following UI composition patterns.

## Package Setup

```json
// apps/web/package.json
{
  "name": "@my-app/web",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@my-app/api": "workspace:*",
    "@my-app/shared": "workspace:*",
    "effect": "^3.0.0",
    "@effect/platform": "^0.77.0",
    "@solidjs/router": "^0.15.0",
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "vite-plugin-solid": "^2.11.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

## Vite Configuration

```typescript
// apps/web/vite.config.ts
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "/v1"),
      },
    },
  },
})
```

## Entry Point

```typescript
// apps/web/src/index.tsx
import { render } from "solid-js/web"
import { Router } from "@solidjs/router"
import { App } from "./app"
import "./index.css"

render(
  () => (
    <Router>
      <App />
    </Router>
  ),
  document.getElementById("root")!
)
```

## App with Providers

```typescript
// apps/web/src/app.tsx
import { type JSX, Suspense } from "solid-js"
import { Routes, Route } from "@solidjs/router"
import { ApiProvider } from "./context/api"
import { AuthProvider } from "./context/auth"
import { SyncProvider } from "./context/sync"
import { ThemeProvider } from "./context/theme"
import { HomePage } from "./pages/home"
import { SessionPage } from "./pages/session"
import { LoginPage } from "./pages/login"

export function App() {
  return (
    <ThemeProvider>
      <ApiProvider baseUrl="/api">
        <AuthProvider>
          <SyncProvider>
            <Suspense fallback={<LoadingScreen />}>
              <Routes>
                <Route path="/" component={HomePage} />
                <Route path="/session/:id" component={SessionPage} />
                <Route path="/login" component={LoginPage} />
              </Routes>
            </Suspense>
          </SyncProvider>
        </AuthProvider>
      </ApiProvider>
    </ThemeProvider>
  )
}

function LoadingScreen() {
  return (
    <div class="flex h-screen items-center justify-center">
      <div class="animate-spin h-8 w-8 border-2 border-blue-500 rounded-full border-t-transparent" />
    </div>
  )
}
```

## API Context

```typescript
// apps/web/src/context/api.tsx
import { createContext, useContext, type JSX } from "solid-js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpApiClient } from "@effect/platform"
import { AppApi } from "@my-app/api"

interface ApiContextValue {
  client: Effect.Effect.Success<ReturnType<typeof HttpApiClient.make<typeof AppApi>>>
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
}

const ApiContext = createContext<ApiContextValue>()

export function ApiProvider(props: { baseUrl: string; children: JSX.Element }) {
  // Create runtime with HTTP client layer
  const runtime = ManagedRuntime.make(FetchHttpClient.layer)

  const runEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
    runtime.runPromise(effect)

  // Create API client
  const client = Effect.runSync(
    HttpApiClient.make(AppApi, { baseUrl: props.baseUrl }).pipe(
      Effect.provide(FetchHttpClient.layer)
    )
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

// Hook for running effects with the API client
export function useRunEffect() {
  const { runEffect } = useApi()
  return runEffect
}
```

## Auth Context

```typescript
// apps/web/src/context/auth.tsx
import { createContext, useContext, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useApi } from "./api"
import type { User } from "@my-app/shared"

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: User; token: string }

interface AuthContextValue {
  state: AuthState
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  isAuthenticated: () => boolean
}

const AuthContext = createContext<AuthContextValue>()

export function AuthProvider(props: { children: JSX.Element }) {
  const { client, runEffect } = useApi()
  const navigate = useNavigate()

  const [state, setState] = createStore<AuthState>({ status: "loading" })

  // Check for existing session on mount
  const token = localStorage.getItem("token")
  if (token) {
    // Verify token and get user
    runEffect(client.auth.me())
      .then((user) => setState({ status: "authenticated", user, token }))
      .catch(() => {
        localStorage.removeItem("token")
        setState({ status: "unauthenticated" })
      })
  } else {
    setState({ status: "unauthenticated" })
  }

  const login = async (email: string, password: string) => {
    const result = await runEffect(
      client.auth.login({ payload: { email, password } })
    )
    localStorage.setItem("token", result.accessToken)
    setState({
      status: "authenticated",
      user: result.user,
      token: result.accessToken,
    })
  }

  const logout = () => {
    localStorage.removeItem("token")
    setState({ status: "unauthenticated" })
    navigate("/login")
  }

  const isAuthenticated = () => state.status === "authenticated"

  return (
    <AuthContext.Provider value={{ state, login, logout, isAuthenticated }}>
      {props.children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
```

## SSE Sync Context

```typescript
// apps/web/src/context/sync.tsx
import { createContext, useContext, onMount, onCleanup, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useAuth } from "./auth"
import type { Session } from "@my-app/shared"

interface SyncState {
  sessions: Session[]
  connected: boolean
}

interface SyncContextValue {
  state: SyncState
  updateSession: (id: string, changes: Partial<Session>) => void
}

const SyncContext = createContext<SyncContextValue>()

export function SyncProvider(props: { children: JSX.Element }) {
  const { state: authState } = useAuth()
  const [state, setState] = createStore<SyncState>({
    sessions: [],
    connected: false,
  })

  let eventSource: EventSource | null = null

  const connect = () => {
    if (authState.status !== "authenticated") return

    eventSource = new EventSource(`/api/events?token=${authState.token}`)

    eventSource.onopen = () => {
      setState("connected", true)
    }

    eventSource.addEventListener("session.created", (e) => {
      const session = JSON.parse(e.data)
      setState("sessions", (prev) => [...prev, session])
    })

    eventSource.addEventListener("session.updated", (e) => {
      const { id, ...changes } = JSON.parse(e.data)
      setState("sessions", (s) => s.id === id, changes)
    })

    eventSource.addEventListener("session.deleted", (e) => {
      const { id } = JSON.parse(e.data)
      setState("sessions", (prev) => prev.filter((s) => s.id !== id))
    })

    eventSource.onerror = () => {
      setState("connected", false)
      eventSource?.close()
      // Exponential backoff reconnection
      setTimeout(connect, 3000)
    }
  }

  onMount(() => {
    connect()
  })

  onCleanup(() => {
    eventSource?.close()
  })

  // Optimistic update helper
  const updateSession = (id: string, changes: Partial<Session>) => {
    setState("sessions", (s) => s.id === id, changes)
  }

  return (
    <SyncContext.Provider value={{ state, updateSession }}>
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

## Compound Components Example

```typescript
// apps/web/src/components/session-list/index.tsx
import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "../../context/sync"
import { useApi } from "../../context/api"

// Provider for session list state
function SessionListProvider(props: { children: JSX.Element }) {
  const { state } = useSync()
  const { client, runEffect } = useApi()

  const [localState, setLocalState] = createStore({
    selected: null as string | null,
    creating: false,
  })

  const create = async (title: string) => {
    setLocalState("creating", true)
    try {
      await runEffect(client.sessions.create({ payload: { title } }))
    } finally {
      setLocalState("creating", false)
    }
  }

  return (
    <SessionListContext.Provider
      value={{
        sessions: () => state.sessions,
        selected: () => localState.selected,
        setSelected: (id) => setLocalState("selected", id),
        create,
        creating: () => localState.creating,
      }}
    >
      {props.children}
    </SessionListContext.Provider>
  )
}

// Root component
export function SessionList(props: { children?: JSX.Element }) {
  return (
    <SessionListProvider>
      <div class="flex flex-col h-full">{props.children}</div>
    </SessionListProvider>
  )
}

// Header subcomponent
SessionList.Header = function Header(props: { children?: JSX.Element }) {
  const { sessions } = useSessionList()

  return (
    <div class="flex items-center justify-between p-4 border-b">
      <h2 class="text-lg font-semibold">Sessions ({sessions().length})</h2>
      {props.children}
    </div>
  )
}

// Content subcomponent
SessionList.Content = function Content() {
  const { sessions, selected, setSelected } = useSessionList()

  return (
    <div class="flex-1 overflow-y-auto">
      <For each={sessions()}>
        {(session) => (
          <SessionList.Item
            session={session}
            active={selected() === session.id}
            onClick={() => setSelected(session.id)}
          />
        )}
      </For>
    </div>
  )
}

// Item subcomponent with data attributes
SessionList.Item = function Item(props: {
  session: Session
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      class="w-full p-3 text-left hover:bg-gray-100 data-[active]:bg-blue-50 data-[active]:border-l-2 data-[active]:border-blue-500"
      data-active={props.active ? "" : undefined}
      onClick={props.onClick}
    >
      <div class="font-medium">{props.session.title}</div>
      <div class="text-sm text-gray-500">
        {new Date(props.session.createdAt).toLocaleDateString()}
      </div>
    </button>
  )
}

// Create button
SessionList.CreateButton = function CreateButton() {
  const { create, creating } = useSessionList()

  const handleCreate = async () => {
    const title = prompt("Session title:")
    if (title) await create(title)
  }

  return (
    <button
      class="px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
      onClick={handleCreate}
      disabled={creating()}
    >
      {creating() ? "Creating..." : "New Session"}
    </button>
  )
}
```

## Usage in Pages

```typescript
// apps/web/src/pages/home.tsx
import { SessionList } from "../components/session-list"
import { Show } from "solid-js"
import { useAuth } from "../context/auth"
import { Navigate } from "@solidjs/router"

export function HomePage() {
  const { isAuthenticated } = useAuth()

  return (
    <Show when={isAuthenticated()} fallback={<Navigate href="/login" />}>
      <div class="h-screen flex">
        <aside class="w-80 border-r">
          <SessionList>
            <SessionList.Header>
              <SessionList.CreateButton />
            </SessionList.Header>
            <SessionList.Content />
          </SessionList>
        </aside>
        <main class="flex-1 p-6">
          <h1>Select a session</h1>
        </main>
      </div>
    </Show>
  )
}
```

## Form Handling (Uncontrolled)

```typescript
// apps/web/src/pages/login.tsx
import { createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useAuth } from "../context/auth"

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()

  type FormState =
    | { status: "idle" }
    | { status: "submitting" }
    | { status: "error"; message: string }

  const [state, setState] = createSignal<FormState>({ status: "idle" })

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const data = new FormData(form)

    setState({ status: "submitting" })

    try {
      await login(data.get("email") as string, data.get("password") as string)
      navigate("/")
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Login failed",
      })
    }
  }

  return (
    <div class="flex h-screen items-center justify-center">
      <form onSubmit={handleSubmit} class="w-80 space-y-4">
        <h1 class="text-2xl font-bold">Sign In</h1>

        <Show when={state().status === "error"}>
          <div class="p-3 bg-red-50 text-red-700 rounded">
            {(state() as { message: string }).message}
          </div>
        </Show>

        <input
          name="email"
          type="email"
          placeholder="Email"
          required
          class="w-full p-2 border rounded"
        />

        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          minLength={8}
          class="w-full p-2 border rounded"
        />

        <button
          type="submit"
          disabled={state().status === "submitting"}
          class="w-full p-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {state().status === "submitting" ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  )
}
```

## Key Points

1. **SolidJS + Vite**: Fast development and builds
2. **Provider hierarchy**: Theme → API → Auth → Sync
3. **Compound components**: Render-to-opt-in pattern
4. **Union state**: For loading/error/success states
5. **Uncontrolled forms**: Use FormData over controlled inputs
6. **Data attributes**: For conditional Tailwind styling
7. **SSE sync**: Real-time updates from server
8. **Optimistic updates**: Update UI before server confirms
