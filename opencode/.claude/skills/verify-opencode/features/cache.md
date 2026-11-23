# Prompt cache

A large prompt-cache miss is shown where it happened, with its cost and its cause. When a turn's request writes back a prefix the cache had lost, the turn ends on a row such as `◌ cache miss · 48k tokens · $0.17 · expired during a 4s shell call`. A compaction's summary request that misses gets its own row under the compaction, not at the next turn's end. The session sidebar sums the session and its subagents in one line, such as `Cache 91% · missed $0.42 · expired`, naming the cause that cost the most, and shows nothing before the session reports cache activity. Each request is judged against the one before it, and its line goes in the ledger: a hit, or a miss by expiry, a pool login move, a compaction, a changed prefix, or an unchanged prefix the cache still lost. While a tool call runs in a subagent on a cache of five minutes or less, the keepalive pings the cache every 4.5 minutes, at most 8 times a wait, so the next request still reads it. A root session is never pinged.

## Sub-features

- `miss-row`: a turn whose request missed a large cached prefix ends on a row with the tokens, the cost and the cause.
- `compaction-row`: a compaction's summary request that misses has its row under the compaction.
- `cache-sidebar`: one sidebar line for the session family: the share read back, what the misses cost, and the costliest cause.
- `cache-cause`: a miss is judged an expiry (by the model's or the agent's cache lifetime), a login move, a compaction, a changed prefix (naming the part that changed) or a lost unchanged prefix.
- `cache-ledger`: each judged request is a line in `ledger.jsonl`; `scripts/cache-ledger.ts` sums it and `scripts/cache-audit.ts` audits it.
- `keepalive`: a subagent's short cache is pinged while its tool call runs, at most 8 times a wait; each ping is a line in `keepalive.jsonl`.

## How to get to it (user POV)

- Any turn on a model that caches: the rows and the sidebar line come on their own, with no key and no tool.
- `/compact` in a session: a miss on the summary request shows under the compaction.
- `bun scripts/cache-ledger.ts` and `bun scripts/cache-audit.ts`, from `opencode/`, read the ledger the server half writes.

## Driving it with the world

- **Preconditions:** none.
- **States:** default (a hit and an expired miss), the compaction's miss, and a keepalive wait. Loading, empty, refused and error are `n/a`.
- **World suites:** none yet. The rows and the sidebar draw from the usage a real model step reports, and the world's model reports no cache usage, so a drive of this feature runs its real checks with --real.
- **Code:** `mods/cache/`, `cmd/cache/`, `scenarios/cache.ts`, `scenarios/cache-compaction.ts`, `tests/cache.test.ts` (its real check); `tests/owned.ts`, `tests/scratch.ts` (the spawn helper and scratch folders its real checks run through: a change to them is due on every such check)
- **Regression:** `cmd/cache/server.test.ts` (the server half: the ledger's lines, the keepalive's pings and when they stop), `mods/cache/request-log.test.ts` and `mods/cache/miss.test.ts` (how a miss is judged), `mods/cache/keepalive.test.ts`, `mods/cache/fingerprint.test.ts`, `mods/cache/ttl.test.ts`, `mods/cache/price.test.ts`, `mods/cache/summary.test.ts`.

1. **Miss.** Run `bun run verify:drive --feature cache --real`. The scripted model, priced like Sonnet with a 2 s cache, runs a 4 s shell call, so the second request misses: the turn ends on `◌ cache miss · 48k tokens · $0.17 · expired during a 4s shell call` and the sidebar reads `Cache 0% · missed $0.17 · expired`.
2. **Compaction.** In the same run, `/compact` between two turns puts its miss row under the compaction: `the compaction request missed the cached prefix`.

## Driving it with real OpenCode

- **Real:** `tests/cache.test.ts`

The verify model reports no cache usage, so on a scratch server no request hits or misses, and the rows and the sidebar line stay away. Report a miss row as unreachable there by a user path. Its drawn row, the sidebar and the ledger are proved by `tests/cache.test.ts` (`scenarios/cache.ts`, `scenarios/cache-compaction.ts`):

1. **Run.** `bun run verify:drive --feature cache --real` runs it against the fork in `OPENCODE_DEV`.
2. **Proof.** The drive's `drive.json` holds the run, its exit and its log.

## Gotchas

- A miss row shows only for a large miss, 20k tokens or $0.10 and up; the sidebar's sum still counts every miss.
- The keepalive pings only a subagent's request on a cache of five minutes or less; a root session, or an hour's cache, is never pinged.
- A ping on a pool login goes out only when the pool's pace, asked as a dispatch (`dispatch: true`), admits its model on that login (`eligible`) on a fresh reading (`measured`) within the even line; on a claim's room (`admission: "backed"`), which a ping reserves none of, unmeasured, held, ineligible, failed, undecodable or unanswered skips it and ends the wait's pings, the tool call running on (`cmd/cache/server.test.ts`). A ping no pool placed, or on a host where no plugin answers the pool's RPC, goes out as before.
- The cost comes from the model catalog's price: a miss on a model the catalog does not price costs nothing.
