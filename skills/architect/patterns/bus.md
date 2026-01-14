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
import { Context, Effect, Layer, PubSub, Queue, Schema as S } from "effect"
import type { BusEvent } from "./bus-event"

export { BusEvent } from "./bus-event"
export { Events } from "./events"

type EventPayload<D extends BusEvent.Definition> = {
  type: D["type"]
  data: S.Schema.Type<D["schema"]>
  timestamp: Date
}

export class BusService extends Context.Tag("BusService")<
  BusService,
  {
    readonly publish: <D extends BusEvent.Definition>(
      def: D,
      data: S.Schema.Type<D["schema"]>
    ) => Effect.Effect<void>
    readonly subscribe: <D extends BusEvent.Definition>(
      def: D,
      handler: (payload: EventPayload<D>) => Effect.Effect<void>
    ) => Effect.Effect<void>
    readonly subscribeAll: (
      handler: (payload: EventPayload<BusEvent.Definition>) => Effect.Effect<void>
    ) => Effect.Effect<void>
  }
>() {
  static Live = Layer.effect(
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

            // Publish to PubSub for subscribeAll
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

        subscribeAll: (handler) =>
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(pubsub)

            yield* Effect.forever(
              Effect.gen(function* () {
                const event = yield* Queue.take(queue)
                yield* handler(event)
              })
            ).pipe(Effect.fork)
          }),
      })
    })
  )

  static Test = Layer.succeed(
    BusService,
    BusService.of({
      publish: () => Effect.void,
      subscribe: () => Effect.void,
      subscribeAll: () => Effect.void,
    })
  )
}
```

## Usage in Services

```typescript
// packages/core/src/services/session.ts
import { BusService, Events } from "../bus"

export class SessionService extends Context.Tag("SessionService")<...>() {
  static Live = Layer.effect(
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
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { Effect, Stream } from "effect"
import { BusService } from "@my-app/core"

export const EventsGroupLive = HttpApiBuilder.group(
  AppApi,
  "events",
  (handlers) =>
    Effect.gen(function* () {
      const bus = yield* BusService

      return handlers.handle("subscribe", () =>
        Effect.gen(function* () {
          const events = yield* Stream.async<EventPayload>((emit) => {
            bus.subscribeAll((event) =>
              Effect.sync(() => emit.single(event))
            )
          })

          return HttpServerResponse.stream(
            events.pipe(
              Stream.map((e) => `data: ${JSON.stringify(e)}\n\n`)
            ),
            { contentType: "text/event-stream" }
          )
        })
      )
    })
)
```

## Key Points

1. **Typed events**: BusEvent.define creates type-safe event definitions
2. **Decoupled**: Publishers don't know about subscribers
3. **Effect-native**: All operations return Effect
4. **Testable**: BusService.Test provides no-op implementation
5. **SSE ready**: Easy to stream events to clients
