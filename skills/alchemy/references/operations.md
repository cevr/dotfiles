# Operations

Running Alchemy: the CLI, credentials, stages, state, lifecycle policies, CI, and troubleshooting.

## Contents

- CLI
- Profiles and credentials
- Stages
- State
- Adopt, retain, rename
- CI
- Troubleshooting

## CLI

| Command | Does |
|---------|------|
| `alchemy plan [file] --stage s` | Diffs and prints the plan without applying it |
| `alchemy deploy [file] --stage s --yes` | Plans and applies. `--yes` is required in plain mode (agents, CI, no TTY) |
| `alchemy destroy --stage s --yes` | Deletes every resource in the stage in reverse dependency order, skipping retained ones |
| `alchemy dev` | Hot-reloading local loop in `dev_$USER`, with emulated resources locally and the rest live |
| `alchemy drift` | Detects drift, and can repair it |
| `alchemy logs [--tail]` | Runtime logs (Workers and Lambda; not Railway) |
| `alchemy state list\|read\|delete` | Inspects the state store |
| `alchemy profile create\|edit\|refresh\|show\|current\|list` | Credentials |
| `alchemy provider check-env --provider <P>` | CI preflight: lists missing provider env vars (name each provider, or it checks all of them) |

Common flags are `--stage`, `--profile`, `--env-file` (default `.env`), `--config/-c <file>`, `--adopt`, and `--no-input`. Exit code 0 means the command completed, 1 means it failed or the plan was declined, and 130 means it was cancelled.

Agents (`CLAUDECODE` is set) always get plain output. Read `plan` first, then `deploy --yes`.

## Profiles and Credentials

- Profiles are stored in `~/.alchemy/profiles.json`, with secrets in `~/.alchemy/credentials/<profile>/`. Selection order: `--profile`, then `$ALCHEMY_PROFILE`, then `default`.
- Add a provider with `alchemy profile edit --add <Provider>`. It is interactive (OAuth in the browser, or a pasted token), so the user runs it. Change the method or scopes with `--reconfigure <Provider>`, and renew tokens without changing scopes with `alchemy profile refresh`.
- **Environment variables win, per provider.** If every variable a provider needs is present (process env or `.env`), that provider ignores the profile, and the log says so. Examples are `RAILWAY_API_TOKEN` and `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. A partial set is ignored.
- When `CI=true`, profiles are never read, and credentials come only from env.

## Stages

- The defaults are `live_$USER` (deploy, plan, destroy), `dev_$USER` (dev), and `test_$USER` (Test.make). Names match `[a-z0-9][-_a-z0-9]*`.
- Production scripts pin `--stage prod`, and previews use `pr-<n>`.
- Each stage has its own state and physical names. Destroying one never touches another.
- Branch on the stage with `const { stage } = yield* Alchemy.Stack;`, or with `Stack.useSync(({ stage }) => props)` at module scope. Keep that logic next to the resource it changes.

## State

- `Alchemy.localState()` → `.alchemy/state/<stack>/<stage>/…`. Git-ignore it but keep it: losing it makes the next deploy try to create everything again.
- For team or CI use, pick `Cloudflare.state()` or another remote store. Moving stores means re-adopting.
- Recover from lost state with `alchemy deploy --adopt`. Providers with `read` find live resources by their deterministic physical names, and a resource owned by someone else fails with `OwnedBySomeoneElse` until you adopt it.

## Adopt, Retain, Rename

| Need | Tool |
|------|------|
| Take over a resource created outside Alchemy | `.pipe(Alchemy.AdoptPolicy.adopt(true))` or `--adopt` for one run |
| Never delete the cloud object | `.pipe(Alchemy.RemovalPolicy.retain())`. Conditional: `retain(stage === "prod")`. It must be deployed *before* the change that would delete the resource. |
| Rename a logical ID without a replacement | `.pipe(Alchemy.renamedFrom("OldId"))` |
| Reference another stage's or stack's resource | `X.ref("id", { stage: "staging" })`, or a typed `Alchemy.Stack<Self, Outputs>()("Name")` handle |

Policies are decorations, so a plan shows no diff for them, but they are persisted on deploy.

## CI

The workflow template and the list of GitHub secrets and variables are in the project-scaffolding skill (`templates/deploy.yml`, `references/deploy-ci.md`). The runtime rules:

- **`CI=true` means env-only credentials.** GitHub Actions sets it. Profiles are never read, and each provider resolves from its env contract: `RAILWAY_API_TOKEN` (an account token), and `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Run `alchemy provider check-env` first; it exits 1 and names each missing variable.
- **CI needs remote state.** `localState()` on a runner forgets everything between runs. Use `Cloudflare.state()` (from `alchemy/Cloudflare`): a Worker plus Durable Object in your account that stores state encrypted with a key in the account's Secrets Store. In CI it derives the store's URL and bearer token from the Cloudflare API token. So the token needs the Workers and Secrets Store permissions even when the stack deploys only to Railway.
- **Bootstrap the store once from a laptop** with `alchemy provider cloudflare bootstrap`. If the store is missing or out of date, a CI run fails, unless it passes `--yes`, which deploys or upgrades the store itself.
- **Move a stack to remote state before CI deploys it.** Switching `state:` migrates nothing, and an empty store plans every resource as a create. Copy the records instead, then confirm with `alchemy plan` that it shows no changes:

  ```typescript
  // one-off script, run with bun from the repo
  import * as Alchemist from "alchemy/Alchemist";
  import * as State from "alchemy/State";
  const program = Effect.gen(function* () {
    const local = yield* Alchemist.State.store({ backend: "local" });
    const remote = yield* Alchemist.State.store({ backend: "cloudflare", profile: undefined, envFile: undefined });
    yield* State.syncState(local, remote, { stacks: ["myapp"] });
  });
  Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  ```

  `alchemy deploy --adopt` is the fallback when no local state is left.
