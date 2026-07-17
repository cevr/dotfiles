# Event Bus Pattern

Event-driven communication using Effect for decoupled components.

## Bus Service Definition

```typescript
// packages/core/src/bus/bus-event.ts
import { Schema as S } from "effect"

export namespace BusEvent {
  export type Definition<Type extends string = string, Props = unknown> = {
    readonly type: Type
    readonly schema: S.Schema<Props>
  }

  const registry = new Map<string, Definition>()

  export function define<Type extends string, A, I, R>(
    type: Type,
    schema: S.Schema<A, I, R>
  ): Definition<Type, A> {
    const def = { type, schema }
    registry.set(type, def)
    return def
  }

  export function getAll(): ReadonlyMap<string, Definition> {
    return registry
  }
}
```

## Event Definitions

```typescript
// packages/core/src/bus/events.ts
import { Schema as S } from "effect"
import { BusEvent } from "./bus-event"
import { SessionIdSchema, UserIdSchema } from "@my-app/shared"

export namespace Events {
  // Session events
  export const SessionCreated = BusEvent.define(
    "session.created",
    S.Struct({
      id: SessionIdSchema,
      title: S.String,
      createdAt: S.Date,
    })
  )

  export const SessionUpdated = BusEvent.define(
    "session.updated",
    S.Struct({
      id: SessionIdSchema,
      changes: S.Record({ key: S.String, value: S.Unknown }),
    })
  )

  export const SessionDeleted = BusEvent.define(
    "session.deleted",
    S.Struct({
      id: SessionIdSchema,
    })
  )

  // User events
  export const UserCreated = BusEvent.define(
    "user.created",
    S.Struct({
      id: UserIdSchema,
      email: S.String,
    })
  )

  export const UserLoggedIn = BusEvent.define(
    "user.logged_in",
    S.Struct({
      id: UserIdSchema,
      timestamp: S.Date,
    })
  )
}
```

## Bus Service

```typescript
// packages/core/src/bus/index.ts
import {
  Context,
  Effect,
  Layer,
  PubSub,
  Schema as S,
  Scope,
  Stream,
} from "effect"
import type { BusEvent } from "./bus-event"

export { BusEvent } from "./bus-event"
export { Events } from "./events"

type EventPayload<D extends BusEvent.Definition> = {
  type: D["type"]
  data: S.Schema.Type<D["schema"]>
  timestamp: Date
}

export class BusService extends Context.Service<
  BusService,
  {
    readonly publish: <D extends BusEvent.Definition>(
      def: D,
      data: S.Schema.Type<D["schema"]>
    ) => Effect.Effect<void>
    readonly subscribe: <D extends BusEvent.Definition>(
      def: D,
      handler: (payload: EventPayload<D>) => Effect.Effect<void>
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly all: () => Stream.Stream<EventPayload<BusEvent.Definition>>
  }
>()("BusService") {
  static layer = Layer.effect(
    BusService,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EventPayload<BusEvent.Definition>>()
      const subscriptions = new Map<string, Set<(e: EventPayload<any>) => Effect.Effect<void>>>()

      return BusService.of({
        publish: (def, data) =>
          Effect.gen(function* () {
            const payload: EventPayload<typeof def> = {
              type: def.type,
              data,
              timestamp: new Date(),
            }

            // Publish to the all-events stream
            yield* PubSub.publish(pubsub, payload)

            // Notify specific subscribers
            const handlers = subscriptions.get(def.type)
            if (handlers) {
              yield* Effect.forEach(
                [...handlers],
                (handler) => handler(payload),
                { concurrency: "unbounded" }
              )
            }
          }),

        subscribe: (def, handler) =>
          Effect.gen(function* () {
            const handlers = subscriptions.get(def.type) ?? new Set()
            handlers.add(handler)
            subscriptions.set(def.type, handlers)

            // Return cleanup in finalizer
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                handlers.delete(handler)
              })
            )
          }),

        all: () => Stream.fromPubSub(pubsub),
      })
    })
  )

  static layerTest = Layer.succeed(
    BusService,
    BusService.of({
      publish: () => Effect.void,
      subscribe: () => Effect.void,
      all: () => Stream.empty,
    })
  )
}
```

## Usage in Services

