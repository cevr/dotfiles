# Client Wrapper

Wrap third-party Promise-based SDKs as Effect services (v4).

## Template

```typescript
import { ServiceMap, Effect, Layer, Schema } from "effect"

// 1. Error class — v4 uses TaggedErrorClass
export class StripeError extends Schema.TaggedErrorClass<StripeError>()(
  "StripeError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }
) {}

// 2. Service — v4 uses ServiceMap.Service
class StripeService extends ServiceMap.Service<StripeService, {
  readonly use: <A>(fn: (client: Stripe) => Promise<A>) => Effect.Effect<A, StripeError>
}>()("StripeService") {
  // Live → layer
  static layer = (apiKey: string) =>
    Layer.succeed(StripeService, {
      use: (fn) =>
        Effect.tryPromise({
          try: () => fn(new Stripe(apiKey)),
          catch: (e) =>
            new StripeError({
              message: e instanceof Error ? e.message : String(e),
              code: (e as any)?.code,
            }),
        }),
    })

  // Test → layerTest
  static layerTest = (mock: Partial<Stripe> = {}) =>
    Layer.succeed(StripeService, {
      use: (fn) =>
        Effect.tryPromise({
          try: () => fn(mock as Stripe),
          catch: (e) => new StripeError({ message: String(e) }),
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

```typescript
class SentryApi extends ServiceMap.Service<SentryApi, {
  readonly listOrganizations: () => Effect.Effect<Array<Org>, ApiError>
  readonly getProject: (slug: string) => Effect.Effect<Project, ApiError>
  readonly use: <A>(fn: (client: SentryClient) => Promise<A>) => Effect.Effect<A, ApiError>
}>()("SentryApi") {
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

## Key Principles

- **One error class per SDK** — `Schema.TaggedErrorClass` in v4
- **`use` as escape hatch** — named methods for common ops, `use` for one-offs
- **`static layer` / `static layerTest`** — v4 naming convention
- **Always testable** — mock the SDK client, not the Effect service
