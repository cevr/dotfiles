# Hosts: starting and restarting a role

- **OpenCode.** A native `subagent` call names the role (`agent: "verifier"`), runs in the background and names no `model`; its description starts like the hand-back line (`implementor auth r2`). A verifier runs on the newest Opus and latches while Claude is held; a planner tries Fable, then Opus. A latched call opens by itself and its result wakes you: never retry, poll or send to it. Round 2 on the same implementor passes its `sessionID`.
- **Claude Code.** `Agent` with `subagent_type` set to the role (`planner`, `implementor`, `verifier`, else `worker`), in the background. A held verifier: run `budget.ts --wait <ticket>` in the background, then call `Agent` again.
- **Codex** is the fallback host: each role is `agent_type` with `fork_turns: "none"`. Never a verifier on Codex.

## Worker restarts

- **Provider stop.** A content-filter notice that reports only a session interruption gets one plain continuation; if it ends again, restart the step fresh and say so in the brief.
- **Other dead workers.** Rerun the step with a fresh agent (after a limit, once `budget.ts --resume-at` has passed); the same failure twice is `stuck`.
