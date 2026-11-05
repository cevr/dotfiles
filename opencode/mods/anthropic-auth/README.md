# Anthropic auth

OpenCode's Claude subscription login, vendored from
[@ex-machina/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth)
(MIT, `LICENSE`). Source: `cevr/opencode-anthropic-auth`, branch `pool-seam`,
commit 38b7c06, which adds to upstream's `v2/main`:

- quota readings from response headers and the usage endpoint;
- a seam for another plugin (the pool) to choose the credential per request
  and to receive each reading;
- tokens taken from a registered credential source (the pool's login store);
- a failed refresh that carries a retry time holds the credential as
  rate-limited instead of signed out;
- (here, after the fork) a sourced credential that fails with a retry time
  answers its request as a retryable 429 (`retry-after`, `x-should-retry`)
  instead of failing the hook, so the session retries on another login;
  the usage sweep reads a sourced credential only through the source's
  `peek`, never a refresh, and skips a source without one;
- Claude Code's per-model beta set and session header.

The code is ours from here; edit it in place. The package and release tests
of the original were left out.

## Layout

The domain sits at the top, one concept per file (`betas.ts`, `oauth.ts`,
`request-body.ts`, `tool-alias.ts`, …), and reaches nothing outside Effect.
`service.ts` holds the contracts it needs from the world, `laws.ts` what each
implementation owes, and `model.ts` the plugin's decisions over them (logins,
refreshes, readings). Each implementation sits in a folder named after what
it reaches: `fetch/` (Anthropic's endpoints and the request and response
hooks), `node/` (entropy), `registry/` (the process-wide credential sources)
and `opencode/` (the host's integration and the quota RPC). Tests sit beside
the code they test.

`cmd/anthropic-auth/server.ts` assembles them into the plugin OpenCode loads;
its `server.test.ts` drives the plugin's hooks, methods and quota RPC on a
stand-in host.
