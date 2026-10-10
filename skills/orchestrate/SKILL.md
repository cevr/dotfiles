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

**`baton`** (`~/Developer/personal/baton`, on `PATH`) runs the relay. One agent holds the baton at a time. Each step ends with `baton pass <file>`, which appends the step to an event log (SQLite, one file per machine). Baton then works out whose turn is next and delivers that agent a one-line message through herdr. The state, the routing and the record all come from that log. Nobody polls, you included. `baton --help` lists the commands.

The rules every track agent follows are in [`protocol.md`](protocol.md). Read it once now, so your specs and decisions match it.

The **orchestrate mod** (`~/Developer/personal/dotfiles/claude/mods/orchestrate`, loaded by the shared `settings.json`) runs beside you and every Claude track agent, at no model cost:

- **Guard.** It refuses polling, and refuses a hand-written `herdr agent prompt` to a track agent. The refusal names the `baton` command to use instead.
- **Watchdog.** In your session it runs `baton tick` every minute. Baton then sends you `[watchdog]` messages when a track stalls.
- **`/tracks`.** This command opens a pane from `baton status`. The status line keeps the summary.

## Why tracks, not subagents

Evidence from the gent, effra, bible-tools and effect-frame loops (2026-09 and 2026-10):

- **Cache lifetime.** A top-level session (a herdr pane) caches for 1 hour. An Agent-tool subagent caches for 5 minutes, unless the shared `settings.json` sets `subagentPromptCacheTtl: "1h"`, as it now does. Before that, subagents that waited on a gate, a counsel round or a peer rewrote 160–190k tokens after each long gap. That was 71–75% of subagent cache writes in effra. Root sessions survived 111 of 112 such gaps warm.
- **Cache reads.** Cache reads are the biggest cost: 62–83% of weighted spend. In bible-tools, apply subagents read 7.4B tokens, 93% of the run. One batch ran 2,924 turns through 15 compactions. Even with a 1-hour cache, the lever is a smaller context per worker:
  - one unit per track, about one concern; an implementor that compacts twice is holding too much, so split the unit;
  - delta rounds;
  - messages that carry paths, not content;
  - gate output kept in logs, not in context;
  - closing the tab when the unit merges.
- **Separate contexts.** Generation and judgment live in separate contexts and model families. An author is biased about its own change. Codex reviews were rarely rubber stamps (about 5 "clean" verdicts in about 213).

Subagents still fit read-only work that finishes in one run with no long waits: a sweep, a search, a planner draft. Anything that runs a gate, waits on a peer or iterates rounds is a track.

## 0. Preconditions

1. **Inside herdr, with baton.** Run `test "${HERDR_ENV:-}" = 1 && command -v baton`. If herdr is missing, say the orchestrator must run inside a herdr pane, and stop. If baton is missing, run `bun install && bun run build` in `~/Developer/personal/baton`.
2. **Same server as the work.** Baton's log and herdr's agent names are both per machine. For work on the workbox, the orchestrator itself runs there. Start a Claude pane with `herdr --machine Workbox agent start …`, then hand it the plan.
3. **Start the run.** Pick a short run slug (`[a-z][a-z0-9]{0,7}`), then run `baton run start <run>`. It names your pane `<run>-orch` and prints the **run dir**, where the unit folders live. After a compaction, `baton whoami` prints them again.

Done when `baton whoami` says you are `orch` of `<run>`.

## 1. Plan

