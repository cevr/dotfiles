# Prime's reply emphasis

A reply's `[[Word]]` pills draw as coloured chips and the "In the queue" section's bold lead labels gain their state's diamond, in the Prime look. Nine words are chips (`Measured ●`, `Inferred ○`, `Guess ?`, `Done ✓`, `Failed ✗`, `Blocked ◆`, `Skipped ◌`, and solid `Costs money $`, `Irreversible !`; `Passed` and `Unverified` draw as `Done` and `Guess`), each exactly as wide as its source, with short detail kept (`[[Failed: 3 tests]]` reads ` ✗ Failed: 3 tests `). A bold span opening a paragraph or list item that names a queue state (`Running`, `Waiting on you`, `Waiting`, `Dated`, `Scheduled`, `Held`, `Next`) reads with the subagent rows' diamond in that state's colour in front. Unknown words, code and the stored text stay as typed; a streamed reply never shows a closed pill as typed; the TUI option `emphasis: false`, or Markdown shown as source, draws every pill as typed.

## Sub-features

- `emphasis-chip`: a known pill draws as its chip, in its tone, as wide as `[[text]]`.
- `emphasis-label`: a queue label opening a block draws its state's diamond in front.
- `emphasis-table`: a pill in a table cell draws as its chip.
- `emphasis-stream`: once a pill's `]]` arrives no frame shows it as typed, and the reply never loses a row.
- `emphasis-typed`: unknown words, code, the stored text and copies stay as typed.
- `emphasis-off`: the TUI option `emphasis: false` draws every pill as typed.

## How to get to it (user POV)

- An assistant reply (or a compaction's summary at All) whose text holds `[[Word]]` or opens a block with a bold queue label.
- The option is set on Prime's TUI plugin entry in `cli.json` (`{ "package": ".../cmd/prime", "options": { "emphasis": false } }`).

## Driving it with the world

- **Preconditions:** none. The suite runs on the simulated TUI (`sim-tui/`): the fork's real TUI in the test's process, with Prime loaded by path, in front of a server double whose tree-sitter is OpenTUI's mock (it highlights nothing, so bold markers stay on screen; the suite drops them before comparing with the real run's frame).
- **States:** default (the finished reply), loading (the reply streaming). Empty, refused and error are `n/a`: a reply with no pill draws as it did.
- **World suites:** `cmd/prime/prime-emphasis.sim.test.tsx`
- **Code:** `mods/prime/emphasis.ts`, `mods/prime/tui/emphasis.ts`, `mods/prime/tui/prose.tsx`, `mods/prime/tui/tone.ts`, `cmd/prime/prime-emphasis.sim.test.tsx`, `scenarios/prime-emphasis.ts`, `sim-tui/golden/prime-emphasis/`
- **Regression:** `mods/prime/emphasis.test.ts` (the words, the splitting on both paths, the width law, the prompt section), `mods/prime/tui/emphasis.test.ts` (attach on the pinned opentui with its real tree-sitter: the final frame, a table cell, a stream, the source view, both private names).

1. **The finished reply.** The suite asks `How did the disk cleanup go?` and the model streams the scenario's reply. The frame matches `sim-tui/golden/prime-emphasis/emphasis.txt`: ` ● Measured `, ` ✓ Done 104/104 `, ` ✗ Failed: 3 tests `, ` ! Irreversible `, the table's ` ✓ Done ` and ` ◆ Blocked `, and `◈ Running (mine):`, `◆ Waiting on you:`, `◇ Dated (mine):`, `◇ Next:`.
2. **Colours.** ` ✓ Done 104/104 ` and ` ● Measured ` share the success colours; ` ! Irreversible ` is bold on the error colour ` ✗ Failed: 3 tests ` writes in; every chip's ground is opaque.
3. **Stream.** No frame recorded while it streams shows a closed pill as `[[Word]]` or `[Word]`, and the rows from the ask to the reply's end never shrink.
4. **Stored.** The double's stored text part is the reply as sent, pills and all.

## Driving it with real OpenCode

- **Real:** `scenarios/prime-emphasis.ts`

1. **Chips.** Type `verify: say Disk is at 61% [[Measured]] and the gate passed [[Done 12/12]], one check [[Failed: 3 tests]], deleting it is [[Irreversible]]; see [[acknowledge-before-processing]] and the code `[[Guess]]`.` and press Enter. Wait for `Irreversible`. The reply reads ` ● Measured `, ` ✓ Done 12/12 `, ` ✗ Failed: 3 tests `, ` ! Irreversible ` (bold, on red), `[acknowledge-before-processing]` and `[[Guess]]` as before.
2. **Label.** Type `verify: say **Waiting on you:** the bucket login.` and Enter. The reply reads `◆ Waiting on you: the bucket login.`, the diamond in the warning colour.
3. **Proof.** After each step, `pilotty snapshot -s verify-$PORT --format text > $EVIDENCE/prime-emphasis/<step>.txt`. For the screenshots, run the scenario twice (`SCENARIO_EMPHASIS=off` for the plain one): `emphasis.png` and `emphasis-plain.png` under `OPENCODE_DRIVE_MEDIA_DIR`, and `emphasis-stream.json` lists no raw pill.

## Gotchas

- The simulated TUI's tree-sitter highlights nothing: its frames show `**` around a label where the real TUI hides them, and an unknown `[[word]]` as typed where the real TUI draws `[word]`. Compare with the real run's golden only after dropping the `**`.
- A pill still open mid-stream (`[[Done]`) shows as typed until its `]]` arrives; only a closed one is drawn.
- The chips are drawn into the host's Markdown through two of opentui's private names; after an opentui upgrade, `mods/prime/tui/emphasis.test.ts` says whether both are still there.
