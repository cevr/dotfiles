# rex-migrate (`rexm`)

Moves herdr-core (`hc`) spaces into [Rex](https://www.superlogical.com/rex/docs), as `hcm` moved Herdr workspaces into `hc`. Each hc space becomes a Rex session, named after the space (or its folder when the space has no name), and each hc tab becomes a Rex tab with a new shell per hc terminal, in that terminal's folder. Running programs cannot move. An OpenCode terminal's session is typed into its new Rex shell once (`opencode -s <id>`), and only after its hc copy has stopped.

`~/.local/bin/rexm` links to `rex-migrate/rexm.ts`: `install.sh` sets the link on the Mac, and `workbox/bin/apply-agent-settings` sets it on the workbox. It needs `bun`, `hc` and `rex`. On the Mac, `rexm` uses the `rex` inside `Rex Beta.app` when no `rex` is on the PATH.

| Command | What it does |
| --- | --- |
| `rexm plan` (the default) | Read-only. Lists the Rex session each hc space becomes and the Rex tab each hc tab becomes. Marks each OpenCode terminal with its session id, and names what does not move: terminals on another machine, terminals in no space, sessions two terminals share. |
| `rexm apply` | Creates them on the Rex server. A rerun adds only what is new. A space whose Rex session exists (recorded, or the one Rex session with its label) gets the new tabs, and a Rex tab you closed comes back. It changes nothing in hc. |
| `rexm resume` | For each OpenCode tab, types `opencode -s <id>` into its new Rex shell, once. It refuses, and says where, while the session is still open in hc (its terminal's command line or the `opencode.session` label), while the source terminal still runs OpenCode, while the Rex shell runs anything, or while another Rex pane has the session open. |
| `rexm verify` | Read-only. Checks that each hc tab has one Rex tab with a shell per terminal, that no resume is pending or failed, and that no session is open twice across hc and Rex. |

`-S <server>` (or `REX_SERVER`) picks the Rex server: a host label from `rex hosts`, or an address. The default is the local server. `rexm` never starts a server (`rex --autostart=false`). `HC_SESSION` picks the hc session, as it does for `hc`.

## Where things come from

- **Spaces and tabs**: from the `herdr-app` doc in hc (`doc.get` over `hc connect`). This is the doc `hcm` wrote and that rodeo and the Herdr app share. A tab's terminals are the `terminal` blocks of its layout, in order. A tab with no terminal on this machine still gets one shell in the space's folder.
- **Terminals**: from `hc ls --json` and `hc get <t> --json`, this machine's live terminals only. A `machine/tN` terminal moves when `rexm` runs on that machine.
- **OpenCode sessions**, as `herdr-core/cutover.ts` finds them: the `-s`/`--session` on the foreground's command line (this also covers the handoff's `sh -c` script around `exec '<opencode>' '-s' '<id>'`), then the `opencode.session` label, then a pending `migrate.resume` or a `cutover.session` label. A TUI started bare has no id. `plan` prints it as `session unknown` with its title, so you can open it by hand.
- **What moved**: the state file `$XDG_STATE_HOME/rexm/<hc session>-<hc core id>-<hash of the Rex endpoint>.json` (`REXM_STATE_DIR` overrides the folder). It records the Rex session for each hc space, the Rex tab and the shell for each hc tab and terminal, and each resume's state: `pending`, `typed` or `failed`. A resume is marked `typed` before its keys are sent, so a crash between the two never types it twice.
- **Rex panes' programs**: `rex block call process` gives the foreground's name. On a local (unix-socket) server, `ps` gives its command line, which shows whether a pane has an OpenCode session open.

## Cutover order

Run each step on the host being moved, from a terminal outside hc (a plain Ghostty window on the Mac, or an `ssh bite-workbox` login on the workbox), because step 4 ends programs in hc.

1. **Look.** Run `rexm plan`. Every hc space should be listed once, every OpenCode tab should show its `ses_` id, and the notes should name nothing you want moved. A `session unknown` line means a bare TUI: write down its session (from its title) and open it by hand after step 5.
2. **Make the Rex side.** Run `rexm apply`, then `rexm apply` again. The first run prints `N made; M resume(s) pending` and the second prints `0 made`. Open Rex (`Rex Beta.app` on the Mac; on the workbox, `rex -S <workbox host> ls`) and compare it with rodeo or the Herdr app.
3. **Check the guard.** Run `rexm resume`. It should refuse every pending session with `still open in hc tN; quit it there first`, and type nothing.
4. **Stop the hc copies.** Quit each OpenCode TUI in hc (or `hc kill tN` for each terminal `resume` named). Leave the hc server running; `resume` reads it.
5. **Resume.** Make sure the OpenCode service is up (`opencode api GET /api/session` answers), then run `rexm resume`. It prints `typed ses_… → …block: opencode -s ses_…` once for each session. A `refused` line says why. Fix the cause (quit the program that pane runs, or `rexm apply` if a Rex tab was closed) and run `resume` again. A second run prints `0 typed`.
6. **Verify.** Run `rexm verify`. Expect `ok   tabs`, `ok   resumes`, `ok   sessions`. A `FAIL resumes … failed` line names a session whose typing failed: open it by hand in that pane (it is never typed again).
7. **After.** hc keeps running until you retire it. Use Rex for a day before you stop hc (`hc server stop`).

**Rollback**, before hc is retired: quit the resumed TUIs in Rex first, so that no session is open twice. Then open each session in its hc terminal again (`opencode -s <id>`, at a shell prompt). `rex session kill <session>` removes what `apply` made. Remove the state file too, or the next `apply` adopts the remaining sessions by their labels and skips the resumes it already typed.

## Tests

`bun test --parallel=1 rex-migrate/rexm.test.ts` runs three groups:

- A model-based test: 400 generated hc layouts, each driven by 30 random commands (apply, resume, stop an hc copy, add a tab or a split, close a Rex tab, start or quit a program in a Rex pane, a failed typing, plan, verify). After every step it checks that apply is idempotent, that each session is typed at most once, that no session is open twice, and that plan and verify change nothing. At the end it runs a full cutover and expects `verify` to pass.
- Unit tests of each part: the doc reader, the plan, the session parsing, and the resume refusals.
- A drive against a scratch Rex server (`rex server run --listen unix:///tmp/rxm<pid>/rex.sock --state-dir …`) and a scratch hc core (`HC_SESSION=rxm<pid>`, with its own HOME and XDG folders). It is skipped when `hc` or `rex` is missing. It never reaches the owner's hc session or Rex server, and it checks afterwards that the owner's hc core is still the same process.

Typecheck: `opencode/node_modules/.bin/tsc -p rex-migrate`.
