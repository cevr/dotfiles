# Effect Services Pattern

Services using Context.Tag and Layer for dependency injection.

## Service Definition

```typescript
import { Context, Effect, Layer, Schema } from "effect"

// 1. Define the service interface with Context.Tag
export class SessionService extends Context.Tag("SessionService")<
  SessionService,
  {
    readonly create: (title: string) => Effect.Effect<Session>
    readonly get: (id: SessionId) => Effect.Effect<Session, SessionNotFound>
    readonly list: () => Effect.Effect<ReadonlyArray<Session>>
    readonly delete: (id: SessionId) => Effect.Effect<void, SessionNotFound>
  }
>() {
  // 2. Live implementation with Layer.effect
  static Live = Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const storage = yield* StorageService
      const bus = yield* BusService

      return SessionService.of({
        create: (title) =>
          Effect.gen(function* () {
            const session: Session = {
              id: SessionId.make(crypto.randomUUID()),
              title,
              createdAt: new Date(),
            }
            yield* storage.set(`session:${session.id}`, session)
            yield* bus.publish(Events.SessionCreated, session)
            return session
          }),

        get: (id) =>
          Effect.gen(function* () {
            const session = yield* storage.get<Session>(`session:${id}`)
            if (!session) {
              return yield* Effect.fail(new SessionNotFound({ sessionId: id }))
            }
            return session
          }),

        list: () =>
          storage.list<Session>("session:*"),

        delete: (id) =>
          Effect.gen(function* () {
            const session = yield* storage.get<Session>(`session:${id}`)
            if (!session) {
              return yield* Effect.fail(new SessionNotFound({ sessionId: id }))
            }
            yield* storage.delete(`session:${id}`)
            yield* bus.publish(Events.SessionDeleted, { id })
          }),
      })
    })
  )

  // 3. Test implementation for mocking
  static Test = (sessions: Session[] = []) =>
    Layer.succeed(
      SessionService,
      SessionService.of({
        create: (title) =>
          Effect.succeed({
            id: SessionId.make("test-id"),
            title,
            createdAt: new Date(),
          }),
        get: (id) => {
          const session = sessions.find((s) => s.id === id)
          return session
            ? Effect.succeed(session)
            : Effect.fail(new SessionNotFound({ sessionId: id }))
        },
        list: () => Effect.succeed(sessions),
        delete: (id) => {
          const exists = sessions.some((s) => s.id === id)
          return exists
            ? Effect.void
            : Effect.fail(new SessionNotFound({ sessionId: id }))
        },
      })
    )
}
```

## Usage in Effect.gen

```typescript
const program = Effect.gen(function* () {
  const sessionService = yield* SessionService

  const session = yield* sessionService.create("My Session")
  const fetched = yield* sessionService.get(session.id)
  const all = yield* sessionService.list()

  return { session, fetched, all }
})

// Provide the layer
const runnable = program.pipe(
  Effect.provide(SessionService.Live),
  Effect.provide(StorageService.Live),
  Effect.provide(BusService.Live)
)
```

## Layer Composition

```typescript
// Compose multiple service layers
const AppLive = Layer.mergeAll(
  SessionService.Live,
  UserService.Live,
  ProjectService.Live
).pipe(
  Layer.provide(StorageService.Live),
  Layer.provide(BusService.Live),
  Layer.provide(ConfigService.Live)
)

// Use in main
const main = Effect.gen(function* () {
  const sessions = yield* SessionService
  const users = yield* UserService
  // ...
}).pipe(Effect.provide(AppLive))
```

## Service Dependencies

```typescript
// Service that depends on other services
export class ProjectService extends Context.Tag("ProjectService")<
  ProjectService,
  {
    readonly create: (data: CreateProject) => Effect.Effect<Project>
    readonly getForUser: (userId: UserId) => Effect.Effect<Project[]>
  }
>() {
  static Live = Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const storage = yield* StorageService
      const users = yield* UserService  // Depends on UserService
      const bus = yield* BusService

      return ProjectService.of({
        create: (data) =>
          Effect.gen(function* () {
            // Verify user exists
            yield* users.get(data.ownerId)

            const project: Project = {
              id: ProjectId.make(crypto.randomUUID()),
              ...data,
              createdAt: new Date(),
            }
            yield* storage.set(`project:${project.id}`, project)
            yield* bus.publish(Events.ProjectCreated, project)
            return project
          }),

        getForUser: (userId) =>
          Effect.gen(function* () {
            const all = yield* storage.list<Project>("project:*")
            return all.filter((p) => p.ownerId === userId)
          }),
      })
    })
  )
}
```

## Best Practices

1. **One service per file**: Keep services focused
2. **Service.Live and Service.Test**: Always provide both
3. **Explicit dependencies**: Use `yield*` to get services in `Layer.effect`
4. **Layer composition**: Build up layers from smaller pieces
5. **Tagged errors**: Return `Effect.fail(new TaggedError(...))` not exceptions
