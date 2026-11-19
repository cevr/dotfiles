# Model at the next compaction

A session's model can be switched later instead of now: `/model-next`, or `at next compaction` (ctrl+g) on a model in the host's model picker, queues it, and the tray under the composer reads `old → new queued`. The switch takes over right after the session's next completed compaction, whose summary the outgoing model still writes, so the next step is the new model's; or, when the session wakes after its prompt cache has expired (the last request's start plus its lifetime plus a minute's grace), before the first request of that turn. Inside the cache's lifetime it never applies, and with any fact unknown it waits. `/model-next` with a switch queued offers `Cancel the queued switch` first; its `compact now` (ctrl+o) queues and compacts at once. Any direct model switch drops the queued one; a failed compaction keeps it. It survives a restart, and a subagent started meanwhile does not inherit it. A refusal (the session's own model, a model the catalog lacks, no such session, a session on native compaction) is a toast that says why.

## Sub-features

- `MN1` queue from `/model-next`: the tray line reads `old → new queued`.
- `MN2` a compaction applies it: the summary is the old model's, the next step the new model's, the tray line goes.
- `MN3` cancel from `/model-next`: `The queued switch is cancelled`, the tray line goes, nothing applies.
- `MN4` queued, restart: still shown, still applies at the next compaction.
- `MN5` queue from the host's model picker's `at next compaction` (ctrl+g).
- `MN6` idle past the cache's lifetime plus the grace: the next prompt runs on the new model and the tray line goes; inside it, the old model answers and the switch stays queued.

## How to get to it (user POV)

- `/model-next` in a session (the command palette's `Switch the model at the next compaction`).
- The host's model picker (leader then m): highlight a model, ctrl+g (`at next compaction`; the plugin option `bind` changes the key).
- An agent or a shell: `bun cmd/model-next/cli.ts queue <sessionID> <provider/model[#variant]> [--directory <dir>]`, `cancel <sessionID>`, `show <sessionID>`, from `opencode/`, against the running service.

## Driving it with the world

- **Preconditions:** none. The server half runs on the simulated host with the model-next plugin; the TUI half on the simulated TUI (`sim-tui/`), the fork's real TUI with Prime and the model-next plugin, the queue RPC a stand-in on the double.
- **States:** default (queued, applied), refused (same model, unknown model, native compaction), and the waits (warm cache, unknown lifetime, failed compaction). Loading, empty and error are `n/a`.
- **World suites:** `cmd/model-next/model-next.sim.test.ts`, `cmd/model-next/model-next-tui.sim.test.tsx`
- **Code:** `mods/model-next/`, `cmd/model-next/`, `mods/prime/chrome.ts`, `mods/prime/tui/chrome.tsx`, `sim/`, `sim-tui/`
- **Regression:** `mods/model-next/pending.test.ts` (the rules: the expiry boundary, each unknown, the selection that ends it), `mods/model-next/model.test.ts` (the other metadata keys survive), `mods/model-next/memory/sessions.test.ts` (the contract's laws), `mods/prime/chrome.test.ts` (the tray's words), `sim/host-laws.test.ts` (`switchModel`, `compactionEnded`, `wake`).

1. **MN1, MN5.** `model-next-tui.sim.test.tsx`: `/model-next` then Enter on a model calls `queue` with it; in the picker ctrl+g on the highlighted model does the same; a session whose metadata holds a queued switch draws `gpt-sim-model → claude-fable-5-2 queued` on the tray, and one naming another session draws nothing.
2. **MN2, MN4.** `model-next.sim.test.ts`: a mid-turn compaction's summary is on the old model and the very next step on the new one; a restart between the queue and the compaction still applies it.
3. **MN3.** Both suites: cancel calls `cancel`, and nothing applies at the next compaction.
4. **MN6.** `model-next.sim.test.ts`: past the lifetime plus the grace the next turn's every request is on the new model; at `TTL + GRACE − 5 s` it stays on the old one.

`bun run verify:drive --feature model-next` runs those suites.

## Driving it with real OpenCode

- **Real:** `tests/host-laws.test.ts` (real OpenCode keeps the laws the switch rests on: switchModel, compactionEnded and wake). A real check of the plugin itself is a follow-up; the steps below drive it by hand.

1. **Seed.** `bun run verify:seed $ROOT --plugins model-next`, launch and open the TUI as the index says.
2. **Queue.** Type `/model-next`, Enter, pick a model other than the session's, Enter. The tray under the composer reads `<old> → <new> queued`.
3. **Apply.** Type `/compact`, Enter. A `Switched` row follows the compaction; the tray shows the new model alone.
4. **Proof.** Snapshot after steps 2 and 3 into `$EVIDENCE/model-next/`.

## Gotchas

- The verify model's catalog may hold only one model: a switch to the session's own model is refused (`the session already runs on that model`).
- Idle time alone switches nothing: the expiry switch happens as the next prompt (or a synthetic wake) starts, not at the expiry.
- The wake hook does not run for a steer into a running turn or a continuation after a restart: a cache that expires during a long tool call is applied at the next compaction or the next fresh turn.
