# App-level Code: Infrastructure as Effects

How application code carries its own infrastructure: a Runtime declared next to the code it runs, Bindings that hand back typed clients, and Layers that own resources.

## Contents

- Runtime (`main: import.meta.url`)
- Phases
- Serving an HttpRouter or HttpApi from `fetch`
- Bindings
- Config and secrets
- Layers that own infrastructure
- Keeping the app runnable without Alchemy
- Testing

## Runtime

A Runtime is a Resource that carries code: `Railway.Service`, `Railway.Function`, `Cloudflare.Worker`, `AWS.Lambda.Function`, and ECS/Fly/Docker services. Its third argument is the **Effectful Constructor**, which binds what the code needs and returns what it exposes.

```typescript
// src/Api.ts: declaration and runtime code in one file
import { Service } from "alchemy/Railway/Service";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Site } from "./Site.ts";

export default class Api extends Service<Api>()(
  "Api",
  { project: Site, main: import.meta.url, port: 3000, healthcheck: "/health" },
  Effect.gen(function* () {
    // Construction: runs at plan time AND at cold start
    return {
      // Runtime: runs per request
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
```

- `main: import.meta.url` makes this file the bundle entry. Alchemy bundles it with Rolldown, and the default export must be the Runtime.
- Declaration forms:
  - Inline: `Service("Api", props, effect)`.
  - Class: `class Api extends Service<Api>()(…) {}`, which gives a nominal type in hovers and outputs.
  - Tag + `.make()`: `class Api extends Service<Api, {}>()("Api") {}` plus `export default Api.make(props, effect)`, with the Layer provided to the Stack. Use it when other Runtimes bind `Api` and must not bundle its implementation, or for circular bindings.
- Return methods next to `fetch` to expose schemaless RPC. Other Runtimes bind them with `Railway.bindService(Api)` or `Cloudflare.Workers.bindWorker(Api)`.
- For a background service, omit `fetch` and register a loop with `yield* ServerHost` (from `alchemy/Server`) and `host.run(effect)`.

## Phases

| Phase | Code | Runs |
|-------|------|------|
| Construction | the outer `Effect.gen` | at plan time to discover bindings, then again at cold start |
| Runtime | the returned `fetch` and methods | per request, in the deployed process |

- Build things once per instance: bindings, clients, `Config` values, and the router's `HttpEffect`.
- Use things per request. Acquire disposables such as connections inside the handler, because instance finalizers are best effort.
- An Effect that requires `Alchemy.RuntimeContext` compiles only inside the runtime closure.
- The deploy-time wiring inside bindings sits behind `globalThis.__ALCHEMY_RUNTIME__`, which the bundler folds away. Provisioning code never ships in the bundle.
- `ALCHEMY_PHASE` is `plan` or `runtime`. `ALCHEMY_DEV` (exported from `alchemy`) is true under `alchemy dev`.

## Serving an HttpRouter or HttpApi from `fetch`

`fetch` is an `HttpEffect`: `Effect<HttpServerResponse, HttpServerError | HttpBodyError, HttpServerRequest | Scope | …>`. Turn a router Layer into one with `HttpRouter.toHttpEffect`, which builds the Layer once at boot:

```typescript
import { HttpRouter } from "effect/unstable/http";

export default class Api extends Service<Api>()(
  "Api",
  { project: Site, main: import.meta.url, port: 3000, healthcheck: "/health" },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(
      Routes.pipe(Layer.provide(AppLive)), // the same Routes the local server uses
    );
    return { fetch };
  }).pipe(Effect.provide(FetchHttpClient.layer)),
) {}
```

- Routes must map domain errors to responses before they reach `fetch` (a `catchTags` → status map per route). The error channel only admits HTTP server errors.
- For HttpApi: `HttpRouter.toHttpEffect(HttpApiBuilder.layer(Api).pipe(Layer.provide(GroupLive)))`.
- The host supplies the HTTP server itself: Bun or Node on containers, workerd on Workers. `BunHttpServer.layer` is not provided here.
- The Railway `main` image runs `node` (`node:26-slim`). Keep runtime code off `Bun.*` and `@effect/platform-bun`-only services, or pass `image` with a Bun base.

## Bindings

A Binding is one `yield*` that declares the capability, wires the permission and config at deploy time, and returns a typed client.

