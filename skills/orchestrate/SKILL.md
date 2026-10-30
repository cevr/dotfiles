---
name: orchestrate
description: Coordinate a multi-unit plan as a state machine of background agents (planner, implementor, reviewer from the other model family, verifier) from a Claude Code or a Codex session. Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to implementor and reviewer agents.
---

# Orchestrate

You are the **orchestrator**. You split the work into units, run each unit through its machine, integrate results, and keep the record. You write no product code: your context holds the plan, verdicts and merges, so it stays small and survives the run.

The shape follows Prime Intellect's rewrite of Prime Agent by 2,000 agents (<https://www.primeintellect.ai/blog/prime-agent-rust>): a root that writes no code; a planner, an implementor, a reviewer from another model family in a separate context, and a verifier in a fresh checkout; failed review or verification goes back to the implementor with the findings; a merge needs both to pass. Here the verifier runs on `deep` units only (The machine).

The rules every worker follows are in [`protocol.md`](protocol.md). The role agents carry it in their prompts. Read its Ending a step and Rounds sections once now, so your decisions match them, and a role's section when you judge that role's file.

## The machine

Each unit runs this state machine. You are the router: a worker's final message wakes you, and you start the next state.

```
       light: you write spec.md, no planner
    ┌─────────────────────────────────────┐
    │                                     ▼
  plan ──planner writes spec.md──▶ implement ──▶ review ──changes──▶ implement
    ▲                                 ▲            │       (from r3, a test-strength-only finding
    │                                 │            │        goes to Follow-ups and does not fail)
    │                                 │         accepted
    │                                 │       ┌────┴──────────┐
    │                                 │      deep      light, standard
    │                                 │       ▼               │
    │                                 └─fail─ verify          │
    │                                         │ pass          │
    │                                         ▼               ▼
    │                                       decide ◀──────────┘
    │                                         │
    ├─────────── replan (stuck) ──────────────┤
    └─────── rewrite (3 failed rounds) ───────┤  new premise, new branch, rounds from 1
                                              ├─ stale main ──▶ integration-check ──no conflict, green──▶ merge
                                              ├─ red gate, red acceptance, a conflict ──▶ implement
                                              ├─ PR ──▶ waiting(pr) ──approved──▶ decide
                                              │              └──changes requested──▶ implement
                                              ├─ merge --ff-only, push, CI green ──▶ done
                                              └─ drop ──▶ done

  review or verify stuck ──▶ decide, as stuck
  any step ──limit or dead worker──▶ stuck(quota) ──resume-at timer──▶ same step, fresh agent
```

- **plan**: the planner writes `spec.md`, with an acceptance check that is red now. You read it and approve or edit it.
- **implement**: the implementor builds, runs the gate, and writes `round-N-request.md`. From round 2 the request carries a fix report.
- **review**: a fresh reviewer from the other model family reads the request and the diff, and writes `round-N-findings.md` with `accepted`, `changes` or `stuck`.
- **verify**: on a `deep` unit only, a fresh verifier runs the acceptance check in a clean checkout of the head commit, and writes `round-N-verify.md` with `pass`, `fail` or `stuck`. A `light` or `standard` unit goes from `accepted` to decide.
- **decide**: you check the claims, integrate, and merge, re-plan, rewrite, or drop.
- **integration-check**: the branch lacks today's main. You merge main in; with no conflict you rerun the gate and the acceptance check (and, on the `deep` path, a fresh verifier) at the new head and merge, with no review round (Decide, Integrate).

