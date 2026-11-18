# Work

An agent makes, lists, removes and lands isolated workspaces (copy-on-write copies of a repository's base) with the `work` tool, never with OpenCode's worktree tools, which are gone from its tool list. `create` answers the workspace's directory and branch and how to `session_move` there; `list` names each workspace's branch and unsaved work; `remove` trashes one, refusing one that holds work found nowhere else unless `force`; `land` merges a batch onto main, gates once, pushes, trashes the workspaces and wakes the session with the accept check. The tool answers to `rift` as an alias, with the same input and answers, until 2026-12-06.

## Sub-features

- `work-create`: `{ action: "create", branch }` answers `Created the workspace <path> from <base>, on branch <branch>.`, the workspace under `.work/<repo>/` beside the base (on the workbox, `workrift create <branch>`). A create cut off by an interrupt (a plugin reload) leaves its `work new` to finish, and a create of a name whose record still says `creating` waits for it and answers that workspace, never a `-2` (`mods/work/process/work.test.ts`, the interrupted mid-clone case).
- `work-list`: `{ action: "list" }` answers `Workspaces of <base>:` with each one's branch and `clean` or its unsaved work.
- `work-remove`: `{ action: "remove", name }` moves a workspace to the trash; one holding work found nowhere else is refused, naming it, unless `force: true`.
- `work-land`: `{ action: "land", workspaces }` answers `Landed <n> workspace(s) as one push: <sha> …`, and the accept check wakes the session after the turn.
- `work-alias`: a `rift` call takes the same input and gets the same answer as `work`.
- `no-worktree-tools`: no request offers `opencode_worktree_create`, `_list` or `_remove`.

## How to get to it (user POV)

- The agent's `work` call, direct, or a kernel cell's `tools.work(...)`.
- The agent's `rift` call (the alias, until 2026-12-06).
- A root that runs orchestrate units reaches the same model through the `orchestrate` tool's `lane` and `land` ([orchestrate.md](orchestrate.md)).

## Driving it with the world

- **Preconditions:** the work plugin loaded on its memory doubles (one base, a landing config with a gate and an accept check), never beside the rift plugin.
- **States:** default (create, list by the alias, land) and the accept check's wake. Open, loading, empty, refused and error are `n/a` here: the refusals are in `cmd/work/server.test.ts`.
- **World suites:** `cmd/work/work.sim.test.ts`
- **Code:** `cmd/work/`, `tests/plugin-start.test.ts` (its real check that the bare entry starts with the work binary on PATH, among daily's server plugins)

1. **Create.** Prompt `verify: call work {"action":"create","branch":"feat/x"}`. The answer starts `Created the workspace /code/.rifts/app/feat-x from /code/app, on branch feat/x.`
2. **List by the alias.** Prompt `verify: call rift {"action":"list"}`. The answer is `Workspaces of /code/app:` and the line `- /code/.rifts/app/feat-x · branch feat/x · clean`.
3. **Land.** Prompt `verify: call work {"action":"land","workspaces":["feat-x"]}`. The answer starts `Landed 1 workspace(s) as one push`; only the `integrate` workspace is left, and the accept check runs.

## Driving it with real OpenCode

- **Real:** `tests/work.test.ts`, `tests/plugin-start.test.ts`

1. **Not on a scratch server.** `verify:seed` refuses the work plugin, which makes and trashes workspaces of real repositories. Its real proof is `tests/work.test.ts`, run with `WORK_BIN` naming the `work` binary and `OPENCODE_DEV` the fork: a workspace made under `.work/<base>/`, a commit in it, a refused remove and a forced one, a land with one push to the bare origin and the accept check's wake, and a list by the alias `rift`. `tests/plugin-start.test.ts` starts daily's server plugins on a scratch service, the work plugin listed bare as daily lists it: a setup that fails (no `work` on the service's PATH) fails it.

## Gotchas

- Without `WORK_BIN` and `OPENCODE_DEV`, `tests/work.test.ts` skips: `work` is not on the host's PATH yet.
- The work and rift plugins never load together: both register `rift` and the rift RPC.
- `work gc` empties the trash for good; no drive runs it.
