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
            └──────────────fail────────────────┘               ├─rewrite─▶ plan
                                                                └─drop────▶ done
```

- **plan**: the planner writes `spec.md`, with an acceptance check that is red now. You read it and approve or edit it.
- **implement**: the implementor builds, runs the gate, and writes `round-N-request.md`. From round 2 the request carries a fix report.
- **review**: a fresh reviewer from the other model family reads the request and the diff, and writes `round-N-findings.md` with `accepted`, `changes` or `stuck`.
- **verify**: a fresh verifier runs the acceptance check in a clean checkout of the head commit, and writes `round-N-verify.md` with `pass`, `fail` or `stuck`.
- **decide**: you check the claims, integrate, and merge, re-plan, rewrite, or drop.

A round **fails** on `changes` or `fail`. Minors you want fixed after `accepted` go to the implementor as a polish delta: the verifier checks it, and it gets a new review only when it touches lines the findings did not name. At the failure cap (3, `counsel-review`'s round limit), the unit goes to **decide** for a [rewrite](#rewrite). On `stuck`, it goes to **decide** as [stuck](#stuck): you re-plan it. You never run another round in the same contexts.

**A class seen twice gets its property now.** When a round's Blocker, Major or verify defect is another trigger of an earlier round's class (the findings say `repeat of rN <id>`, or you see it), the next round's message names the class and makes a generated property or model test that owns it the round's first deliverable: red on the unfixed code for every earlier instance, each kept as a fixed case, before any case fix.

The same message states, in one sentence, the premise every earlier fix assumed ([attack-the-premise](~/Developer/personal/dotfiles/principles/attack-the-premise.md)). The implementor either keeps the premise and lets the property prove it for every trigger, or replaces it. Another trigger fix on the same premise is not a round: sheet failed r1 to R1 on fixes that all assumed "the sheet's state can be read from scroll and layout observers".

**A dead worker gives no verdict.** A worker that ends on a usage or rate limit or without its hand-back line, or a reviewer whose counsel run exited non-zero or wrote an empty file, decided nothing. Log the unit's state as `stuck(quota)`: the round neither passes nor fails, and no re-plan follows. Rerun that step with a fresh agent by its failure mode (an implementor resumes from `state.md` and the branch): a usage limit reruns as is once it resets; a network or harness error reruns as is; a context overflow reruns on a narrower unit; the same failure twice makes the unit `stuck`. A dead reviewer or verifier never counts as `accepted` or `pass`.

## Roles on each host

| Role | Claude Code orchestrator | Codex orchestrator | Context |
| --- | --- | --- | --- |
| planner | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "high"` | `spawn_agent` with the newest sol (today `gpt-6.1-sol`), `reasoning_effort: high` | fresh per unit |
| implementor | `Agent`, `run_in_background: true`, `model: "opus"`, `effort: "medium"`; round 2 by `SendMessage` to the same agent | `spawn_agent` with the newest luna (today `gpt-6-luna`), `reasoning_effort: max`; round 2 by `send_input` to the same agent (`followup_task` under `multi_agent_v2`) | **kept for round 2 only; fresh from round 3 or after its first compaction** |
| reviewer | `Agent`, `run_in_background: true`, `model: "sonnet"`, `effort: "medium"` (`"max"` for a `deep` unit), that operates the review (`protocol.md`, Reviewer): `okra counsel` reaches Codex, with `--deep` for a `deep` unit. A reviewer that reviews the change itself, with no counsel run, is `model: "opus"`, `effort: "max"` | `spawn_agent` with the newest sol, `reasoning_effort: max`, running the `counsel-review` skill: `okra counsel` without `--deep` reaches Claude | fresh per round |
| verifier | `Agent`, `run_in_background: true`, `model: "sonnet"`, `effort: "max"` | `spawn_agent` with the newest luna (today `gpt-6-luna`), `reasoning_effort: medium` | fresh per round |

