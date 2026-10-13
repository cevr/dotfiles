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

**A class seen twice gets its property now.** When a round's Blocker, Major or verify defect is another trigger of an earlier round's class (the findings say `repeat of rN <id>`, or you see it), the next round's message names the class and makes a generated property or model test that owns it the round's first deliverable: red on the unfixed code for every earlier instance, each kept as a fixed case, before any case fix. Do not wait for the cap: talk1b and sheet each spent a round fixing triggers after the reviewer had named the class.

The same message states, in one sentence, the premise every earlier fix assumed ([attack-the-premise](~/Developer/personal/dotfiles/principles/attack-the-premise.md)). The implementor either keeps the premise and lets the property prove it for every trigger, or replaces it. Another trigger fix on the same premise is not a round: sheet failed r1 to R1 on fixes that all assumed "the sheet's state can be read from scroll and layout observers".

**A dead worker gives no verdict.** A worker that ends on a usage or rate limit or without its hand-back line, or a reviewer whose counsel run exited non-zero or wrote an empty file, decided nothing. Set the unit's State to `stuck(quota)`: the round neither passes nor fails, and no re-plan follows. When the limit allows, rerun that step with a fresh agent (an implementor resumes from `state.md` and the branch). A dead reviewer or verifier never counts as `accepted` or `pass`: on 10-07, 46 counsel reviewers died on quota in one day, silently.

## Roles on each host

| Role | Claude Code orchestrator | Codex orchestrator | Context |
| --- | --- | --- | --- |
| planner | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "high"` | `spawn_agent` with `model: gpt-6.1-sol`, `reasoning_effort: high` | fresh per unit |
| implementor | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "medium"`; round 2 by `SendMessage` to the same agent | `spawn_agent` with the newest luna (today `gpt-6-luna`), `reasoning_effort: max`; round 2 by `send_input` to the same agent (`followup_task` under `multi_agent_v2`) | **kept for round 2 only; fresh from round 3 or after its first compaction** |
| reviewer | a background agent that runs the `counsel-review` skill: `okra counsel --deep` reaches Codex | `spawn_agent` with `model: gpt-6.1-sol`, `reasoning_effort: max`, running the `counsel-review` skill: `okra counsel` without `--deep` reaches Claude | fresh per round |
| verifier | `Agent`, `run_in_background: true`, `model: "sonnet"`, `effort: "medium"` | `spawn_agent` with the newest luna (today `gpt-6-luna`), `reasoning_effort: medium` | fresh per round |

- **Families.** Every role runs on the host's own family, and the review alone crosses over: the reviewer agent sends its packet through `okra counsel`, which routes to the opposite agent, and validates what comes back. From Claude Code it runs `--deep` (Codex on the newest sol at `max`); from Codex it runs without `--deep` (Claude on Opus at `medium`). The verifier's independence comes from its fresh context, the clean checkout and the pre-written check.
- **Fresh implementor.** Round 2 goes to the same implementor while it has not compacted: its context and prompt cache make the fix round a delta. From round 3, or once `agent-cost.ts` shows a compaction, stop it and start a fresh one with consolidated scope: the spec, every `round-*-findings.md` and `round-*-verify.md`, `state.md`, the branch, and the unit's Decisions lines. Past one compaction the kept context is mostly stale and every turn rereads it: rive-core held 5 compactions over 1,403 turns at about 190k context a turn (266M cache-read), while talk1b's fresh R1 was accepted in one round.
- **Fresh reviewers and verifiers.** They start fresh each round, so they never anchor on what they said before. The findings carry forward as files.
- **Waiting.** Claude Code: background agents and background shell commands wake you when they finish. Codex (`[features] multi_agent = true`, `[agents] max_threads = 12`): a subagent's final status reaches you as a notification. Call `wait_agent` only when nothing else can move. Nobody polls: no sleep loops, and no reading a worker's transcript to check progress.
- **Messages are files** ([`protocol.md`](protocol.md), Messages). You talk to a worker only through the host's agent messages, naming file paths; a terminal pane is never a transport.
- **Cache.** Subagent caches last 5 minutes. A gap longer than that rewrites the context once. Keep each worker small: one concern per unit, delta rounds, messages that carry paths and not content, gate output in logs, and stop a unit's agents when it closes.

