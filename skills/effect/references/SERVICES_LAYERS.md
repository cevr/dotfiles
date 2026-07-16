# Services and Layers

Treat a service as a deep module: its interface expresses domain operations, while its layer owns construction, resources, config, and adapters.

## Canonical service

```ts
import { Context, Effect, Layer } from "effect"

class Users extends Context.Service<Users, {
  readonly find: (id: string) => Effect.Effect<User, UserNotFound>
}>()("@acme/app/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function*() {
      const db = yield* Database

      const find = Effect.fn("Users.find")(function*(id: string) {
        return yield* db.findUser(id).pipe(
          Effect.flatMap(Effect.fromOption(() => new UserNotFound({ id })))
        )
      })

      return Users.of({ find })
    })
  )
}
```

- Use stable, package-qualified service keys.
- Put public and non-trivial internal operations behind named `Effect.fn` boundaries.
- Yield dependencies inside the layer or operation and let requirements remain in the Effect type.
- Return `Service.of(...)` so implementation drift is checked against the interface.
- Keep layers at composition roots; providing a dependency deep inside business logic hides the real graph.

## Layer selection

- `Layer.succeed(Service, value)`: already-constructed pure implementation.
- `Layer.sync(Service, thunk)`: lazy synchronous construction.
- `Layer.effect(Service, effect)`: effectful or scoped construction.
- `Layer.provide(target, dependency)`: satisfy a target requirement.
- `Layer.merge(left, right)`: expose independent outputs together.
- `Layer.unwrap(effectOfLayer)`: choose or construct a layer effectfully.

Draw the input and output services before using `merge`, `mergeAll`, or `provideMerge`. The final application layer should have no accidental requirements and should expose only what the runtime launches.

## Test services

Keep a behaviorally faithful fake next to the service or in test support:

```ts
static layerTest = (users: ReadonlyMap<string, User>) =>
  Layer.succeed(Users, Users.of({
    find: Effect.fn("Users.find")(function*(id) {
      const user = users.get(id)
      if (user === undefined) return yield* new UserNotFound({ id })
      return user
    })
  }))
```

Prefer a fake with explicit state and failure controls over a partial object whose omitted behavior silently succeeds.

## External adapters

Construct SDK clients once in a layer. Expose named domain operations for known use cases; keep a generic escape hatch only when callers genuinely need the provider surface.

```ts
const createCustomer = Effect.fn("Billing.createCustomer")(function*(input: Input) {
  return yield* Effect.tryPromise({
    try: () => client.customers.create(input),
    catch: (cause) => mapBillingError(cause)
  })
})
```

Map provider failures at the adapter boundary without discarding status, code, retry metadata, or cause information needed upstream.

## Resources and runtime edges

- In Effect v4, construct scoped services with `Layer.effect(Service, effect)`: it removes the `Scope` requirement from the layer output. There is no `Layer.scoped(...)` constructor.
- Acquire resources with scoped effects inside that owning layer and register release there.
- Start background fibers with `Effect.forkScoped`; the layer's scope owns their lifetime.
- Use `ManagedRuntime` only at a non-Effect host boundary that repeatedly runs Effect programs.
- Use `Context.Reference` for ambient policy with a truthful default, such as log level. Model credentials, persistence, transports, and authority as required services.
