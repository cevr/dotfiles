---
name: alchemy
description: Alchemy v2, Effect-native infrastructure as code (`alchemy.run.ts` stacks) with Infrastructure as Effects on top. Use when deploying or provisioning infrastructure (Railway, Cloudflare, AWS, DNS, custom domains), writing or reviewing `alchemy.run.ts`, binding cloud resources into Effect application code, or running `alchemy` deploys, profiles, stages, state, or CI.
---

# Alchemy

Alchemy (`alchemy-run/alchemy`, npm `alchemy`, v2 beta) is our infrastructure layer. A **Stack** is an Effect that yields **Resources**, and **Providers** are Layers. The same program can also carry the code that runs on those resources: a **Runtime** such as a Railway Service or a Cloudflare Worker, typed **Bindings**, and **Layers** that own their infrastructure. That second part is Infrastructure as Effects.

## Navigation

```
What are you doing?
├─ Adding Alchemy to a repo              → §Setup
├─ Writing alchemy.run.ts                → §Stack Anatomy, then the platform reference
├─ Putting app code on a Runtime         → references/app-code.md
├─ Railway service / domain / database   → references/railway.md
├─ Cloudflare Worker / DNS / zone / state → references/cloudflare.md
├─ Deploying, profiles, stages, CI, state → references/operations.md
└─ Something failed                      → §Gotchas, then references/operations.md §Troubleshooting
```

| Topic | File | When to Read |
|-------|------|--------------|
| App-level code | `references/app-code.md` | Runtimes with `main: import.meta.url`, bindings, `Config` binding, `HttpRouter` in `fetch`, Layers that own resources, phases, the test harness |
| Railway | `references/railway.md` | Project, Service (the `main`, `context`+`dockerfilePath`, and `image` sources), CustomDomain, Postgres/Redis/Bucket, Variables |
| Cloudflare | `references/cloudflare.md` | Workers, Zone/DNS records, adopting a zone, `Cloudflare.state()`, OAuth scopes |
| Operations | `references/operations.md` | CLI, profiles and credentials, stages, state, adopt/retain/rename, CI, troubleshooting |

## Source Rule

Beta APIs move. Check the installed `node_modules/alchemy/src` for the pinned version before guessing. For the upstream source and docs, run `okra repo fetch alchemy-run/alchemy`; the docs are in `website/src/content/docs/` and working stacks in `examples/` (`railway-service`, `cloudflare-worker`, `monorepo-*`). When the docs and the source disagree, trust the source. For example, the docs say the Railway image is `oven/bun:1`, but the source default is `node:26-slim`.

## Setup

```bash
bun add -D alchemy @effect/platform-node@<effect version>   # plus a provider SDK when you call its API directly, e.g. @distilled.cloud/railway
```

- Pin `alchemy` exactly (`2.0.0-beta.79`, not `^`). Check `npm view alchemy dist-tags`: `latest` is the newest beta, and `next` can be older.
- Alchemy's peers are `effect`, `@effect/platform-bun`, and `@effect/platform-node` at `>=4.0.0-rc.115`. Keep all three on the project's exact Effect version. `alchemy/Cloudflare` loads `@effect/platform-node` even under Bun.
- `devDependencies` is fine even when app code imports `alchemy/*`: the Runtime bundle inlines everything `main` imports, and nothing installs at runtime unless `build.install` asks for it.

`package.json` scripts:

```json
{
  "plan": "alchemy plan alchemy.run.ts --stage prod",
  "deploy": "alchemy deploy alchemy.run.ts --stage prod"
}
```

`.gitignore`: add `.alchemy`, the local state and bundle output, plus any generated build context (`.deploy`). Local state is the only record of what the stack owns, so keep it on disk (see operations.md §State).

`tsconfig.json`: include `alchemy.run.ts` (and `infra/`). If a provider's Resource types leak `any` into `R`, relax only that file with a plugin override:

```json
"overrides": [{ "include": ["alchemy.run.ts"], "options": { "diagnosticSeverity": { "anyUnknownInErrorContext": "off" } } }]
```

`.oxlintrc.json`: add `.alchemy` to `ignorePatterns`.

## Stack Anatomy

```typescript
// alchemy.run.ts: composition root. Name the stack, merge providers, pick state, return outputs.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { providers as railwayProviders } from "alchemy/Railway/Providers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "myapp",
  {
    providers: Cloudflare.providers().pipe(Layer.provideMerge(railwayProviders())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api; // registering is lazy: nothing touches the cloud until plan/apply
    return { url: api.url };
  }),
);
```

