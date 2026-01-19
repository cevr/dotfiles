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

## Dual Export Pattern (CLI Commands)

Export both unprovided (for tests) and provided (for CLI) versions:

```typescript
// commands/deploy.ts
import { Command } from "@effect/cli"
import { Effect } from "effect"
import { AppLayer } from "../layers"

// Unprovided - tests inject their own layers
export const deployCommand = Command.make("deploy", { env: Args.text() }, ({ env }) =>
  Effect.gen(function* () {
    const git = yield* GitService
    yield* git.ensureClean()

    const deploy = yield* DeployService
    yield* deploy.push(env)
  })
)

// Provided - CLI uses this
export const deployCommandLive = deployCommand.pipe(Command.provide(AppLayer))
```

## Test Factory Pattern

Services expose test helpers with call tracking:

```typescript
export class GitService extends Context.Tag("GitService")<
  GitService,
  {
    readonly ensureClean: () => Effect.Effect<void, DirtyWorkingTree>
    readonly getCurrentBranch: () => Effect.Effect<string>
  }
>() {
  static Live = Layer.effect(...)

  // Test factory with call tracking
  static Test(config: { branch?: string; dirty?: boolean } = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = []

    const layer = Layer.succeed(
      GitService,
      GitService.of({
        ensureClean: () => {
          calls.push({ method: "ensureClean", args: [] })
          return config.dirty
            ? Effect.fail(new DirtyWorkingTree())
            : Effect.void
        },
        getCurrentBranch: () => {
          calls.push({ method: "getCurrentBranch", args: [] })
          return Effect.succeed(config.branch ?? "main")
        },
      })
    )

    return {
      layer,
      getCalls: () => calls,
      getCallsForMethod: (method: string) =>
        calls.filter((c) => c.method === method),
    }
  }
}
```

## Sequence-Based Testing

Test orchestration, not just outputs:

```typescript
import { describe, it } from "@effect/vitest"

describe("deploy command", () => {
  it.effect("checks clean before deploying", () =>
    Effect.gen(function* () {
      const git = GitService.Test()
      const deploy = DeployService.Test()

      yield* deployCommand.pipe(
        Effect.provide(git.layer),
        Effect.provide(deploy.layer)
      )

      // Verify call sequence
      const gitCalls = git.getCalls()
      const deployCalls = deploy.getCalls()

      expect(gitCalls[0]).toMatchObject({ method: "ensureClean" })
      expect(deployCalls[0]).toMatchObject({
        method: "push",
        args: expect.arrayContaining(["staging"]),
      })
    })
  )

  it.effect("fails if working tree dirty", () =>
    Effect.gen(function* () {
      const git = GitService.Test({ dirty: true })
      const deploy = DeployService.Test()

      const result = yield* deployCommand.pipe(
        Effect.provide(git.layer),
        Effect.provide(deploy.layer),
        Effect.either
      )

      expect(result._tag).toBe("Left")
      expect(deploy.getCalls()).toHaveLength(0) // Never reached
    })
  )
})
```

## Lazy Layer Provision

Pay layer cost only when needed:

```typescript
// layers/db.ts
import { Effect, Layer } from "effect"
import { SqlClient } from "@effect/sql"

// Heavy layer - DB connection
const DbLayer = Layer.effect(
  SqlClient,
  Effect.gen(function* () {
    // Expensive: connects to database
    return yield* createDbConnection()
  })
)

// Wrapper for lazy provision
export function withDb<A, E>(
  effect: Effect.Effect<A, E, SqlClient>
): Effect.Effect<A, E | DbConnectionError> {
  return Effect.provide(effect, DbLayer)
}

// In command: only connects if path taken
const command = Command.make("cmd", { query: Args.optional(Args.text()) }, ({ query }) =>
  Option.match(query, {
    onNone: () => showHelp(), // No DB needed
    onSome: (q) => withDb(runQuery(q)), // DB only when querying
  })
)
```

Layer scoping for resource cleanup:

```typescript
export function withScopedDb<A, E>(
  effect: Effect.Effect<A, E, SqlClient>
): Effect.Effect<A, E | DbConnectionError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const db = yield* Layer.buildWithScope(DbLayer, scope)
      return yield* Effect.provide(effect, db)
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
6. **Dual exports**: Unprovided for tests, provided for production
7. **Test factories**: Return layer + call tracking helpers
8. **Lazy provision**: Defer heavy layers until needed
9. **Sequence testing**: Verify call order, not just final state
