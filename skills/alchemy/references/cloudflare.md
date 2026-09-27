# Cloudflare

Cloudflare resources in Alchemy: Workers, R2/KV/D1/Queues/Durable Objects, DNS, the remote state store, and credentials.

## Contents

- Imports and providers
- Workers
- DNS and zones
- State store
- Credentials and OAuth scopes

## Imports and Providers

```typescript
import * as Cloudflare from "alchemy/Cloudflare"; // barrel: Worker, R2, KV, D1, Zone, DNS, ApiToken, providers(), state()
```

The barrel loads `@effect/platform-node`, so install it at the project's exact Effect version even on Bun. Merge `Cloudflare.providers()` with other providers using `Layer.mergeAll`, or `Layer.provideMerge` when one provider's layer needs another's services.

## Workers

```typescript
export const Uploads = Cloudflare.R2.Bucket("Uploads");

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Uploads);
    return {
      fetch: Effect.gen(function* () {
        const obj = yield* bucket.get("hello.txt");
        return obj ? HttpServerResponse.text(yield* obj.text()) : HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
```

- The binding layers are `…Binding` for native Worker bindings and `…Http` for HTTP with a scoped token minted at deploy.
- Worker-to-Worker RPC: `yield* Cloudflare.Workers.bindWorker(Other)`.
- The async style (`main: "./src/worker.ts"`, `env: { Uploads }`, `Cloudflare.InferEnv<typeof Worker>`) works, but prefer the Effect style for new code.
- `alchemy dev` runs Workers in workerd with local R2/KV/D1/Queues. Pipe `.pipe(Alchemy.remote())` to force one resource live.

## DNS and Zones

Adopt an existing zone and never modify or delete it:

```typescript
const zone = yield* Cloudflare.Zone.Zone("Zone", { name: "example.com" }).pipe(
  Alchemy.AdoptPolicy.adopt(true),
  Alchemy.RemovalPolicy.retain(),
);
yield* Cloudflare.DNS.Record("App", {
  zoneId: zone.zoneId, name: "app.example.com", type: "CNAME",
  content: target,          // a string or an Output<string>
  proxied: false,           // false when the origin terminates TLS (Railway, Fly)
  comment: "app (alchemy)",
});
```

- The props of an adopted zone must match its live settings (full type, unpaused, no vanity name servers), or the adopt becomes an update.
- `Zone` already defaults to `retain`. Keep the explicit `retain()` as documentation.
- If a record with the same name already exists outside Alchemy, delete it or adopt the record too.

## State Store

- `Alchemy.localState()` writes `.alchemy/` and is enough for solo projects.
- `Cloudflare.state()` is a Worker-backed store shared across machines and CI. Its bootstrap token lives in the Cloudflare Secrets Store, so CI tokens need `Secrets Store Write`.

## Credentials and OAuth Scopes

- Profile login: `bunx alchemy profile edit --add Cloudflare` (interactive), then choose OAuth or an API token.
- The OAuth **Basic** scope set cannot write DNS. Choose **All Scopes**, or **Custom** with `zone.read`, `dns.read`, `dns.write`, `memberships.read`, plus workers/r2/kv/d1 write for the resources the stack declares. Re-run with `--reconfigure Cloudflare` to change scopes.
- In CI, set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Mint that token from a separate `stacks/github.ts` using `Cloudflare.ApiToken.AccountApiToken` + `GitHub.Secret`, deployed once with an `admin` profile (operations.md §CI).
- `const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;` reads the active account. The double yield resolves refreshable credentials.
