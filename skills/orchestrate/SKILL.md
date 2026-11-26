---
name: orchestrate
description: Run work as units of background agents (implementor, verifier, an optional planner) from an OpenCode, Claude Code or Codex session, verified by runs, never by review. Use when the user asks to orchestrate, coordinate, run a swarm, or fan a plan out to agents.
---

# Orchestrate

You run the work, never the code: split it into units, start one agent per unit, land what its runs prove. Workers follow [`protocol.md`](protocol.md), carried in their prompts.

## Frame

- Restate the owner's goal in one line, word for word where he gave it. It opens the plan, every brief and the close.
- A unit is one change with one Done line: its **acceptance law**, a command whose output proves it (a property, a model-based test, a Quint model when steps interleave). If you can't name the evidence, the unit isn't scoped yet.
- One or two files with an obvious fix: one agent, no units.
- Settle a fork you could run by prototype, not by asking. Order units riskiest first; start one end to end before you fan out.
- **At most four lanes** run at once, on units that share no files. A child stacks on its parent's head.

## State

The run dir `tmp/orchestrate/<run>/` in the main checkout holds a folder per unit (`spec.md` from [`spec-template.md`](spec-template.md), `log.md`, `state.md`, `round-N-request.md`, `round-N-findings.md`), and `plan.md`: the goal, a unit table, Decisions, Owner questions, Follow-ups. These and git are the whole state: `orchestrate({ action: "status" })` (elsewhere `scripts/status.ts <run dir>`) derives each unit from them. Each move is one line by `scripts/log.ts`; on OpenCode the plugin logs starts and hand-backs.

## A unit

1. `orchestrate({ action: "lane", unit, purpose })` makes its workspace and branch (or `work new` per `AGENTS.md`).
2. Start its implementor in the background, described `implementor <unit> r<N> — <purpose> (lane: <path>)`. The brief: the goal, the Done line, the writable paths, the workspace, then `Finish the whole list; be economical.` as its last line. A planner writes the spec first only when the law is hard to state.
3. **Done** = the law red before and green after, the checks the change affects green (the receipt: `bun ~/Developer/personal/dotfiles/opencode/scripts/receipt.ts -- '<commands>'`), and `request.ts <unit dir> <N>` exit 0.
4. `orchestrate({ action: "land", units: [<unit>] })`: the merge check runs, then the push. A red merge check never pushes; it becomes a fix unit.
5. Before an install, one fresh verifier **runs** the built pair (`orchestrate({ action: "verify" })` answers its call). Verdict `pass`, `issues` (each failure a run proved) or `blocked`, which never passes. Nothing else is a verdict; there is no review step.

A round with `issues` goes back to the unit as its next round, with the findings path. After two failed rounds, split or drop the unit. A new head needs no new verifier unless it changes what was run.

## Supervise

- **Wait** by ending your turn: agents, lands and monitors wake you. An outside event is one `monitor`.
- **Never block on the shell.** A command that can run longer than about 10 seconds goes to a `job`, a background shell or a subagent; only quick reads run inline.
- Judge an agent by its side effects (commits, receipts, files), never its status text. Never message an idle agent. A dead or stalled one: rerun the step fresh ([hosts](references/hosts.md)); the same failure twice is `stuck`.
- Scope never grows inside a unit: new work is a new unit. A base problem is a follow-up line.
- Subagents ask you (`ask_orchestrator`); answer from the documents, and ask the owner only what is his.
- After a compaction: re-read this file and the plan, run `status`, then act. Long runs keep the [decision trail](references/trail.md); a run's own rules file follows [run-rules](references/run-rules.md); a PR repo waits per [pr-wait](references/pr-wait.md).

## Roles and models

| Role | Agent | Effort | Context |
| --- | --- | --- | --- |
| planner | `planner` (Fable, then Opus) | medium | fresh |
| implementor | `implementor` on Opus | Opus medium | kept for round 2 |
| verifier | `verifier` on Opus only | medium | fresh each time |

Name the role as the agent type; OpenCode names no `model`. Never Sonnet; never verify on Codex. When Claude is held, the call latches; wait ([pace](references/pace.md)).

## Owner

- Decide what you can undo, by the principles, under Decisions. Ask the owner only for an irreversible or external act, or a call no run settles, with your recommendation; keep running.
- **Reserved**: deploy, publish, paid runs, force-push to a shared branch, non-additive changes to stored or wire formats. A green land pushes.
- **The Sabbath** (Friday sunset to 30 minutes after Saturday's): no agent works and no unit starts; the sabbath mod latches held work and resumes it after.

## Close

The goal word for word and whether it is met, each landed hash with its verdict, the drops and why, follow-ups, open owner questions, and the `plan.md` path.
