---
name: orchestrate
description: Coordinate a multi-unit plan by running each unit in a herdr track (a tab with an Opus implementor, a Codex reviewer and, when needed, a verifier) instead of subagents. Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to implementor and reviewer agents.
---

# Orchestrate

You are the **orchestrator**. You plan, write specs, open and close tracks, integrate results, and keep the record. You write no product code: your context holds the plan, verdicts and merges, so it stays small and survives the run.

A **track** is one herdr tab per unit, holding one long-lived agent per role:

- **implementor**: Claude Opus, medium effort. The sole writer.
- **reviewer**: Codex `gpt-6.1-sol`, high effort. A different model family, read-only, and by default it also verifies.
- **verifier**: Codex. A third pane, only when the spec calls for one.

Agents hand off by `herdr agent prompt`, along the chain implementor → reviewer → (verifier) → orchestrator. Each message wakes the next agent. Nobody polls, you included.

The rules every track agent follows are in [`protocol.md`](protocol.md). Read it once now, so your specs and decisions match it.

## Why tracks, not subagents

Evidence from the gent, effra, bible-tools and effect-frame loops (2026-09 and 2026-10):

- **Cache lifetime.** A top-level session (a herdr pane) caches for 1 hour. An Agent-tool subagent caches for 5 minutes unless `subagentPromptCacheTtl: "1h"` is set in settings, which is true on the workbox and not on the laptop. Subagents that waited on a gate, a counsel round or a peer rewrote 160–190k tokens after each long gap. In effra that was 75% of all cache writes. Root sessions survived 111 of 112 such gaps warm.
- **Cache reads.** Cache reads are the biggest cost: 62–83% of weighted spend. Workers ran 200+ turns at 150–195k tokens each. The lever is a smaller context per worker:
  - one unit per track;
  - delta rounds;
  - messages that carry paths, not content;
  - gate output kept in logs, not in context;
  - closing the tab when the unit merges.
- **Separate contexts.** Generation and judgment live in separate contexts and model families. An author is biased about its own change. Codex reviews were rarely rubber stamps (about 5 "clean" verdicts in about 213).

Subagents still fit read-only work that finishes in one run with no long waits: a sweep, a search, a planner draft. Anything that runs a gate, waits on a peer or iterates rounds is a track.

## 0. Preconditions

1. **Inside herdr.** Run `test "${HERDR_ENV:-}" = 1`. If it fails, say the orchestrator must run inside a herdr pane, and stop.
2. **Same server as the work.** Agent names resolve per herdr server, and workers message you by name. For work on the workbox, the orchestrator itself runs there. Start a Claude pane with `herdr --machine Workbox agent start …`, then hand it the plan.
3. **Name yourself.** Pick a short run slug (`[a-z][a-z0-9]{0,7}`), then run `herdr agent rename "$HERDR_PANE_ID" <run>-orch`.

Done when your pane carries the name `<run>-orch`.

## 1. Plan

1. **Read first.** Read the task and the repo's `AGENTS.md`/`CLAUDE.md` and `NORTH_STAR.md` before asking anything.
2. **Units.** Split the work into units. A unit is one reviewable result (one branch, one PR, one batch).
   - Give each unit a slug of up to 12 characters, and list the units it depends on: on their code, their decisions or their files.
   - Order the units topologically.
   - Units with no dependency and no shared files can run at the same time.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **At most 3 tracks at once.** Each track runs the gate. In effra, seven gates queued for an hour on one machine, so a slow gate is the first thing to fix before adding tracks.
   - **You decide small, reversible open points**, and record each one.
   - **Reserved for the user:** push, deploy, publish, paid runs, non-additive changes to stored or wire formats, and anything irreversible.
   - **You may merge locally.**
4. **Run dir.** Create `~/.cache/orchestrate/<repo>/<run>/` and write `plan.md` there. It is the single source of truth, and you re-read it after every compaction:

```markdown
# <run> — <goal in the user's words>
Mode: to the end · Tracks at once: 3 · Reserved: <list> · Repo: <path> · Base: <main hash>

| Unit | Depends on | Track | Workspace | Status | Result |
| ---- | ---------- | ----- | --------- | ------ | ------ |

## Decisions        (decision, principle, unit)
## Owner questions  (question, unit, recommendation, answer)
## Follow-ups       (from state.md files; new units or tracker items)
## Review later     (points the user wants batched, e.g. visual polish)
```

The unit statuses are `planned`, `running r<N>`, `accepted`, `merged <hash>`, `blocked` and `stuck`.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Spec each unit

Write `<run dir>/<unit>/spec.md` from [`spec-template.md`](spec-template.md) before its track opens. You are the planner. The **acceptance check** is written before any code: it is objective and runnable, red now and green when done. It is what verification means for this unit.

