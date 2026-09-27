# Deploy in CI

GitHub Actions deploys with Alchemy: the workflow template, the one-time setup, and where each secret and variable goes.

Copy `../templates/deploy.yml`. It deploys `prod` on pushes to main and a `pr-<n>` preview for each pull request, then destroys the preview when the pull request closes. The `alchemy` skill (operations.md §CI) explains why each piece is there.

**Before the first CI deploy:**

1. Set `state: Cloudflare.state()` in `alchemy.run.ts`. A runner has no disk between runs, so `localState()` would try to create everything again on every run.
2. The user runs `bunx alchemy provider cloudflare bootstrap` once to create the state store, then `bunx alchemy deploy alchemy.run.ts --stage prod --adopt` so the remote store takes over the resources that local state owned.
3. Make the stack stage-aware: previews get their own project and the generated URL, and custom domains and DNS are declared only in `prod`.
4. Create GitHub environments `production` (restricted to `main`, optionally with required reviewers) and `preview`, and store the values below in them.

**Where each value goes.** Secrets are masked in logs, while variables are plain configuration:

| Name | Kind | Holds |
|------|------|-------|
| `RAILWAY_API_TOKEN` | secret | A Railway account token. A project token cannot create projects. |
| `CLOUDFLARE_API_TOKEN` | secret | A scoped API token with Workers Scripts and Secrets Store access (for `Cloudflare.state()`), plus what the stack touches, such as Zone Read and DNS Edit. It is needed even for a Railway-only stack, because the state store runs on Cloudflare. |
| `CLOUDFLARE_ACCOUNT_ID` | variable | The account that holds the state store and the zones. |
| Each `Config.Redacted("KEY")` a Runtime reads | secret | Mapped into the workflow `env`. Alchemy reads it at deploy time and binds it onto the Runtime. |
| Each plain `Config.String` / `Config.Number` a Runtime reads | variable | The same mapping, through `vars.*`. |

Set them with `gh secret set NAME --env production` and `gh variable set NAME --env production`, and repeat for `preview`. A preview can reuse the production tokens, or use narrower ones. To manage these values as code, see the `alchemy` skill (operations.md §CI, credentials as code).

**Rules:**

- Keep the deploy workflow separate from `ci.yml`. The gate never deploys, and deploys never skip the gate: require the CI check in branch protection.
- `bunx alchemy provider check-env` runs before every deploy, so a missing value fails fast and is named in the log.
- `--yes` is required, because CI never prompts. A plan that needs approval fails without it.
- The `concurrency` group allows one deploy per stage at a time and never cancels a running apply.
- The destroy step refuses any stage that does not start with `pr-`.
- Pull requests from forks get no secrets, so their deploy job fails at `check-env`. Skip those pull requests or accept the failure; never pass secrets to fork code through `pull_request_target`.
