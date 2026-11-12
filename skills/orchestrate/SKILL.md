---
name: orchestrate
description: Coordinate a multi-unit plan as a state machine of background agents (planner and implementors fanned out, then one batch landing and one fresh verifier per batch, the planner on Fable first and every other role on Opus first, Codex only as the fallback) from a Claude Code, OpenCode or Codex session. Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to implementor and verifier agents.
---

# Orchestrate

You are the **orchestrator**. You split the work into units, fan them out, land them in batches, verify each batch once, and fan out what follows. You write no product code: your context holds the plan, verdicts and merges, so it stays small and survives the run.

The shape follows Prime Intellect's rewrite of Prime Agent by 2,000 agents (<https://www.primeintellect.ai/blog/prime-agent-rust>): a root that writes no code, planners and implementors in their own contexts, a verifier in a fresh context and a clean checkout, and failed verification back to the implementor with the findings. Here the verifier runs once per batch, on the merged result, not once per unit before it: N verifiers each running heavy checks at the end of a wave was the load that held the workbox at 39 on 16 cores (`opencode/notes/perf-many-sessions.md`, Under load), and a unit's defects that only the merge shows were never in front of them.

The rules every worker follows are in [`protocol.md`](protocol.md); the role agents carry it in their prompts. Read its Ending a step and Rounds sections once now, and a role's section when you judge that role's file.

## The machine

Each unit runs this machine; a batch carries many units through land and verify at once. A worker's final message, a land's answer or a timer wakes you, and you start the next step.

```
        direct, light: you write spec.md
     ┌──────────────────────────────────┐
     │                                  ▼
   plan ──planner writes spec.md──▶ implement ──focused gate green──▶ ready
                                     ▲    ▲                           │ cadence: 3 ready, or the oldest for 30 min
                                     │    └─conflict: merge round─────┤
                                     │                                ▼
                                     │       land: merge every ready unit, regenerate, one batch gate
                                     │         red ──▶ a fix unit per failure; main stays; the batch waits for them
                                     │         green ──▶ push: main pushed │ PR: branches pushed, draft PRs
                                     │                                ▼
                                     │       verify: ONE fresh verifier per batch, on the merged head:
                                     │       the batch acceptance once, then each unit's diff against its spec
                                     │       (while it runs, the next batch's implementors fan out)
                                     │                                │ a verdict per unit
                                     └── changes: each finding folds ─┤
                                         into the next batch: a running
                                         implementor's round, or a fix unit
                                                                      ├─ accepted ─▶ merged                  (push)
                                                                      │          └─▶ waiting(pr) ─approved, CI green─▶ merged
                                                                      │                  └─changes requested, red CI─▶ implement
                                                                      └─ stuck, or a 3rd failed round ─▶ decide: re-plan, rewrite, drop
  direct: no verify; it closes when its batch lands.
  red acceptance, red CI after the push ──▶ a fix unit, fixed forward; until main's CI is green, only fix units land
  any step ──limit or dead worker──▶ stuck(quota) ──resume-at timer──▶ same step, fresh agent
```

1. **Fan out.** Implementors run in parallel, each on its own branch, with focused checks only (`protocol.md`, Rounds), and hand back `ready`. Nothing heavier runs per unit.
2. **Land a batch** when the cadence fires: merge every ready unit, regenerate, gate once. Green pushes before verify, so a defect is fixed forward, never reverted: main moves (`Lands: push`), or each unit's branch and its draft PR do while main stays put until a teammate approves (`Lands: PR`).
3. **Verify the batch** with one fresh verifier on the merged head: the batch acceptance once, then each unit's diff against its spec, one findings file per unit.
4. **Fan out what follows**, in one turn: each finding folds forward into the next batch (the pipeline, below), each failure no unit's findings own (a red acceptance or CI) becomes a fix unit, the next plan units start, and accepted units close.

