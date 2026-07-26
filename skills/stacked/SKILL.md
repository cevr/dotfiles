---
name: stacked
description: Use the `stacked` CLI to manage stacked PRs. Use when the user wants to create branch stacks, sync, submit PRs, or navigate stacked branches. Triggers on "stacked", "stack", "stacked PRs", branch stacking workflows, or any git workflow involving parent-child branch relationships.
---

# stacked

Branch-based stacked PR manager. Manages parent-child branch relationships, propagates upstream changes via merges, creates/updates GitHub PRs via `gh`.

Key idea: **branches** are the unit, not commits. Each branch in a stack has exactly one parent — position in the stack determines lineage.

## Navigation

```
What do you need?
├─ Start a new stack          → §Creating a Stack
├─ Add branches to a stack    → §Creating a Stack
├─ See current stack          → §Viewing the Stack
├─ Quick orientation          → §Status
├─ Navigate between branches  → §Navigation
├─ Sync after changes         → §Syncing
├─ Amend + auto-sync          → §Amending
├─ Push + create PRs          → §Submitting
├─ Adopt existing branches    → §Adopting Branches
├─ Detect existing branches   → §Detecting Existing Branches
├─ Clean up merged branches   → §Cleaning Up Merged Branches
├─ Remove a branch            → §Deleting
├─ Reorganize stack           → §Stack Management
├─ Check metadata health      → §Doctor
├─ Install Claude skill       → §Setup
└─ Troubleshooting            → §Gotchas
```

## Quick Reference

| Command                      | What it does                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `stacked trunk [name]`       | Get/set trunk branch (`--json`)                                                                            |
| `stacked create <name>`      | Create branch on top of current (`--from`, `--json`)                                                       |
| `stacked list [stack]`       | Show stack branches (`--json`)                                                                             |
| `stacked stacks`             | List all stacks in the repo (`--json`)                                                                     |
| `stacked status`             | Show current branch, stack position, working tree state (`--json`)                                         |
| `stacked checkout <name>`    | Switch to branch (falls through to git for non-stacked branches)                                           |
| `stacked up`                 | Move up one branch in the stack                                                                            |
| `stacked down`               | Move down one branch in the stack                                                                          |
| `stacked top`                | Jump to top of stack                                                                                       |
| `stacked bottom`             | Jump to bottom of stack                                                                                    |
| `stacked sync`               | Fetch + sync stack on trunk (`--from`, `--dry-run`, `--continue`, `--abort`, `--include-merged`, `--json`) |
| `stacked detect`             | Detect branch chains and register as stacks (`--dry-run`, `--json`)                                        |
| `stacked clean`              | Remove merged branches + remote branches (`--dry-run`, `--json`)                                           |
| `stacked delete <name>`      | Remove branch from stack + git + remote (`--keep-remote`, `--force`, `--dry-run`, `--json`)                |
| `stacked submit`             | Push + create/update PRs (`--title`, `--body`, `--only`, `--draft`, `--json`)                              |
| `stacked adopt <branch>`     | Add existing git branch into the stack (`--after`, `--json`)                                               |
| `stacked log`                | Show commits grouped by branch (`--json`)                                                                  |
| `stacked amend`              | Amend current commit and merge into children (`--edit`, `--from`, `--json`)                                |
| `stacked doctor`             | Check stack metadata for issues (`--fix`, `--json`)                                                        |
| `stacked rename <old> <new>` | Rename a stack (`--json`)                                                                                  |
| `stacked reorder <branch>`   | Move a branch within the stack (`--before`, `--after`, `--json`)                                           |
| `stacked reparent <branch>`  | Move a branch subtree onto a branch or trunk (`--onto`, `--sync`, `--dry-run`, `--json`)                   |
| `stacked split <branch>`     | Split stack at a branch point (`--dry-run`, `--json`)                                                      |
| `stacked init`               | Install the stacked Claude skill to ~/.claude/skills                                                       |

### Global Flags

| Flag           | Description                   |
| -------------- | ----------------------------- |
| `--verbose`    | Enable debug output           |
| `--quiet`/`-q` | Suppress non-essential output |
| `--no-color`   | Disable colored output        |
| `--yes`/`-y`   | Skip confirmation prompts     |

## Setup

```sh
# Install the Claude skill (optional, compiled binary only):
stacked init

# Trunk is auto-detected on first use from origin/HEAD when available
# (fallback: main > master > develop). Override only if needed:
stacked trunk <name>
```

Requires `gh` CLI installed and authenticated for `submit` and `clean`.

