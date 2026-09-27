# Railway

Railway resources in Alchemy: Projects, Services and their three code sources, custom domains, data stores, and variables.

## Contents

- Resources at a glance
- Project
- Service sources: `main`, Dockerfile context, `image`
- Custom domain on a Cloudflare zone (worked example)
- Data and variables
- Gotchas

## Resources at a Glance

| Resource | Import | Notes |
|----------|--------|-------|
| `Project` | `alchemy/Railway/Project` | Pass `name` and `workspaceId` to land in a specific workspace. Production is `project.environmentId`; never recreate it as an `Environment`. |
| `Service` | `alchemy/Railway/Service` | A container. See §Service sources. `url` is `https://{name}.up.railway.app` unless `publicDomain: false`. |
| `CustomDomain` | `alchemy/Railway/CustomDomain` | `{ service, environment: project, domain, targetPort }`. Exposes `verificationToken`, `verificationDnsHost`, `certificateStatus`, and `url`, but not the CNAME target. |
| `Postgres` / `MySQL` / `Mongo` / `Redis` | `alchemy/Railway` | Bind with `ConnectPostgres`, `ConnectMySQL`, `ConnectMongo`, or `ReadWriteRedis` plus the matching `…Http` Layer. |
| `Bucket` | `alchemy/Railway` | Bind with `PutObject`, `GetObject`, `HeadObject`, `ListObjectsV2`, or `DeleteObject`. |
| `Volume` | `alchemy/Railway` | `MountVolume(volume, { path })` in one Service. |
| `Variable` | `alchemy/Railway` | For a value Railway owns. `Railway.ref(Db, "DATABASE_URL")` for templates. |
| `Environment` | `alchemy/Railway` | Extra environments such as staging. |
| `providers()` | `alchemy/Railway/Providers` | Credentials come from `RAILWAY_API_TOKEN` or the profile's Railway login. |

The `alchemy/Railway` barrel also exports `Website`, which needs `@alchemy.run/frontend-frameworks`. Use subpaths when that peer is absent.

## Service Sources

Pick one:

| Source | Props | When |
|--------|-------|------|
| Effect-native | `main: import.meta.url` + the constructor Effect | The default for Effect servers (ytt.cvr.im runs this way: a code change deploys in about 30 s). Alchemy bundles the file and generates a Dockerfile (`FROM node:26-slim`, `ENTRYPOINT node /app/index.mjs`), and the upload is skipped when the hash is unchanged. `build: { install: ["pg"] }` for CJS or native packages, and `image` for another base (it must run the bundle). |
| Dockerfile context | `context: <dir>`, `dockerfilePath: "Dockerfile"` | The runtime needs Bun APIs, a native toolchain, or an unbundled source tree. |
| Image | `image: "org/name:tag"` | A prebuilt public image. |
| GitHub | `repo`, `branch`, `rootDirectory`, `buildCommand`, `startCommand` | Railway builds from the repo (requires a GitHub connection). |

Common props: `port` (written to `PORT`, default 3000), `region` (`us-east4`, `us-west2`, …), `healthcheck` plus `healthcheckTimeout` (seconds), `restartPolicyType`, `restartPolicyMaxRetries`, `sleepApplication` (scale to zero on idle), `publicDomain` (false when only a custom domain should serve it), and `cronSchedule`.

### Dockerfile context

Reach for this only when the Effect-native source cannot work. Alchemy tars the context the way `railway up` does, but it walks every file before applying ignore files (limits: 32 MiB and 10k entries). Generate a minimal context on every plan instead of pointing at the repo root:

```typescript
// infra/context.ts
const FILES = ["package.json", "bun.lock", "tsconfig.json", "src"];
export const makeContext = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const infra = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const root = path.dirname(infra);
  const context = path.join(root, ".deploy");          // git-ignored
  yield* fs.remove(context, { recursive: true, force: true });
  yield* fs.makeDirectory(context, { recursive: true });
  yield* Effect.forEach(FILES, (f) => fs.copy(path.join(root, f), path.join(context, f)), { discard: true });
  yield* fs.copyFile(path.join(infra, "Dockerfile"), path.join(context, "Dockerfile"));
  return context;
}).pipe(Effect.provide(BunServices.layer));

// alchemy.run.ts
const context = yield* Effect.orDie(makeContext);
yield* Service("Server", { project, context, dockerfilePath: "Dockerfile", port: 8080, healthcheck: "/health" });
```