Rendering and critique run at max reasoning effort (owner, 2026-10-13): a verifier and any agent that renders or judges renders or looks (a look prototype, a film critique, a stills judge) gets `effort: "max"`. The review depth follows the impact (owner, 2026-10-20): the spec marks a unit `deep` when a defect would be costly (ownership, authority, stored or wire formats, money, security, the hardest unit of a run); its reviewer runs at `max` with `--deep`, and every other reviewer at `medium` without it.

The table is each role's baseline, and effort moves with the job: raise it a step for the hardest unit, and lower the implementor's a step for routine work (a rename sweep, a docs-only unit). Change effort, never the family.

- **Worker type.** On Claude Code, every `Agent` call in the table, and any other agent the run starts (an exploration agent, a look prototype), passes `subagent_type: "orchestrate-worker"` (owner, 2026-10-21). It loads 9 tools and a one-paragraph prompt instead of `general-purpose`'s full tool list, MCP servers included, so each turn rereads a smaller context.
- **Families.** Every role runs on the host's own family, and the review alone crosses over: the reviewer agent sends its packet through `okra counsel`, which routes to the opposite agent, and validates what comes back. From Claude Code it reaches Codex on the newest sol, at `max` with `--deep`; from Codex it runs without `--deep` (Claude on Opus at `medium`). The reviewer's model follows who does the review (owner, 2026-10-23): Codex does it through `okra counsel`, so the agent that only writes the packet and validates the claims is Sonnet; when the Claude agent does the review itself, it is Opus at `max`. Never Fable. The verifier's independence comes from its fresh context, the clean checkout and the pre-written check.
- **Fresh implementor.** Round 2 goes to the same implementor while it has not compacted: its context and prompt cache make the fix round a delta. From round 3, or once `agent-cost.ts` shows a compaction, stop it and start a fresh one with consolidated scope: the spec, every `round-*-findings.md` and `round-*-verify.md`, `state.md`, the branch, and the unit's Decisions lines. Past one compaction the kept context is mostly stale and every turn rereads it: rive-core held 5 compactions over 1,403 turns at about 190k context a turn (266M cache-read), while talk1b's fresh R1 was accepted in one round.
- **Fresh reviewers and verifiers.** They start fresh each round, so they never anchor on what they said before. The findings carry forward as files.
- **Waiting.** Claude Code: background agents and background shell commands wake you when they finish. Codex (`[features] multi_agent = true`, `[agents] max_threads = 12`): a subagent's final status reaches you as a notification. Call `wait_agent` only when nothing else can move. Nobody polls: no sleep loops, and no reading a worker's transcript to check progress.
- **Messages are files** ([`protocol.md`](protocol.md), Messages). You talk to a worker only through the host's agent messages, naming file paths; a terminal pane is never a transport.
- **Cache and budget.** Subagent caches last 5 minutes; keep that TTL. A gap longer than that rewrites the context once. A Claude turn costs about 28k weighted tokens whatever the role or effort, so cost is turns: plan a week below the 6.3B weighted tokens that hit this pool's limit ten times in the week of 2026-10-13. Keep each worker small: one concern per unit, delta rounds, messages that carry paths and not content, gate output in logs, and stop a unit's agents when it closes.

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
   - **Bulk model work is a script.** Reading or judging many items the same way (pages, images, stills) is one script on the Messages Batch API that a unit writes and checks, not an agent per item. Every agent pays its harness context first: about 600 page readers in bible-tools started at about 88k tokens each.
   - **Sketch before a new seam.** A unit that adds a core seam (a layer, a service boundary, a runtime concept) is preceded by a sketch unit: two sketches of the call sites, types and signatures, one from each model family, judged by a fresh agent against `NORTH_STAR.md`. The implement unit builds the winner. An `any`, a cast, or the same workaround at two call sites sends it back to the sketch. gent's orchestration was built three times (tracks, kernel orchestration, machines) on designs chosen from prose.
   - **From tickets.** Work that arrives as `to-tickets` tickets is already split: each ticket is a unit, its blocking edges are the dependencies, and the ready frontier starts first. Its spec quotes the ticket as the Done line, and the merge names the ticket so the tracker closes it. Before the first wave, one read-only exploration agent reads the code and docs the tickets touch and writes shared notes to `<run dir>/notes/`, outside every workspace; every planner reads them.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. These apply unless the user says otherwise:
   - **Run to the end.**
   - **Claude agents across every host on the account pool run at the pool's pace, and at most 3 heavy agents run at once, fewer when the gate cannot take them.** The pace spends 99% of every account before its weekly reset, more by day than by night, and keeps each account under 90% of its 5-hour window. Each agent kind's cost per active hour comes from its own transcripts over 7 days, per project; a session's project is its herdr workspace's name, or what `/pool project <name>` sets. The `guard-agent` hook (`claude/hooks/guard-agent.ts` in dotfiles) asks `budget.ts --admit` before each `Agent` call: the agent starts when its expected cost fits the pace and its project's share, and at night each project runs one agent. `projectAgents` in the settings sets a project's limits: `{ "min": 1, "max": 3 }` gives its first agent priority over every project's second or third, and stops it at 3; every agent still waits for the pace. A number n is `{ "min": n, "max": n }`. Before a wave, run `bun ~/.claude/skills/orchestrate/scripts/budget.ts` for the pace and `--costs` for what each kind costs; `--burn` shows where every host's tokens went over 7 days (what the context held, each kind's start and mean context) and which levers cut the most. Settings live in `~/.config/orchestrate/budget.json`, a link to `orchestrate/budget.json` in dotfiles on every host, so change them there and pull on each host (`budget/pace.ts` holds the defaults). Codex Counsel runs do not count. A heavy agent runs a gate or a browser: every implementor and verifier, and a reviewer that runs probes. Time the gate once before the first wave. Before starting a heavy agent, read the load (`sysctl -n vm.loadavg` or `uptime`), and start none while it is above the core count. While a gate waits longer than twice its own run, start no new unit, and make gate speed the next unit.
   - **Pilot first.** The first unit runs alone through verify before the first wave fans out, so a flaw in the spec template, the gate or the verify recipe costs one edit instead of one per unit.
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

A unit's **state** is its machine state (`plan`, `implement`, `review`, `verify`, `decide`, `merged <hash>`, `blocked`, `stuck`, `stuck(quota)`, `dropped`), and it lives in the unit's `log.md`, never typed into a table: `bun ~/.claude/skills/orchestrate/scripts/status.ts <run dir>` prints every unit's state, round, time and cause from the logs. `Agents` holds the current implementor's agent id, so round 2 reaches the same agent. `Result` holds `merged <hash>` or `dropped`, so the committed plan keeps the outcome.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Run a unit

Every transition appends one line, in plain words under 200 characters, to `<run dir>/<unit>/log.md`: `<time from date -u +%FT%RZ> <from> → <to> r<N> <file that caused it>`. That line is the status; `plan.md` changes only when `Agents` or `Result` does.

1. **plan.** Make the unit's workspace from the warm source as `AGENTS.md` says (`rift create`; on the workbox, `workrift create <branch>`), on branch `<run>/<unit>`. Then start the planner: give it [`spec-template.md`](spec-template.md), the unit's goal and dependencies, the workspace, and `protocol.md`'s Planner section. When it ends, read `spec.md`. The Owns, Do not touch, Acceptance check and Gate sections must be concrete enough for a reader with no context. Edit them until they are.
2. **implement.** Start the implementor with one message: the paths of `protocol.md` and `spec.md`, its role, and the round number. At each hand-back, read its compactions with `bun ~/.claude/skills/orchestrate/scripts/agent-cost.ts <agent id>`. For round 2, send the same agent the paths of the last findings or verify report. From round 3, or after its compaction, start a fresh implementor ([Fresh implementor](#roles-on-each-host)) whose message also names every findings and verify file, `state.md` and the branch.
3. **review.** When the implementor ends, check that `round-N-request.md` exists with a head commit. Start a fresh reviewer: it runs the `counsel-review` skill on the request and writes `round-N-findings.md` (`protocol.md`, Reviewer).
4. **verify.** On `accepted`, start a fresh verifier on the round's request (`protocol.md`, Verifier).
5. **Route.** On `changes`, `fail` or `stuck`, follow [The machine](#the-machine); a `stuck` whose reason is quota, or a worker that died, is `stuck(quota)` there. On `pass`, go to step 3, Decide.

**Scope.** Scope never grows inside a running unit. New work, a host defect included, becomes a new unit in `plan.md`, never a message to a working agent. A message that must change a running unit's goal states the invariant that must hold ("a frame's pixels never depend on frames drawn before it") and the evidence, never the mechanism; the implementor picks the mechanism, and the reviewer judges it. A rule or skill change reaches a running unit only at its next round boundary, in one message.

## 3. Decide

### pass

1. **Check the claims.** Read the verify report, the findings, and `git diff --stat`. Then check the claims behind the spec's Risks section against the code. Workers report their mistakes in the same confident words as their results. Read files, not transcripts.
2. **Integrate.**
   - The branch must contain today's main (`git merge-base --is-ancestor main <branch>`), so main only fast-forwards to the exact tree that was reviewed. If it does not, merge nothing: send the implementor a merge round ("merge main into your branch, gate, and write the next request"). It goes through review and verify like any round, and counts only if it fails.
   - Run the gate in the unit's workspace at the branch head into `<run dir>/merge-<unit>.log`, and read its exit line. Red: merge nothing, and send the implementor the log as a merge round.
   - Green: in the main checkout, `git merge --ff-only <branch>`. A fix you would make yourself goes to the implementor as a round.
   - Push only as the Reserved default allows. After a push, wait for the pushed commit's CI run (`gh run watch` on the run whose head is that commit). Green is that run, not the local gate. While it is red, merge nothing but the unit that fixes it. gent's main stayed red from 2026-09-25 to 2026-10-18 behind a green local gate: 10 of 400 runs passed.
3. **Record and close.** Write `merged <hash>` into the unit's row, with decisions, follow-ups from `state.md`, and anything for Review later. A spike, sketch or prototype unit's verdict also goes where the next session reads it: a `NORTH_STAR.md` row, a `PRIOR_ART.md` → Settled row, or an ADR. Rive was studied twice in bible-tools because the first verdict lived in a session. A helper the unit's workers built that a later round or unit would rebuild (a browser driver, a rerun script, a seed root) is a follow-up unit that moves it into the repo's scripts or its `verify-<app>` skill ([build-the-lever](~/Developer/personal/dotfiles/principles/build-the-lever.md)). Stop the unit's agents (Codex: `close_agent`). Delete the branch and remove the workspace by its full path.
4. **Next.** Start each unit whose seams are frozen, stacked on its parents' current heads, up to the limit. Restack its children. If a result changes what a later unit needs, update that unit's spec first.

### asks

A worker ended with `blocked`, and its final message names its `blocked.md`. Read it.

- If the point is small and reversible, decide it by principle, record it in Decisions, and send the same worker the decision.
- Otherwise put it in Owner questions with your recommendation, and tell the user in one short message. Other units keep running.

### rewrite

The unit failed three rounds. Repair is over: rewrite it.

1. Write the premise every failed repair assumed (`~/Developer/personal/dotfiles/principles/attack-the-premise.md`), and the census of triggers from every round's findings and verify reports.
2. Rewrite the spec on a new premise, or on the old one kept with proof. Its acceptance check adds a property or model test that owns the repeated class, red on every earlier counterexample. The property ranges over the rule's whole domain as the rule is written (every paint, direction and value the rule names; every input path and modality), not the space around the last counterexample: papercut's shading rule failed three times after its property. The property is part of the acceptance check, never "if cheap": sheet's optional one compared the code with itself, and two more rounds failed on its class.
3. Start a fresh implementor on a new branch from the base commit. The old branch and findings are data, never a starting point.
4. Number the rewrite's rounds from 1 again.

A rewrite that fails three rounds goes to the owner with both premises and the census.

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