1. **Read first.** Read the task and the repo's `AGENTS.md`/`CLAUDE.md` and `NORTH_STAR.md` before asking anything.
2. **Units.** Split the work into units. A unit is one reviewable result (one branch, one PR, one batch).
   - Give each unit a slug of up to 12 characters, and list the units it depends on: on their code, their decisions or their files.
   - Order the units topologically.
   - Units with no dependency and no shared files can run at the same time.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **At most 3 tracks at once, and fewer when the gate cannot take them.** Each track runs the gate. Time it once before the first wave. While a gate waits in the queue longer than twice its own run, open no new track, and make gate speed the next unit; it preempts the others. In effra, eight lanes queued on the gate lock for up to 39 minutes at a load of 19–36, and the gate-speed lane, opened last, cut the gate from 446 s to under a minute.
   - **You decide small, reversible open points**, and record each one.
   - **Owner questions never wait in a dialog.** Put the question in Owner questions with your recommendation, and tell the user in one short message. Then end your turn, and keep the other tracks running.
   - **Reserved for the user:** push (unless the repo's `NORTH_STAR.md` has a `Push:` owner rule, or its `AGENTS.md` grants it), deploy, publish, paid runs, non-additive changes to stored or wire formats, and anything irreversible.
   - **You may merge locally.**
4. **Plan file.** Write `plan.md` in the run dir. It is the single source of truth for the plan, and you re-read it after every compaction. Each track's own state lives in baton's log. Its first line holds the user's goal word for word, so a new session (after a limit, or on the other account or machine) resumes from `plan.md` and `baton status` alone. The handoff is that, never a file in `/tmp`.

```markdown
# <run> — <goal, word for word as the user gave it>
Mode: to the end · Tracks at once: 3 · Gate: <seconds> · Reserved: <list> · Repo: <path> · Base: <main hash>

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
   baton open <unit> --cwd <workspace> [--verifier] [--max-failures 3] [--claude-config ~/.claude2]
   ```

   This opens a tab named `<run>-<unit>` and starts the agents in it. It then hands the implementor the baton, with a message pointing at the spec.

   - **Account.** The implementor's Claude account comes from `CLAUDE_CONFIG_DIR`: `~/.claude` is `claude` and `~/.claude2` is `claude2`. Baton uses yours unless `--claude-config` names the other one. Spread tracks across both accounts when usage limits bind. Personal repos use the account the user names.
   - **Models.** `--impl-model`, `--impl-effort`, `--rev-model` and `--rev-effort` override the defaults. Raise the effort only where a fault is expensive.
3. **Read the JSON.** A `started` other than `ready` means the agent stopped at a startup dialog, such as folder trust or login. Read it with `herdr agent read <name> --source visible --lines 30` and ask the user. Never answer a trust or permission dialog yourself. Once the user clears it, `baton status` shows whether the kickoff is still owed, and `baton redeliver <ref>` sends it.
4. **Record.** Write the track, the workspace and `running r1` into `plan.md`.

Done when `baton status` shows the track with the baton at the implementor, and `plan.md` names it. Open every unit whose dependencies are merged, up to the track limit. Then end your turn.

## 4. On a message

Baton's messages arrive as new turns, prefixed `[<track>]`, `[watchdog]` or `[baton]`. Handle one at a time. The baton is yours until you act: a `baton tell` or `baton close` hands it on.

### accepted

1. **Check the claims.** Read the accepting file's verdict and receipts and `git diff --stat`. Then check, against the code, the claims behind the spec's Risks section. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to the exact tree that was reviewed. If it does not, merge nothing and run `baton tell <unit> impl "merge main into your branch, gate, and send the next round"`. That round is a merge round ([Rounds](protocol.md#rounds)).
   - Run the gate in the unit's workspace at the branch head, the exact tree main will become, into `<run dir>/merge-<unit>.log`, and read its exit line. Red: merge nothing, and send the implementor the log as a merge round.
   - Green: in the main checkout, `git merge --ff-only <branch>`. That is the whole of your part. A track's work reaches main only as its reviewed head. A fix you would make yourself goes to the implementor as a round.
   - Push only as the Reserved default allows. After a push, read `gh run list --branch main --limit 1` once CI finishes; a red CI is a new unit.
3. **Record and close.**
   - Write `merged <hash>` into the unit's row in `plan.md`, with decisions, follow-ups from `state.md`, and anything for "Review later".
   - Run `baton close <unit> --merged <hash>`. Then delete the branch and remove the workspace by its full path. Effra kept 111 branches, 21 worktrees and 22 rifts (6.3 GB) after runs that skipped this.
4. **Next.** Open each unit whose dependencies are now all merged, up to the limit (step 3). If a result changes what a later unit needs, update that unit's spec first.

### asks

A worker ran `baton ask`, and the message names its `blocked.md`. Read it.

- If the point is small and reversible, decide it by principle, record it in Decisions, and answer with `baton tell <unit> <role> "decision: …; continue"`.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other tracks keep running.

### could not deliver

A `[baton]` message says a message could not reach its agent, usually because the agent sits at a dialog. Read the dialog (`herdr agent read <agent> --source visible --lines 30`) and ask the user to clear it. Then run the `baton redeliver <ref>` the message names.

### stuck

The track hit its failure cap (a Blocker or Major, or a verify fail), or a worker passed `stuck`. Never run another round in the same contexts. Re-plan, by one of these:

- sharpen the spec;
- split the unit;
- make the contested decision yourself;
- open a fresh track with the old findings as data.

Close the old track (`baton close <unit>`).

**Scope.** Scope never grows inside a running track. New work becomes a new unit in `plan.md`; it never goes into a message to a working agent.

## 5. Between messages

- **Wait.** End your turn and let messages wake you. No loops, no `agent wait`, no reading panes to check progress.
- **Use the idle time.** Spec the next units while you wait.
- **Stall check.** Run it on a `[watchdog]` message. Baton sends one, once per step, when the agent holding the baton:
  - has gone;
  - sits at a dialog for 2 minutes;
  - has been quiet, with nothing in flight to it, for 10 minutes.

  The message names the holder, the step and the unit folder. Read the last 40 lines of the holder:
  - **A dialog.** Read it, and ask the user.
  - **An agent that finished its step but did not pass.** Tell it to pass: `baton tell <unit> <role> "pass your <file> with baton pass"`.
  - **A gone agent.** Re-plan the unit as for stuck.

  `baton status` (or `/tracks`) answers the user's status questions without a model call.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md`, and run `baton status`, before any other action.
- **Pause.** On a pause, or when the user stops the run, run `baton close <unit>` for every open track, so no orphan agent burns tokens. `baton run end` closes them all and ends the run. Write where each unit stands into `plan.md`. If a `/goal` is set, tell the user to clear it: its check-ins keep waking you, and only the user can stop them.

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

Close every workspace you opened, then run `baton run end`.
