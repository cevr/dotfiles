---
name: dream
description: "Weekly retro across every session, machine and orchestrate run: where the week's time and compute went, and what to change."
disable-model-invocation: true
---

The owner has asked you to **dream**: take stock of the past week of agent work on every machine, and find the changes that make next week's work cost less for the same accepted result. [`retro`](../retro/SKILL.md) looks at one session's mistakes. A dream looks at the **process**: which states of the machine took the time, which ceremony found nothing, and what the owner kept saying.

The window is the last 7 days unless the owner names another. Work only from measured records. Label each claim measured, inferred or guess.

## Steps

1. **Read last week's dream** in `~/.claude/dreams/`, if one exists. For each action it applied, find the number it promised to move. An action that moved nothing is a revert candidate. Removing tooling counts the same as adding it.

2. **Mine the sessions on each machine.** The machines are this Mac and the workbox (`ssh bite-workbox`). Run the miner from [`retro`](../retro/SKILL.md) step 2 on each one, with its own `--out`:

   ```
   bun ~/.claude/skills/retro/scripts/mine-sessions.ts --since 7d --out <scratch>/<machine>
   ```

   On the workbox, run `git -C ~/Developer/personal/dotfiles pull --ff-only` first. Copy each `digest.md` back. Read the digests, not the transcripts. Record per machine: limit errors, cache-read tokens, compactions, the costliest sessions and agents, the skills used, and the owner's repeated messages.

3. **Time the orchestrate runs.** On each machine, find the run directories touched this week and pass them to the timing script:

   ```
   find ~/Developer /tmp -maxdepth 7 -name log.md -mtime -7 2>/dev/null | xargs grep -l '→' \
     | xargs -n1 dirname | xargs -n1 dirname | sort -u \
     | xargs bun ~/.claude/skills/orchestrate/scripts/timing.ts --since <window start>
   ```

   It prints the wall-clock share of each state, round 1 against rework, review and verify bounces, rounds per unit, and the longest tails.

   Then, on each machine, run `bun ~/.claude/skills/orchestrate/scripts/models.ts --since <window start>`. It reads Claude Code and Codex transcripts, and prints two tables: per role and model, the count, the API-priced cost, minutes, tokens and compaction share; and per orchestrate phase and model, what the phase produced (round-1 accepts, review changes and escapes, verify fails, units merged). Compare models within a phase, never across phases. A model swap is judged on both tables: cost alone does not justify one.

4. **Classify every bounce in the longest tails.** Read the Major headings in each tail unit's `round-*-findings.md` and `verify-*.md`, not the whole files. Put each Major in one class:
   - **defect**: a bug a user would hit.
   - **test strength**: the generator, oracle or mutant suite is weaker than the rule.
   - **spec**: the spec was ambiguous or wrong, so a decide or a rewrite fixed it.
   - **environment**: quota, a shared slot, a slow or flaky gate, a dead agent.
   - **owner wait**: a decide or a merge that waited on a person.

   Count the classes per round. A ceremony step whose bounces are all one class, or that bounced nothing, is the finding.

5. **Hold the week against the skills and principles.** Read `~/Developer/personal/dotfiles/principles/` and the skills the digest counts most. For each repeated owner message, find the line that encodes it. A message with no encoding line is a candidate. A line the owner had to repeat is a candidate too, because it does not hold.

   When a step costs much and finds little, read how a peer does the same step with less, for example `okra repo fetch cursor/plugins` (`pstack`) or `okra repo fetch mattpocock/skills`. Name the peer's mechanism. Do not copy the peer's ceremony.

6. **Write `~/.claude/dreams/<YYYY-MM-DD>.md`.** Do not write it in the dotfiles. That repository is public, and the digest quotes work sessions. Include:
   - The week's numbers per machine, with a measured label.
   - At most 10 candidates, ranked by expected saving. Each candidate gives: the evidence, the class, the fix at the highest level that works (the ladder in [`retro`](../retro/SKILL.md) step 4), the expected saving, and the number next week's dream reads to check it.
   - Last week's actions, each kept or reverted, with the number.

7. **Present the candidates to the owner.** Skill, `AGENTS.md` and principle edits land once the owner picks them. Then follow [`writing-for-agents`](../writing-for-agents/SKILL.md), commit each edit as its own Conventional Commit, and push. Add a `Applied:` line to the dream file that names each commit.

## Reference

- **Compute or process.** Limit errors and compactions say the week was compute-bound. Rework rounds, owner waits and a serialized shared slot say the process was the bound. Report both. Do not treat more compute as the fix for a process bound.
- **Ceremony scales with risk.** A review or verify step that never bounces for a class of unit is ceremony for that class. Propose a lighter path for that class, not the removal of the step.
- **Converging tails.** When rounds 3 and later bounce only on test strength, the round cap or the class-seen-twice rule is the candidate, not the implementor.
