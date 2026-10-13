# Retro

Every pass ends with a retro of that pass (step 11), and the loop's close ends with one over every pass. A sweep looks at the code. A retro looks at how the loop produced it: what went wrong, what cost the most, and which tooling and skills to add, change or remove so the next pass takes less work and fewer tokens for the same accepted change. That includes the project's own skills, so each of its domains is quicker to navigate, understand and improve.

Read [`retro`](../retro/SKILL.md) first. It is user-invoked only, so read it rather than calling it. Its categories apply here: navigation, automated checks, coding standards, steering files, tool economy, no-ops and information access. This file adds the loop's own evidence and where each fix lands.

## Evidence

The loop records evidence while it runs, so the retro reads it instead of rebuilding it. At each hand-back, step 6 appends the agent's spend to the unit's `log.md`, read from its transcript by `orchestrate/scripts/agent-cost.ts`: turns, cache-read tokens, compactions and wall time. A task notification's token count is only the agent's final context, 50 to 1000 times under its spend. The retro reads:

- the pass section of the ledger, and each unit's `log.md`, which holds the round trail and the costs;
- the `round-*-findings.md` and `round-*-verify.md` files, which say what each failing round caught;
- the gate and e2e logs: their run times, queue waits and flakes;
- the owner's messages during the pass, from `retro/scripts/mine-sessions.ts --since <pass start>` (see [`retro`](../retro/SKILL.md) step 2). A direction given twice, an interruption, or a breakage the owner noticed before the loop did each counts as a finding.
- the orchestrator's own session (`~/.claude*/projects/<repo>/*.jsonl`), read with grep for compactions, refusals and repeated commands, never read whole.

## Questions

Answer each with a number or a file.

1. **Rounds.** Which units took more than one round, and what did each failing round catch? A defect class caught twice should have had its property or guard written after the first catch. For example, talk1b fixed one comment-ownership class case by case over three rounds, reached the failure cap, and closed it in one round once a generated property owned the class.
2. **Lost work.** Which agents died, and from what: quota, compaction, a permission refusal, or the host? What was redone? Which units waited, and on what: the gate queue, the owner, or another unit?
3. **Cost.** What were the tokens and wall time per accepted unit, and which three units spent the most? Find the reads behind the spend, such as whole logs, whole files, or a context re-read every round.
4. **Hand work.** What did the orchestrator do by hand more than once that a script would do? For example, in p5 the orchestrator diffed a full e2e run's failures against base and reran each new failure alone, by hand, for each unit.
5. **Checks.** Which review or verify finding could a lint rule, a type or a test have caught? Place each check by [`guardrails.md`](guardrails.md).
6. **Host.** What broke on the host that the loop should have caught first? For example, in p5 the test Chrome played audio through the owner's speakers until the owner asked about it.
7. **Remove.** Which step, rule, prompt line or file changed no outcome this pass? A rule that changed no outcome is a candidate for removal. The test: could the loop have accepted the same units without it?
8. **Project skills.** List the project's domains and goals: its north stars, its packages and apps, and what the owner works on (in bible-tools, the film engine and its looks, the lab, the UI kit, EGW search, the CLI, the studies). For each domain the pass touched, answer three things:
   - **Navigate.** Which files did agents explore again and again before they could act? Grep the transcripts for the same paths read by several agents, or by one agent after each compaction. A skill holding that map (where things live, which seam owns what, the commands that prove a change) is a candidate.
   - **Understand.** Which rule did an agent break because no skill said it? Which owner direction lived only in a message? Which domain fact did several agents rediscover: a runtime quirk, a host fact, an art rule?
   - **Stale.** Does a project skill now say what the code or the owner no longer means? In p5, the film skill still said "one hand design, a mitten with a thumb" after the owner chose circle hands. A stale skill steers every later agent wrong.

   Each answer becomes an edit to an existing project skill, or a new one when no skill covers the domain. A domain with no skill that agents worked in all pass is a finding by itself.

## Report and actions

Write `<pass dir>/retro.md`. List at most 10 candidates, ranked by expected saving. Each row gives:
- the evidence, as a path and a number;
- the category;
- the expected saving, in tokens, rounds or hours;
- the action and where it lands;
- its status.

Where an action lands:

- **This skill, `orchestrate`, or the loop's prompts.** The orchestrator edits them now, in `~/Developer/personal/dotfiles/skills/` (owned skills are edited at their source), and commits there. It pushes only if the owner rules allow it.
- **The project's tooling, guards or `AGENTS.md`.** A batch of the next pass, triaged first.
- **The project's skills.** These are in the repo (`.claude/skills/<name>/`, or `skills/<name>/` when they are installed elsewhere through okra). A correction to a stale line, or a short map or rule from the evidence, the orchestrator commits now on main, after the docs guard passes. A new skill, or a rewrite, is a batch of the next pass, written by the `writing-for-agents` guide and checked by its first user. A skill installed through okra is reinstalled after the edit (`okra` remove, then add), and never hand-edited in the install dir.
- **An owner rule, or a question of scope.** `NORTH_STAR.md`, or an owner question.
- **Rejected.** Give the reason.

On the ledger, the pass section gets a `Retro:` line. It names the report, the actions applied, and the actions carried. Carried retro actions stay open like `Carried` rows.

The next pass's retro checks each applied action: did its number move? An action that saved nothing is reverted. Removing tooling counts the same as adding it.

## Keep it cheap

Run it as one read-only agent, or as the orchestrator itself. Read with grep, and cap the read at about a tenth of the pass's spend. Done when `retro.md` exists, every candidate has a destination, and the skill edits are committed.
