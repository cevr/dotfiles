---
name: orchestrate
description: Coordinate a multi-unit plan as a state machine of background agents (planner, implementor, reviewer through okra counsel, verifier) from a Claude Code or a Codex session. Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to implementor and reviewer agents.
---

# Orchestrate

You are the **orchestrator**. You split the work into units, run each unit through its machine, integrate results, and keep the record. You write no product code: your context holds the plan, verdicts and merges, so it stays small and survives the run.

The shape follows Prime Intellect's rewrite of Prime Agent by 2,000 agents (<https://www.primeintellect.ai/blog/prime-agent-rust>): a root that writes no code; a planner, an implementor, a reviewer from another model family in a separate context, and a verifier in a fresh checkout; failed review or verification goes back to the implementor with the findings; a merge needs both to pass.

The rules every worker follows are in [`protocol.md`](protocol.md). Read it once now, so your specs and decisions match it.

## The machine

Each unit runs this state machine. You are the router: a worker's final message wakes you, and you start the next state.

```
plan ──▶ implement ──▶ review ──accepted──▶ verify ──pass──▶ decide ──merge──▶ done
            ▲              │                   │               │
            └───changes────┘                   │               ├─replan──▶ plan
            └──────────────fail────────────────┘               └─drop────▶ done
```

- **plan**: the planner writes `spec.md`, with an acceptance check that is red now. You read it and approve or edit it.
- **implement**: the implementor builds, runs the gate, and writes `round-N-request.md`. From round 2 the request carries a fix report.
- **review**: a fresh reviewer from the other model family reads the request and the diff, and writes `round-N-findings.md` with `accepted`, `changes` or `stuck`.
- **verify**: a fresh verifier runs the acceptance check in a clean checkout of the head commit, and writes `round-N-verify.md` with `pass`, `fail` or `stuck`.
- **decide**: you check the claims, integrate, and merge, re-plan, or drop.

A round **fails** on `changes` or `fail`. At the failure cap (3 unless the spec says otherwise), or on `stuck`, the unit goes to **decide** as stuck: you re-plan it. You never run another round in the same contexts.

## Roles on each host

| Role | Claude Code orchestrator | Codex orchestrator | Context |
| --- | --- | --- | --- |
| planner | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "high"` | `spawn_agent` with `model: gpt-6.1-sol`, `reasoning_effort: high` | fresh per unit |
| implementor | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "medium"`; later rounds by `SendMessage` to the same agent | `spawn_agent` with the newest luna (today `gpt-6-luna`), `reasoning_effort: max`; later rounds by `send_input` to the same agent (`followup_task` under `multi_agent_v2`) | **one per unit, kept across rounds** |
| reviewer | a background agent that runs the `counsel-review` skill: `okra counsel --deep` reaches Codex | `spawn_agent` with `model: gpt-6.1-sol`, `reasoning_effort: max`, running the `counsel-review` skill: `okra counsel --deep` reaches Claude | fresh per round |
| verifier | `Agent`, `run_in_background: true`, `model: "sonnet"`, `effort: "medium"` | a subagent that runs `claude -p --permission-mode auto --model sonnet --effort medium` with the verifier prompt, and relays its report | fresh per round, Claude |

- **Families.** The reviewer is always the other family from the implementor: `okra counsel` routes to the opposite agent. `--deep` runs Codex on the newest sol at `max`, and Claude on Fable at `max`. The verifier is always Claude, in a fresh context. Its independence comes from the clean checkout and the pre-written check.
- **Why the implementor is kept.** Its context, and its prompt cache, carry from round to round, so a fix round is a delta. The reviewer and verifier are fresh each round, so they never anchor on what they said before. The findings carry forward as files.
- **Waiting.** Claude Code: background agents and background shell commands wake you when they finish. Codex (`[features] multi_agent = true`, `[agents] max_threads = 12`): a subagent's final status reaches you as a notification. Call `wait_agent` only when nothing else can move. Nobody polls: no sleep loops, and no reading a worker's transcript to check progress.
- **Cache.** Subagent caches last 5 minutes. A gap longer than that rewrites the context once. Keep each worker small: one concern per unit, delta rounds, messages that carry paths and not content, gate output in logs, and stop a unit's agents when it closes.

## 0. Start the run

1. **Run dir.** Pick a run slug (`[a-z][a-z0-9]{0,7}`). The run dir is `~/.cache/orchestrate/<run>/`, with one folder per unit.
2. **Same machine as the work.** For work on the workbox, the orchestrator runs on the workbox.

Done when the run dir exists and you know which host column of the table you use.

## 1. Plan

