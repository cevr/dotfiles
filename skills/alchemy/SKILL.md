---
name: alchemy
description: Alchemy v2, Effect-native infrastructure as code (`alchemy.run.ts` stacks) with Infrastructure as Effects on top. Use when deploying or provisioning infrastructure (Railway, Cloudflare, AWS, DNS, custom domains), writing or reviewing `alchemy.run.ts`, binding cloud resources into Effect application code, building a backend with `@alchemy.run/domain` (commands, events, one Api projected to HTTP, CLI and MCP), running `alchemy` deploys, profiles, stages, state, or CI, or testing a domain model, a deployed stack, or a provider (`@alchemy.run/test`).
---

# Alchemy

Alchemy (`alchemy-run/alchemy`, npm `alchemy` plus one `@alchemy.run/<provider>` package per cloud, v2 beta) is our infrastructure layer. A **Stack** is an Effect that yields **Resources**, and **Providers** are Layers. The same program can also carry the code that runs on those resources: a **Runtime** such as a Railway Service or a Cloudflare Worker, typed **Bindings**, and **Layers** that own their infrastructure. That second part is Infrastructure as Effects.

## Navigation

```
What are you doing?
├─ Adding Alchemy to a repo               → §Setup
├─ Writing alchemy.run.ts                 → §Stack Anatomy, then the platform reference
├─ Putting app code on a Runtime          → references/app-code.md
├─ Backend on @alchemy.run/domain         → references/domain.md
├─ Stories, Api, stack, provider tests    → references/testing.md
├─ Checking that a deploy really works    → §Test on Real Infrastructure, then testing.md §Stack tests
├─ Railway service / domain / database    → references/railway.md
├─ Cloudflare Worker / DNS / zone / state → references/cloudflare.md
├─ Deploying, profiles, stages, CI, state → references/operations.md
└─ Something failed                       → §Gotchas, then references/operations.md §Troubleshooting
```

| Topic | File | When to Read |
|-------|------|--------------|
| App-level code | `references/app-code.md` | Runtimes with `main: import.meta.url`, bindings, `Config` binding, `HttpRouter` in `fetch`, Layers that own resources, phases |
| Domain backends | `references/domain.md` | Whether to use `@alchemy.run/domain`, the upstream `alchemy-domain` skill, our Go-style layout in place of its kind-suffixed one, the Api's HTTP, CLI and MCP projections, beta.85 gaps |
| Testing | `references/testing.md` | Which test fits, stories, Api tests, stack tests with `@alchemy.run/test`, provider tests, the runner adapters |
| Railway | `references/railway.md` | Project, Service (the `main`, `context`+`dockerfilePath`, and `image` sources), CustomDomain, Postgres/Redis/Bucket, Variables |
| Cloudflare | `references/cloudflare.md` | Workers, Zone/DNS records, adopting a zone, `Cloudflare.state()`, OAuth scopes |
| Operations | `references/operations.md` | CLI, profiles and credentials, stages, state, adopt/retain/rename, CI, troubleshooting |

## Source Rule

Beta APIs move. Check the installed `node_modules/alchemy/src` for the pinned version before guessing. For the upstream source and docs, run `okra repo fetch alchemy-run/alchemy`; the docs are in `website/src/content/docs/` and working stacks in `examples/` (`railway-service`, `cloudflare-worker`, `monorepo-*`). When the docs and the source disagree, trust the source. For example, the docs say the Railway image is `oven/bun:1`, but the source default is `node:26-slim`.

## Setup

```bash
npm view alchemy dist-tags            # take `latest`; `next` can be older
bun add -D -E alchemy@<latest> @alchemy.run/cloudflare@<latest> @effect/platform-node@<effect version>   # one @alchemy.run/<provider> per cloud; plus a provider SDK when you call its API directly, e.g. @distilled.cloud/railway
```

- **Start from the newest release.** Look up `latest` every time you add Alchemy, and never pin a version from memory or from this skill. Pin it exactly (no `^`), because betas break between releases.
- **In an existing repo, compare the pinned version with `latest` first.** If the repo is behind, say so, and read the newer source (`okra repo fetch npm:alchemy@<latest>`) before working around a bug or a missing API; the fix may already have shipped. Upgrade as its own commit, and run `alchemy plan` after it to confirm the plan shows no changes.
- **Providers are their own packages since beta.84** (`@alchemy.run/cloudflare`, `@alchemy.run/railway`, …), released with `alchemy` and peering on its exact version. Pin each at the same version as `alchemy`. The `alchemy/Cloudflare` and `alchemy/Railway/*` paths are gone.
- Alchemy's peers are `effect`, `@effect/platform-bun`, and `@effect/platform-node` (`^4.1.0` from beta.85). Keep all three on the project's exact Effect version. `@alchemy.run/cloudflare` loads `@effect/platform-node` even under Bun.
- **Alchemy `2.0.0-beta.85` and later need Effect 4.1 (peer `^4.1.0`); beta.84 and earlier do not load on 4.1.** Those import `effect/Crypto`, which `effect@4.1.0` removed, so `alchemy plan` and `deploy` fail with `Cannot find package 'effect' imported from …/alchemy/src/Auth/OAuthFlow.ts`. Typecheck, build and unit tests still pass, because none of them load the CLI. Bump Alchemy and Effect together, then run `alchemy plan` as well as the gate.
- **beta.85 upgrades the Cloudflare state store from v7 to v8, one way.** See cloudflare.md §State Store before the first beta.85 deploy.
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
import * as Cloudflare from "@alchemy.run/cloudflare";
import { providers as railwayProviders } from "@alchemy.run/railway/Providers";
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
| A backend of business rules (commands, events, views) reached by several clients, on Cloudflare | A `@alchemy.run/domain` model hosted on Durable Objects, its Api projected to each client (domain.md) |
| A database, cache, or bucket used by app code | The Resource plus a Binding in the Runtime's constructor, never a hand-wired env var (app-code.md §Bindings) |
| A DNS record for a non-Cloudflare host | An adopted and retained `Cloudflare.Zone.Zone` plus `Cloudflare.DNS.Record` (cloudflare.md §DNS) |
| A secret from `.env` | `yield* Config.Redacted("KEY")` in the constructor (app-code.md §Config) |