## Creating a Stack

Start from trunk, build upward. Each `create` branches off the current branch.

```sh
git checkout main
stacked create feat-auth          # branches off main
# ... make commits ...
stacked create feat-auth-ui       # branches off feat-auth
# ... make commits ...
stacked create feat-auth-tests    # branches off feat-auth-ui
```

Result: `main → feat-auth → feat-auth-ui → feat-auth-tests`

Use `--from` to branch from a specific branch instead of current:

```sh
stacked create hotfix --from feat-auth
```

## Viewing the Stack

```sh
stacked list              # shows current stack's branches (colored tree view)
stacked list feat-auth    # shows a specific stack by name
stacked list --json       # machine-readable JSON output
stacked stacks            # lists all stacks in the repo
stacked stacks --json     # machine-readable JSON output
stacked log               # shows commits grouped by branch
stacked log --json        # machine-readable JSON output
```

## Status

Quick orientation — shows current branch, working tree state, stack position, and per-branch state (push state, merged state):

```sh
stacked status
# Branch: feat-auth-ui
# Working tree: clean
# Stack: feat-auth (2 of 3)
#
#   ✓ feat-auth (merged)        ← merged PR, skipped by sync/submit
#   ● feat-auth-ui ↑2           ← current, 2 unpushed commits
#   ○ feat-auth-tests (no remote)

stacked status --json
# Each branch entry includes: name, current, ahead, hasRemote, merged
```

Per-branch markers:

- `●` current branch
- `○` other branches in the stack
- `✓` merged (PR has merged on GitHub; skipped by sync/submit)
- `↑N` N unpushed commits
- `(no remote)` branch never pushed
- `(merged)` PR has merged

## Navigation

```sh
stacked up                   # move up one branch
stacked down                 # move down one branch
stacked checkout feat-auth   # switch to specific branch
stacked checkout any-branch  # falls through to git for non-stacked branches
stacked top                  # jump to top of stack
stacked bottom               # jump to bottom (trunk-adjacent)
```

All navigation commands support `--json` for structured output. `checkout` falls through to `git checkout` for branches not in any stack.

## Syncing

Fetch latest trunk, fast-forward trunk, then merge each parent into its child bottom-to-top:

```sh
stacked sync
stacked sync --dry-run         # preview sync plan with predicted actions per branch
stacked sync --continue        # continue after resolving conflicts
stacked sync --abort           # abort in-progress merge
stacked sync --include-merged  # force-include merged branches (rare)
stacked sync --json            # structured output: { branches: [{ name, action, base }] }
```

**How sync works:**

1. Fetch and fast-forward trunk onto `origin/trunk` (fails if trunk diverges — reconcile manually)
2. Query `gh` for each branch's PR state; mark merged PRs in `stacked.json#mergedBranches`
3. For each non-merged branch, check if parent moved since last sync (`syncedOnto` metadata)
4. If parent unchanged or already incorporated → skip (no push needed)
5. If parent changed → `git merge --no-ff` parent into branch
6. Plain-push changed branches, update `syncedOnto` metadata

Merged branches are skipped entirely — no merge, no push. Children of a merged branch reparent to the next non-merged ancestor (or trunk). Use `--include-merged` to opt back in.

No rebases. No force-pushes. History only grows forward.

After mid-stack changes, sync only the branches above a specific point:

```sh
stacked checkout feat-auth
# ... make changes, commit ...
stacked sync --from feat-auth    # syncs only children of feat-auth
```

**Note:** `sync` requires a clean working tree — commit or stash before running (except with `--dry-run`). On conflict, the merge is left in progress so you can resolve it:

```sh
# On conflict:
# edit conflicted files, then:
git add <resolved-files>
stacked sync --continue    # finalizes merge and resumes remaining branches
# or bail out:
stacked sync --abort
```

## Amending

Amend the current commit and auto-merge into child branches:

```sh
stacked amend                     # amend + merge into children
stacked amend --edit              # open editor for commit message
stacked amend --from feat-auth    # start syncing from a specific branch
stacked amend --json              # structured output
```

## Submitting

Push all stack branches and create/update GitHub PRs with correct base branches:

```sh
stacked submit                                        # push + create/update PRs
stacked submit --draft                                # create as draft PRs
stacked submit --title "Add auth" --body "OAuth2"     # with title and body
stacked submit --title "Auth,Validation,Tests"        # per-branch titles (comma-delimited)
stacked submit --only                                 # process only the current branch
stacked submit --dry-run                              # show what would happen
stacked submit --json                                 # structured JSON output
```

