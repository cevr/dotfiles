# PRIOR_ARTS.md Format

`PRIOR_ARTS.md` sits at the repo root and lists what this project compares itself against: other codebases, products and write-ups, what to read in each, and the comparisons already settled. `improve-codebase-architecture` and `architecture-loop` read it before surveying, so a settled question is never surveyed twice.

Repos come from the `repo` skill: `okra repo fetch <slug>`, then `okra repo path <slug>`. `okra repo list` prints hundreds of kilobytes; use `path`. When a cached repo is on the wrong branch, `git fetch origin <branch>` and read `origin/<branch>`.

## Structure

```md
# Prior arts

## Repos

| Slug           | Branch | Pass         | Read it for                                                        | Compare with                         |
| -------------- | ------ | ------------ | ------------------------------------------------------------------ | ------------------------------------ |
| `sst/opencode` | `v2`   | architecture | Effect-based runner: `packages/core/src/session/runner/step.ts`     | `packages/core/src/runtime/turn.ts`  |
| `vercel-labs/fx` | default | ui        | inline output that keeps scrollback; settle-then-capture pty tests | `apps/tui`                           |

## Other sources

| Source                                         | Pass       | Read it for                         |
| ---------------------------------------------- | ---------- | ----------------------------------- |
| https://cursor.com/blog/harness (2026-09)      | efficiency | per-task cost layers, cache layout  |

## Settled

- The queue-as-one-module shape (opencode `inbox.ts`, codex `input_queue.rs`) is adopted: `packages/core/src/runtime/agent-loop.ts`.
- Theatre.js keeps values in JSON: rejected on **Lab-first** (a second copy of a value).

## To survey

- How pi's codemode exposes host tools without writing them into the prompt.
```

## Rules

- **One row per source, paths inside it.** "Read it for" names the files or concepts worth reading, with paths inside the repo, so a sweep opens them directly. "Compare with" names this repo's paths.
- **Pass ties a source to a pass** from `NORTH_STAR.md`, or to a standard one: `architecture`, `review`, `guardrails`. A source used by several passes lists them comma-separated.
- **Settled lines are verdicts.** Each says adopted (with where it lives here) or rejected (with the north star it fails, in bold). A sweep reads this list first and reopens a line only with a new receipt.
- **To survey holds open questions only.** A survey answers each one by moving it into Settled. When To survey is empty, the prior-art step of a loop pass is done.
- **No size conclusions across repos.** Line counts compare different scopes; a comparison is about shape, seams and behavior.