## 0. Start the run

1. **Run dir.** Pick a run slug (`[a-z][a-z0-9]{0,7}`). The run dir is scratch: `tmp/orchestrate/<run>/` in the checkout that holds the run's main (git-ignored, gone when that checkout is), with one folder per unit. Nothing durable lives there: the plan file is a docs file in the project (step 4), and what a later run needs goes on the project's ledger. No `~/.cache` run dirs.
2. **Same machine as the work.** For work on the workbox, the orchestrator runs on the workbox.
3. **Host check.** On a host this run has not used (a new run, or a run moved to another machine), run the base, alone, with no unit started: the gate, the e2e, and every browser suite CI runs; make one workspace and take the e2e lock with the tools `AGENTS.md` names. During the e2e, check that no test browser holds the audio output (`pmset -g assertions | grep audio-out` on macOS) or shows a window. Every red leg and every missing tool, browser binary or OS permission goes into one host unit's spec, written whole before it starts. Other units start once it merges; until then a unit carries its fixes only by merging its branch, never by cherry-picks. On the laptop move, six host defects reached the host unit one message at a time, and the owner heard the test browser's audio before the loop did.

Done when the run dir exists, you know which host column you use, and the host check is green or its host unit is planned.

## 1. Plan

1. **Read first.** Read the task, the repo's `AGENTS.md` or `CLAUDE.md`, and `NORTH_STAR.md`, before asking anything.
2. **Units.** Split the work into units. A unit is one reviewable result: one branch, one PR, one batch. A unit that builds on a seam another planned unit replaces depends on that unit; it never starts on the old seam.
   - Give each unit a slug of up to 12 characters, and list the units it depends on: their code, their decisions or their files.
   - Order the units topologically. Units with no dependency and no shared files can run at the same time.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **At most 3 heavy agents at once, and fewer when the gate cannot take them.** A heavy agent runs a gate or a browser: every implementor and verifier, and a reviewer that runs probes. Time the gate once before the first wave. Before starting a heavy agent, read the load (`sysctl -n vm.loadavg` or `uptime`), and start none while it is above the core count. While a gate waits longer than twice its own run, start no new unit, and make gate speed the next unit.
   - **You decide small, reversible open points**, and record each one.
   - **Owner questions never wait in a dialog.** Put the question in Owner questions with your recommendation, and tell the user in one short message. Then end your turn, and keep the other units running.
   - **Reserved for the user:** deploy, publish, paid runs, force-push to a shared branch, non-additive changes to stored or wire formats, and anything irreversible. Push is not reserved: the owner's global `AGENTS.md` (2026-10-13) pushes after the merge gate is green.
   - **You may merge locally.**
