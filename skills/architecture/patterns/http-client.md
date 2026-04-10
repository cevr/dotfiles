# HttpApiClient

Auto-generated type-safe client from HttpApi schema.

## Client Creation

```typescript
// apps/web/src/api/client.ts
import { HttpApiClient } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Effect, Layer } from "effect"
import { AppApi } from "@my-app/api/definition"

// Create type-safe client from schema
export const makeClient = (baseUrl: string, token?: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient

    // Optionally add auth header
    const clientWithAuth = token
      ? HttpClient.mapRequest(httpClient, (req) =>
          HttpClientRequest.setHeader(req, "Authorization", `Bearer ${token}`)
        )
      : httpClient

    return yield* HttpApiClient.make(AppApi, {
      baseUrl,
      transformClient: () => clientWithAuth,
    })
  })
```

## Usage in Effect

```typescript
import { Effect } from "effect"
import { BrowserHttpClient } from "effect/unstable/http"
import { makeClient } from "./api/client"

const program = Effect.gen(function* () {
  const client = yield* makeClient("http://localhost:3000", authToken)

  // Type-safe API calls
  // Methods match group names and endpoint names from schema
  const sessions = yield* client.sessions.list({
    urlParams: { limit: 10 },
  })

  const session = yield* client.sessions.get({
    path: { id: sessionId },
  })

  const newSession = yield* client.sessions.create({
    payload: { title: "My Session" },
  })

  return { sessions, session, newSession }
}).pipe(Effect.provide(BrowserHttpClient.layer))
```

## In SolidJS Context

```typescript
// apps/web/src/context/api.tsx
import { createContext, useContext, type JSX } from "solid-js"
import { Effect, Runtime } from "effect"
import { BrowserHttpClient } from "effect/unstable/http"
import type { HttpApiClient } from "effect/unstable/httpapi"
import { AppApi } from "@my-app/api/definition"
import { makeClient } from "../api/client"

type Client = HttpApiClient.Client<typeof AppApi>

const ApiContext = createContext<{
  client: Client
  runtime: Runtime.Runtime<never>
}>()

export function ApiProvider(props: {
  baseUrl: string
  token?: string
  children: JSX.Element
}) {
  const runtime = Runtime.defaultRuntime

  // Create client synchronously for context
  const client = Effect.runSync(
    makeClient(props.baseUrl, props.token).pipe(
      Effect.provide(BrowserHttpClient.layer)
    )
  )

  return (
    <ApiContext.Provider value={{ client, runtime }}>
      {props.children}
    </ApiContext.Provider>
  )
}

export function useApi() {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error("useApi must be within ApiProvider")
  return ctx
}

// Hook for running effects
export function useRunEffect() {
  const { runtime } = useApi()
  return <A, E>(effect: Effect.Effect<A, E>) =>
    Runtime.runPromise(runtime)(effect)
}
```

## Usage in Components

```typescript
// apps/web/src/components/SessionList.tsx
import { createResource, For, Show } from "solid-js"
import { useApi, useRunEffect } from "../context/api"

export function SessionList() {
  const { client } = useApi()
  const runEffect = useRunEffect()

  const [sessions] = createResource(() =>
    runEffect(
      client.sessions.list({ urlParams: { limit: 50 } })
    )
  )

  const createSession = async (title: string) => {
    await runEffect(
      client.sessions.create({ payload: { title } })
    )
    // Refetch sessions
  }

  return (
    <div>
      <Show when={sessions.loading}>Loading...</Show>
      <Show when={sessions.error}>Error: {sessions.error?.message}</Show>
      <Show when={sessions()}>
        <For each={sessions()!.data}>
          {(session) => <SessionItem session={session} />}
        </For>
      </Show>
    </div>
  )
}
```

## Error Handling

```typescript
import { Effect, Match } from "effect"
import { SessionNotFound, Unauthorized } from "@my-app/api/definition"

const program = client.sessions.get({ path: { id } }).pipe(
  Effect.catchTags({
    SessionNotFound: (error) =>
      Effect.succeed({ notFound: true, id: error.sessionId }),
    Unauthorized: () =>
      Effect.sync(() => {
        // Redirect to login
        window.location.href = "/login"
        return { redirected: true }
      }),
  })
)
```

## SSE/Event Subscription

```typescript
// If the API has an SSE endpoint
const subscribeToEvents = Effect.gen(function* () {
  const client = yield* makeClient(baseUrl, token)

  // Assuming endpoint returns EventSource-like stream
  const events = yield* client.events.subscribe({})

  // Process events
  for await (const event of events) {
    console.log("Event:", event)
  }
})
```

## Key Points

1. **Auto-generated**: Client types match server schema exactly
2. **Group.endpoint**: Access via `client.groupName.endpointName`
3. **Parameters**: `path`, `urlParams`, `payload` match schema
4. **Error types**: Same TaggedErrors from schema definition
5. **No manual types**: Everything inferred from AppApi schema