```typescript
// packages/core/src/services/session.ts
import { BusService, Events } from "../bus"

export class SessionService extends Context.Service<...>()("SessionService") {
  static layer = Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const storage = yield* StorageService
      const bus = yield* BusService

      return SessionService.of({
        create: (title) =>
          Effect.gen(function* () {
            const session = { id: generateId(), title, createdAt: new Date() }
            yield* storage.set(`session:${session.id}`, session)

            // Publish event
            yield* bus.publish(Events.SessionCreated, {
              id: session.id,
              title: session.title,
              createdAt: session.createdAt,
            })

            return session
          }),

        delete: (id) =>
          Effect.gen(function* () {
            yield* storage.delete(`session:${id}`)

            // Publish event
            yield* bus.publish(Events.SessionDeleted, { id })
          }),
      })
    })
  )
}
```

## SSE Event Streaming

```typescript
// apps/server/src/handlers/EventsGroupLive.ts
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { Effect, Stream } from "effect"
import { BusService } from "@my-app/core"

export const EventsGroupLive = HttpApiBuilder.group(
  AppApi,
  "events",
  (handlers) =>
    Effect.gen(function* () {
      const bus = yield* BusService

      return handlers.handle("subscribe", () =>
        Effect.succeed(
          HttpServerResponse.stream(
            bus.all().pipe(
              Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`)
            ),
            { contentType: "text/event-stream" }
          )
        )
      )
    })
)
```

## Event-Sourced State Derivation

Events as source of truth; state derived from event stream:

```typescript
// State derived from events
type AppState = {
  sessions: Map<SessionId, Session>
  messages: Map<MessageId, Message>
}

const initialState: AppState = {
  sessions: new Map(),
  messages: new Map(),
}

// Pure reducer - no side effects
function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "session.created":
      return {
        ...state,
        sessions: new Map(state.sessions).set(event.data.id, event.data),
      }
    case "session.deleted":
      const sessions = new Map(state.sessions)
      sessions.delete(event.data.id)
      return { ...state, sessions }
    case "message.added":
      return {
        ...state,
        messages: new Map(state.messages).set(event.data.id, event.data),
      }
    default:
      return state
  }
}

// Client subscribes and derives local state
function createStore() {
  let state = initialState

  const subscribers = new Set<(state: AppState) => void>()

  return {
    getState: () => state,
    subscribe: (fn: (state: AppState) => void) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    // Called when events arrive from server
    applyEvent: (event: AppEvent) => {
      state = reduce(state, event)
      subscribers.forEach((fn) => fn(state))
    },
  }
}
```

### Benefits of Event-Sourced State

1. **Replay**: Reconstruct any past state from event log
2. **Sync**: Any client can catch up by replaying events
3. **Debug**: Full audit trail of state changes
4. **Branching**: Fork state for "what if" scenarios

```typescript
// Replay from event log
function replayEvents(events: AppEvent[]): AppState {
  return events.reduce(reduce, initialState)
}

// Branch for experimentation
function branchState(currentState: AppState, hypotheticalEvents: AppEvent[]): AppState {
  return hypotheticalEvents.reduce(reduce, currentState)
}

// Time travel
function stateAtEvent(events: AppEvent[], eventIndex: number): AppState {
  return events.slice(0, eventIndex + 1).reduce(reduce, initialState)
}
```

### Client Integration

```typescript
// SolidJS client with event-sourced state
import { createSignal, onCleanup } from "solid-js"

function useEventSourcedState(eventSource: EventSource) {
  const [state, setState] = createSignal<AppState>(initialState)

  const handler = (e: MessageEvent) => {
    const event = JSON.parse(e.data) as AppEvent
    setState((prev) => reduce(prev, event))
  }

  eventSource.addEventListener("message", handler)
  onCleanup(() => eventSource.removeEventListener("message", handler))

  return state
}
```

## Key Points

1. **Typed events**: BusEvent.define creates type-safe event definitions
2. **Decoupled**: Publishers don't know about subscribers
3. **Effect-native**: All operations return Effect
4. **Testable**: BusService.layerTest provides no-op implementation
5. **SSE ready**: Easy to stream events to clients
6. **Event-sourced**: Derive state from events, enable replay/sync/branching
7. **Pure reducers**: State derivation has no side effects
