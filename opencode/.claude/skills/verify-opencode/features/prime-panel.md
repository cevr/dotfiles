# Prime's panel

↓ on an empty prompt opens the host's background-work panel, which Prime draws whole: a tab bar counting what each tab lists (Subagents, Shell, Terminals, then Prime's Wakes, Monitors and Jobs), one row shape for every tab (the state's diamond, a subagent's role and model, the name, what it last did, its state in a word, a live time, and how long since it was last heard from), and a footer wording the keys as the hint line does. ↑/↓ move the highlight, Enter shows the whole entry, ctrl+d cancels a wake as `wake_cancel` does or kills a running job, ←/→ move between tabs, and Escape puts it away. As the panel narrows its parts drop in a set order. The dock counts the session's running jobs (`1 job`) beside the shells.

## Sub-features

- `panel-open`: ↓ on an empty composer opens it; Escape closes it.
- `panel-tabs`: the tab bar counts each tab's rows; ←/→ move between tabs.
- `panel-rows`: every tab's rows share the columns above.
- `panel-wakes`: the Wakes tab lists pending alarms and latches' notes; Enter shows a whole note; ctrl+d cancels one.
- `panel-monitors`: the Monitors tab lists monitors with their newest output.
- `panel-jobs`: the dock counts the running jobs; the Jobs tab lists the session's jobs (id, note, command, state, time) with the highlighted one's log tail, and ctrl+d kills a running one; an ended job reads `exited N` or `killed` and leaves the dock's count.
- `panel-empty`: an empty tab says `No pending wakes`, `No monitors` or `No jobs`.
- `panel-narrow`: at 80 columns the parts drop from the last-heard age to the model, the state's word, then what it last did.

## How to get to it (user POV)

- ↓ on an empty composer, in a session.
- ←/→ inside it for the tabs; ↑/↓, Enter, ctrl+d on a row; Escape to close.

## Driving it with the world