In the Dockerfile, strip the `prepare` script before `bun install --production --frozen-lockfile`, because lefthook and `effect-tsgo patch` are absent from the image. Copy the manifests first so the install layer caches, which keeps builds inside Alchemy's roughly 50s wait.

## Custom Domain on a Cloudflare Zone

Declare this only in `prod` (`const { stage } = yield* Alchemy.Stack`). A test or preview stage that repeats it collides on the hostname and the DNS records.

Railway asks for two records: a CNAME to a per-domain edge host, and a TXT `_railway-verify.<domain>`. `CustomDomain` does not expose the CNAME target, so read it back from Railway's GraphQL API (`@distilled.cloud/railway`) inside `Output.mapEffect`:

```typescript
import * as railway from "@distilled.cloud/railway";

const edgeTarget = (d: { customDomainId: string; projectId: string }) =>
  railway.customDomain(
    { id: d.customDomainId, projectId: d.projectId },
    { status: { dnsRecords: { recordType: true, requiredValue: true } } },
  ).pipe(
    Effect.flatMap((found) => {
      const cname = found.status.dnsRecords.find((r) => r.recordType === "DNS_RECORD_TYPE_CNAME");
      return cname ? Effect.succeed(cname.requiredValue) : Effect.die(new Error("no CNAME requested"));
    }),
    Effect.orDie,
  );

const domain = yield* CustomDomain("Domain", { service, environment: project, domain: DOMAIN, targetPort: PORT });
const zone = yield* Cloudflare.Zone.Zone("Zone", { name: ZONE }).pipe(
  Alchemy.AdoptPolicy.adopt(true),
  Alchemy.RemovalPolicy.retain(),
);
yield* Cloudflare.DNS.Record("Cname", {
  zoneId: zone.zoneId, name: DOMAIN, type: "CNAME", proxied: false, // Railway terminates TLS
  content: Output.all(domain.customDomainId, domain.projectId).pipe(
    Output.mapEffect(([customDomainId, projectId]) => edgeTarget({ customDomainId, projectId })),
  ),
});
yield* Cloudflare.DNS.Record("Verify", {
  zoneId: zone.zoneId, name: `_railway-verify.${DOMAIN}`, type: "TXT",
  content: domain.verificationToken.pipe(
    Output.mapEffect((t) => Effect.fromOption(Option.fromNullishOr(t)).pipe(Effect.orDie)),
  ),
});
```

The stack's providers are `Cloudflare.providers().pipe(Layer.provideMerge(providers()))`. The certificate is issued within minutes of the records resolving; check `certificateStatus` in the outputs.

## Data and Variables

```typescript
export const Db = Railway.Postgres("Db", { project: Site });
// in a Service constructor:
const conn = yield* Railway.ConnectPostgres(Db);   // provide Railway.ConnectPostgresHttp
```

- Service-to-service traffic uses `{name}.railway.internal`. Schemaless RPC (`bindService`) stays on the private mesh, and public `/__rpc__/*` requests get a 401.
- `Config.Redacted("KEY")` in the constructor binds a `.env` secret onto the Service. Use `Railway.Variable` when several services share one value that Railway owns.

## Gotchas

- `alchemy logs` does not support Railway yet. Use `railway logs` or `railway ssh --project <id> --service <name> --environment production -- <cmd>`.
- Changing `project` replaces the Service, while changing `region` updates it in place.
- Railway egress IPs are shared datacenter IPs. Third parties such as YouTube may bot-wall them, depending on which container you land on.
- Workspace is not a resource. Alchemy uses the token's default workspace unless the Project sets `workspaceId`.