```typescript
Effect.gen(function* () {
  const conn = yield* Railway.ConnectPostgres(Db);       // typed connection string
  const cache = yield* Railway.ReadWriteRedis(Cache);
  const put = yield* Railway.PutObject(Data);
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(Uploads);
  return { fetch: /* uses conn, cache, put, bucket */ };
}).pipe(
  Effect.provide(Layer.mergeAll(
    Railway.ConnectPostgresHttp, Railway.ReadWriteRedisHttp, Railway.PutObjectHttp,
    Cloudflare.R2.ReadWriteBucketBinding,
  )),
);
```

- Every Binding is a contract (`Binding.Service`) paired with an implementation Layer: `…Binding` for native Worker bindings, `…Http` for HTTP/SDK with a scoped credential. Provide exactly the ones you use, so each one adds one client and one grant.
- A Layer that needs a platform the host cannot supply is a compile error, for example an R2 native binding on a Lambda.
- Calling a binding outside a Runtime (`AWS.EC2.getAmi(...)`) is a plan-time lookup that returns an `Output`.

## Config and Secrets

`Config` values yielded in the **constructor** are read from the deployer's environment (`.env` plus the shell) and bound onto the Runtime as secrets. At runtime the same `Config` resolves from that binding.

```typescript
// GOOD: bound at deploy, captured for requests
Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("API_KEY");
  return { fetch: Effect.gen(function* () { /* Redacted.value(apiKey) */ }) };
});

// BAD: read only in fetch, so it was never discovered at plan time and is missing at runtime
return { fetch: Effect.gen(function* () { const k = yield* Config.Redacted("API_KEY"); }) };
```

- Combinators re-run at runtime against the raw source. Defaults are never bound, so keep them deterministic.
- Use `env: {...}` only for a known plain value. On Railway, use `Railway.Variable` for values Railway should own and share, and `Railway.ref(Db, "DATABASE_URL")` for Railway templates.

## Layers That Own Infrastructure

A service Layer can declare its own Resource and Binding, so providing the Layer brings the infrastructure into the Stack. This is the app-level seam to reach for.

```typescript
export class Jobs extends Context.Service<Jobs, {
  readonly get: (id: string) => Effect.Effect<Job | undefined, JobsError, Alchemy.RuntimeContext>;
}>()("app/Jobs") {}

export const JobsKV = Layer.effect(Jobs, Effect.gen(function* () {
  const ns = yield* Cloudflare.KV.Namespace("Jobs");         // a Resource the Layer owns
  const kv = yield* Cloudflare.KV.ReadWriteNamespace(ns);    // its Binding
  return Jobs.of({ get: Effect.fn("Jobs.get")((id) => kv.get<Job>(id, "json")) });
}));

// in the Runtime: Effect.provide(JobsKV.pipe(Layer.provide(Cloudflare.KV.ReadWriteNamespaceBinding)))
```

- Handlers depend on `Jobs` only. Swapping `JobsKV` for `JobsDynamo` is a one-line provide change, and it can cross clouds.
- A stable logical ID means two Runtimes that provide the same Layer share one namespace.
- Mark methods that only work in a deployed handler with `Alchemy.RuntimeContext` in `R`.
- Use `Layer.mergeAll` for independent services and `Layer.provide` to satisfy a dependency privately.

## Keeping the App Runnable Without Alchemy

When the app also runs as a CLI or a local `bun --watch` server, keep domain services, routes, and errors Alchemy-free. The Runtime module is a thin adapter: it imports `Routes` and `AppLive` and wraps them with `toHttpEffect`. Put Alchemy-specific Layers (bindings, resource-owning Layers) behind the same `Context.Service` tags the local entry satisfies with local Layers, such as an in-memory or file implementation. Tests keep using the local Layers.

## Testing

- Keep unit and route tests on local Layers (`HttpRouter.serve` + `BunHttpServer.layerTest`). They need no Alchemy.
- For integration tests against a real deploy, use `Test.make` from `alchemy/Test/Bun`. It deploys once per file into `test_$USER`, and each test drives the output URL:

```typescript
import * as Test from "alchemy/Test/Bun";
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state: Alchemy.localState() });
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!process.env.CI)(destroy(Stack));
test("health", Effect.gen(function* () {
  const { url } = yield* stack;
  const res = yield* Test.getWhenReady(`${url}/health`); // retries 404/5xx while the edge converges
  expect(res.status).toBe(200);
}));
```

- `Test.make({ dev: true })` runs against the local emulators (workerd, Docker) and needs no cloud credentials.