**The pipeline.** Batches overlap: while batch N's verifier runs, batch N+1's implementors fan out, and a running verifier never holds an implementor start. Verdict N folds forward: each finding goes to a running implementor of batch N+1 that owns the same unit or files, as a round message, or to a new fix implementor that joins batch N+1. There is no fix batch, and no verifier for the fixes alone. Batch N+1 lands only once batch N's verdict is in, and only with every finding of batch N folded into a unit of batch N+1. A finding folded into a ready unit lands with it; one folded into a unit still implementing does not hold the land of the other ready units: it rides with its unit's later land, and that land's verifier names it as folded. A finding not folded at all holds the land. Its land takes every ready unit, as any land does, and its one verifier checks batch N+1's units and the findings that landed with them as folded. A unit of batch N that starts its next round does not end batch N's wait: the verdict is the batch's. A `changes` whose findings file does not read (none named, missing, or naming a unit file that is missing) counts as unfolded findings, never as none: make the report readable (the plugin reads it again at the next start or land) and fold what it holds, or land with `departs:`.

**States.** `plan`, `implement`, `ready` (waits for its batch), `verify` (landed, its batch's verifier running), `waiting(pr)`, `merged <hash>`, `decide` (yours: re-plan, rewrite or drop), `blocked`, `stuck`, `stuck(quota)`, `stuck(size)`, `dropped`.

**Ceremony scales with the risk** (after pstack's orchestrate). The spec's `Path` line picks one:

- `direct`: the diff is prose only (Markdown and plain-text docs no program parses as data). You write a short spec (Goal, Owns, Gate); no planner, no verify: the round gate is the acceptance check, and the batch gate runs the docs tests that hold prose to code. At `ready`, check the lane: `git diff --name-only <base>...<head>` lists only prose files, or the unit becomes `light`. It closes when its batch lands. Several prose items can share one unit.
- `light`: mechanical work (a rename sweep, a version bump, an established pattern carried to more files). You write the spec; no planner. Its batch's verifier reviews it once. A fix round that touches only the lines the findings named closes when its batch lands, its acceptance test green in its round gate; one that touches more is verified again.
- `standard`, the default: planner, and verified in every batch that lands a round of it.
- `deep`: a defect would be costly (ownership, authority, stored or wire formats, money, security, the hardest unit of a run), or the acceptance check is a live drive. Planner; its round 1's batch runs its live matrix.

**Rounds.** A unit's round is one request and its verdict in the batch that lands it. A round **fails** on `changes`; a red acceptance check is a Blocker. There is no polish round: a Minor or a nit is never filed, since lint owns taste. At the third failed round, the unit goes to decide for a [rewrite](#rewrite); on `stuck`, to decide to be [re-planned](#stuck). A merge round counts only if it fails.

**Every guard is a unit.** Each `guard:` line in the findings (a lint rule, codemod, type or check outside the unit's Owns) becomes a tooling unit in the plan, so a class of defect is caught by a machine after its first verify, not by the next verifier.

**Stateful units start from a model.** A unit that changes behavior over time (a player, a queue, a lock, a sync or retry loop, a protocol, an outbox) has a model-based test as its acceptance check from round 1: a small reference model, generated command sequences against the implementation, the invariants as its oracle (`protocol.md`, Planner). When correctness depends on how concurrent steps interleave, the planner also model-checks the protocol in Quint or TLA+ before implement. Without one, the unit finds its states one trigger at a time, a round each.

**A class seen twice gets its property now.** When a Blocker or Major is another trigger of an earlier round's class (`repeat of rN <id>`), the next round's message names the class and makes a generated property or model test that owns it the first deliverable: red on the unfixed code for every earlier instance, before any case fix. It also states, in one sentence, the premise every earlier fix assumed ([attack-the-premise](~/Developer/personal/dotfiles/principles/attack-the-premise.md)); the implementor keeps it and lets the property prove it, or replaces it. Another trigger fix on the same premise is not a round.

**Tests converge after round 2.** From round 3, a finding that shows no product failure, only a weaker test (a narrow generator, a surviving mutant, an oracle that excuses), does not fail the round: it goes under Test strength, and you make it a Follow-ups unit. A product failure (an input or state → a wrong result a user meets) still fails it.

**A dead worker gives no verdict.** A worker that ends on a usage or rate limit or without its hand-back line decided nothing: log its units `stuck(quota)` (the round neither passes nor fails) and rerun that step with a fresh agent by its failure mode. A limit reruns once it resets, a network or harness error at once, a context overflow on a narrower unit (or a smaller batch); the same failure twice makes it `stuck`. A dead verifier never counts as `accepted`. While any step is `stuck(quota)`, keep one background waiter armed on `budget.ts --resume-at` ([`references/pace.md`](references/pace.md)) before you end a turn, and rerun every such step when it exits.

**A third continuation is `stuck(size)`.** An implementor that needs a third message inside one round is too big for one context: log `stuck(size)` and split the unit ([stuck](#stuck)).

## Roles on each host

| Role | OpenCode orchestrator | Claude Code orchestrator | Codex orchestrator | Effort | Context |
| --- | --- | --- | --- | --- | --- |
| planner | `subagent`, `agent: "planner"` | `Agent` on Fable (`model: "fable"`), Opus when held | `spawn_agent`, the newest sol | medium; sol high | fresh per unit |
| implementor | `subagent`, `agent: "implementor"` | `Agent` on Opus | never: Codex does not implement | Opus medium | kept for round 2, through its compactions; fresh from round 3 |
| verifier | `subagent`, `agent: "verifier"` | `Agent` on Opus | `spawn_agent`, the newest sol | medium, always | fresh per batch: a new thread or agent, never `send` |

- **OpenCode.** Every role is a background `subagent` call with `agent: "<role>"`, never `general` or `worker`, and no `model`: the config binds every role to Opus, the orchestrate mod starts a new planner on the newest Fable first, and it picks the Codex fallback for a planner or verifier. Round 2 reaches the same implementor by a `subagent` call with its `sessionID`.
- **Claude Code and Codex.** Every `Agent` call passes `run_in_background: true`, `subagent_type: "<role>"`, and the row's model and effort. Round 2 reaches the same implementor by `SendMessage` (Codex thread: `mcp__codex__send`; Codex host: `send_input`).
- **Descriptions.** Each role call's `description` starts like its hand-back line: `<role> <unit> r<N>`, and a batch's verifier `verifier batch-<k> r1`. The model eval joins a worker to its unit by it.
- **One effort policy.** The Effort column is each role's baseline, and the role agents carry it (`scripts/agents.ts`). The planner (Fable, or Opus or sol when it falls back) and the verifier run at medium, always: never pass them a higher effort (the owner's call, 2026-11-10). An implementor that renders a look runs at max; raise an implementor a step for the hardest unit, lower it a step for routine work. Change effort, never the model.
- **Fable plans; Opus first for the rest; Codex second.** The planner runs on the newest Claude Fable, at medium (the owner's call, 2026-11-12: "Fable is our planner"); when the Claude pool holds a new Fable start (Fable's own week spent, or the pool's pace), it starts on the newest Opus, then on Codex as below, and the call log (OpenCode) or Decisions (`planner auth on Opus: Fable week spent`) says why. Every other role runs on the newest Claude Opus, even with Codex available; an implementor or verifier never runs on Fable. Codex is the fallback, only when the Claude pool holds a new Opus start: start a planner or verifier on the newest sol at once instead of waiting. Codex plans and verifies, never implements (the owner's rule): a held implementor waits for Opus, and the pool's spend-evenly pace alone never holds one, only accounts out of quota do. Wait only when Codex holds too, and take whichever opens first. A role on Codex stays there for its next round; the next new start tries its first model again (Fable for a planner, Opus for the rest). Log each move in Decisions (`verifier batch-2 on sol: Claude pool held`). Never Sonnet. Fable is the planner's model and nothing else: never an overflow tier for another role, since it draws Opus's windows too. The verifier's independence comes from its fresh context, the clean checkout and the pre-written checks, not from a second model family. A UI unit is any change a person sees on screen.

How each host starts, moves and waits on a role is in [`references/hosts.md`](references/hosts.md): read it before the first wave, and when a role is held. The Claude pool's and the Codex account's pace are in [`references/pace.md`](references/pace.md): read it before a wave, and when a start is held or latched.

## 0. Start the run

1. **Run dir.** Pick a run slug (`[a-z][a-z0-9]{0,7}`). The run dir is scratch: `tmp/orchestrate/<run>/` in the checkout that holds the run's main (git-ignored), with one folder per unit, and the batch files (`batch-<k>.md`, its logs and findings) beside them. Nothing durable lives there: the plan is a docs file in the project (step 1.4), and what a later run needs goes on the project's ledger.
2. **Same machine as the work.** For work on a remote dev box, the orchestrator runs on that box.
3. **Host check.** On a host this run has not used, run the base alone, with no unit started: the gate, the e2e and every browser suite CI runs; make one workspace and take the e2e lock with the tools `AGENTS.md` names. During the e2e, check that no test browser holds the audio output (`pmset -g assertions | grep audio-out` on macOS) or shows a window. Every red leg and every missing tool, browser binary or OS permission goes into one host unit's spec. Other units start once it merges; until then a unit carries its fixes only by merging its branch, never by cherry-picks.

Done when the run dir exists, you know your host column, and the host check is green or its host unit is planned.

## 1. Plan

1. **Read first.** The task, the repo's `AGENTS.md` or `CLAUDE.md`, and `NORTH_STAR.md`, before asking anything.
2. **Units.** A unit is one reviewable result: one branch, one PR, one spec.
   - Give each a slug of up to 12 characters (never `batch-<k>`), and list the units it depends on: their code, decisions or files.
   - Order them topologically. Units with no dependency and no shared files fan out together. A dependent unit stacks on its parent's current head and restacks (`gh stack rebase`) when a parent round lands; freeze each shared seam's types and paths first, so a restack stays a rebase. A unit that builds on a seam another planned unit replaces never starts on the old seam.
   - **One agent per deliverable.** A unit with two deliverables is two units. An owner-feature or prototype agent hands back at each publish or owner ask, and its next step goes to a fresh agent briefed from `log.md` and the branch.
   - **The owner's ask is the Done line.** The spec quotes it word for word, and its acceptance check is that ask, not what the unit grew into. An owner-facing spec also names what the owner opens after round 1 (a screen, a render, a command's output).
   - **A bulk code edit is a codemod**: one script that rewrites every site, which the verifier reads with its output diff. **Bulk model work is a script** on the Messages Batch API, not an agent per item.
   - **Sketch before a new seam.** A unit that adds a core seam (a layer, a service boundary, a runtime concept) follows a sketch unit: two sketches of call sites, types and signatures from two fresh agents that do not see each other's, judged by a fresh agent against `NORTH_STAR.md`. An `any`, a cast, or the same workaround at two call sites sends it back to the sketch.
   - **From tickets.** `to-tickets` tickets are already units: blocking edges are dependencies, the spec quotes the ticket as the Done line, and the merge names the ticket. Before the first wave, one read-only exploration agent writes shared notes to `<run dir>/notes/` for every planner.
3. **Defaults.** Decide by `~/Developer/personal/dotfiles/principles/`, and ask only what the plan cannot settle. Unless the user says otherwise:
   - **Run to the end.**
   - **Pace, not a count.** The account pools' pace alone sets how many agents run at once ([`references/pace.md`](references/pace.md)). A heavy agent (every implementor and verifier) starts only while the load (`sysctl -n vm.loadavg` or `uptime`) is under the core count. Time the round gate once before the first wave; while a round gate waits longer than twice its own run, start no new unit, and make gate speed the next unit.
   - **Units run focused checks; the batch runs the suite.** A round gate is the changed packages' tests and typecheck, lint of the changed files, and the unit's own acceptance test, each leg under a minute (`protocol.md`, Rounds). The full gate, the full e2e and the affected acceptance run belong to the batch alone, in every repo, CI repos included: a red that a local run can see costs one batch, not a CI round per unit. A leg slower than a minute runs at the batch, and making it fast is a tooling unit.
   - **Heavy checks fit the machine.** A heavy check is a build, test, vet, lint or benchmark run; the batch gate, the acceptance run and the batch verifier's checks are one each. The threads all running heavy checks can use add up to no more than the core count. Divide the cores among the implementors running at once and the batch lane (one gate, acceptance or verifier at a time), and name each worker's share in its start message as its tools' own flags: Go's `-p` and `GOMAXPROCS` multiply (`-p 4` with `GOMAXPROCS=4` is up to 16 threads), Cargo has `-j`, Bun, Vitest and Jest their worker flags. A share is at least 4 threads; more workers than shares wait for a slot, and the plan header's `Heavy` field shows the split. Never wrap a command in a unit or launcher (`systemd-run`, `nohup`, a scope, a lock per worker): the host's heavy launcher already runs it niced and memory-capped. Five verifier lanes at `GOMAXPROCS=4 -p 4` under `systemd-run` asked about 80 threads of the 16-core workbox (2026-11-08).
   - **Batch cadence.** Land when 3 units are ready or the oldest ready unit has waited 30 minutes. A spec's `Batch cadence` line overrides it for its unit; the plan's header holds the run's.
   - **Pilot first.** The first unit runs alone through its own batch, verify included, before the first wave fans out, so a flaw in the spec template, the gate or the acceptance check costs one edit instead of one per unit.
   - **You decide small, reversible open points**, and record each one.
   - **Owner questions never wait in a dialog.** Put the question in Owner questions with your recommendation, tell the user in one short message, end your turn, and keep the other units running.
   - **Reserved for the user:** deploy, publish, paid runs, force-push to a shared branch, non-additive changes to stored or wire formats, anything irreversible. Push is not reserved: a green batch gate pushes. You may merge locally.
   - **A run's rules file holds project facts, never the skill.** `<run dir>/common.md`, when the run needs one, holds the commands, paths, flags, thread shares and owner additions the skill cannot know. It never restates or overrides a skill default: a run that must depart from one writes `Departs from <rule>: <why>`, and you offer each departure upstream as a skill change at close. When the skill changes mid-run, reconcile the file once ([`references/run-rules.md`](references/run-rules.md); on OpenCode the plugin's note says when).
   - **Carried tooling first.** A carried tooling unit that pays back inside this run takes the next free slot before a new feature unit.
4. **Plan file.** Write the plan as a docs file in the project, beside its plans or ledger (`plans/<run>-run.md`), and link it as `<run dir>/plan.md`. Commit it with each batch. It is the single source of truth, re-read after every compaction. Move a closed section into `<run>-run-archive.md` beside it, so `plan.md` holds only the live table, Decisions and Owner questions. Its first line holds the user's goal word for word.

```markdown
# <run> — <goal, word for word as the user gave it>
Host: <claude|codex|opencode> · Heavy: <workers> × <threads> + batch lane <threads> of <cores> cores · Round gate: <seconds> · Batch: 3 ready or 30 min · Lands: <push|PR> · CI: <workflow and trigger|none> · Reserved: <list> · Repo: <path> · Base: <main hash>

| Unit | Depends on | Workspace | Agents | Result |
| ---- | ---------- | --------- | ------ | ------ |

## Batches          (k, units, base, head, gate, acceptance, verifier, verdicts)
## Decisions        (decision, principle, unit)
## Owner questions  (question, unit, recommendation, answer)
## Follow-ups       (from state.md files and findings; new units or tracker items)
## Review later     (points the user wants batched, e.g. visual polish)
```

A unit's state lives in its `log.md`, never in a table: `bun ~/.claude/skills/orchestrate/scripts/status.ts <run dir>` prints every unit's state, round, time, cause and cadence. `Agents` holds the current implementor's agent id, so round 2 reaches the same agent; `Result` holds `merged <hash>` or `dropped`.

Done when every unit has a row with its dependencies, and `plan.md` lists the reserved actions.

## 2. Fan out

Every transition appends one line to `<run dir>/<unit>/log.md` by `bun ~/.claude/skills/orchestrate/scripts/log.ts <unit dir> <from> <to> r<N> <cause>`, its only writer: it refuses an unknown state, a `from` that is not the current state, and a round below the last. Which move follows which is The machine's. On OpenCode the orchestrate plugin logs a planner's and an implementor's start and hand-back itself (`log.ts --current`); you log the rest, every batch move included.

1. **plan.** For a `direct` or `light` unit, write `spec.md` yourself from [`spec-template.md`](spec-template.md). Otherwise make the unit's workspace from the warm source as `AGENTS.md` says (OpenCode: the `rift` tool's `create` with `name: "<unit>"`; elsewhere `rift create --name <unit>`, or `workrift create <branch>` on a remote dev box), on branch `<run>/<unit>` (`feat/<unit>` works too; a later round in a fresh workspace: `<unit>-<n>` on `<run>/<unit>-<n>`). A name or branch can read as another unit's (`db-2`, db's round 2, when the run also has a unit `db-2`), so the land never relies on it: name the Rift in each implementor's description, `implementor <unit> r<N> (rift: <path>)`, and land each Rift as `{ path, unit }`. The orchestrate plugin keeps each unit's Rifts from those descriptions and never reads a brief; a Rift it can only place by a name or branch that reads two ways is no unit's. Then start the planner with the template, the goal, the dependencies and the workspace. Read its `spec.md`: Owns, Do not touch, Acceptance check and Gate must be concrete enough for a reader with no context. Edit them until they are.
2. **implement.** Start the implementor with one message: the path of `spec.md`, its role, the round, and its thread share; its description ends `(rift: <its workspace's path>)`. Start every unit whose dependencies allow it, up to the pace and the shares.
3. **ready.** When an implementor hands back, run `bun ~/.claude/skills/orchestrate/scripts/request.ts <unit dir> N`; a refusal goes back to it and is not a round. A `direct` unit's lane check runs here too. The unit waits in `ready` and holds no slot: start the next unit in its place. A child of a ready parent stays stacked on the parent's branch until the parent's batch lands.

