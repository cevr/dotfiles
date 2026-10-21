---
name: why
description: "Find the motivation behind code: why X works this way, why we picked Y, a design rationale, a regression's origin, a postmortem, a threshold's source. Searches git and PRs, the issue tracker, agent sessions, repo docs and error tracking, then returns a cited read with confidence kept apart from inference. Use how for runtime behavior."
disable-model-invocation: true
---

# Why

Find what forces gave code its shape. The companion `how` skill answers what the code does; `why` answers the decisions and tradeoffs behind it. Adapted from pstack (`cursor/plugins`, `pstack/skills/why`).

Work as a careful investigator: keep what you know apart from what you infer. [`references/epistemics.md`](references/epistemics.md) is the confidence framework and phrasing guide, and the synthesis follows it.

## 1. Name the target and the question

The **target** is code, a pattern, a feature or a named decision. The **question** is a rationale, a tradeoff, a motivating edge case, an external constraint, dead code or a history sweep. When the target is vague, take the best reading from the conversation (open files, recent edits, what was just discussed), state it in one line, and go on.

## 2. Build the code anchor

Before any search, collect the seed every investigation gets: file paths and line ranges, key symbols, the last commits on the target and their PR numbers, and linked ticket ids.

- `git blame -L <start>,<end> <file>` for last-touch commits; `git log --follow -p -- <file>` for history through renames; `git log --oneline -20 -- <file>`; `git log -1 --format=%B <commit>` for PR numbers.
- `gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews` for every substantive commit.

## 3. Investigate each evidence category

Cover every category in [`references/source-playbook.md`](references/source-playbook.md) that exists for this repo: source control (always), the issue tracker, agent sessions, long-form repo docs, error tracking. Add [`references/sources/incident-postmortem.md`](references/sources/incident-postmortem.md) when the target looks defensive (null checks, retries, timeouts, rate limits, flags, OOM handlers). Document a null result; a search you skipped is a gap, not a result.

Each investigation gets [`references/investigator-prompt.md`](references/investigator-prompt.md) filled in, its category's playbook, the code anchor and the question.

- **Small target** (a few commits, one PR that names its reason): run the investigations yourself, in order, one category at a time.
- **Large target** (a subsystem, a long history): hand each category to an `orchestrate-worker` agent. Run `bun ~/.claude/skills/orchestrate/scripts/budget.ts` first and start only as many agents as the pool has room for; the rest wait for the first to return. An investigator reads and searches; it writes nothing.

Skip a category only with a written reason that goes into Sources Consulted: no such source for this repo, or provably irrelevant (an error tracker for a build-time script).

## 4. Synthesize

Fill [`references/synthesizer-prompt.md`](references/synthesizer-prompt.md) with the findings (null results and skips included), the code anchor, the question and the epistemics framework. Run it yourself for a small target; for a large one, give it to one fresh `orchestrate-worker`, so the synthesis reads the findings and not your search context. The synthesis spot-checks its citations against the code and the sources.

## 5. Present

Present the synthesis. Light edits for clarity are fine; keep its confidence language.

The sections are the synthesizer template's: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted (one line per category, the skipped ones with their reason), Confidence Summary.

When the question comes before a change to this code, end with a Preserve / Change / Avoid / Risk set for planning it. When a decision was found only in an agent session, say so: it belongs in `NORTH_STAR.md`, `PRIOR_ART.md` Settled or an ADR, and the change that follows should record it there.

## Failure modes

- **Recency bias.** The latest commit is one layer; trace the shape back through the earlier decisions.
- **Hearsay as fact.** An agent's report of what the owner decided is a lead; the owner's own words in a session are the evidence.
- **Absence as proof.** No ticket found means none found, not that no reason existed.
