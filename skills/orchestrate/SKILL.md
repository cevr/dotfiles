---
name: orchestrate
description: Coordinate work as units of background role agents (planner, implementor, verifier) from a Claude Code, OpenCode or Codex session, in one of five modes (single fix, lane by default, batch, deep, long run). Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to implementor and verifier agents.
---

# Orchestrate

You are the **orchestrator**, the run's root: you split the work into units, start a role agent for each step, land what is green and have it verified. You write no product code; your context holds the plan, verdicts and merges.
Pick a mode by the table. Workers follow [`protocol.md`](protocol.md), carried in their prompts.

## Modes

| Mode | When | Shape | Verify |
| --- | --- | --- | --- |
| `single fix` | 1 to 2 files, one bug or one ask | one agent, focused gate, merge | none; blast-radius when risky |
| `lane` | the default: a few independent units | per unit: lane, implement, receipt, land at once | over main, when the tool warns |
| `batch` | many units on shared seams, or a PR repo | the ready units land together | one fresh verifier per batch |
| `deep` | money, auth, stored or wire formats, concurrency | planner, model test, live matrix | a verifier before the merge, plus an adversary |
| `long run` | overnight, a program | one owner agent per PR, a decision trail | once, at the code-ready head |

### single fix

- No units and no planner: one agent, the focused gate, the merge.
- Risky (a shared seam, a hot path, a format): run `code-review`'s [blast-radius](../code-review/references/blast-radius.md) page first.

### lane

- Per unit: `orchestrate({ action: "lane", unit: "<unit>", purpose: "<outcome>" })` → its implementor → the focused round gate as the receipt (`bun ~/Developer/personal/dotfiles/opencode/scripts/receipt.ts -- '<commands>'`, with `gate.ts --merge <base>` where the repo has it) → `orchestrate({ action: "land", units: ["<unit>"] })` at once.
- One land and one full gate per host at a time: the land's merge check runs before its push.
- When a `land` or `status` answer starts `orchestrate: <N> lands on <branch> since the last verify`, call `orchestrate({ action: "verify" })` and start the subagent call it answers. Each finding goes by where it came from (`protocol.md`, Rounds): one the unit's change introduced is its lane's next round; one the base head shows too becomes a follow-up unit.
- Nothing waits for a verdict: the next green unit lands.

### batch

- Many units on shared seams, or a PR repo (`rift.push false`, Bite). The ready units land together in one `orchestrate land`; the first lands alone, as the pilot.
- Write `<run dir>/batch-<k>.md` (base, head, gate log, per unit its spec, request, round and merge; with the fleet on, the one line `Heads: dotfiles=<40-hex> fork=<40-hex>`), then `orchestrate({ action: "verify", batch: "batch-<k>" })`: one fresh verifier for the batch, a verdict per unit.
- A PR repo pushes each unit's branch with a draft PR, marked ready on `accepted` ([pr-wait](references/pr-wait.md)).
- A rebase with the same `git patch-id` keeps its verdict. A batch still waiting for its verdict: start its verifier now; no land waits on it.

### deep

- Money, auth, stored or wire formats, concurrency, the run's hardest unit. A planner; its acceptance check is a model-based test (and a Quint or TLA+ model when steps interleave), red before implement.
- A verifier **before** the merge: a batch file `<run dir>/<unit>.md` naming that unit alone, then `orchestrate({ action: "verify", batch: "<unit>", head: "<its head>" })`, plus an adversary by `code-review`'s [interrogate](../code-review/references/interrogate.md) page; its live matrix (device, simulator, browser) runs there. It lands on `accepted` only.

### long run

- Overnight, or a program of PRs. One owner agent per PR from build to merge, a fresh one at each hand-back briefed from `log.md` and the branch.
- Keep the [decision trail](references/trail.md): a replacement root reads it first.
- A verifier once, at the code-ready head; a rebase with the same `git patch-id` keeps its verdict.

## The run's state