**Ceremony scales with the risk** (owner, 2026-10-24, after pstack's orchestrate). The spec's `Path` line picks one:

- `light`: mechanical work (a rename sweep, a docs-only change, a version bump, an established pattern carried to more files). You write the spec yourself from the template; no planner. One review; a fix round goes back to review only when it touches lines the findings did not name. No verifier.
- `standard`, the default: planner and review. No verifier: at decide you rerun the acceptance check at the head beside the merge gate, and compare it with the request's receipt.
- `deep`: a defect would be costly (ownership, authority, stored or wire formats, money, security, the hardest unit of a run), or the acceptance check is a live drive (a device, a browser, a render) that decide cannot rerun cheaply. Planner, a `max` review in round 1, and a fresh verifier every round.

In the week of 2026-10-17, verify failed 2 of about 77 units that review had accepted, and held 6 to 15% of the wall clock.

A round **fails** on `changes` or `fail`. Minors you want fixed after `accepted` go to the implementor as a polish delta: the verifier (off the `deep` path, your rerun at decide) checks it, and it gets a new review only when it touches lines the findings did not name. At the failure cap (3, `counsel-review`'s round limit), the unit goes to **decide** for a [rewrite](#rewrite). On `stuck`, it goes to **decide** as [stuck](#stuck): you re-plan it. You never run another round in the same contexts.

**A class seen twice gets its property now.** When a round's Blocker, Major or verify defect is another trigger of an earlier round's class (the findings say `repeat of rN <id>`, or you see it), the next round's message names the class and makes a generated property or model test that owns it the round's first deliverable: red on the unfixed code for every earlier instance, each kept as a fixed case, before any case fix.

The same message states, in one sentence, the premise every earlier fix assumed ([attack-the-premise](~/Developer/personal/dotfiles/principles/attack-the-premise.md)). The implementor either keeps the premise and lets the property prove it for every trigger, or replaces it. Another trigger fix on the same premise is not a round: sheet failed r1 to R1 on fixes that all assumed "the sheet's state can be read from scroll and layout observers".

**Tests converge after round 2** (owner, 2026-10-24). From round 3, a finding that shows no product failure, only a weaker test (a generator narrower than its rule, a mutant that survives, an oracle that excuses), does not fail the round. The reviewer files it under Test strength, and you add it to Follow-ups as its own unit. A finding with a product failure (an input or state → a wrong result a user meets) still fails the round. In the week of 2026-10-17, round 1 Majors were real defects (an Android startup crash, a seek bar that stuck); from round 3 nearly every Major was test strength, and the tails ran to 8 and 12 rounds.

**A dead worker gives no verdict.** A worker that ends on a usage or rate limit or without its hand-back line, or a reviewer whose counsel run exited non-zero or wrote an empty file, decided nothing. Log the unit's state as `stuck(quota)`: the round neither passes nor fails, and no re-plan follows. Rerun that step with a fresh agent by its failure mode (an implementor resumes from `state.md` and the branch): a usage limit reruns as is once it resets; a network or harness error reruns as is; a context overflow reruns on a narrower unit; the same failure twice makes the unit `stuck`. A dead reviewer or verifier never counts as `accepted` or `pass`.

**A third continuation is `stuck(size)`.** When an implementor needs a third message to go on inside one round, log `stuck(size)` and re-plan the unit into smaller units ([stuck](#stuck)): one unit took 31 continuation prompts.

**Resume on your own after a limit** (owner, 2026-10-24). While any step is `stuck(quota)`, keep one background waiter armed on `budget.ts --resume-at` ([`references/pace.md`](references/pace.md)), and rerun every `stuck(quota)` step when it exits. Arm it before you end a turn on a limit, so the run never waits for the owner.

## Roles on each host

| Role | Claude Code orchestrator | Codex orchestrator | Effort | Context |
| --- | --- | --- | --- | --- |
| planner | `Agent` on Opus | `spawn_agent`, the newest sol | high | fresh per unit |
| implementor | `Agent` on Opus. A `light` or mechanical unit with no UI: a Codex thread on luna (`mcp__codex__start`, `role: "implementor"`, `model: "luna"`) | `spawn_agent`, the newest luna; a UI unit: the newest sol | Opus medium, luna max | kept for round 2 only; fresh from round 3 or after its first compaction |
| reviewer | a Codex thread on sol (`role: "reviewer"`, `model: "sol"`); a unit a Codex thread implemented: `Agent` on Opus. Either way its message says `review directly` | `spawn_agent`, the newest sol, through `okra counsel` (Claude on Opus) | medium; max for a `deep` unit's round 1 | fresh per round: a new thread or agent, never `send` |
| verifier | `Agent` on Opus | `spawn_agent`, the newest luna | medium | fresh per round |

Every `Agent` call passes `run_in_background: true`, `subagent_type: "orchestrate-<role>"`, and the row's model and effort. Every `Agent` call and `mcp__codex__start` has a `description` that starts like the hand-back line, `<role> <unit> r<N>`: the model eval joins the worker to its unit by it. Round 2 reaches the same implementor by `SendMessage` (Codex thread: `mcp__codex__send`; Codex host: `send_input`).

**One effort policy.** The Effort column is each role's baseline, and the role agents for both hosts carry it (`scripts/agents.ts`). A reviewer runs at `medium`, and at `max` only for a `deep` unit's round 1: pass `effort: "max"` to that one call (`mcp__codex__start`, or `Agent`), and on a Codex host run that counsel with `okra counsel --deep` (owner, 2026-10-20). Round 2 on is a delta review of the fix commits, so a whole deep pass again costs a 6 to 9 minute review for little (owner, 2026-10-24). A verifier runs at medium (owner, 2026-10-25: "Opus medium effort is better for the verifier"). An agent that renders or judges renders or looks (a look prototype, a film critique, a stills judge) runs at max (owner, 2026-10-13). Raise a step for the hardest unit, and lower the implementor's a step for routine work (a rename sweep, a docs-only unit). Change effort, never the family.

**Models.** Luna takes light and mechanical units, never Sonnet (owner, 2026-10-30: "Luna is always better than Sonnet for now"). A UI unit's implementor is Opus, or the newest sol on a Codex host, whatever its path: React, React Native, web pages, styling, any change a person sees on screen (owner, 2026-10-25). The Luna `standard` implementor is a trial (owner, 2026-10-24) that the model eval judges. Never Fable. The review always comes from the family the implementor is not.

How each host starts, moves and waits on a role (agent types, the 10-minute move to the other family, Codex threads, waiting, the model eval) is in [`references/hosts.md`](references/hosts.md): read it before the first wave, and when a role is held. The Claude pool's and the Codex account's pace are in [`references/pace.md`](references/pace.md): read it before a wave, and when an `Agent` call is held or a Codex turn is latched.

## 0. Start the run

1. **Run dir.** Pick a run slug (`[a-z][a-z0-9]{0,7}`). The run dir is scratch: `tmp/orchestrate/<run>/` in the checkout that holds the run's main (git-ignored, gone when that checkout is), with one folder per unit. Nothing durable lives there: the plan file is a docs file in the project (step 4), and what a later run needs goes on the project's ledger. No `~/.cache` run dirs.
2. **Same machine as the work.** For work on the workbox, the orchestrator runs on the workbox.
3. **Host check.** On a host this run has not used (a new run, or a run moved to another machine), run the base, alone, with no unit started: the gate, the e2e, and every browser suite CI runs; make one workspace and take the e2e lock with the tools `AGENTS.md` names. During the e2e, check that no test browser holds the audio output (`pmset -g assertions | grep audio-out` on macOS) or shows a window. Every red leg and every missing tool, browser binary or OS permission goes into one host unit's spec, written whole before it starts. Other units start once it merges; until then a unit carries its fixes only by merging its branch, never by cherry-picks.

Done when the run dir exists, you know which host column you use, and the host check is green or its host unit is planned.

## 1. Plan

1. **Read first.** Read the task, the repo's `AGENTS.md` or `CLAUDE.md`, and `NORTH_STAR.md`, before asking anything.
2. **Units.** Split the work into units. A unit is one reviewable result: one branch, one PR, one batch. A unit that builds on a seam another planned unit replaces depends on that unit; it never starts on the old seam.
   - Give each unit a slug of up to 12 characters, and list the units it depends on: their code, their decisions or their files.
   - Order the units topologically. Units with no dependency and no shared files can run at the same time. A dependent unit does not wait for its parent to merge: it stacks on the parent's current head and restacks (`gh stack rebase`) when a parent round lands. Freeze each shared seam's types and paths first, so a restack stays a rebase; only a seam change sends the child back to work. Waiting for final heads made verifyall a months-long chain (owner, 2026-10-20).
   - **One agent per deliverable.** A unit with two deliverables is two units. An owner-feature or prototype agent hands back at each publish or owner ask, and its next step goes to a fresh agent briefed from `log.md` and the branch. In p5, 36 of 86 agents compacted twice or more and held 77% of the spend (scriptdesk then codefollow in one agent: 22 compactions).
   - **The owner's ask is the Done line.** The spec quotes the ask word for word, and its acceptance check is that ask, not what the unit grew into. For an owner-facing unit, the spec also names what the owner opens after round 1 (a screen, a render, a command's output); shared components and scaffolding grow from that, not before it ("we're not building a reusable library", bible-tools, 2026-10-13).
   - **A bulk code edit is a codemod.** A mechanical change across many sites starts as one script that rewrites every site; the review reads the script and its output diff. One 170-site unit ran as 14 hand slices.
   - **Bulk model work is a script.** Reading or judging many items the same way (pages, images, stills) is one script on the Messages Batch API that a unit writes and checks, not an agent per item. Every agent pays its harness context first: about 600 page readers in bible-tools started at about 88k tokens each.
   - **Sketch before a new seam.** A unit that adds a core seam (a layer, a service boundary, a runtime concept) is preceded by a sketch unit: two sketches of the call sites, types and signatures, one from each model family, judged by a fresh agent against `NORTH_STAR.md`. The implement unit builds the winner. An `any`, a cast, or the same workaround at two call sites sends it back to the sketch. gent's orchestration was built three times (tracks, kernel orchestration, machines) on designs chosen from prose.
   - **From tickets.** Work that arrives as `to-tickets` tickets is already split: each ticket is a unit, its blocking edges are the dependencies, and the ready frontier starts first. Its spec quotes the ticket as the Done line, and the merge names the ticket so the tracker closes it. Before the first wave, one read-only exploration agent reads the code and docs the tickets touch and writes shared notes to `<run dir>/notes/`, outside every workspace; every planner reads them.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **Pace, not a count.** Claude agents run at the account pool's pace and Codex turns at the Codex account's; the budget alone sets how many run at once ([`references/pace.md`](references/pace.md)). A held `Agent` call or a latched Codex turn is queued, not refused: run its waiter in the background and go on. A heavy agent (every implementor and verifier, a reviewer that runs probes) starts only while the load (`sysctl -n vm.loadavg` or `uptime`) is under the core count. Time the gate once before the first wave; while a gate waits longer than twice its own run, start no new unit, and make gate speed the next unit.
   - **The round gate has a time budget.** Each leg of the gate a round runs (a property suite, a lab or e2e leg) finishes in under a minute. A slower leg leaves the round gate and runs once at merge, and making it fast is a tooling unit. The owner asked twice on 2026-10-22: "keep the property test out of the gate", and "skip these tests for the verification lab until we can get them to less than a minute".
   - **Pilot first.** The first unit runs alone through decide before the first wave fans out, so a flaw in the spec template, the gate or the verify recipe costs one edit instead of one per unit.
   - **You decide small, reversible open points**, and record each one.
   - **Owner questions never wait in a dialog.** Put the question in Owner questions with your recommendation, and tell the user in one short message. Then end your turn, and keep the other units running.
   - **Reserved for the user:** deploy, publish, paid runs, force-push to a shared branch, non-additive changes to stored or wire formats, and anything irreversible. Push is not reserved: the owner's global `AGENTS.md` (2026-10-13) pushes after the merge gate is green.
   - **You may merge locally.**
   - **Carried tooling first.** A carried tooling unit that pays back inside this run (a flake triage script, a meter fix) takes the next free slot before a new feature unit, unless the user orders otherwise.
4. **Plan file.** Write the plan as a docs file in the project, beside its plans or ledger (in bible-tools, `apps/animations/plans/<run>-run.md`), and link it as `<run dir>/plan.md` so workers find it there. Commit it with each merge. It is the single source of truth, and you re-read it after every compaction. Move a closed section (a finished table, an earlier host's table) into a `<run>-run-archive.md` beside it, so `plan.md` holds only the live table, Decisions and Owner questions. Its first line holds the user's goal word for word, so a new session resumes from `plan.md` and the unit folders alone.

```markdown
# <run> — <goal, word for word as the user gave it>
Host: <claude|codex> · Units at once: 3 · Gate: <seconds> · Reserved: <list> · Repo: <path> · Base: <main hash>

| Unit | Depends on | Workspace | Agents | Result |
| ---- | ---------- | --------- | ------ | ------ |

## Decisions        (decision, principle, unit)
## Owner questions  (question, unit, recommendation, answer)
## Follow-ups       (from state.md files; new units or tracker items)
## Review later     (points the user wants batched, e.g. visual polish)
```

A unit's **state** is its machine state (`plan`, `implement`, `review`, `verify`, `decide`, `integration-check`, `waiting(pr)`, `merged <hash>`, `blocked`, `stuck`, `stuck(quota)`, `stuck(size)`, `dropped`), and it lives in the unit's `log.md`, never typed into a table: `bun ~/.claude/skills/orchestrate/scripts/status.ts <run dir>` prints every unit's state, round, time and cause from the logs. `Agents` holds the current implementor's agent id, so round 2 reaches the same agent. `Result` holds `merged <hash>` or `dropped`, so the committed plan keeps the outcome.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Run a unit

Every transition appends one line to `<run dir>/<unit>/log.md` by `bun ~/.claude/skills/orchestrate/scripts/log.ts <unit dir> <from> <to> r<N> <file that caused it>`, its only writer, which refuses an unknown state, a `from` that is not the unit's current state, and a round below the last; which move follows which is The machine's, and yours to keep. That line is the status; `plan.md` changes only when `Agents` or `Result` does.

1. **plan.** For a `light` unit, write `spec.md` yourself from the template, and go to implement. Otherwise, make the unit's workspace from the warm source as `AGENTS.md` says (`rift create`; on the workbox, `workrift create <branch>`), on branch `<run>/<unit>`. Then start the planner: give it [`spec-template.md`](spec-template.md), the unit's goal and dependencies, the workspace, and, for a Codex planner, `protocol.md`'s Planner section. When it ends, read `spec.md`. The Owns, Do not touch, Acceptance check and Gate sections must be concrete enough for a reader with no context. Edit them until they are.
2. **implement.** Start the implementor with one message: the path of `spec.md`, its role, and the round number. For round 2, send the same agent the paths of the last findings or verify report. From round 3, or after it ended `blocked compacted`, start a fresh implementor ([`references/hosts.md`](references/hosts.md), Fresh implementor) whose message also names every findings and verify file, `state.md` and the branch.
3. **review.** When the implementor ends, run `bun ~/.claude/skills/orchestrate/scripts/request.ts <unit dir> N`; a refusal goes back to the implementor and is not a round. Start a fresh reviewer by your host's row: it reviews the request directly, or through Counsel on a Codex host, and writes `round-N-findings.md` (`protocol.md`, Reviewer).
4. **verify.** On `accepted`, start a fresh verifier on the round's request when the Path is `deep` (`protocol.md`, Verifier). Otherwise go to step 3, Decide.
5. **Route.** On `changes`, `fail` or `stuck`, follow [The machine](#the-machine); a `stuck` whose reason is quota, or a worker that died, is `stuck(quota)` there. On `pass`, go to step 3, Decide.

**Scope.** Scope never grows inside a running unit. New work, a host defect included, becomes a new unit in `plan.md`, never a message to a working agent. A message that must change a running unit's goal states the invariant that must hold ("a frame's pixels never depend on frames drawn before it") and the evidence, never the mechanism; the implementor picks the mechanism, and the reviewer judges it. A rule or skill change reaches a running unit only at its next round boundary, in one message.

## 3. Decide

### pass

1. **Check the claims.** Read the verify report (on the `deep` path), the findings, and `git diff --stat`. Then check the claims behind the spec's Risks section against the code. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to a tree that was checked. If it does not, go to **integration-check**: in the unit's workspace, merge main into the branch (a stacked child: `gh stack rebase`). A merge with no conflict leaves the reviewed diff as it was, so it needs no review round, but main's other changes can still change its behavior: run the gate and the acceptance check below at the new head, on every path, and on the `deep` path start a fresh verifier on that head too. Merge on green. A conflict: abort it (`git merge --abort`), and send the implementor a merge round ("merge main into your branch, gate, and write the next request"), reviewed and verified like any round, which counts only if it fails.
   - Run the gate in the unit's workspace at the branch head into `<run dir>/merge-<unit>.log`, and read its exit line. When that head is the request's head, and the request's `gate-N.log` ran the spec's round gate on this host, that log stands for the round legs: run only the merge-only legs. Also run the acceptance check as written into `<run dir>/accept-<unit>.log`, always: off the `deep` path it checks the request's receipt, and after an integration-check it checks the new head. Red: merge nothing, and send the implementor the log as the next round; a red acceptance check counts as a failed round.
   - **Team approval.** Where main changes only through a PR that a teammate approves (Bite), green opens the PR (`create-pr`), and the unit goes to `waiting(pr)`, holding no slot: follow [`references/pr-wait.md`](references/pr-wait.md).
   - Green: in the main checkout, `git merge --ff-only <branch>`. A fix you would make yourself goes to the implementor as a round.
   - Push only as the Reserved default allows. After a push, wait for the pushed commit's CI run (`gh run watch` on the run whose head is that commit). Green is that run, not the local gate. While it is red, merge nothing but the unit that fixes it. gent's main stayed red from 2026-09-25 to 2026-10-18 behind a green local gate: 10 of 400 runs passed.
3. **Record and close.** Write `merged <hash>` into the unit's row, with decisions, follow-ups from `state.md`, and anything for Review later. A spike, sketch or prototype unit's verdict also goes where the next session reads it: a `NORTH_STAR.md` row, a `PRIOR_ART.md` → Settled row, or an ADR. Rive was studied twice in bible-tools because the first verdict lived in a session. A helper the unit's workers built that a later round or unit would rebuild (a browser driver, a rerun script, a seed root) is a follow-up unit that moves it into the repo's scripts or its `verify-<app>` skill ([build-the-lever](~/Developer/personal/dotfiles/principles/build-the-lever.md)). Stop the unit's agents (Codex: `close_agent`). Delete the branch and remove the workspace by its full path.
4. **Next.** Start each unit whose seams are frozen, stacked on its parents' current heads, up to the limit. Restack its children. If a result changes what a later unit needs, update that unit's spec first.

### asks

A worker ended with `blocked`, and its final message names its `blocked.md`. Read it.

- If the point is small and reversible, decide it by principle, record it in Decisions, and send the same worker the decision.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other units keep running.

### rewrite

The unit failed three rounds. Repair is over: diagnose it, then rewrite it from its base on a new spec, by [`references/rewrite.md`](references/rewrite.md).

### stuck

No round can help (a spec that contradicts itself, a missing decision). Re-plan, by one of these:

- sharpen the spec, starting from the written premise;
- split the unit;
- narrow it to the owner's ask, and log the rest as known limits;
- make the contested decision yourself.

Stop the old implementor.

## 4. Between messages

- **Wait.** End your turn and let workers wake you. Spec the next units while you wait. To wait on an outside event (the owner's answer, a lab change), run one background Bash until-loop that exits on the event, and re-arm it only after an event.
- **Stop finished agents.** TaskStop an agent at its final hand-back.
- **Owner direction** goes, the same turn, into the file that owns it: `NORTH_STAR.md` for scope and standing rules, the project's skill for craft and voice, `AGENTS.md` for the stack.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md`, and run `status.ts`, before any other action.
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
- the environment changes that would make the next run go better (a constrained API, a lint rule, a log, data access), and the recurring schedules worth setting up;
- the `plan.md` path.

Close every workspace you opened.