**Scope.** Scope never grows inside a running unit. New work, a host defect included, becomes a new unit in `plan.md`. A message that must change a running unit's goal states the invariant that must hold and the evidence, never the mechanism. A rule or skill change reaches a running unit only at its next round boundary, in one message.

## 3. Land a batch

Land every ready unit at once when the cadence fires (a timer wakes you for the 30 minutes, Between messages). Main only moves to a tree that passed the batch gate. Where the warm source's Git config names its checks (`rift.gate`, `rift.accept`, `rift.generated`, `rift.regenerate`, and `rift.push false` with `rift.pushBranches true` for a PR repo; the opencode README's Rift section), `rift({ action: "land", rifts: [{ path: "<the unit's Rift>", unit: "<unit>" }, …] })` (every Rift as `{ path, unit }`) runs steps 1 to 4 as one call and answers each unit green or red; read its answer and logs, then go on at step 5. Otherwise run the steps by hand. On OpenCode the orchestrate plugin refuses a `rift` land against these rules and the pipeline's (one that leaves a ready unit out, one before the cadence while an implementor runs, one before the previous batch's verdict is in, one with a finding of it folded into no unit, or into one neither landing nor still implementing), in their words; a run that must go against one states `departs: "<why>"` in the land's input, and the plugin records the departure.

