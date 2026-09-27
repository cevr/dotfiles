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
| `alchemy provider check-env` | CI preflight: lists missing provider env vars |

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

```yaml
- run: bun install --frozen-lockfile
  env: { LEFTHOOK: 0 }
- run: bun alchemy provider check-env
- run: bun alchemy deploy --stage ${{ env.STAGE }} --yes
  env:
    RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_API_TOKEN }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- CI needs remote state. `localState` on a runner forgets everything between runs.
- Stage: `pr-<n>` on pull requests, `prod` on main. A cleanup job runs `destroy --stage pr-<n> --yes`, guarded against `prod`.
- Credentials as code: a separate `stacks/github.ts` mints scoped tokens (`Cloudflare.ApiToken.AccountApiToken`, `AWS.IAM.Role` for OIDC) and writes them with `GitHub.Secret` or `GitHub.Variable`. Deploy it once with `--profile admin`.
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
