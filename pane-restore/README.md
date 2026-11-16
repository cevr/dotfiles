# pane-restore

Carries each Herdr pane's OpenCode session across a herdr restart or a move
of the disk under it.

Herdr's snapshot keeps a pane's folder, not the OpenCode session its TUI had
open. OpenCode itself finds every session after a move (a project is keyed by
its repo's root commit, a session keeps its directory, and the database keeps
its path), so only the pane → session link needs carrying.

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts save              # while Herdr still runs
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check             # before and after the move
bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore --herdr   # after, with the panes back as shells
```

| Command | What it does |
| --- | --- |
| `save` | Reads every live Herdr pane (`herdr api snapshot`) and writes its workspace, tab, cwd and its OpenCode session to `~/.local/state/pane-restore/<host>-<time>.json`. It only reads. |
| `check [file]` | Asks the OpenCode server (`opencode api GET /api/session/<id>`) that every saved session still opens. Exits 1 and names each one that does not. |
| `restore --herdr [file]` | Back into herdr itself, after a herdr restart left the panes as plain shells: in the herdr the save read (its `--machine` or `--session`), runs `herdr pane run <pane> opencode --session <id>` in each saved pane that is an idle shell (`herdr pane process-info`). A pane that runs anything, a pane that is gone, or a session already open in another pane is not touched. A second run types nothing. |

With no file, `check` and `restore --herdr` use the newest save of this host, or of
`--machine <label>`.

## Where the session id comes from

1. Herdr's own record of the pane: `session.json` (read as a copy) keeps the
   `resume_argv` the dotfiles herdr mod reports (`agent_resume`, Herdr 0.9.5), or
   an official integration's `agent_session`. Herdr does not act on our
   `dotfiles:opencode` source after a restart, but it keeps it.
2. Else the TUI's own arguments (`herdr pane process-info`): `-s <id>` or
   `--session <id>`. A TUI started bare has none; one Herdr resumed has one.

Herdr's record wins: a TUI that switched sessions keeps its old argv.

## Options

- `save --session <name>`: a named Herdr session (the workbox runs `bite`), and
  its record in `~/.config/herdr/sessions/<name>/session.json`.
- `save --machine <label>`: a saved Herdr machine, through its API. Its record
  is on that host, so only the TUIs' arguments name sessions. Run `restore` on
  that host with the file, or run `save` there.
- `save --herdr-state <path>`: read Herdr's record from another file.

## What `restore --herdr` reports

One line per saved OpenCode pane, then the totals; it exits 1 when any failed.

- `restored <pane>: opencode --session <id>`: started.
- `skipped`: `already open` (a second run), `already open in <pane>`, or
  `runs <program>` (the pane is not at its shell).
- `failed`: the pane is gone, `herdr pane process-info` or `pane run` failed, or
  the session does not open through the server.

## Runbook steps

The Mac's are in `mac/developer-volume/RUNBOOK.md` (steps 3 and 12), the
workbox's in `linux/workbox-btrfs/RUNBOOK.md` (steps 4 and 7); a test holds both.

Before the move, while Herdr still runs:

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts save     # add --session bite on the workbox
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
```

After the move, with the panes back in herdr as plain shells:

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore --herdr
```

## Tests

`bun test --parallel=1` in this folder runs the CLI against a fake `herdr` and
OpenCode server (`fake.ts`, put on `PATH` as shims). Typecheck with
`../opencode/node_modules/.bin/tsc -p .`.
