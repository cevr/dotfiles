# Runbook: move herdr to herdr-core (hc), Saturday 2026-11-14 after 21:25Z

The outer runbook of the window. Each host stops once: storage first, then hc, because an hc shell holds its folder open and both storage moves refuse while anything does. The workbox goes first, while the Mac stays whole to drive and check it; the Mac goes last, by hand. The storage steps live in their own runbooks and are named here by file and heading, not copied. Deadline: the Monday 2026-11-16 09:00 EST wake.

Every cutover line runs from the dotfiles checkout: `cd ~/Developer/personal/dotfiles` first. `<saved>` is the folder `pre` prints on its last line (`~/.local/state/herdr-core-cutover/<host>-<time>/`); `<save>` is the file `pane-restore save` prints. Times are guesses unless marked measured.

What the cutover script does and does not do: `pre` and `verify` only read. `labels` sets labels on hc terminals `hcm apply` made, and refuses while herdr runs. `resume` drops any label whose terminal is no longer a fresh shell, then runs `hcm resume`, which does the typing, once. Nothing here stops a program; you do that by hand in steps 2 and 6.

## Step 1 — Workbox, before stopping (herdr up)

Where: an `ssh bite-workbox` login outside herdr (not a herdr pane, not mosh). Takes 5 to 10 min.

1. `bun pane-restore/main.ts save --session bite`, then `bun pane-restore/main.ts check <save>`.
   Expect: `5 panes, 5 with an OpenCode session`, the file path, then `5 of 5 sessions open`.
   On failure: a `missing` line names a session the server cannot open; note it, it resumes as nothing. A `herdr … exited` error: herdr is down; stop here, nothing has changed.
2. Update herdr so it writes a snapshot: `herdr --version` (0.9.1 today, measured 2026-11-13), then `herdr update --handoff` with `herdr-bite.service` owning the server (`workbox/bin/migrate-herdr-to-systemd --dry-run` says whether it does). Then `herdr --version` again: 0.9.5 or newer, and `herdr --session bite workspace list` still lists prs, ergo, perf, sync-engine and sentry-factory.
   A failed handoff looks like: an error from `herdr update` or `migrate-herdr-to-systemd` ("Herdr changed a workspace, pane, or agent session during the handoff", "the Herdr handoff request is invalid"), the old version still printed, or the workspace list shorter than before. Do not retry. Use the fallback in 3: it needs no update and no snapshot.
3. `bun herdr-core/cutover.ts pre --session bite` (after a good update), or the fallback `bun herdr-core/cutover.ts pre --session bite --from-live --save <save>`.
   Expect: `ok` lines for herdr, hc (0.1.18 or newer), hcm, the snapshot's age (newer than the herdr server's start), no split, every id typeable; the pane table with 5 rows, each with a `ses_` id; and `saved: <saved>`. `<saved>/hcm-plan.txt` reads `5 workspaces, 5 tabs, 0 agents to resume` (hcm resumes Claude and Codex only; `labels` adds ours).
   On failure: a `FAIL` line names what is wrong. `no snapshot` with `--session bite`: pass `--snapshot <file>` from wherever herdr 0.9.5 wrote it, or use `--from-live`. A split tab: unsplit it in herdr and run `pre` again. Nothing has changed yet, so stopping here costs nothing.

## Step 2 — Workbox, stop

Where: the same `ssh bite-workbox` login outside herdr. Takes 2 min.