Add a verifier to the spec when the acceptance check is a live drive (a TUI, a browser, a deck render), a parity or golden diff, or a benchmark. That kind of check is long and its output is heavy, and a separate verifier keeps all of it out of the reviewer's context. The independence comes from the clean checkout and the pre-written check, not from a third model. For any other unit, the reviewer verifies.

Done when the spec's Owns, Do not touch, Acceptance check and Gate sections are concrete enough that a reader with no context could run them.

## 3. Open the track

1. **Workspace.** Make the unit's workspace from the warm source as `AGENTS.md` says (`rift create`; on the workbox, `workrift create <branch>`), on branch `<run>/<unit>`. Where Rift cannot run, use a git worktree.
2. **Open:**

   ```sh
   ~/.claude/skills/orchestrate/scripts/track up <run>-<unit> --cwd <workspace> [--verifier] [--claude-config ~/.claude2]
   ```

   - **Account.** The implementor's Claude account comes from `CLAUDE_CONFIG_DIR`: `~/.claude` is `claude` and `~/.claude2` is `claude2`. The script uses yours unless `--claude-config` names the other one. Spread tracks across both accounts when usage limits bind. Personal repos use the account the user names.
   - **Models.** `--impl-model`, `--impl-effort`, `--rev-model` and `--rev-effort` override the defaults. Raise the effort only where a fault is expensive.
3. **Read the JSON.** A `status` other than `ready` means the agent stopped at a startup dialog, such as folder trust or login. Read it with `herdr agent read <name> --source visible --lines 30` and ask the user. Never answer a trust or permission dialog yourself.
4. **Kick off the implementor only.** The reviewer and the verifier learn the protocol from the request file when round 1 arrives:

   ```sh
   herdr agent prompt <run>-<unit>-impl "You are the implementor of track <run>-<unit>. Read ~/.claude/skills/orchestrate/protocol.md and <run dir>/<unit>/spec.md in full, then start."
   ```

5. **Record.** Write the track, the workspace and `running r1` into `plan.md`.

Done when the implementor is working and `plan.md` names its track. Open every unit whose dependencies are merged, up to the track limit. Then end your turn.

## 4. On a message

Messages arrive as new turns, prefixed `[<track>]`. Handle one at a time.

### accepted

1. **Check the claims.** Read the accepting file's verdict and receipts and `git diff --stat`. Then check, against the code, the claims behind the spec's Risks section. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to the exact tree that was reviewed. If it does not, merge nothing and message the implementor: `orch: [<track>] merge main into your branch, gate, and send the next round`. That round is a merge round ([Rounds](protocol.md#rounds)).
   - Run the gate in the unit's workspace at the branch head, the exact tree main will become, into `<run dir>/merge-<unit>.log`, and read its exit line. Red: merge nothing, and send the implementor the log as a merge round.
   - Green: in the main checkout, `git merge --ff-only <branch>`.
3. **Record and close.**
   - Write `merged <hash>` into the unit's row in `plan.md`, with decisions, follow-ups from `state.md`, and anything for "Review later".
   - Run `track down <track>`, then remove the workspace by its full path.
4. **Next.** Open each unit whose dependencies are now all merged, up to the limit (step 3). If a result changes what a later unit needs, update that unit's spec first.

### blocked

Read `blocked.md`. If it holds a message an agent could not deliver because its target sat at a dialog, read the dialog (`herdr agent read <target> --source visible --lines 30`), ask the user to clear it, then deliver the held message to its target yourself.

- If the point is small and reversible, decide it by principle, record it in Decisions, and reply to the implementor with `orch: [<track>] decision: … ; continue`.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other tracks keep running.

### stuck

The track's third failed round (a Blocker or Major, or a verify FAIL). Never run another round in the same contexts. Re-plan, by one of these:

- sharpen the spec;
- split the unit;
- make the contested decision yourself;
- open a fresh track with the old findings as data.

Close the old track.

**Scope.** Scope never grows inside a running track. New work becomes a new unit in `plan.md`; it never goes into a message to a working agent.

## 5. Between messages

- **Wait.** End your turn and let messages wake you. No loops, no `agent wait`, no reading panes to check progress.
- **Use the idle time.** Spec the next units while you wait.
- **Stall check.** Do this only when the user asks for status, or when every running track is idle with no message for its last round. Run one `herdr agent list`. An implementor and a reviewer that are both idle mean a dropped message. Read the last 40 lines of each, then re-send the one missing message. A `blocked` agent is at a dialog: read it and ask the user.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md`, and run `herdr agent list`, before any other action.
- **Pause.** On a pause, or when the user stops the run, run `track down` on every track you opened, so no orphan agent burns tokens.

## 6. Close

The run closes when every unit is merged, or is blocked on an owner question.

The end report covers:

- what merged, with hashes;
- the gate on main;
- decisions taken by principle;
- the owner questions, each with a recommendation;
- the follow-ups;
- the Review later list;
- the `plan.md` path.

Close every track and workspace you opened.
