# baton

An event-sourced relay for [herdr](https://herdr.dev) agent tracks. Whoever holds the baton works next.

Each run keeps one append-only log in SQLite. Every view of a run is a fold of that log: which agent holds each track's baton, what step it is at, and which messages are still owed. Commands append events. The messages those events imply are delivered with `herdr agent prompt`, and each delivery is recorded too. So a crash, a compaction or a second process changes nothing that the log does not already know.

    { view, messages } = fold(log)

baton is the runtime of the [orchestrate skill](../skills/orchestrate/SKILL.md), which lives beside it in dotfiles.

## Commands

Run each command in a herdr pane. The pane decides who is asking: the run's orchestrator, or a seat on one of its tracks.

| Who          | Command                                                                               | Does                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| orchestrator | `baton run start <run>`                                                               | names this pane `<run>-orch` and prints the run dir                                                                                                          |
| orchestrator | `baton open <unit> --cwd <dir> [--verifier] [--max-failures N] [--claude-config DIR]` | opens a tab with the implementor (Claude) and reviewer (Codex), and optionally a verifier, then hands the implementor the spec at `<run dir>/<unit>/spec.md` |
| orchestrator | `baton tell <unit> <impl\|rev\|ver> <text>`                                           | sends a worker a line; that worker then holds the baton                                                                                                      |
| orchestrator | `baton close <unit> [--merged <commit>]` / `baton run end`                            | closes a track's tab, or every track and the run                                                                                                             |
| orchestrator | `baton redeliver <ref>`                                                               | resends a failed message now, or after baton stopped resending it                                                                                            |
| worker       | `baton pass <file> [--verdict …]`                                                     | ends the step; baton routes it by role and verdict                                                                                                           |
| worker       | `baton ask <note>`                                                                    | hands the orchestrator a question                                                                                                                            |
| anyone       | `baton status [--json]`, `baton whoami [--json]`                                      | the live runs, or this pane's place                                                                                                                          |
| watchdog     | `baton tick`, `baton watch [--every 60]`                                              | records agent states, resends a failed message once its agent is idle, reports stalls once per step, retries owed messages                                   |

The log lives at `$BATON_DB`, else `$XDG_STATE_HOME/baton/baton.db`, else `~/.local/state/baton/baton.db`. Run dirs default to `~/.cache/baton/<run>`.

## Layout

- `src/domain/`: the events, the pure fold (`state.ts`) and the pure decisions (`decide.ts`). Test this layer first.
- `src/services/`: the journal (SQLite), herdr and the shell.
- `src/Baton.ts`: each command as read, decide, append, deliver.
- `src/commands/`: the CLI.

`bun run gate` runs typecheck, lint, format, build and tests, and the dotfiles pre-commit hook runs them on any commit that touches `baton/`. The build links `~/.bun/bin/baton`.