1. `systemctl --user disable --now herdr-bite.service` (every herdr pane ends; disabled so the storage move's restart does not bring it back).
2. `opencode service stop`.
3. `hc server stop` (it holds no terminals yet: `hc ls` prints none first).
4. Check: `herdr --session bite status server` says `not running`; `hc server status` is not asked again (it would start a core).

On failure: a unit that will not stop: `systemctl --user status herdr-bite.service` names the process; the storage move's own stop (its step 6.2) stops `user@1000.service` anyway.

## Step 3 — Workbox, btrfs move

Where and how long: `linux/workbox-btrfs/RUNBOOK.md`, "## The window", its steps 5, 6 and 8 (30 to 60 min for the first copy, 5 to 10 for the final pass, its guess). Its step 4 (save, `pre`, disable herdr-bite, `hc server stop`) is steps 1 and 2 here, and its step 7's hc path is step 4 here. The `@home` copy carries `~/.local/state/herdr-core-cutover/` and `~/.local/state/pane-restore/` along, at the same paths.

Expect: its `check.sh`, every line `ok`.
On failure: its "## Rollback". Herdr is only disabled, so its own rollback is this runbook's Rollback below.

## Step 4 — Workbox, hc

Where: a new `ssh bite-workbox` login outside herdr. Takes 5 min.

1. `hc server start`, then `hc ls` lists nothing.
2. `hcm apply --snapshot <saved>/snapshot.json`. Expect `added 1 tab(s) to the new space for /home/exedev` five times (hcm looks up a folder's space before it adds any, so each workspace gets its own space, all in the home). `hc ls` lists 5 shells.
3. `bun herdr-core/cutover.ts labels --snapshot <saved> --save <save> --session bite`. Expect a `save:` line for each pane whose session moved on since the snapshot, `labelled <tab> → t<n>: migrate.resume=opencode -s ses_…` 5 times, and `5 labelled`. Run it again: `0 labelled`, every line `skipped … already labelled`.
   On failure: `herdr still runs`: back to step 2.1. `no live hc terminal from …`: run step 4.2. `… runs <program>` or `reported a status`: someone started a program in that shell; open that session there by hand with `opencode -s <id>` once it is at its prompt.
4. `opencode service start`, and wait until `opencode api GET /api/session` answers (`opencode -s <id>` needs the service).
5. `bun herdr-core/cutover.ts resume --session bite`. Expect `t<n>: opencode -s ses_…` per terminal (hcm's lines). An `unlabelled` line names a terminal that stopped being a fresh shell; resume that one by hand.
6. `bun herdr-core/cutover.ts verify --snapshot <saved> --session bite`, then `bun pane-restore/main.ts check <save>`. Expect `ok   herdr`, `ok   terminals`, `ok   labels`, `ok   status`, `ok   sessions`, then `5 of 5 sessions open`. A `FAIL status` line can be an OpenCode still starting: wait 30 s and run verify again.
7. Clients and the plugin: `curl -fsSL https://rodeo.lukeed.com | sh`, then `herdr plugin list` and `herdr plugin uninstall <the id it lists for cevr/herdr-hunk>`.

## Step 5 — Mac, before stopping (herdr up)

Where: any shell on the Mac. Takes 3 min.

1. `bun pane-restore/main.ts save`, then `bun pane-restore/main.ts check <save>`. Expect `7 panes, 3 with an OpenCode session` (measured 2026-11-13; the count is whatever runs then) and `N of N sessions open`.
2. `bun herdr-core/cutover.ts pre`. Expect every line `ok` (herdr 0.9.5 measured, hc 0.1.21 measured), the snapshot newer than the herdr server's start, the pane table, and `saved: <saved>`. On failure: as step 1.3; the Mac's herdr writes snapshots, so `--from-live` is only for a snapshot older than the server.

## Step 6 — Mac, stop

Where: a plain Ghostty window outside herdr (this runbook's driver, the orchestrator, ends here; the owner runs steps 6 to 8 by hand). Takes 5 min.

1. `mac/developer-volume/RUNBOOK.md`, "## Steps", its steps 4 (quit the agents, `opencode service stop`), 5 (`herdr server stop`, then `hc server stop`), 6 (syncthing) and 7 (`migrate.sh bootout`). Its step 3 (save and `pre`) was step 5 here.

On failure: whatever still runs shows up in its step 8 (`migrate.sh preflight`).

## Step 7 — Mac, volume move

Where and how long: `mac/developer-volume/RUNBOOK.md`, "## Steps", its steps 8 to 10 (1.5 to 3 h, its guess), and its "## After" check.

On failure: its "## Rollback", then step 8 here.

## Step 8 — Mac, hc

Where: a new plain Ghostty window. Takes 10 min.

1. `mac/developer-volume/RUNBOOK.md` step 11 (`$D/migrate.sh bootstrap`, `brew services start syncthing`, `opencode service start`, `rift gc`; herdr stays stopped). Its step 12 is the lines below.
2. `hc server start`; `hcm apply --snapshot <saved>/snapshot.json` (expect 7 tabs).
3. `bun herdr-core/cutover.ts labels --snapshot <saved> --save <save>`. Expect 3 `labelled` lines (as many as step 5 saved with a session) and `project=` set on each named workspace's terminal. Failures as step 4.3.
4. The service is up from 8.1; `bun herdr-core/cutover.ts resume`.
5. `bun herdr-core/cutover.ts verify --snapshot <saved>`, then `bun pane-restore/main.ts check <save>`. Expect every line `ok`.
6. Clients: `curl -fsSL https://releases.herdr.dev/app/install.sh | sh` (Herdr.app), `curl -fsSL https://rodeo.lukeed.com | sh` (rodeo). Herdr.app opens on the spaces hcm wrote.
7. `herdr plugin list`, `herdr plugin uninstall <the id it lists for cevr/herdr-hunk>`.
8. `hc machine add bite-workbox --name workbox`, then `hc machine ls` lists `workbox`, and `hc exec --on workbox hc ls` lists its 5 terminals.

## Step 9 — After

`hc-words` lands (AGENTS.md and the `workbox()` shell function name hc again). Use both hosts for a day. Herdr and its snapshots stay installed until `herdr-retire` (not before 2026-11-21).

## Rollback

Per host, at any point before `herdr-retire`. Herdr, its config and its snapshots stay installed.

1. End the hc copies first, so no session is open twice: `hc ls`, then `hc kill <t>` for each terminal `hcm apply` made (they carry the `migrate.from` label: `hc ls --label migrate.from=<tab>` per tab, or `hc get <t>`).
2. Start herdr: on the workbox `systemctl --user enable --now herdr-bite.service`; on the Mac `herdr`. The panes come back as shells in their folders.
3. `bun pane-restore/main.ts restore --herdr <save>` reopens each saved session in its herdr pane, only where the pane is an idle shell (pane-restore's README, "Runbook steps"). Plain `restore` (no `--herdr`) labels hc terminals and is not the way back.
4. The storage moves roll back on their own runbooks ("## Rollback" in each), independently of this one.