## Test on Real Infrastructure

A green typecheck and a clean plan only prove the stack is well formed. What proves it works is a real deploy: the bundle boots on the host's runtime, the health check passes, bindings resolve, and third parties answer from the host's IPs. So **hill-climb against real infrastructure**: deploy a throwaway stage, probe it, change one thing, and redeploy until the probes pass. Then destroy the stage.

- **Stages are the sandbox.** Every non-prod stage (`test_$USER`, `dev_$USER`, `agent-<topic>`) gets its own physical names, and with a stage-aware stack its own project, generated URL, and no custom domain or DNS. An agent may create, redeploy, and destroy these stages without asking. `prod` stays a user-approved deploy.
- **The loop:**
  1. `alchemy plan --stage <s>`
  2. `alchemy deploy --stage <s> --yes`
  3. Probe the outputs: `curl` the URL, run a real request, and read the host's logs (`railway logs` / `alchemy logs`).
  4. Fix the cause and redeploy. An update in place takes about 30 s on Railway.
  5. `alchemy destroy --stage <s> --yes`
- **Keep the loop as a test.** A `Test.make` file (testing.md §Stack tests) that deploys, asserts, and destroys in one scope becomes the repeatable check behind `bun run test:deploy`. Run it before handing off infrastructure or Runtime changes, and after upgrading Alchemy or Effect. Add an assertion for each failure you hit, such as a bot wall, a missing binding, or a slow cold start.
- **Reproduce production problems on a stage first.** Deploy the same commit to a throwaway stage, reproduce the problem there, and fix it there. Then promote the fix to `prod`.
- **Clean up.** Destroy each stage you created before handing off. `alchemy state list` shows leftover stages.

## Gotchas

- **Import subpaths when a barrel drags in peers.** `@alchemy.run/railway` re-exports `Website`, which needs `@alchemy.run/frontend-frameworks`. Import from `@alchemy.run/railway/Service`, `/Project`, `/CustomDomain`, and `/Providers` instead.
- **`Output.mapEffect` needs `E = never`.** Finish lookups with `Effect.orDie`, and die with a descriptive error when a value is missing, since that failure stops the plan.
- **Environment credentials beat the profile.** When every variable a provider needs is set (`RAILWAY_API_TOKEN`, or `CLOUDFLARE_API_TOKEN`+`CLOUDFLARE_ACCOUNT_ID`), including through `.env`, that provider ignores the profile. Remove the variables to use OAuth.
- **Agents get plain mode, which never prompts.** It prints the plan and exits 1 with "Pass --yes". Read the `alchemy plan` output, then run `alchemy deploy --stage <s> --yes`. That is routine on a throwaway stage, and needs the user's approval on `prod`.
- **Profile login is interactive.** An agent cannot complete `alchemy profile edit --add <Provider>`. Ask the user to run it with `! bunx alchemy profile edit --add Cloudflare`.
- **Cloudflare OAuth "Basic" scopes cannot write DNS.** Pick All Scopes, or Custom with `zone.read`, `dns.read`, `dns.write`, `memberships.read`, plus what else the stack touches.
- **`Config` read only inside `fetch` is never bound.** Resolve it in the constructor and close over the value.
- **Railway Services wait about 50s for the build.** Keep the image small and the install layer cached. A slow build fails the deploy even when Railway finishes later.
- **Local build contexts are walked in full before ignore files apply** (limits: 32 MiB and 10k entries). Point `context` at a generated directory with only the files the image needs, never at a repo root with `node_modules`.
- **A Runtime's bundle hash depends on the machine that builds it.** A bundle built on a Mac and one built on the Linux CI runner hash differently. After a deploy from one, `plan` on the other shows the Runtime as `update` with no code change, and deploying redeploys the same code. So one place owns each stage: CI owns `prod`, and local work goes to throwaway stages. An unexpected Runtime `update` in a local `plan` after a CI deploy is this, not drift. See operations.md §CI.
- **Losing `.alchemy/` means the next deploy creates everything again.** Recover by adopting (`--adopt`) instead.

## Compatibility

Last proven on a real project with `alchemy@2.0.0-beta.85` and `effect@4.1.2`: a site on Cloudflare, deployed by CI on 2026-11-02; that first beta.85 deploy upgraded the shared Cloudflare state store from v7 to v8, and three other stacks deployed on it the same day. Effect stable (`4.0.0` and later) has no `effect/unstable/*`: those modules live at `effect/cli`, `effect/http`, `effect/http-api`, `effect/ai` and `effect/rpc`. For a newer release, recheck against its source.

`@alchemy.run/domain` and `@alchemy.run/test` are reviewed against their 2.0.0-beta.85 source and docs, not yet proven on a real project.

## License

The Alchemy guidance restates, in our own words, Alchemy's Apache-2.0 source, docs and `alchemy-domain` skill from `alchemy-run/alchemy` at commit `d0b4a3326` (2.0.0-beta.85). No text is copied.
