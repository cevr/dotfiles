# Rex panes

In Rex, an agent shows its work in a pane beside the user's: `rex-show image FILE` draws a PNG, `rex-show md FILE` a Markdown page, and `rex-show tally TEXT` a line that is also the tab header's tally, all in the one pane labeled `showcase` that it splits off beside the caller's pane (or finds, keeping the oldest). A shell of a subagent draws beside the TUI that shows its family, and a shell whose session no TUI shows names no pane, so `rex-show` refuses it (exit 2) instead of drawing in another session's pane.

## Sub-features

- `rex-show`: `image`, `md` and `tally` draw in the session's showcase pane; a usage error or no pane exits 2, a failed Rex call 1.
- `rex-browse`: `rex-show browse URL` opens a live tab in a headless browser on the caller's host; its frames draw in the showcase, clicks, scrolls and keys in the pane reach the page, the header follows navigations, Ctrl-C (or `q` outside a field) quits and the browser goes with it.
- `rex-showcase`: one showcase per session, split off beside the caller, made again when its viewer exited; never the caller's own pane.
- `rex-family`: each subagent of the family on screen gets the TUI's pane when it appears and each time it starts to run again.
- `rex-server`: the server drops `REX_SESSION` and `REX_BLOCK` it inherited, so a shell no TUI set names no pane.
- `rex-state`: in a Rex pane (`TERM_PROGRAM=rex` or a `REX_SESSION`) the TUI takes the terminal's program status from the host (`ui.programStatus.claim()`) and writes one OSC 7501 record for the family on screen: `working` with the running call (`shell: bun test`, `2 subagents`) or `thinking`, `blocked` on a permission or a question (a form, or the owner's background questions once nothing works), `error` when the root's last run failed, `idle`; titled with the root's title, at most four writes a second and only on a change, cleared at a stop signal and when the plugin closes. Outside Rex it writes nothing and the host keeps its own records.

## How to get to it (user POV)

- An agent's shell, in a session a Rex pane's TUI shows, runs `rex-show image|md|tally …` (on `PATH` as `~/.local/bin/rex-show`).
- The user sees the `showcase` pane beside the TUI's, and the tally in Rex's tab header.

## Driving it with the world

- **Preconditions:** none.
- **States:** default (a picture, a page, a tally), refused (outside a pane, a usage error), error (a failing Rex tool). Loading and empty are `n/a`.
- **World suites:** none yet. Rex is an outside app with its own tool, which the world does not host, so a drive of this feature runs its real checks with --real: the command and the Rex adapter against a stand-in tool.
- **Code:** `mods/rex/`, `cmd/rex/`, `scenarios/rex-state.ts`, `tests/rex-state.test.ts`; rex-state reads its view through `mods/herdr/activity.ts` and `mods/herdr/opencode/` (a change there is due on it too)
- **Regression:** `mods/rex/memory/model.test.ts` (the showcase rule over interleaved calls), `mods/rex/pane.test.ts` (the pane's variables, the family's due rule), `mods/rex/opencode/family.test.ts` (the family the TUI hands its pane to), `mods/rex/frame.test.ts` (the pane's frame, the tally's OSC 7501 report), `cmd/rex/server.test.ts` (the server's seam), `mods/rex/live.test.ts` (a click lands in its cell's part of the page; SGR mouse reports and keys), `mods/rex/process/cdp.test.ts` (the DevTools client against a stand-in debugger), `cmd/rex/browse.test.ts` (the live tab's viewer over a stand-in tab), `mods/rex/state.test.ts` (the record of each state, the write rule), `mods/rex/opencode/state.test.ts` (the record of each view; the model over session events: exit always clears, nothing outside Rex, writes are spaced changes; the reporter over a stand-in claim).

1. **Show.** Run `cmd/rex/show.test.ts`: from a caller's pane, one showcase splits off beside it and the viewer is told the spool; outside a pane the command exits 2.
2. **Rex's tool.** Run `mods/rex/process/rex.test.ts`: each call names the session, a split asks for the showcase beside the caller, a failing tool is a failure with what it said.

## Driving it with real OpenCode

- **Real:** `cmd/rex/show.test.ts`, `mods/rex/process/rex.test.ts`, `tests/rex-state.test.ts` (a real TUI in a pty, believing it is in a Rex pane: working with the command, idle, cleared on SIGTERM; needs a fork with ui.programStatus.claim)

1. **In Rex.** Only in a Rex pane on the owner's Mac or the workbox, never his own session: open a pane with a TUI on the verify root, and have it run `verify: call bash {"command":"rex-show tally 'verify tally' --state working"}`. A pane labeled `showcase` opens beside it, and the tab header reads `verify tally`.
2. **Picture.** `verify: call bash {"command":"rex-show image notes.png"}` with a PNG in the root: the showcase draws it, the tally's line above.
3. **Outside.** `verify: call bash {"command":"env -u REX_SESSION -u REX_BLOCK rex-show tally x"}`: exit 2, nothing drawn.
4. **State.** In that pane, `rex block call -s "$REX_SESSION" -b "$REX_BLOCK" program_status` (from another shell of the same session) shows one `opencode` record: `working` with the running call during a turn, `idle` after it, and none once the TUI quits.
5. **Proof.** A screenshot of the pane and the command's output into `$EVIDENCE/rex/`.

## Gotchas

- A pane is named by `REX_SESSION` and `REX_BLOCK` together: one alone is no pane.
- A TUI attached to another machine's server (`--server`) hands no pane: its pane means nothing there.
- In Rex, as in herdr, OpenCode's own tab strip stays off with `tabs.mode` `"auto"` (a pane already holds one session).
