---
name: dream
description: "Weekly retro across every session, machine and orchestrate run: where the week's time and compute went, what to change, and an audit of each machine's memory notes and prompt-cache efficiency."
disable-model-invocation: true
---

The owner has asked you to **dream**: take stock of the past week of agent work on every machine, and find the changes that make next week's work cost less for the same accepted result. [`retro`](../retro/SKILL.md) looks at one session's mistakes. A dream looks at the **process**: which states of the machine took the time, which ceremony found nothing, and what the owner kept saying.

The window is the last 7 days unless the owner names another. Work only from measured records. Label each claim measured, inferred or guess.

## Steps

1. **Read last week's dream** in `~/.claude/dreams/`, if one exists. For each action it applied, find the number it promised to move. An action that moved nothing is a revert candidate. Removing tooling counts the same as adding it. Its Memory section counts too: a note added for a repeated correction worked when the owner stopped repeating it, and a note no session used since is a prune candidate in step 6. So does its Cache section, which step 7 holds against this week's audit.

2. **Mine the sessions on each machine.** The machines are this one and each remote dev box the global `AGENTS.md` names (over `ssh`). Run the miner from [`retro`](../retro/SKILL.md) step 2 on each one, with its own `--out`:

   ```
   bun ~/.claude/skills/retro/scripts/mine-sessions.ts --since 7d --out <scratch>/<machine>
   ```

   On a remote box, run `git -C ~/Developer/personal/dotfiles pull --ff-only` first. The miner reads OpenCode sessions through the machine's running OpenCode service (its HTTP API, never its database), and Claude Code and Codex transcripts. The digest's OpenCode section gives the per-role and per-model rows, tool errors and notices; when it says the service did not answer, start OpenCode on that machine and run the miner again. Any harness beyond these three that the machine ran in the window (its session store, its server, or a recent process) is mined by hand, through its own export or review command, into the same `messages.jsonl`, `sessions.jsonl` and `digest.md` shapes with its own `src`. Copy each `digest.md` back. Read the digests, not the transcripts. Record per machine: limit errors, cache-read tokens, compactions, the costliest sessions and agents, the skills used, and the owner's repeated messages.

3. **Time the orchestrate runs.** On each machine, pass every run directory touched in the window (under `~/Developer`, `/tmp` and `~/.cache/orchestrate`) to the timing script:

   ```
   bun ~/.claude/skills/orchestrate/scripts/runs.ts --since <window start> \
     | xargs bun ~/.claude/skills/orchestrate/scripts/timing.ts --since <window start>
   ```

   It prints the wall-clock share of each state, round 1 against rework, verify bounces, rounds per unit, and the longest tails.

   Then, on each machine, run `bun ~/.claude/skills/orchestrate/scripts/models.ts --since <window start>`. It reads OpenCode sessions and the orchestrate mod's call log (`~/.cache/orchestrate/opencode-agents.jsonl`), and Claude Code and Codex transcripts, and prints the tables: per role and model, the count, the API-priced cost, minutes, tokens and compaction share; per orchestrate phase and model, what the phase produced (round-1 accepts, review changes, units merged); and OpenCode's rounds per role and `model@effort`. Compare models within a phase, never across phases. A model swap is judged on both tables: cost alone does not justify one.

4. **Classify every bounce in the longest tails.** Read the Major headings in each tail unit's `round-*-findings.md` and `verify-*.md`, not the whole files. Put each Major in one class:
   - **defect**: a bug a user would hit.
   - **test strength**: the generator, oracle or mutant suite is weaker than the rule.
   - **spec**: the spec was ambiguous or wrong, so a decide or a rewrite fixed it.
   - **environment**: quota, a shared slot, a slow or flaky gate, a dead agent.
   - **owner wait**: a decide or a merge that waited on a person.

   Count the classes per round. A ceremony step whose bounces are all one class, or that bounced nothing, is the finding.

   Then audit each live run's own rules (its `common.md` and any other rules file in the run dir, by [`orchestrate/references/run-rules.md`](../orchestrate/references/run-rules.md)) against the installed `orchestrate/SKILL.md` and `protocol.md`. Write a drift table, one row per run: the run and machine, its `skill-version` against the installed one, and its rules counted as **restates** (the skill says it; delete), **project fact** (keep), **departure** (a `Departs from` line) and **contradicts** (differs from the skill with no `Departs from`; the run drifted). A departure that two or more runs make, or one run makes for two weeks, is a candidate skill change in step 8: the skill takes it, or the runs drop it. A contradiction is a candidate too, since the reconcile note did not hold.

5. **Hold the week against the skills and principles.** Read `~/Developer/personal/dotfiles/principles/` and the skills the digest counts most. For each repeated owner message, find the line that encodes it. A message with no encoding line is a candidate. A line the owner had to repeat is a candidate too, because it does not hold.

   When a step costs much and finds little, read how a peer does the same step with less, for example `okra repo fetch cursor/plugins` (`pstack`) or `okra repo fetch mattpocock/skills`. Name the peer's mechanism. Do not copy the peer's ceremony.