`submit` plain-pushes (no force). Because sync never rewrites history, every push fast-forwards.

Each PR targets its parent branch (not trunk), preserving the stack structure on GitHub. PRs include auto-generated stack metadata showing position and navigation links. The metadata is refreshed on every `submit`.

Merged branches are skipped — `submit` does not push them or mutate their PRs. They still render in the metadata table of sibling PRs (with ✅) for bookkeeping.

**Output:** `submit` prints one line per branch to stdout: `<branch> #<number> <url> <action>`. With `--json`, outputs a structured `{ results: [...] }` array.

## Adopting Branches

Bring an existing git branch into the stack:

```sh
stacked adopt existing-branch                    # append to top
stacked adopt existing-branch --after feat-auth  # insert after specific branch
```

## Detecting Existing Branches

Auto-detect linear branch chains from git history and register them as stacks:

```sh
stacked detect              # scan and register branch chains
stacked detect --dry-run    # preview what would be registered
stacked detect --json       # structured JSON output
```

Only linear chains are detected. Forked branches (one parent with multiple children) are reported but skipped. Already-tracked branches are excluded.

## Cleaning Up Merged Branches

After PRs are merged on GitHub, clean up the local and remote branches and stack metadata:

```sh
stacked clean              # removes all merged branches (prompts for confirmation)
stacked clean --dry-run    # preview what would be removed
stacked clean --json       # structured JSON output
stacked clean --yes        # skip confirmation prompt
```

`clean` also deletes the corresponding remote branches. `list` shows merge status per branch (`[merged]`, `[closed]`, `[#N]` for open PRs). After cleaning, run `stacked sync` to re-parent remaining branches via merges.

## Deleting

```sh
stacked delete feat-auth-ui                # removes from stack + deletes local + remote branch
stacked delete feat-auth-ui --force        # skip children check
stacked delete feat-auth-ui --keep-remote  # don't delete remote branch
stacked delete feat-auth-ui --dry-run      # show what would happen
stacked delete feat-auth-ui --json         # structured JSON output
```

Deleting a mid-stack branch with `--force` warns about potentially lost commits and recommends running `stacked sync` to merge the new parent into child branches.

## Stack Management

Rename, reorder, reparent, and split stacks:

```sh
# Rename a stack (metadata only, doesn't rename branches)
stacked rename old-name new-name

# Move a branch to a different position in the stack
stacked reorder feat-b --before feat-a
stacked reorder feat-b --after feat-c

# Move feat-b and every descendant above it onto a new Parent
stacked reparent feat-b --onto feat-x
stacked reparent feat-b --onto main --dry-run
stacked reparent feat-b --onto feat-x --sync

# Split a stack at a branch point (branches at/above become a new stack)
stacked split feat-b
stacked split feat-b --dry-run    # preview the split
```

`reparent` moves the selected Branch and its descendant suffix as one unit. It supports same-Stack and cross-Stack moves; targeting Trunk creates a new Stack. Since Stacks are linear, the target's former descendants follow the moved subtree. Cycles are rejected, emptied source Stacks are removed, and only `syncedOnto` markers whose Parent changed are cleared. `--sync` checks that synchronization can start before changing topology, then merges and pushes the destination Lineage even when the checkout is still on the source Stack. It cannot be combined with `--dry-run`.

After reordering or reparenting, run `stacked sync` to merge the new parents into children, or use `reparent --sync` to do both operations together.

## Doctor

Check shared topology and clone-local synchronization state for issues:

```sh
stacked doctor            # report issues
stacked doctor --fix      # auto-fix where possible (trunk, sync markers, interrupted sync)
stacked doctor --json     # structured output
```

## Error Codes

Coded errors include a machine-readable value for programmatic handling:

| Code                  | Meaning                                     |
| --------------------- | ------------------------------------------- |
| `BRANCH_EXISTS`       | Branch already exists                       |
| `BRANCH_NOT_FOUND`    | Branch not found in any stack               |
| `NOT_IN_STACK`        | Current branch not tracked in a stack       |
| `DIRTY_WORKTREE`      | Working tree has uncommitted changes        |
| `SYNC_CONFLICT`       | Merge conflict during sync/amend            |
| `GH_NOT_INSTALLED`    | `gh` CLI not installed or not authenticated |
| `STACK_NOT_FOUND`     | Stack not found                             |
| `STACK_EXISTS`        | Stack name already taken                    |
| `INVALID_BRANCH_NAME` | Branch name fails validation                |
| `ALREADY_AT_TOP`      | Already at top of stack                     |
| `ALREADY_AT_BOTTOM`   | Already at bottom of stack                  |
| `TRUNK_ERROR`         | Trunk-related error                         |