- **Preconditions:** none. These suites run on the simulated TUI (`sim-tui/`): the fork's real TUI in the test's process, with Prime loaded by path, in front of a server double.
- **States:** `prime-jobs` opens the panel to its Jobs tab (running, exited, killed); the other tabs' states are `n/a` here, and the real path drives them.
- **World suites:** `cmd/prime/prime-jobs.sim.test.tsx` (the dock's job count and the Jobs tab, the wake RPC a stand-in: a running job, its exit, a ctrl+d kill), `cmd/prime/prime-runs.sim.test.tsx`, `cmd/prime/prime-sidebar.sim.test.tsx`, `cmd/prime/prime-pin.sim.test.tsx`, `cmd/prime/prime-idle-send.sim.test.tsx`, `cmd/prime/prime-escape.sim.test.tsx`, `cmd/prime/own-tabs.sim.test.tsx`, `cmd/prime/single-tab.sim.test.tsx`, `cmd/prime/prime-subagent-view.sim.test.tsx`, `cmd/prime/prime-subagent-panel.sim.test.tsx`, `cmd/prime/prime-subagent-click.sim.test.tsx`, `cmd/prime/prime-emphasis.sim.test.tsx`, `cmd/prime/prime-rules.sim.test.ts`. These are Prime's other surfaces on the simulated TUI: the subagent rows, the sidebar, the pin, a send while idle, Escape, the window's own session tabs (the window tab scope daily writes: another TUI's tabs never show; the row hides while the window holds only the session it shows and shows once a second is opened), and a subagent's view (entered from the open panel it shows alone, the panel closed, through the fork's layout knob composer.subagentPicker, set to closed; it keeps the parent's layout, the composer on the same row and the way back (↑ back to parent · ←/→ other subagents) and the family's rows under it where the parent's ↓ subagents and rows are, the dock counting the whole family in both; ↑ on its empty prompt goes back to the parent as Escape does, ↑ on a draft stays, and the parent's ↑ still walks the history; with the panel opened by ↓, ↑ moves up its list and past its top closes it back to the prompt; the ways down, back and across can be clicked too: a click on the parent's way down (↓ subagents) opens the Subagents panel as ↓ does, a click on the dock's way back goes to the parent as ↑ does, a click on its ← or → moves to the previous or next running subagent as the keys do, and a click on the parent's title in the top bar's breadcrumb goes to the direct parent, a grandchild's to the subagent above it, each brightening under the pointer in place). A change to Prime's code can break any of them, so its drive runs them all.
- **Code:** `mods/prime/`, `cmd/prime/`, `sim-tui/` (the harness every suite above runs on: a change to it is due on all of them), `scenarios/tui-paint.ts`, `tests/tui-paint.test.ts` (the paint rate of an idle orchestrator's TUI with workers running, its real check), `scenarios/tui-cpu.ts`, `tests/tui-cpu.test.ts` (the TUI's CPU while a long session streams), `scenarios/herdr.ts`, `tests/herdr.test.ts` (the herdr reporter in a real TUI), `scenarios/prime-subagents.ts`, `tests/prime-subagents.test.ts` (moving between a session and its running subagents, and the rows under the dock hidden on a phone-sized terminal, in a real TUI), `cmd/herdr/`, `mods/herdr/` (the reporter itself, which tests/herdr.test.ts runs); `tests/owned.ts`, `tests/scratch.ts` (the spawn helper and scratch folders its real checks run through: a change to them is due on every such check)
- **Regression:** `mods/prime/panel.test.ts` (the words and columns), `mods/prime/jobs.test.ts` and `mods/prime/opencode/jobs.test.ts` (the job words and the reading), `mods/wake/memory/model.test.ts` (the jobs board and the owner's stop).

`bun run verify:drive --feature prime-panel` runs those suites. Beyond the Jobs tab, the panel (its other tabs, rows and keys) has no world suite yet, so drive it on real OpenCode below, or with `--real` for `scenarios/prime-panel.ts`.

## Driving it with real OpenCode

- **Real:** `tests/prime-panel.test.ts`, `scenarios/prime-panel.ts`, `tests/tui-paint.test.ts`, `tests/tui-cpu.test.ts`, `tests/herdr.test.ts`, `tests/prime-subagents.test.ts`, `scenarios/prime-subagents.ts`

1. **A wake to list.** Type `verify: call wake {"afterSeconds":600,"note":"verify panel wake"}`, Enter. Wait for `the alarm starts a new turn`: the turn's last line is the tool answer's last (the call itself shows folded as `+ 1 tool`).
2. **Open.** With the composer empty, `pilotty key -s verify-$PORT Down`. Wait for `Wakes 1`. The tab bar reads `Subagents`, `Shell`, `Terminals`, `Wakes 1`, `Monitors`; the footer words the keys.
3. **Tabs.** `pilotty key -s verify-$PORT Right` until the Wakes tab is active: its row reads `verify panel wake`, `wake · once`, `pending`, `in 9m …`.
4. **Empty tab.** One more Right: the Monitors tab says `No monitors`.
5. **Close.** `pilotty key -s verify-$PORT Escape`: the panel goes and the composer is back.
6. **Narrow.** `pilotty resize -s verify-$PORT 80 30`, then Down again: the row keeps the name and the time, dropping the parts in order.
7. **Proof.** Snapshot after steps 2, 3, 4 and 6 into `$EVIDENCE/prime-panel/`.
8. **Jobs.** Type `verify: call job {"command":"sleep 120","note":"verify panel job"}`, Enter, wait for `started`. The dock reads `1 job`. Down, then Right until the Jobs tab: its row reads the job's id, `verify panel job`, `sleep 120`, `running` and a live time. ctrl+d: the row reads `killed` and the dock's `1 job` goes; the end letter wakes the session (`was killed`).

## Gotchas

- ↓ opens the panel only on an empty composer; with a draft it moves the cursor.
- The panel needs the fork's `panel-slots` and `panel-terminal-state` work (in `prime-look`); a fork without it draws the host's own panel, which is not Prime's.
- Times tick live: compare words, never a whole frame, across snapshots.
- Each finished turn ends with a wall-clock row (`mods/prime/turn-time.ts`); goldens and transcript checks read it as `<turn-time>` (`maskTurnTime`, the `MASKS` in `sim-tui/golden.ts`).
