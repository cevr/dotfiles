---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up, or pick up the latest Claude or Codex session in this workspace.
argument-hint: "What will the next session be used for? (or: pick up)"
disable-model-invocation: true
---

Two branches: **send** (this session hands its work on) and **receive** (this session continues another agent's work: "pick up", "continue where the last session left off", a handoff doc path).

## Send

1. **Pause at a safe boundary.** Finish the step in flight or back out of it, start nothing new, and stop the agents you launched. Commit uncommitted task edits as one `wip: <what>` commit on the current branch, staged by exact path, so nothing lives only in this context; when the tree is broken, say so in one line of the commit body. Leave it unpushed unless the branch was already pushed.
2. **Write the document** summarising the current conversation so a fresh agent can continue the work. Save it to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows), not the current workspace. It names the goal in the owner's words, the branch and the `wip:` commit, what is verified and how, and the next action.
   - Include a "suggested skills" section, naming which skills the next agent should call the Skill tool for.
   - Reference specs, plans, ADRs, issues, commits and diffs by path or URL rather than copying them.
   - Redact sensitive information, such as API keys, passwords, or personally identifiable information.
   - If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
3. **Launch, when asked** to start the next agent now: `claude --bg --name "<descriptive name>" -- "$(cat <doc path>)"`. Reading the doc from its file keeps the shell from running backticks or expanding `$` in it. The agent starts in the current directory; the user manages it with `claude agents`.

## Receive

1. **Find the trail.** A handoff doc the user named: read it. Otherwise mine this workspace's recent sessions, Claude and Codex alike:

   ```
   bun ~/.claude/skills/retro/scripts/mine-sessions.ts --project <workspace dir name> --since 2d --out <tmp dir>
   ```

   The newest non-subagent row of `sessions.jsonl` (by `last`) other than this session is the one to continue; its rows in `messages.jsonl` are the owner's directions, in order. Read the transcript itself only for what that digest leaves out (the final turns, a decision's reason).
2. **Reconstruct the state** from git: the branch, `git log` and `git diff` against its base, any `wip:` commit, the open todos.
3. **Verify inherited claims** ("tests pass", "merged", "fixed") against git and the real artifact before building on them. The trail is authoritative for what was decided; the artifact is authoritative for what is true.
4. **Adopt its goal**, in the owner's words, and continue from its resume point. Report where the last session stopped, which claims held, and the next action.
