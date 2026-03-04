---
name: stacked
description: Use the `stacked` CLI to manage stacked PRs. Use when the user wants to create branch stacks, rebase, sync, submit PRs, or navigate stacked branches. Triggers on "stacked", "stack", "stacked PRs", branch stacking workflows, or any git workflow involving parent-child branch relationships.
---

# stacked

Branch-based stacked PR manager. Manages parent-child branch relationships, automates rebasing, creates/updates GitHub PRs via `gh`.

Key idea: **branches** are the unit, not commits. Each branch in a stack has exactly one parent — position in the stack determines lineage.

## Navigation

```
What do you need?
├─ Start a new stack          → §Creating a Stack
├─ Add branches to a stack    → §Creating a Stack
├─ See current stack          → §Viewing the Stack
├─ Quick orientation          → §Status
├─ Navigate between branches  → §Navigation
├─ Rebase after changes       → §Rebasing
├─ Amend + auto-rebase        → §Amending
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

| Command                      | What it does                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `stacked trunk [name]`       | Get/set trunk branch (`--json`)                                                             |
| `stacked create <name>`      | Create branch on top of current (`--from`, `--json`)                                        |
| `stacked list [stack]`       | Show stack branches (`--json`)                                                              |
| `stacked stacks`             | List all stacks in the repo (`--json`)                                                      |
| `stacked status`             | Show current branch, stack position, working tree state (`--json`)                          |
| `stacked checkout <name>`    | Switch to branch (falls through to git for non-stacked branches)                            |
| `stacked up`                 | Move up one branch in the stack                                                             |
| `stacked down`               | Move down one branch in the stack                                                           |
| `stacked top`                | Jump to top of stack                                                                        |
| `stacked bottom`             | Jump to bottom of stack                                                                     |
| `stacked sync`               | Fetch + rebase stack on trunk (`--from`, `--dry-run`, `--json`)                             |
| `stacked detect`             | Detect branch chains and register as stacks (`--dry-run`, `--json`)                         |
| `stacked clean`              | Remove merged branches + remote branches (`--dry-run`, `--json`)                            |
| `stacked delete <name>`      | Remove branch from stack + git + remote (`--keep-remote`, `--force`, `--dry-run`, `--json`) |
| `stacked submit`             | Push + create/update PRs (`--title`, `--body`, `--only`, `--draft`, `--json`)               |
| `stacked adopt <branch>`     | Add existing git branch into the stack (`--after`, `--json`)                                |
| `stacked log`                | Show commits grouped by branch (`--json`)                                                   |
| `stacked amend`              | Amend current commit and rebase children (`--edit`, `--from`, `--json`)                     |
| `stacked doctor`             | Check stack metadata for issues (`--fix`, `--json`)                                         |
| `stacked rename <old> <new>` | Rename a stack (`--json`)                                                                   |
| `stacked reorder <branch>`   | Move a branch within the stack (`--before`, `--after`, `--json`)                            |
| `stacked split <branch>`     | Split stack at a branch point (`--dry-run`, `--json`)                                       |
| `stacked init`               | Install the stacked Claude skill to ~/.claude/skills                                        |

### Global Flags

| Flag           | Description                   |
| -------------- | ----------------------------- |
| `--verbose`    | Enable debug output           |
| `--quiet`/`-q` | Suppress non-essential output |
| `--no-color`   | Disable colored output        |
| `--yes`/`-y`   | Skip confirmation prompts     |

## Setup

```sh
# Trunk is auto-detected (main > master > develop). Override if needed:
stacked trunk develop

# Install the Claude skill (optional, compiled binary only):
stacked init
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

Quick orientation — shows current branch, working tree state, and stack position:

```sh
stacked status
# Branch: feat-auth-ui
# Working tree: clean
# Stack: feat-auth (2 of 3)

stacked status --json
# { "branch": "feat-auth-ui", "clean": true, "stack": { "name": "feat-auth", "position": 2, "total": 3 } }
```

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

## Syncing / Rebasing

Fetch latest trunk and rebase the entire stack bottom-to-top:

```sh
stacked sync
stacked sync --dry-run    # preview rebase plan without executing
stacked sync --json       # structured output: { branches: [{ name, action, base }] }
```

After mid-stack changes, rebase only the branches above a specific point:

```sh
stacked checkout feat-auth
# ... make changes, commit ...
stacked sync --from feat-auth    # rebases only children of feat-auth
```