4. **Plan file.** Write the plan as a docs file in the project, beside its plans or ledger (in bible-tools, `apps/animations/plans/<run>-run.md`), and link it as `<run dir>/plan.md` so workers find it there. Commit it with each merge. It is the single source of truth, and you re-read it after every compaction. Move a closed section (a finished table, an earlier host's table) into a `<run>-run-archive.md` beside it, so `plan.md` holds only the live table, Decisions and Owner questions. Its first line holds the user's goal word for word, so a new session resumes from `plan.md` and the unit folders alone.

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

`State` is the machine state (`plan`, `implement`, `review`, `verify`, `decide`, `merged <hash>`, `blocked`, `stuck`, `stuck(quota)`, `dropped`). `Agents` holds the current implementor's agent id, so round 2 reaches the same agent.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Run a unit

Every transition appends one line to `<run dir>/<unit>/log.md`: the time from `date -u +%FT%RZ`, `from → to`, the round, and the file that caused it. Then update the unit's row in `plan.md`.

1. **plan.** Make the unit's workspace from the warm source as `AGENTS.md` says (`rift create`; on the workbox, `workrift create <branch>`), on branch `<run>/<unit>`. Then start the planner: give it [`spec-template.md`](spec-template.md), the unit's goal and dependencies, the workspace, and `protocol.md`'s Planner section. When it ends, read `spec.md`. The Owns, Do not touch, Acceptance check and Gate sections must be concrete enough for a reader with no context. Edit them until they are.
2. **implement.** Start the implementor with one message: the paths of `protocol.md` and `spec.md`, its role, and the round number. At each hand-back, read its compactions with `bun ~/.claude/skills/orchestrate/scripts/agent-cost.ts <agent id>`. For round 2, send the same agent the paths of the last findings or verify report. From round 3, or after its compaction, start a fresh implementor ([Fresh implementor](#roles-on-each-host)) whose message also names every findings and verify file, `state.md` and the branch.
3. **review.** When the implementor ends, check that `round-N-request.md` exists with a head commit. Start a fresh reviewer: it runs the `counsel-review` skill on the request and writes `round-N-findings.md` (`protocol.md`, Reviewer).
4. **verify.** On `accepted`, start a fresh verifier on the round's request (`protocol.md`, Verifier).
5. **Route.** On `changes`, `fail` or `stuck`, follow [The machine](#the-machine); a `stuck` whose reason is quota, or a worker that died, is `stuck(quota)` there. On `pass`, go to step 3, Decide.

**Scope.** Scope never grows inside a running unit. New work, a host defect included, becomes a new unit in `plan.md`, never a message to a working agent. A message that must change a running unit's goal states the invariant that must hold ("a frame's pixels never depend on frames drawn before it") and the evidence, never the mechanism; the implementor picks the mechanism, and the reviewer judges it. In p5, a mechanism sent by message (an author-declared `fresh` timeline) was built, then deleted by the next round as purity resting on authoring nothing checks.

## 3. Decide

### pass

1. **Check the claims.** Read the verify report, the findings, and `git diff --stat`. Then check the claims behind the spec's Risks section against the code. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to the exact tree that was reviewed. If it does not, merge nothing: send the implementor a merge round ("merge main into your branch, gate, and write the next request"). It goes through review and verify like any round, and counts only if it fails.
   - Run the gate in the unit's workspace at the branch head into `<run dir>/merge-<unit>.log`, and read its exit line. Red: merge nothing, and send the implementor the log as a merge round.
   - Green: in the main checkout, `git merge --ff-only <branch>`. A fix you would make yourself goes to the implementor as a round.
   - Push only as the Reserved default allows. After a push, read `gh run list --branch main --limit 1` once CI finishes; a red CI is a new unit.
3. **Record and close.** Write `merged <hash>` into the unit's row, with decisions, follow-ups from `state.md`, and anything for Review later. A helper the unit's workers built that a later round or unit would rebuild (a browser driver, a rerun script, a seed root) is a follow-up unit that moves it into the repo's scripts or its `verify-<app>` skill ([build-the-lever](~/Developer/personal/dotfiles/principles/build-the-lever.md)). Stop the unit's agents (Codex: `close_agent`). Delete the branch and remove the workspace by its full path.
4. **Next.** Start each unit whose dependencies are now all merged, up to the limit. If a result changes what a later unit needs, update that unit's spec first.

### asks

A worker ended with `blocked`, and its final message names its `blocked.md`. Read it.

- If the point is small and reversible, decide it by principle, record it in Decisions, and send the same worker the decision.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other units keep running.

### stuck

Re-plan, by one of these:

- sharpen the spec, starting from the written premise;
- split the unit;
- make the contested decision yourself;
- start a fresh implementor with the old findings as data and a property or model test that owns the repeated class, red on every earlier counterexample. The property is part of the re-plan's acceptance check, never "if cheap": sheet's optional one compared the code with itself, and two more rounds failed on its class.

Stop the old implementor.

## 4. Between messages

- **Wait.** End your turn and let workers wake you. Spec the next units while you wait.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md` before any other action.
- **Host move.** When the run moves host, rewrite the run's shared rules file for the new host in place; never keep an override file that every agent maps by hand.
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
