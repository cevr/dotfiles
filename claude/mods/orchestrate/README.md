# orchestrate mod

The in-session half of the [`orchestrate` skill](../../../skills/orchestrate/SKILL.md). [baton](../../../baton) holds each run's state as an event log, and this mod reads it. It acts in a Claude session that `baton whoami` places in a live run, as the orchestrator or a track seat. In any other session it stays out of the way. It spends no model tokens.

- **Guard** (`tool.call` on Bash). In a baton seat it refuses:
  - a commit that skips the hook (`--no-verify`, `LEFTHOOK=0`);
  - polling: `herdr agent wait`, a `sleep` of 10 seconds or more, and `until`/`while … sleep` loops;
  - a hand-written `herdr agent prompt` to one of the run's agents. The refusal names the command to use instead: `baton pass` or `baton ask` for a worker, `baton tell` for the orchestrator.
- **Watchdog** (orchestrator only). Every minute it runs `baton tick`. Baton records herdr's agent states, alerts the orchestrator once per stalled step, and retries owed messages.
- **`/tracks`** opens a pane from `baton status --json`. The status line keeps the summary (`hymn: 2 tracks · 1 for you`).

`hooks/protocol.ts` holds the pure parts: baton's JSON, the guard and the summary. `hooks/register.tsx` wires them to the engine.

## Checks

```sh
claude plugin validate ~/Developer/personal/dotfiles/claude/mods/orchestrate
claude plugin test ~/Developer/personal/dotfiles/claude/mods/orchestrate
```
