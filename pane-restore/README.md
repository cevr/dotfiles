# pane-restore

Carries each Herdr pane's OpenCode session across a move to herdr-core (`hc`).

`hcm` moves Herdr's workspaces and tabs into `hc`, and resumes only Claude and
Codex panes: Herdr's snapshot keeps a pane's folder, not the OpenCode session
its TUI had open. OpenCode itself finds every session after the move (a project
is keyed by its repo's root commit, a session keeps its directory, and the
database keeps its path), so only the pane → session link needs carrying.

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts save      # while Herdr still runs
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check     # before and after the move
bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore   # after `hcm apply`, before `hcm resume`
```

| Command | What it does |
| --- | --- |
| `save` | Reads every live Herdr pane (`herdr api snapshot`) and writes its workspace, tab, cwd, hcm's tab key (`migrate.from`: `<workspace id>/<tab index>`) and its OpenCode session to `~/.local/state/pane-restore/<host>-<time>.json`. It only reads. |
| `check [file]` | Asks the OpenCode server (`opencode api GET /api/session/<id>`) that every saved session still opens. Exits 1 and names each one that does not. |
| `restore [file]` | For each saved OpenCode pane, finds the `hc` terminal `hcm apply` made from its tab (label `migrate.from`) and sets `migrate.resume=opencode --session <id>` on it. `hcm resume` then types that once. It never types into a terminal. |

With no file, `check` and `restore` use this host's newest save.

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

## What `restore` reports

One line per saved OpenCode pane, then the totals; it exits 1 when any failed.

- `restored <pane> → <terminal>`: labelled.
- `skipped`: `already labelled` (a second run), `already resumes <cmd>` (hcm set
  one, as for Claude or Codex), or `runs <program>` (the terminal is not at its
  shell).
- `failed`: no `hc` terminal from that tab (`hcm apply` has not moved it), the
  terminal finished, or the session does not open through the server.

## Runbook steps

Before the move, while Herdr still runs:

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts save     # add --session bite on the workbox
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
```

After the move:

```sh
bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
hcm apply                                                       # if the tabs are not in hc yet
bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore
herdr server stop                                               # from a terminal outside Herdr
hcm resume
```

## Tests

`bun test --parallel=1` in this folder runs the CLI against a fake `herdr`, `hc`
and OpenCode server (`fake.ts`, put on `PATH` as shims). Typecheck with
`../opencode/node_modules/.bin/tsc -p .`.
