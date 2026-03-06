# Client Wrapper

Wrap third-party Promise-based SDKs as Effect services.

## Template

```typescript
import { Context, Effect, Layer, Schema } from "effect"

// 1. Error class
export class StripeError extends Schema.TaggedError<StripeError>()(
  "StripeError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }
) {}

// 2. Service shape
export interface StripeServiceShape {
  readonly use: <A>(
    fn: (client: Stripe) => Promise<A>
  ) => Effect.Effect<A, StripeError>
}

// 3. Tag + layers
export class StripeService extends Context.Tag("StripeService")<
  StripeService,
  StripeServiceShape
>() {
  // Live: wraps the real SDK
  static Live = (apiKey: string) => {
    const stripe = new Stripe(apiKey)

    return Layer.succeed(StripeService, {
      use: (fn) =>
        Effect.tryPromise({
          try: () => fn(stripe),
          catch: (e) =>
            new StripeError({
              message: e instanceof Error ? e.message : String(e),
              code: (e as any)?.code,
            }),
        }),
    })
  }

  // Test: mock implementation
  static Test = (mock: Partial<Stripe> = {}) =>
    Layer.succeed(StripeService, {
      use: (fn) =>
        Effect.tryPromise({
          try: () => fn(mock as Stripe),
          catch: (e) =>
            new StripeError({ message: String(e) }),
        }),
    })
}
```

## Usage

```typescript
const createCheckout = Effect.fn("createCheckout")(
  function* (priceId: string) {
    const stripe = yield* StripeService
    return yield* stripe.use((client) =>
      client.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
      })
    )
  }
)
```

## Named Operations Variant

For frequently-used operations, expose named methods instead of raw `use`:

```typescript
export interface SentryApiShape {
  readonly listOrganizations: () => Effect.Effect<Array<Org>, ApiError>
  readonly getProject: (slug: string) => Effect.Effect<Project, ApiError>
  readonly use: <A>(fn: (client: SentryClient) => Promise<A>) => Effect.Effect<A, ApiError>
}

export class SentryApi extends Context.Tag("SentryApi")<
  SentryApi,
  SentryApiShape
>() {
  static make = (token: string) => {
    const client = new SentryClient({ token })
    const use = <A>(fn: (c: SentryClient) => Promise<A>) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: (e) => new ApiError({ message: String(e) }),
      })

    return Layer.succeed(SentryApi, {
      listOrganizations: () => use((c) => c.listOrgs()),
      getProject: (slug) => use((c) => c.getProject(slug)),
      use,
    })
  }
}
```

## With Retry Policy

```typescript
export class HttpApi extends Context.Tag("HttpApi")<
  HttpApi,
  HttpApiShape
>() {
  static Live = Layer.succeed(HttpApi, {
    use: (fn) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: (e) => new HttpError({ message: String(e) }),
      }).pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("100 millis"),
        })
      ),
  })
}
```

## Key Principles

- **One error class per SDK** — don't split by operation unless errors are structurally different
- **`use` as escape hatch** — named methods for common ops, `use` for one-offs
- **Layer.succeed for stateless** — use `Layer.effect` if SDK needs async init
- **Always static `Test`** — mock the SDK client, not the Effect service