- **App secrets travel as env.** Every `Config.Redacted("KEY")` in a Runtime constructor is read from the deployer's environment. Map each one from a GitHub secret into the deploy step's `env`. A missing one fails the plan.
- **Deploy each stage one run at a time.** Use a `concurrency` group per stage, with `cancel-in-progress: false`, so a cancelled run never leaves an apply half done.
- Stage: `pr-<n>` on pull requests, `prod` on main. A cleanup job runs `destroy --stage pr-<n> --yes`, guarded against `prod`.
- **`alchemy provider check-env` checks every provider Alchemy knows** (AWS, Fly, Stripe, …) and fails on the ones the stack never uses. Name the stack's providers: `check-env --provider Cloudflare --provider Railway`.
- **Bundles built on different machines hash differently.** A Runtime deployed from a Mac plans as an update on the Linux runner, and the reverse. Each such update redeploys the same code (about 20 s on Railway). Let CI own `prod`, and use a throwaway stage for anything you deploy locally.
- **Credentials as code has limits.** `Cloudflare.ApiToken.AccountApiToken` needs the Account API Tokens Write permission, which no Cloudflare OAuth scope grants. Mint it with an admin API-token profile, or have the user create the token in the dashboard. `GitHub.Environment` always sends protection fields, and GitHub Free rejects them on private repos: create the environments with `gh api -X PUT repos/<owner>/<repo>/environments/<name>`, then pass the environment name to `GitHub.Secret` or `GitHub.Variable`. A Railway token can be minted through the OAuth profile with `@distilled.cloud/railway`'s `apiTokenCreate({ input: { name, workspaceId } })`, provided with `Credentials.fromAuthProvider()` from `alchemy/Railway/Credentials` and `RailwayAuth`. Pipe its output straight into `gh secret set`, so the token never reaches a log.
- **A `Forbidden: Authentication error` from Cloudflare in CI** means the token is missing a permission, not that it is invalid. Probe it from a throwaway job and print only the result: `/accounts/<id>/tokens/verify` (account-owned tokens fail `/user/tokens/verify`), `/zones/<zone>`, and `/zones/<zone>/dns_records`. Zone Read alone lists the zone, but every DNS call fails.
- Use `GitHub.Comment` with a stable logical ID to post preview URLs that update in place.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot approve this operation without terminal input` | Plain mode | Review the plan, then add `--yes` |
| Cannot find `@alchemy.run/frontend-frameworks` | Barrel import (`alchemy/Railway`) | Import subpaths |
| Cannot find `@effect/platform-node` | `alchemy/Cloudflare` peer | `bun add -D @effect/platform-node@<effect version>` |
| The profile is ignored | Provider env vars are set (`.env`) | Unset them, or accept env credentials |
| Cloudflare 403 on DNS | OAuth Basic scopes | `alchemy profile edit --reconfigure Cloudflare`, then All Scopes or Custom with `dns.write` |
| The Railway deploy times out but builds later | The build exceeded Alchemy's roughly 50s wait | Smaller context, cached install layer, redeploy |
| Context upload too large or slow | The context walk includes `node_modules` | A generated minimal context directory |
| `anyUnknownInErrorContext` in `alchemy.run.ts` | Provider types carry `any` in `R` | A file-scoped tsgo override for `alchemy.run.ts` only |
| Everything plans as `+ create` | Lost or moved state | `--adopt`, or restore `.alchemy/` |
| `OwnedBySomeoneElse` | The resource exists without Alchemy's ownership stamp | `adopt(true)` on that resource |
