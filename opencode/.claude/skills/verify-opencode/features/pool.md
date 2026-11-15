# Account pool

The pool chooses the login each request of a pooled provider (Claude) goes out on: a session stays on its login while its prompt cache lives, a login the provider refuses (a plan limit, a lost token) is held and the refused request goes out at once on another, a reset window frees a held login, and the login store's lost logins and failing refreshes surface as alerts. Other mods read it over the `dotfiles-opencode.pool` RPC: orchestrate's pace, the `/pool` pane, the sidebar's login label.

## Sub-features

- `pool-choose`: a run goes out on a login with room; a session with a live cache stays on its login.
- `pool-failover`: a plan-limit 429 holds the login and the run finishes on the next.
- `pool-reset`: a held login is used again after its reset.
- `pool-claim`: the pool claims a usage-limit reset on its own (`claim-rule.ts`): one about to expire, else one for held work no fresh account can take that the work would use; it never asks, and tells the owner after with one `OK` notice in the waiting session's tray.
- `pool-store`: the login store's accounts, read and refreshed in place under its lock.
- `pool-alerts`: a lost login or failing refreshes name the slot file to sign in again.
- `pool-rpc`: `pace`, `status`, `session`, `alerts` answer the other mods.

## How to get to it (user POV)

- Any primary request on a pooled provider: the user's prompt, an agent's turn, a compaction.
- The `/pool` pane (the status mod) and the sidebar's login line.
- Orchestrate's pace, before each role start.

## Driving it with the world

- **Preconditions:** a world made with `anthropic` (sim/provider.ts, the fake's wire) and two or more logins; the Anthropic auth plugin and the pool loaded as the real run loads them.
- **States:** default, refused (a 429), a reset, error (the faults suite: failed store writes, a refresh outage). Loading is `n/a`.
- **World suites:** `cmd/pool/pool-failover.sim.test.ts`, `cmd/pool/pool-resets.sim.test.ts`, `cmd/pool/pool-faults.sim.test.ts`, `cmd/pool/pool-store.sim.test.ts`, `cmd/pool/pool-store-refresh.sim.test.ts`, `cmd/pool/pool-store-opencode.sim.test.ts`
- **Code:** `mods/pool/`, `cmd/pool/`, `mods/anthropic-auth/`, `cmd/anthropic-auth/`, `sim/`
- **Regression:** `mods/pool/*.test.ts`.

1. **Failover.** The first login answers an agent turn with a plan-limit 429; the run finishes on the second, and the world's provider saw exactly those two requests in that order.
2. **Without the pool.** The same refusal ends the run: the host does not retry a plan limit on its own.
3. **Resets and store.** The resets suite holds a login to its reset, claims a reset on its own only with work running (one per pool, the claimed login taking the work), uses a reset about to expire, and asks nothing; the store suites read, refresh and write the login store under its lock.

## Driving it with real OpenCode

- **Real:** `tests/pool-failover.test.ts`, `tests/pool-resets.test.ts`, `tests/pool-store.test.ts`

The scratch server never loads the pool (`verify:seed` refuses it: it needs the owner's Claude logins). Its real proof is the acceptance tests above, on `tests/fake-anthropic.ts`; run them with `bun run verify:drive --feature pool --real`.

## Gotchas

- Never point a drive at the owner's logins or his login store; a real pool run spends a Claude account.
- The `/pool` pane is the status mod's; with no pool loaded it draws an empty pool, which proves nothing about the pool.
- A failover seen only in the transcript is incomplete: read the provider's requests (which login each went out on).
- A question about a reset in the tray is a regression: the pool claims or waits on its own, and only tells (`Pool reset claimed`, one `OK`).
- Every usage figure the pool shows (pace holds, reset notices and the claim log, `pool_push`, the pane and sidebar) reads as the share used, out of 100% (`70% used of 100%`, `70%/100% used`): a bare `X%`, or a percent of room, left or remaining, is a regression. `cmd/pool/usage-wording.test.ts` holds each kind's text.