The run dir is scratch: `tmp/orchestrate/<run>/` in the main checkout (git-ignored), one folder per unit holding `spec.md` (from [`spec-template.md`](spec-template.md): you write it when there is no planner), `log.md`, `state.md` (the implementor's), `round-N-request.md` and `round-N-findings.md`. These files and git are the run's whole state: `orchestrate({ action: "status" })`, or `scripts/status.ts <run dir>` on another host, derives each unit's state from them, and a unit whose request's head is on the default branch is merged. A restart or a new root loses nothing. Each move is one line by `scripts/log.ts <unit dir> <from> <to> r<N> <cause>`, its only writer (on OpenCode the plugin logs a role's start and hand-back).

The plan is a docs file in the project (`plans/<run>-run.md`), linked as `<run dir>/plan.md`: its first line the user's goal word for word, then a unit table (Unit, Depends on, Workspace, Agents, Result), Decisions, Owner questions and Follow-ups.

## Starting units

- **Read first**: the task, the repo's `AGENTS.md` or `CLAUDE.md`, and `NORTH_STAR.md`. Run on the machine that holds the work. On a host the run has not used, run the base's gate and e2e alone first; each red leg or missing tool goes into one host unit that merges before the others start.
- **A unit** is one reviewable result: one deliverable, one spec, one lane and branch for its life, a slug of words naming its outcome: no `-rN`, no run prefix. Order units by dependency; those with no shared files run together, and a child stacks on its parent's head. The owner's ask, quoted word for word, is the Done line.
- **Shape first**: a bulk code edit is a codemod; bulk model work is a script on the Batch API; a new core seam follows two blind sketches judged against `NORTH_STAR.md`; a `to-tickets` ticket is a unit, its blocking edges the dependencies. A carried tooling unit that pays back inside the run takes the next free slot.
- **One workspace per unit**, from the base as `AGENTS.md` says. The implementor's message names its spec, role, round and thread share; its description is `implementor <unit> r<N> — <purpose> (lane: <path>)`. At its hand-back, `scripts/request.ts <unit dir> <N>`; a refusal goes back to it and is not a round.
- **Pace, not a count**: the account pools set how many agents run ([pace](references/pace.md)), and a heavy agent starts only while the load is under the core count. All heavy checks together use at most the core count in threads: name each worker's share (4 threads or more) in its start message, as its tools' flags.
- **Focused checks**: a unit's round gate is its changed packages' tests and typecheck, lint of its changed files and its acceptance test, each leg under a minute (`protocol.md`, Rounds). The full gate is the land's merge check; a leg slower than a minute is a tooling unit.
- **Stateful units start from a model**: a unit that changes behavior over time gets a model-based test as its acceptance check from round 1. A Blocker that repeats an earlier round's class makes a property over that class the next round's first deliverable.
- **Scope never grows inside a running unit**: new work is a new unit. A rule change reaches a running unit only at its next round boundary, in one message.
- **Decide small, reversible points** yourself by the `principle-*` skills, each in Decisions. Difficulty is never a reason (`principle-nothing-is-hard`): to options that differ only in effort, "leave it as a follow-up" is no answer; the better one is built. A follow-up is work no spec item asks for, with a trigger; a spec item never is one. **Owner questions never wait in a dialog**: write it with your recommendation in Owner questions, ask in one short message, keep the other units running.
- **A run's rules file** (`<run dir>/common.md`) holds project facts only ([run-rules](references/run-rules.md)).

## What blocks, and what is refused

- **Every verify is a fresh verifier in a clean checkout** of the head it judges. **The verifier blocks only on a shown failure**, the bar in [`protocol.md`](protocol.md) (Verifier, Proof). Everything else it proves (a weak test, narrowed acceptance, a written-rule break) fails no round and goes by where it came from: one the unit's change introduced, the same lane closes in its next round, before that lane takes another unit; one the base head shows too becomes a follow-up unit; each `guard:` line a tooling unit.
- **Refused**, the harm rules only: a red merge check never pushes; one land and one full gate per host at a time; the reserved actions; a subagent never lands; the Sabbath.
- **Reserved for the user**: deploy, publish, paid runs, force-push to a shared branch, non-additive changes to stored or wire formats, anything irreversible. Push is not reserved: a green land pushes.

## Rounds

- A round is one request and its verdict; it fails on `changes`, a proven Blocker or Major. Its next round goes to the same implementor (from main's head once it landed); from round 3, a fresh one ([hosts](references/hosts.md)).
- At the third failed round, the unit goes to decide: [rewrite](references/rewrite.md), re-plan (sharpen the spec, split it, narrow it to the owner's ask) or drop. `stuck` (no round can help) goes to re-plan.
- A dead worker gives no verdict: it ended on a limit or without its hand-back line. Follow [worker restarts](references/hosts.md#worker-restarts). A dead verifier never counts as `accepted`. An implementor that needs a third message inside one round is `stuck(size)`: split the unit.
- A red merge check, acceptance run or CI on main becomes a fix unit, fixed forward, never reverted; until main's CI is green, only fix units land.
- **Close a unit**: `merged <hash>` in its row, its and its findings' follow-ups in the plan; stop its agents and remove its workspace. End an abandoned one by `log.ts --current <unit dir> dropped r<N> superseded-by <hash>` (or a reason), or status lists it.

## Roles and models

| Role | OpenCode | Claude Code | Codex | Effort | Context |
| --- | --- | --- | --- | --- | --- |
| planner | `subagent`, `agent: "planner"` | `Agent`, `model: "fable"` | `spawn_agent`, the newest sol | medium | fresh per unit |
| implementor | `subagent`, `agent: "implementor"` | `Agent` on Opus | never | Opus medium | kept for round 2; fresh from round 3 |
| verifier | `subagent`, `agent: "verifier"` on Opus | `Agent` on Opus | never | medium | fresh each time |

- Every role call runs in the background, names the role as its agent type, and has a `description` that starts like its hand-back line (`implementor auth r2`, `verifier batch-3 r1`); a reused agent (next round, lane) gets the new one; where the host keeps the old title, rename it. On OpenCode it names no `model`. Effort is the table's, always; an implementor that renders a look runs at max. Change effort, never the model. How each host starts, falls back and waits: [hosts](references/hosts.md).
- The pool and model rules are `AGENTS.md`'s (Fable plans, Opus first, never Sonnet). Verification and review run only on Claude Opus. When Claude is held, latch and wait; never start a verifier on Codex.

## Between messages

- **Wait** by ending your turn: workers, lands and timers wake you. An outside event (CI, a time) is one `monitor` or background waiter. Before you end a turn with units in `plan`, `implement` or `verify` and no agent on them, start them or name what they wait on.
- **Never block on the shell.** A command that can run longer than about 10 seconds (a build, a test run, an ssh) goes to a `job`, a background shell or a subagent, and you end the turn or go on until it wakes you. Only quick reads run inline.
- **Owner direction** goes, the same turn, into the file that owns it: `NORTH_STAR.md` for scope and standing rules, `AGENTS.md` for the stack. On a pause, stop every worker and write where each unit stands into the plan.
- **After a compaction**: re-read this file and the plan, and run `orchestrate({ action: "status" })` (elsewhere `status.ts`), before any other action.
- **Close the run** when every unit is merged, dropped or blocked on an owner question: the goal word for word and whether it is met, merges with hashes, decisions, owner questions, follow-ups and the `plan.md` path.