| Concept | Rule |
|---------|------|
| Logical ID | The first string argument. It keys state and must stay stable, so changing it is a replacement. For a rename, use `.pipe(Alchemy.renamedFrom("Old"))`. |
| Physical name | Generated as `{stack}-{stage}-{id}-{instance}`. Pass `name` only when a human-facing name matters, such as a Railway project or service. |
| Output | Resource attributes are lazy `Output<T>`, and passing one into props adds a graph edge. Transform with `Output.map`, `Output.mapEffect` (the Effect must have `E = never`, so `orDie` lookups), `Output.all`, and `` Output.interpolate`…` ``. |
| Declaration | `export const Db = Railway.Postgres("Db", {...})` at module scope is inert, and yielding it anywhere registers it once. |
| Stage | `live_$USER` by default for deploy, `dev_$USER` for dev, and `test_$USER` for tests. Prod deploys pass `--stage prod`. |
| Policies | `Alchemy.AdoptPolicy.adopt(true)` takes over existing cloud objects, and `Alchemy.RemovalPolicy.retain()` stops Alchemy from deleting them. Both apply to every resource in the piped scope. |

Keep `alchemy.run.ts` as wiring. Put each Resource, Runtime, or resource-owning Layer in its own `src/` module, and group resources that share a lifecycle.

## Choosing the Shape

| You need | Shape |
|----------|-------|
| An Effect HTTP server on Railway | An Effect-native `Railway.Service` class with `main: import.meta.url` that returns `{ fetch: HttpRouter.toHttpEffect(Routes) }`, with no Dockerfile (app-code.md) |
| A server that must keep its own Dockerfile (Bun-only APIs, a native toolchain) | `Railway.Service` with `context` + `dockerfilePath` (railway.md §Dockerfile) |
| An edge function | `Cloudflare.Worker` with `main: import.meta.url` (cloudflare.md) |
| A database, cache, or bucket used by app code | The Resource plus a Binding in the Runtime's constructor, never a hand-wired env var (app-code.md §Bindings) |
| A DNS record for a non-Cloudflare host | An adopted and retained `Cloudflare.Zone.Zone` plus `Cloudflare.DNS.Record` (cloudflare.md §DNS) |
| A secret from `.env` | `yield* Config.Redacted("KEY")` in the constructor (app-code.md §Config) |

## Gotchas

- **Import subpaths when a barrel drags in peers.** `alchemy/Railway` re-exports `Website`, which needs the optional `@alchemy.run/frontend-frameworks` peer. Import from `alchemy/Railway/Service`, `/Project`, `/CustomDomain`, and `/Providers` instead.
- **`Output.mapEffect` needs `E = never`.** Finish lookups with `Effect.orDie`, and die with a descriptive error when a value is missing, since that failure stops the plan.
- **Environment credentials beat the profile.** When every variable a provider needs is set (`RAILWAY_API_TOKEN`, or `CLOUDFLARE_API_TOKEN`+`CLOUDFLARE_ACCOUNT_ID`), including through `.env`, that provider ignores the profile. Remove the variables to use OAuth.
- **Agents get plain mode, which never prompts.** It prints the plan and exits 1 with "Pass --yes". Run `alchemy deploy --stage <s> --yes` only after you have read `alchemy plan` output.
- **Profile login is interactive.** An agent cannot complete `alchemy profile edit --add <Provider>`. Ask the user to run it with `! bunx alchemy profile edit --add Cloudflare`.
- **Cloudflare OAuth "Basic" scopes cannot write DNS.** Pick All Scopes, or Custom with `zone.read`, `dns.read`, `dns.write`, `memberships.read`, plus what else the stack touches.
- **`Config` read only inside `fetch` is never bound.** Resolve it in the constructor and close over the value.
- **Railway Services wait about 50s for the build.** Keep the image small and the install layer cached. A slow build fails the deploy even when Railway finishes later.
- **Local build contexts are walked in full before ignore files apply** (limits: 32 MiB and 10k entries). Point `context` at a generated directory with only the files the image needs, never at a repo root with `node_modules`.
- **Losing `.alchemy/` means the next deploy creates everything again.** Recover by adopting (`--adopt`) instead.
