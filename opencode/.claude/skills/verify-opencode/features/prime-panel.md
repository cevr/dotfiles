# Prime's panel

↓ on an empty prompt opens the host's background-work panel, which Prime draws whole: a tab bar counting what each tab lists (Subagents, Shell, Terminals, then Prime's Wakes and Monitors), one row shape for every tab (the state's diamond, a subagent's role and model, the name, what it last did, its state in a word, a live time, and how long since it was last heard from), and a footer wording the keys as the hint line does. ↑/↓ move the highlight, Enter shows the whole entry, ctrl+d cancels a wake as `wake_cancel` does, ←/→ move between tabs, and Escape puts it away. As the panel narrows its parts drop in a set order.

## Sub-features

- `panel-open`: ↓ on an empty composer opens it; Escape closes it.
- `panel-tabs`: the tab bar counts each tab's rows; ←/→ move between tabs.
- `panel-rows`: every tab's rows share the columns above.
- `panel-wakes`: the Wakes tab lists pending alarms and latches' notes; Enter shows a whole note; ctrl+d cancels one.
- `panel-monitors`: the Monitors tab lists monitors with their newest output.
- `panel-empty`: an empty tab says `No pending wakes` or `No monitors`.
- `panel-narrow`: at 80 columns the parts drop from the last-heard age to the model, the state's word, then what it last did.

## How to get to it (user POV)

- ↓ on an empty composer, in a session.
- ←/→ inside it for the tabs; ↑/↓, Enter, ctrl+d on a row; Escape to close.

## Driving it with the world

- **Preconditions:** none; the world has no TUI.
- **States:** `n/a` on the world.
- **World suites:** none yet. The world has no TUI, and the simulated TUI has no panel suite; the real scenario holds the rows and words.
- **Code:** `mods/prime/`, `cmd/prime/`
- **Regression:** `mods/prime/panel.test.ts` (the words and columns).

`bun run verify:drive --feature prime-panel` reports it `unreachable` on the world; drive it on real OpenCode.

## Driving it with real OpenCode

- **Real:** `tests/prime-panel.test.ts`, `scenarios/prime-panel.ts`

1. **A wake to list.** Type `verify: call wake {"afterSeconds":600,"note":"verify panel wake"}`, Enter. Wait for `the alarm starts a new turn`: the turn's last line is the tool answer's last (the call itself shows folded as `+ 1 tool`).
2. **Open.** With the composer empty, `pilotty key -s verify-$PORT Down`. Wait for `Wakes 1`. The tab bar reads `Subagents`, `Shell`, `Terminals`, `Wakes 1`, `Monitors`; the footer words the keys.
3. **Tabs.** `pilotty key -s verify-$PORT Right` until the Wakes tab is active: its row reads `verify panel wake`, `wake · once`, `pending`, `in 9m …`.
4. **Empty tab.** One more Right: the Monitors tab says `No monitors`.
5. **Close.** `pilotty key -s verify-$PORT Escape`: the panel goes and the composer is back.
6. **Narrow.** `pilotty resize -s verify-$PORT 80 30`, then Down again: the row keeps the name and the time, dropping the parts in order.
7. **Proof.** Snapshot after steps 2, 3, 4 and 6 into `$EVIDENCE/prime-panel/`.

## Gotchas

- ↓ opens the panel only on an empty composer; with a draft it moves the cursor.
- The panel needs the fork's `panel-slots` and `panel-terminal-state` work (in `prime-look`); a fork without it draws the host's own panel, which is not Prime's.
- Times tick live: compare words, never a whole frame, across snapshots.
