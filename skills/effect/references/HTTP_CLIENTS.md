# HTTP Clients

Use the Effect HTTP client when an application benefits from typed failures, schema codecs, layers, request transforms, tracing, or retry policy.

## Adapter pattern

```ts
import { Context, Effect, Layer, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"

const RemoteUser = Schema.Struct({ id: Schema.String, name: Schema.String })
interface RemoteUser extends Schema.Schema.Type<typeof RemoteUser> {}

class UsersApi extends Context.Service<UsersApi, {
  readonly get: (id: string) => Effect.Effect<RemoteUser, UsersApiError>
}>()("@acme/app/UsersApi") {
  static readonly layer = Layer.effect(
    UsersApi,
    Effect.gen(function*() {
      const base = yield* HttpClient.HttpClient
      const client = base.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.example.com"))
      )

      const get = Effect.fn("UsersApi.get")(function*(id: string) {
        return yield* client.get(`/users/${id}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteUser)),
          Effect.mapError(mapUsersApiError)
        )
      })

      return UsersApi.of({ get })
    })
  )
}
```

Construct and transform the client once in the layer. Expose domain operations rather than leaking raw response types across the adapter boundary.

## Requests and responses

- Build requests with `HttpClientRequest` combinators.
- Encode typed JSON bodies with `HttpClientRequest.schemaBodyJson(schema)`.
- Decode typed JSON responses with `HttpClientResponse.schemaBodyJson(schema)`.
- Decide status behavior before decoding. Map expected statuses to specific domain errors and preserve unexpected response metadata.
- Bound response bodies and redact credentials in logs and errors.

## Retry

```ts
const client = base.pipe(
  HttpClient.retryTransient({
    times: 4,
    schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered)
  })
)
```

`HttpClient.retryTransient` can handle transient transport errors and responses such as rate limits. Keep it bounded, honor provider retry metadata when possible, and apply it only to idempotent requests. For a non-idempotent endpoint, use a provider-supported idempotency key or keep retries disabled.

## Boundary errors

Distinguish at least:

- request construction or URL failure;
- transport or timeout failure;
- expected non-success status;
- unexpected status;
- response decode failure.

Collapse these only when callers truly make the same recovery decision. Keep the original cause and safe response metadata available for observability.