1. **Read first.** Read the task, the repo's `AGENTS.md` or `CLAUDE.md`, and `NORTH_STAR.md`, before asking anything.
2. **Units.** Split the work into units. A unit is one reviewable result: one branch, one PR, one batch.
   - Give each unit a slug of up to 12 characters, and list the units it depends on: their code, their decisions or their files.
   - Order the units topologically. Units with no dependency and no shared files can run at the same time.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **At most 3 units at once, and fewer when the gate cannot take them.** Each implementor and verifier runs the gate. Time it once before the first wave. While a gate waits longer than twice its own run, start no new unit, and make gate speed the next unit.
   - **You decide small, reversible open points**, and record each one.
   - **Owner questions never wait in a dialog.** Put the question in Owner questions with your recommendation, and tell the user in one short message. Then end your turn, and keep the other units running.
   - **Reserved for the user:** push (unless the repo's `NORTH_STAR.md` has a `Push:` owner rule, or its `AGENTS.md` grants it), deploy, publish, paid runs, non-additive changes to stored or wire formats, and anything irreversible.
   - **You may merge locally.**
4. **Plan file.** Write `<run dir>/plan.md`. It is the single source of truth, and you re-read it after every compaction. Its first line holds the user's goal word for word, so a new session resumes from `plan.md` and the unit folders alone.

```markdown
# <run> — <goal, word for word as the user gave it>
Host: <claude|codex> · Units at once: 3 · Gate: <seconds> · Reserved: <list> · Repo: <path> · Base: <main hash>

| Unit | Depends on | State | Round | Workspace | Agents | Result |
| ---- | ---------- | ----- | ----- | --------- | ------ | ------ |

## Decisions        (decision, principle, unit)
## Owner questions  (question, unit, recommendation, answer)
## Follow-ups       (from state.md files; new units or tracker items)
## Review later     (points the user wants batched, e.g. visual polish)
```

`State` is the machine state (`plan`, `implement`, `review`, `verify`, `decide`, `merged <hash>`, `blocked`, `stuck`, `dropped`). `Agents` holds the implementor's agent id, so a fix round reaches the same agent.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Run a unit

Every transition appends one line to `<run dir>/<unit>/log.md`: the time, `from → to`, the round, and the file that caused it. Then update the unit's row in `plan.md`.

1. **plan.** Make the unit's workspace from the warm source as `AGENTS.md` says (`rift create`; on the workbox, `workrift create <branch>`), on branch `<run>/<unit>`. Then start the planner: give it [`spec-template.md`](spec-template.md), the unit's goal and dependencies, the workspace, and `protocol.md`'s Planner section. When it ends, read `spec.md`. The Owns, Do not touch, Acceptance check and Gate sections must be concrete enough for a reader with no context. Edit them until they are.
2. **implement.** Start the implementor with one message: the paths of `protocol.md` and `spec.md`, its role, and the round number. For a fix round, send the same agent the paths of the last findings or verify report.
3. **review.** When the implementor ends, check that `round-N-request.md` exists with a head commit. Start a fresh reviewer: it runs the `counsel-review` skill on the request and writes `round-N-findings.md` (`protocol.md`, Reviewer).
4. **verify.** On `accepted`, start a fresh verifier on the round's request (`protocol.md`, Verifier).
5. **Route.** On `changes`, `fail` or `stuck`, follow [The machine](#the-machine). On `pass`, go to step 3, Decide.

**Scope.** Scope never grows inside a running unit. New work becomes a new unit in `plan.md`, never a message to a working agent.

## 3. Decide

### pass

1. **Check the claims.** Read the verify report, the findings, and `git diff --stat`. Then check the claims behind the spec's Risks section against the code. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to the exact tree that was reviewed. If it does not, merge nothing: send the implementor a merge round ("merge main into your branch, gate, and write the next request"). It goes through review and verify like any round, and counts only if it fails.
   - Run the gate in the unit's workspace at the branch head into `<run dir>/merge-<unit>.log`, and read its exit line. Red: merge nothing, and send the implementor the log as a merge round.
   - Green: in the main checkout, `git merge --ff-only <branch>`. A fix you would make yourself goes to the implementor as a round.
   - Push only as the Reserved default allows. After a push, read `gh run list --branch main --limit 1` once CI finishes; a red CI is a new unit.
3. **Record and close.** Write `merged <hash>` into the unit's row, with decisions, follow-ups from `state.md`, and anything for Review later. Stop the unit's agents (Codex: `close_agent`). Delete the branch and remove the workspace by its full path.
4. **Next.** Start each unit whose dependencies are now all merged, up to the limit. If a result changes what a later unit needs, update that unit's spec first.

### asks

A worker ended with `blocked`, and its final message names its `blocked.md`. Read it.

- If the point is small and reversible, decide it by principle, record it in Decisions, and send the same worker the decision.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other units keep running.

### stuck

Re-plan, by one of these:

- sharpen the spec;
- split the unit;
- make the contested decision yourself;
- start a fresh implementor with the old findings as data.

Stop the old implementor.

## 4. Between messages

- **Wait.** End your turn and let workers wake you. Spec the next units while you wait.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md` before any other action.
- **Pause.** On a pause, or when the user stops the run, stop every running worker, so no orphan agent burns tokens. Write where each unit stands into `plan.md`.

## 5. Close

The run closes when every unit is merged, dropped, or blocked on an owner question.

The end report covers:

- what merged, with hashes;
- the gate on main;
- decisions taken by principle;
- the owner questions, each with a recommendation;
- the follow-ups;
- the Review later list;
- the `plan.md` path.

Close every workspace you opened.