1. **Integration branch.** A workspace from the warm source on branch `<run>/batch-<k>` from main (`rift land` keeps one, `integrate`); write main's hash as the batch base in Batches.
2. **Merge each ready unit**, parents before children: `git merge --no-ff <run>/<unit>`. A conflict in lockfiles or generated files only: take the unit's side, regenerate, finish the merge. After the last merge, regenerate the generated files every batch, conflict or not (a unit that changed `protocol.md` leaves the role agents behind): run the install and the generation scripts (here both `agents.ts`), and commit what changed as `chore: regenerate generated files after landing`; a failing regenerate fails the batch. Any other conflict: `git merge --abort`, log `ready → implement` with the conflicting paths, and once this batch lands, send that unit's implementor a merge round.
3. **One batch gate** at the integration head, the spec's `Batch gate` line, into `<run dir>/batch-<k>-gate.log`, as a heavy job, never a foreground shell (OpenCode's `job({ command, note, heavy: true })`, or a background shell the heavy launcher runs). Where CI is the thorough gate, this is the repo's quick local pass (Bite on the workbox: `bite gate` over the batch's diff with its DB-backed suites on the local Mongo). Red: main stays; each failure becomes a fix unit (step 6 of [Fan out what follows](#5-fan-out-what-follows)), branched from the integration head (PR repo: from the touched unit's branch) and merged back; the batch lands when the gate reruns green.
4. **Push**, green only:
   - `Lands: push`: fast-forward main to the integration head and push it.
   - `Lands: PR`: main is never pushed. Push each unit's own branch (never forced; a stack's layers through `gh stack`), and open or update its PR as a draft (`create-pr`).
   - The batch's acceptance run follows the push, once: the spec's `Batch accept` line, affected since the batch base (`rift land` runs it as `rift.accept`, in the background, and wakes you), into `<run dir>/batch-<k>-accept.log`. `Lands: push` also watches the pushed commit's CI run (`gh run watch`); green is CI's run, not a local one. `Lands: PR` starts CI on the PRs as the spec's `CI` line names: where it starts on a comment (Bite's `/pipeline <suites>`), comment once the stack is quiet, after its last push, on its top PR, naming the suites the batch's diff needs; a later push cancels it, so comment again.
   - A repo's post-land work is part of the land: where it names one (`rift.postLand`; `rift land` runs it after the acceptance run and wakes you with its report), act on the to-do the report hands you as on any red: each item becomes a unit of the next batch or a question to the owner, as the report says.
