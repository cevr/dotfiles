# orchestrate mod

The runtime half of the [`orchestrate` skill](../../../skills/orchestrate/SKILL.md). It acts in Claude sessions whose herdr agent name marks them as orchestrate agents: `<run>-orch`, or `<run>-<unit>-impl|rev|ver`. In every other session it stays out of the way. It spends no model tokens: everything below runs in the mod. Only a real stall becomes a prompt.

- **Guard** (`tool.call` on Bash). It refuses these commands:
  - `herdr agent wait`;
  - `agent prompt --wait|--until`;
  - `sleep` of 10 seconds or more;
  - `until`/`while … sleep` loops.

  For workers, it also refuses a handoff that is not one of `protocol.md`'s messages, goes to the wrong agent, or names a file that does not exist.
- **Watchdog** (orchestrator only). Every minute it runs `herdr agent list` and reads `~/.cache/orchestrate/*/<run>/<unit>/`, then works out whose turn each track is from the round files' verdict lines. It sends the orchestrator one `[watchdog]` prompt per step when:
  - a track sits quiet for 10 minutes while the next step is an agent's;
  - an agent sits at a dialog for 2 minutes;
  - the agent whose turn it is has gone;
  - an accepted, stuck or blocked file exists that no message reported within 3 minutes.
- **`/tracks`** opens a pane with each track's round, step, next actor and agent states. The status line keeps the summary (`hymn: 2 tracks · 1 for you`).

The protocol logic is pure, in `hooks/protocol.ts`; `hooks/register.tsx` wires it to the engine.

## Checks

```sh
claude plugin validate ~/Developer/personal/dotfiles/claude/mods/orchestrate
claude plugin test ~/Developer/personal/dotfiles/claude/mods/orchestrate
```