6. **Audit memory on each machine.** Each machine keeps its own memory file, the notes the OpenCode memory plugin injects at session start (rules in `opencode/README.md`, Memory). Read and change it only through its CLI, run on that machine after the pull of step 2:

   ```
   bun ~/Developer/personal/dotfiles/opencode/cmd/memory/cli.ts stats --json
   ```

   `stats` gives each note's uses, showings, last use and idle days, the stale notes, the near pairs, and each project's digest fill; `projects` maps project ids to directories; `show`, `search`, `edit`, `merge`, `add` and `forget` do the rest (a bad command prints the usage). Hold the notes against the week's digests and act on each class:
   - **Repeats**: a near pair that states one fact → `merge <keep> <drop>`, with `--text` for the better wording. A pair that states two facts stays.
   - **Contradicted**: a note the week's sessions or the owner's messages show wrong or outdated → `edit <id> --text`, or `forget` when nothing true remains.
   - **Stale**: idle past 30 days with no use → reword it so a search finds it, or `forget` it when its fact no longer bears on the work.
   - **Missing**: an owner correction or preference the digest shows twice or more that no note holds → `add --scope global` (about the owner, any project) or `add --scope project --project <id>` (one repository's convention).
   - **Budget**: a digest whose `holds` is below its `visible` drops notes at session start; keep the ones the week used and merge or prune the rest.

   The audit is done when every stale note and near pair has a decision and every repeated owner correction maps to a note. These changes apply now, without the owner's pick: they are reversible, and next week's dream checks them.

7. **Audit the prompt cache on each machine.** The north star is the overall **hit rate** (`read / (read + write + uncached)`) and the **wasted writes** (tokens a break wrote again). Each machine keeps its own ledger, so run the audit on each one, after the pull of step 2:

   ```
   cd ~/Developer/personal/dotfiles/opencode && bun scripts/cache-audit.ts --since 7d --static --json
   ```

   It gives the hit rate and the writes' share of prompt and cost, overall and per host, agent and model; the **breaks** (a session's read falling sharply against its request before) by cause, ranked by wasted writes, with the first changed segment; the cold starts (`subagent-first`, `session-start`); the top sessions; the trade of lifetimes under an hour; and `rules`, the six caching rules plus the lifetime fit, `pass`, `warn` or `fail`, each finding naming its file. The causes and rules are in `opencode/README.md`, Cache.

   - Hold each number against last week's dream file, its **Cache** section. A fix it applied is kept when its cause's wasted writes fell, and is a revert candidate when they did not.
   - Name the top two causes by wasted writes on each machine, with their segment or file. `dropped` and `restart` name no segment: read the top sessions' breaks (`--top 20`, text output) before naming a fix for them.
   - Pick one or two fixes for the top causes, at the highest rung that works: a plugin or config change first (a mod under `opencode/mods`, its `cmd/` root, the config), a fork hook last (`opencode/AGENTS.md`, the fork's ladder). A fix that is a small, reversible plugin or config change applies now, on its own branch, with its focused tests and gate, committed as one Conventional Commit; anything larger, and every fork change, goes to the candidates of step 8. Each fix names the number next week's audit reads: the cause's wasted writes, or a rule's status.

   The audit is done when each machine's hit rate, write-token share, write cost share and top causes are recorded, every `fail` rule has a fix applied or queued, and every fix names its number.

8. **Write `~/.claude/dreams/<YYYY-MM-DD>.md`.** Do not write it in the dotfiles. That repository is public, and the digest quotes work sessions. Include:
   - The week's numbers per machine, with a measured label.
   - At most 10 candidates, ranked by expected saving. Each candidate gives: the evidence, the class, the fix at the highest level that works (the ladder in [`retro`](../retro/SKILL.md) step 4), the expected saving, and the number next week's dream reads to check it.
   - Last week's actions, each kept or reverted, with the number.
   - A **Memory** section per machine: each note added, edited, merged or forgotten, by id, with its evidence (the digest line or session it rests on) and the number next week's dream reads, such as how often the owner repeated that correction; and the `stats` totals before and after.
   - A **Cache** section per machine, measured: the hit rate, the write-token share, the write cost share, the wasted writes and the break count, each beside last week's with the trend; the top causes with their wasted writes; each rule's status; and each fix applied (its commit) or queued, with the number next week's audit reads.

9. **Present the candidates to the owner.** Skill, `AGENTS.md` and principle edits land once the owner picks them. Then follow [`writing-for-agents`](../writing-for-agents/SKILL.md), commit each edit as its own Conventional Commit, and push. Add a `Applied:` line to the dream file that names each commit.

## Reference

- **Compute or process.** Limit errors and compactions say the week was compute-bound. Rework rounds, owner waits and a serialized shared slot say the process was the bound. Report both. Do not treat more compute as the fix for a process bound.
- **Ceremony scales with risk.** A verify step that never bounces for a class of unit is a candidate for a lighter path for that class, never for removal. Before calling it ceremony, check for escapes: defects found later (a later round, CI, the owner, production) in units that step passed, over a comparable number of units. A week with no finds means sound work or a blind check; the escape count tells which.
- **Measured, not assumed.** Report usage inside the window only, and the effort each agent actually ran at. An outcome that cannot be joined to its unit is reported as missing, with the join rate, not left out.
- **Converging tails.** When rounds 3 and later bounce only on test strength, the round cap or the class-seen-twice rule is the candidate, not the implementor.