5. **Hand the batch to verify.** Write `<run dir>/batch-<k>.md`: the batch base and head, the gate log and its exit line, the acceptance command and log (or `none: run it`), and per unit its path, round, spec, request, its base and head, and its merge commit, and each finding of the previous batch folded into a unit of this one, with that unit. Log each landed unit `ready → verify rN batch-<k>.md`, except a `direct` unit and a `light` fix round on named lines only, which close as an accepted unit does (step 2 of Fan out what follows). Then [verify the batch](#4-verify-a-batch).

## 4. Verify a batch

One verifier per batch, fresh, in a clean checkout of the batch head (the pushed main, or the integration head of a PR repo). Start it once the acceptance run has answered, so the two heavy runs never overlap; with no acceptance run named, the verifier runs it. Its message names `batch-<k>.md`; its description is `verifier batch-<k> r1`, and its thread share is the batch lane's. While it runs, fan out the next batch: its implementors start, and spec the units after it. When the previous batch's findings were folded into this one, its message also names each finding and the unit it was folded into, so it checks them as folded; on OpenCode the orchestrate plugin adds that list to its prompt.

The verifier runs the batch acceptance once (or reads its log), then for each unit in the batch file's order proves that the change does what its spec says and follows the written rules (`protocol.md`, Verifier). It writes `round-N-findings.md` into each unit's dir and `<run dir>/batch-<k>-findings.md`: the batch verdict first, the acceptance result, then a row per unit with its verdict and findings path. A failure the merge alone shows (two units each right on their own) is filed on the unit merged later, naming both. A red acceptance test is a Blocker on the unit whose diff it reaches; one no unit's diff reaches goes under On base.

A batch too big for one verifier's context goes to a fresh verifier for the units it did not finish; never more than one runs on a machine at a time. On OpenCode the orchestrate plugin refuses a verifier start against these rules (one named for a unit, a second while one runs, one before the cadence with nothing landed), in their words; a run that must go against one ends the description with `(departs: <why>)`, and the plugin records the departure.

## 5. Fan out what follows

When the batch verifier hands back, route every unit in one turn, then end it with the new wave running.

1. **Check the claims.** Read `batch-<k>-findings.md`, each unit's findings, their check evidence first, and `git diff --stat` per unit; check the claims behind each spec's Risks against the code. Workers report their mistakes in the same confident words as their results. Read files, not transcripts. A fix you would make yourself goes to the implementor as a round.
2. **accepted** (or a unit that skips verify, from `ready`). `Lands: push`: log `verify → merged <hash>` (its merge commit) and [close](#close-a-unit) it. `Lands: PR`: mark its PR ready for review (`gh pr ready`), request reviewers, and log `verify → waiting(pr)` by [`references/pr-wait.md`](references/pr-wait.md); it closes when its PR merges on GitHub with CI green on its head.
3. **changes.** Fold each finding into the next batch ([the pipeline](#the-machine)), never into a fix batch of its own. A finding of a unit whose files a running implementor of the next batch owns goes to that implementor as a round message: a `subagent` call with its `sessionID`, its description its step with `(folds: <unit>/<id>, …)` at the end (`implementor billing r1 (folds: auth/M2)`). Any other finding goes to a new fix implementor that joins the next batch (`implementor auth-fix1 r1 (folds: auth/M1)`), or back to its own unit's implementor as its next round, which folds that unit's findings by itself. On OpenCode the orchestrate plugin reads the findings from the verifier's hand-back, records each fold, and lists in your run's state what is folded and what is not. For a unit's own next round, log `verify → implement r<N+1>`, and send the implementor the findings path as its next round (from round 3, a fresh implementor: [`references/hosts.md`](references/hosts.md), Fresh implementor). `Lands: push`: the unit's code is on main, so the round starts from main's head (its workspace fast-forwarded, or made again from the warm source on the same branch when the land removed it); `Lands: PR`: on its own branch, and its next batch updates the PR. At the third failed round, log `verify → decide`, and [rewrite](#rewrite).
4. **stuck**, or a verifier that died: log `verify → decide` and [re-plan](#stuck), or `stuck(quota)` and rerun the verifier.
5. **Next.** Start each plan unit whose dependencies are now on main or ready, up to the pace and the shares, and restack their children. If a result changes what a later unit needs, update its spec first.
6. **Fallout.** Each red the batch gate, the acceptance run or CI showed that no unit's findings already own becomes one fix unit, routed to the unit whose diff it touches (`git log --merges <base>..HEAD -- <path>`): a `light` unit `<unit>-fix<n>` whose acceptance check is the failing test, red now, owning the touched unit's Owns, its implementor reading that unit's spec and findings. A test that fails once and passes on one retry is a flake: name it in Follow-ups. A failure no unit's diff touches becomes a host or tooling unit. A red CI run on one unit's own PR is that unit's next round instead ([`references/pr-wait.md`](references/pr-wait.md)). Until main's CI is green, a batch lands only fix units. Red stays on main and is fixed forward, never reverted.

### Close a unit

Write `merged <hash>` into its row, with its decisions, the follow-ups from `state.md`, the findings' Unproven, On base and `guard:` entries (each guard a tooling unit), and anything for Review later. A spike, sketch or prototype unit's verdict also goes where the next session reads it: a `NORTH_STAR.md` row, a `PRIOR_ART.md` → Settled row, or an ADR. A helper its workers built that a later unit would rebuild (a browser driver, a rerun script, a seed root) is a follow-up unit that moves it into the repo's scripts or its `verify-<app>` skill ([build-the-lever](~/Developer/personal/dotfiles/principles/build-the-lever.md)). Stop its agents (Codex: `close_agent`), delete its branch and remove its workspace by its full path; remove the batch's once every unit in it is closed.

### asks

A worker ended `blocked`, naming its `blocked.md`. A small, reversible point: decide it by principle, record it in Decisions, and send the same worker the decision. Otherwise: Owner questions with your recommendation, one short message to the user, and the other units keep running.

### rewrite

The unit failed three rounds. Repair is over: diagnose it, then rewrite it on a new spec, by [`references/rewrite.md`](references/rewrite.md).

### stuck

No round can help (a spec that contradicts itself, a missing decision). Re-plan by one of: sharpen the spec, starting from the written premise; split the unit; narrow it to the owner's ask and log the rest as known limits; make the contested decision yourself. Stop the old implementor.

## 6. Between messages

- **Wait.** End your turn and let workers, land answers and timers wake you. To wait on an outside event, set one `monitor({ command, until, note })` on OpenCode, or one background until-loop on Claude Code, and re-arm it only after an event. While units wait in `ready`, the oldest one's 30 minutes is such an event: one timer, re-armed when a batch lands.
- **Name the wait.** Before you end a turn with units in `plan`, `implement` or `verify` and no agent working on them, start them, or name what they wait on (the acceptance run, a slot) as a `waiting` queue item. On OpenCode an idle root with such units and no named wait is steered once: `idle with units in plan, implement or verify: …; start them or name what you wait on.`, and once a batch is due (by the cadence `status.ts` prints per unit): `idle with a batch due (…): …; land it with rift({ action: "land", rifts: ["<run>/<unit>", …] }).`
- **Stop finished agents.** On OpenCode a subagent stops when its turn ends. On Claude Code, TaskStop an agent at its final hand-back.
- **Owner direction** goes, the same turn, into the file that owns it: `NORTH_STAR.md` for scope and standing rules, the project's skill for craft and voice, `AGENTS.md` for the stack.
- **After your own compaction.** Re-read this file, `protocol.md` and `plan.md`, and run `status.ts`, before any other action. On OpenCode the orchestrate plugin also sends you, with your next request, The machine section above and your run's state from its ledger (each unit by state, the batch verifying, the next batch's units and the findings folded into it, the findings riding with a unit still implementing, a due batch); the re-read stays.
- **Host move.** Rewrite the run's shared rules file for the new host in place; never keep an override file.
- **Pause.** On a pause, stop every running worker, and write where each unit stands into `plan.md`.

## 7. Close

The run closes when every unit is merged, dropped, or blocked on an owner question. The end report opens with the goal from `plan.md`'s first line, word for word, and whether it is met. It covers what merged, with hashes; the gate and CI on main; the decisions taken by principle; the owner questions, each with a recommendation; the follow-ups, with each `Departs from` line of the run's rules file as a proposed skill change; the Review later list; the environment changes that would make the next run go better (a constrained API, a lint rule, a log, data access) and the recurring schedules worth setting up; and the `plan.md` path. Close every workspace you opened.