**Note:** `sync` requires a clean working tree — commit or stash before running (except with `--dry-run`). On rebase conflict, the rebase is left in progress so you can resolve it:

```sh
# On conflict:
git rebase --continue    # after resolving conflicts
stacked sync --from <parent-branch>    # resume syncing remaining branches
```

## Amending

Amend the current commit and auto-rebase child branches:

```sh
stacked amend                     # amend + rebase children
stacked amend --edit              # open editor for commit message
stacked amend --from feat-auth    # start rebasing from a specific branch
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
stacked submit --no-force                             # disable force-push
stacked submit --dry-run                              # show what would happen
stacked submit --json                                 # structured JSON output
```

Force-push (with lease) is the default because stacked branches are always rebased. Use `--no-force` if you haven't rebased.

Each PR targets its parent branch (not trunk), preserving the stack structure on GitHub. PRs include auto-generated stack metadata showing position and navigation links. The metadata is refreshed on every `submit`.

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

`clean` also deletes the corresponding remote branches. `list` shows merge status per branch (`[merged]`, `[closed]`, `[#N]` for open PRs). After cleaning, run `stacked sync` to rebase remaining branches.

## Deleting

```sh
stacked delete feat-auth-ui                # removes from stack + deletes local + remote branch
stacked delete feat-auth-ui --force        # skip children check
stacked delete feat-auth-ui --keep-remote  # don't delete remote branch
stacked delete feat-auth-ui --dry-run      # show what would happen
stacked delete feat-auth-ui --json         # structured JSON output
```

Deleting a mid-stack branch with `--force` warns about potentially lost commits and recommends running `stacked sync` to rebase child branches onto the new parent.

## Stack Management

Rename, reorder, and split stacks:

```sh
# Rename a stack (metadata only, doesn't rename branches)
stacked rename old-name new-name

# Move a branch to a different position in the stack
stacked reorder feat-b --before feat-a
stacked reorder feat-b --after feat-c

# Split a stack at a branch point (branches at/above become a new stack)
stacked split feat-b
stacked split feat-b --dry-run    # preview the split
```

After reordering, run `stacked sync` to rebase branches in new order.

## Doctor

Check stack metadata for issues (stale branches, missing trunk, duplicates):

```sh
stacked doctor            # report issues
stacked doctor --fix      # auto-fix where possible (remove stale branches, auto-detect trunk)
stacked doctor --json     # structured output
```

## Error Codes

All errors include a machine-readable code for programmatic handling:

| Code                  | Meaning                                     |
| --------------------- | ------------------------------------------- |
| `BRANCH_EXISTS`       | Branch already exists                       |
| `BRANCH_NOT_FOUND`    | Branch not found in any stack               |
| `NOT_IN_STACK`        | Current branch not tracked in a stack       |
| `DIRTY_WORKTREE`      | Working tree has uncommitted changes        |
| `REBASE_CONFLICT`     | Rebase conflict during sync/amend           |
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

Stack metadata lives in `.git/stacked.json`. Each branch's parent is implied by array position:

- `branches[0]` → parent is trunk
- `branches[n]` → parent is `branches[n-1]`

Trunk is auto-detected on first use by checking for `main`, `master`, or `develop` branches. Override with `stacked trunk <name>`.

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
stacked sync --from feat-auth  # rebase children

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
- `stacked sync` rebases bottom-to-top — resolve conflicts one branch at a time
- `stacked sync` leaves rebase in progress on conflict — resolve with `git rebase --continue`, then resume with `stacked sync --from <parent>`
- `stacked submit` force-pushes by default (use `--no-force` to disable)
- `stacked submit` and `stacked clean` require `gh` CLI authenticated (`gh auth login`)
- PRs target parent branches, not trunk — this is intentional for stacked review
- PRs include auto-generated stack metadata (position, navigation links)
- Trunk is auto-detected (`main` > `master` > `develop`) — use `stacked trunk <name>` to override
- Forked branches (one parent, multiple children) are not supported — `detect` reports them but skips
- `stacked delete --force` on a mid-stack branch requires `stacked sync` afterward
- `stacked checkout` falls through to `git checkout` for branches not in a stack
- Detached HEAD is detected and produces a clear error — checkout a branch first
- Stack file writes are atomic (write to tmp, then rename) to prevent corruption
- `create` and `adopt` are idempotent — safe to re-run after transient failures
- Use `stacked doctor` to detect and fix metadata drift (stale branches, missing trunk)