Usage errors (invalid args, bad state) exit code 2. Operational errors (git/gh failures) exit code 1.

## Idempotent Commands

`create` and `adopt` are idempotent:

- `create` succeeds silently if the branch already exists and is tracked
- `adopt` succeeds silently if the branch is already in the current stack (errors only if in a different stack)

## Output Conventions

- **stdout**: data output only (JSON, branch names, tree views) — safe for piping
- **stderr**: progress messages, spinners, success/warning/error messages
- All write commands support `--json` for structured output
- Colored output respects `NO_COLOR`, `FORCE_COLOR`, and `--no-color`

## Data Model

Repository-wide Stack topology lives under `$XDG_STATE_HOME/stacked` (normally `~/.local/state/stacked`) and is keyed through normalized `origin` aliases. SSH and HTTPS clones of the same remote, plus linked worktrees, see the same Stacks. Override the location with `STACKED_STATE_HOME`.

Repositories without an `origin` use the common Git directory as their identity and therefore do not share topology across clones. Legacy `.git/stacked.json` files migrate automatically only when their normalized topology agrees.

Each shared Branch record stores:

- `stack` — which stack it belongs to
- `parent` — parent branch name (null for root)

Clone-local state separately stores `syncedOnto`, the Parent tip at last synchronization. Linked worktrees share this marker, while duplicate clones do not.

Trunk is auto-detected on first use from `origin/HEAD` when available, then falls back to local `main`, `master`, or `develop`. Override with `stacked trunk <name>`.

A repo can have multiple independent stacks. The current stack is determined by which branch you're on.

## Typical Workflow

```sh
# 1. Start a stack
stacked create feat-auth
# ... work, commit ...

# 2. Stack more branches
stacked create feat-auth-ui
# ... work, commit ...

# 3. Quick check
stacked status

# 4. Need to fix something mid-stack
stacked checkout feat-auth
# ... fix, commit ...
stacked sync --from feat-auth  # merge into children

# 5. Sync with latest main
stacked sync

# 6. Submit for review
stacked submit --draft --title "Add auth" --body "Implements OAuth2 flow"

# 7. After review, final submit
stacked submit

# 8. Navigate quickly
stacked up    # go to next branch
stacked down  # go to previous branch
```

## Gotchas

- `stacked sync` requires a clean working tree — commit or stash first (except `--dry-run`)
- `stacked sync` fast-forwards trunk onto `origin/<trunk>` — if trunk has diverged, sync aborts so you can reconcile manually
- `stacked sync` skips branches whose parent hasn't moved since last sync
- `stacked sync` and `stacked submit` skip branches whose PRs have merged — they stay in shared topology for bookkeeping (and continue rendering in PR metadata tables with ✅), but no merge/push/PR-mutation happens. Children reparent to the next non-merged ancestor. Use `stacked clean` to remove them, or `stacked sync --include-merged` to force them back into the loop
- `stacked sync` leaves the merge in progress on conflict — resolve, `git add`, then `stacked sync --continue` (or `--abort`)
- `syncedOnto` metadata may become stale if branches are manipulated outside `stacked` — doctor clears stale entries; first sync re-establishes from `merge-base`
- `stacked submit` plain-pushes (no force). Since sync only merges, history always fast-forwards
- `stacked submit` and `stacked clean` require `gh` CLI authenticated (`gh auth login`)
- PRs target parent branches, not trunk — intentional for stacked review. GitHub dedupes commits against the parent PR so reviewers see only each child's diff
- PRs include auto-generated stack metadata (position, navigation links)
- Trunk is auto-detected (`origin/HEAD` first, then `main` > `master` > `develop`) — use `stacked trunk <name>` only when detection is wrong
- Forked branches (one parent, multiple children) are not supported — `detect` reports them but skips
- `stacked delete --force` on a mid-stack branch requires `stacked sync` afterward
- `stacked checkout` falls through to `git checkout` for branches not in a stack
- Detached HEAD is detected and produces a clear error — checkout a branch first
- Stack file writes are atomic (write to tmp, then rename) to prevent corruption
- `create` and `adopt` are idempotent — safe to re-run after transient failures
- Use `stacked doctor` to detect and fix invalid topology, missing trunk, and clone-local sync drift
- `stacked doctor --fix` clears stale `syncedOnto` entries pointing at non-existent commits
