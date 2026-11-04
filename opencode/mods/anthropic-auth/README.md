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
- Claude Code's per-model beta set and session header.

The code is ours from here; edit it in place. Its tests are `test/`; the
package and release tests of the original were left out.
