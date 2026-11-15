# Escape and waiting prompts

One Escape on a busy session with an empty composer stops its run. Within the grace (5 s by default) after a send it takes that prompt back: the run stops, the session reverts and the prompt is back in the composer. Past the grace, or over a draft, it interrupts and the turn reads `■ Interrupted`. A prompt waiting in the queue comes back to the composer whatever the grace, with every other waiting prompt, one line each, and the turn they waited behind stops once they are back. Up on the composer's first row takes the waiting prompts back the same way and leaves the turn running. Prompts queued behind a turn (leader+Enter) arrive as one user message when it ends. Ctrl+Enter (or leader then F) on a busy session interrupts the turn and sends the draft and every waiting prompt as the next turn. In a subagent's view, Escape goes back to the parent and leaves the subagent running. A press the server does not answer is a toast.

## Sub-features

- `escape-take-back`: within the grace, Escape takes the prompt just sent back into the composer and the session reverts.
- `escape-interrupt`: past the grace or over a draft, Escape interrupts; the turn reads `■ Interrupted`.
- `escape-waiting`: Escape on queued prompts takes them all back, one line each, and stops the turn; nothing queued is sent.
- `queue-up`: Up on the composer's first row takes the queued prompts back; the turn runs on; with nothing queued, Up walks the history.
- `queue-merge`: prompts queued behind a turn arrive as one user message, one line each.
- `escape-send`: Ctrl+Enter, or leader then F, interrupts and sends the draft and the waiting prompts, the queued ones first, each once.
- `escape-subagent`: in a subagent's view Escape goes back to the parent; the subagent keeps running.
- `escape-unanswered`: a run still going, or a prompt still queued, 5 s after the press is a toast.

## How to get to it (user POV)

- Escape, Up, Ctrl+Enter or leader then F, in a session's composer while a turn runs.
- leader+Enter puts the composer's prompt in the queue for after the turn.

## Driving it with the world

- **Preconditions:** none. These suites run on the simulated TUI (`sim-tui/`): the fork's real TUI in the test's process, with Prime and the escape plugin loaded by path, in front of a server double.
- **States:** default (a busy session), refused (an interrupt the server refuses) and the unanswered press (`escape-unanswered`). Loading, empty and error are `n/a`.
- **World suites:** `cmd/escape/escape-states.sim.test.tsx`, `cmd/escape/escape-send.sim.test.tsx`, `cmd/escape/escape-subagent.sim.test.tsx`, `cmd/escape/queue-merge.sim.test.tsx`
- **Code:** `mods/escape/`, `cmd/escape/`, `sim-tui/` (the harness every suite above runs on), `scenarios/escape-states.ts`, `scenarios/escape-send.ts`, `scenarios/escape-subagent.ts`, `scenarios/queue-merge.ts`; `tests/owned.ts`, `tests/scratch.ts` (the spawn helper and scratch folders its real checks run through: a change to them is due on every such check)
- **Regression:** `cmd/escape/setup.test.ts` (the plugin's keys and calls on a stand-in host, the order of the take-back and the stop), `cmd/escape/server.test.ts` (the delivery hook), `mods/escape/escape.test.ts` and `mods/escape/send.test.ts` (what a press decides).

`bun run verify:drive --feature escape` runs those suites, and `--real` runs the tests below.

## Driving it with real OpenCode

- **Real:** `tests/escape-states.test.ts`, `tests/escape-send.test.ts`, `tests/escape-subagent.test.ts`, `tests/queue-merge.test.ts`, `tests/prime-escape.test.ts`

1. **A turn to stop.** Type `verify: call shell {"command":"sleep 60"}`, Enter. Wait for the shell call to show running.
2. **Queue.** Type `Also update the docs.`, then leader (`pilotty key -s verify-$PORT Ctrl+X`) and Enter. Wait for `◌ after the turn · Also update the docs.`. Do the same with `Then tag it.`.
3. **Take back.** `pilotty key -s verify-$PORT Escape`. The composer holds both prompts, one line each, the `◌` lines go, and the turn reads `■ Interrupted`. No later turn carries either prompt.
4. **Interrupt.** Submit `verify: call shell {"command":"sleep 60"}` again, wait 7 s, press Escape: the prompt stays in the transcript and the turn reads `■ Interrupted`.
5. **Proof.** Snapshot after steps 2, 3 and 4 into `$EVIDENCE/escape/`.

## Gotchas

- Within the grace Escape takes the prompt back and reverts the session; wait past 5 s to see a plain interrupt.
- leader is Ctrl+X: queue with Ctrl+X then Enter, never Enter alone (that steers into the running turn).
- The take-back needs the fork's `ui.composer.takeBack` and `experimental.queue.deliver` (in `prime-look`); without them the prompts come back one at a time, or not at all.
