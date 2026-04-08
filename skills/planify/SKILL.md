---
name: planify
description: >
  Dual-model research → synthesis → commit-batched implementation plan with gated execution and
  multi-model verification. Use when tackling complex features, migrations, or architectural changes
  that need grounded research, principled planning, and verified execution. Triggers on "planify",
  "plan and execute", "research and implement", "dual research", or when a task is too complex for
  a single-pass plan.
---

# Planify

Principled, dual-model research-driven planning and gated execution. Every claim grounded in
brain vault principles and file paths. Every commit justified, reviewed, and verified.

## Navigation

```
Where are you?
├─ Starting a new planify run         → Phase 1: Dual-Model Research
├─ Research complete, need synthesis   → Phase 2: First Synthesis
├─ Synthesis done, need review         → Phase 3: Codex Review
├─ Review done, need final plan        → Phase 4: Final Synthesis
├─ Plan ready, executing commits       → Phase 5: Gated Execution
├─ All commits done, need verify       → Phase 6: Deep Verification
└─ Resuming a planify run              → Check tasks, pick up where left off
```

## Prerequisites

Before every planify run:

1. Read `$(okra brain vault)/principles.md` fresh. Follow every `[[wikilink]]`. **Never skip. Never use memorized content.**
2. Check `~/.claude/skills/` for domain-relevant skills. Invoke them.
3. Create a task list (TaskCreate) tracking each phase.

---

## Phase 1: Dual-Model Research

**Goal**: Two independent research streams producing grounded findings.

Launch both in background simultaneously:

### Stream A — Codex Deep Research

```
okra counsel --deep "
Research: [TOPIC]

Context: [project context, affected areas, constraints]

Brain vault principles are at: $(okra brain vault)/principles/
Read principles.md and follow all wikilinks before starting.

Ground ALL claims in:
1. Brain vault principles — cite principle name + relevant excerpt
2. File paths — exact paths with line numbers where applicable
3. Existing patterns — show how the codebase currently handles similar concerns

Deliverables:
- Findings with principle citations
- Risks and trade-offs
- Recommended approach with justification
- File paths that informed each conclusion

Do NOT speculate. If you can't ground a claim, say so.
"
```

### Stream B — Claude Research (parallel)

Use `Agent` tool with `subagent_type: Explore` (or multiple parallel Explore agents for independent areas):

- Explore the affected codebase areas
- Map architecture, dependencies, patterns, types, tests
- Cross-reference against brain vault principles (read them fresh)
- Identify relevant skills and their guidance
- Document every file path that informs a conclusion

**Both streams MUST**:
- Cite specific principle names for every architectural claim
- Include full file paths (with line numbers) for every code reference
- Flag areas where principles conflict or are ambiguous

---

## Phase 2: First Synthesis

**Goal**: Merge both research streams into a unified analysis.

1. Read Stream A output: `/tmp/counsel/<slug>/codex.md`
2. Read Stream B output: agent results from Phase 1
3. Produce a synthesis document:

```markdown
## Research Synthesis

### Agreed Findings
[Where both streams converge — strongest signal]

### Divergent Findings
[Where streams disagree — needs resolution]

### Principle Grounding
| Finding | Principle(s) | File Evidence |
|---------|-------------|---------------|
| ...     | ...         | ...           |

### Open Questions
[Unresolved items requiring user input]

### Recommended Approach
[Unified recommendation with principle justification]
```

4. Use `AskUserQuestion` to resolve open questions and divergent findings before proceeding.

---

## Phase 3: Codex Review

**Goal**: Adversarial review of the synthesis by Codex.

```
okra counsel --deep "
Review this research synthesis for a planify run.

Brain vault principles are at: $(okra brain vault)/principles/
Read principles.md and follow all wikilinks.

## Synthesis
[paste or reference the Phase 2 synthesis]

## Your Task
1. Challenge every finding — is the principle citation accurate? Is the file evidence current?
2. Identify gaps — what did the research miss?
3. Flag weak justifications — where is the grounding thin?
4. Propose corrections or additions
5. Ground YOUR review in principles and file paths too

Be adversarial. Poke holes. Don't rubber-stamp.
"
```

---

## Phase 4: Final Synthesis → Commit-Batched Plan

**Goal**: Incorporate Codex review feedback into a final, commit-batched implementation plan.

1. Read Codex review output
2. Resolve any new issues raised
3. Produce the final plan, batched by commit:

### Plan Format

```markdown
# Planify: [Title]

## Context
[Why this plan exists, what problem it solves]

## Scope
- **In**: [what's included]
- **Out**: [what's excluded]

## Constraints
[Tech, time, compatibility limits]

## Applicable Skills
[Which skills to invoke during execution]

## Gate Command
[Project-specific gate — discover from package.json scripts, Makefile, etc.
 Examples: `bun run typecheck && bun run lint && bun run test`
           `make check`
           `pnpm gate`]

---

## Commit 1: [conventional commit message]

**Justification**: [Why this change, grounded in principles]

**Principles**:
- [principle-name]: [how it applies]

**Skills**: [skills to invoke for this commit]

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| path/to/file.ts | [what changes] | ~N-M |

**Verification**: [what the gate should catch + any manual checks]

---

## Commit 2: [conventional commit message]
...

---

## Commit N: [conventional commit message]
...
```

### Plan Rules

- **Order**: infrastructure and shared types first, features after
- **Sizing**: each commit is independently shippable. 1 logical change per commit. Max 3-5 files
- **Justification**: every commit cites at least one brain vault principle
- **Skills**: list which skills apply to each commit's implementation
- **File paths**: exact paths for every file that will be touched, with approximate line ranges
- **Gate**: every commit must pass the project gate before proceeding to the next

4. Present plan to user. **Wait for approval before execution.**

---

## Phase 5: Gated Execution

**Goal**: Execute each commit with gate checks and Codex review.

For each commit in the plan:

### 5a. Implement

Execute the changes described in the commit. Invoke listed skills. Follow brain vault principles.

### 5b. Gate

Run the project-specific gate command. **All checks must pass before proceeding.**

If gate fails: fix the issue, re-run gate. Do not skip.

### 5c. Commit

Create the commit with the conventional commit message from the plan.

### 5d. Codex Review (per-commit)

```
okra counsel "
Review this commit against the planify plan.

Plan:
[inline the relevant commit section from the plan]

Diff:
[git diff of the commit]

Check:
1. Does the commit match what the plan specified?
2. Are there drift or scope creep issues?
3. Do the changes align with cited principles?
4. Any issues the gate wouldn't catch?

Be concise. Flag issues only.
"
```

Note: standard counsel (not --deep) for per-commit reviews — speed over depth.

If Codex flags issues: fix them, re-gate, amend or create a fixup commit, re-review.

### 5e. Proceed to next commit

Repeat 5a-5d for each commit in the plan.

---

## Phase 6: Deep Verification

**Goal**: Two independent deep reviews of ALL commits against the plan.

Launch both in background simultaneously:

### Reviewer A — Independent Opus Ultrathink

Use `Agent` tool with `model: opus`:

```
You are performing a deep verification of a planify execution.

## Plan
[full plan content]

## Commits
[git log --oneline for all planify commits]

## Full Diff
[git diff main...HEAD]

## Brain Vault Principles
Read $(okra brain vault)/principles.md and follow all wikilinks.

## Your Task
Review EVERY commit against the plan:
1. Scope compliance — did each commit do what it said, nothing more, nothing less?
2. Principle compliance — are cited principles actually followed in the code?
3. Architectural integrity — does the whole hang together?
4. Test coverage — is new behavior tested?
5. Missed issues — anything the per-commit reviews missed?

Think deeply. Take your time. This is the last gate before shipping.
Ground every finding in file paths and principle names.
```

### Reviewer B — Codex Deep

```
okra counsel --deep "
Deep verification of a planify execution.

Brain vault principles are at: $(okra brain vault)/principles/
Read principles.md and follow all wikilinks.

## Plan
[full plan content]

## Commits
[git log --oneline for all planify commits]

## Full Diff
[git diff main...HEAD]

Review ALL commits against the plan:
1. Scope compliance — each commit matches plan specification
2. Principle compliance — cited principles followed in code
3. Architectural integrity — whole system coherence
4. Test coverage — new behavior tested
5. Missed issues — anything per-commit reviews missed

Ground every finding in file paths and principle names. Be thorough and adversarial.
"
```

### Synthesis

1. Read both verification outputs
2. Categorize findings: **blocking** vs. **advisory**
3. Blocking issues: fix, re-gate, create fixup commits
4. Advisory issues: present to user for decision
5. If clean: report final status

---

## Output

After Phase 6 completes:

```markdown
## Planify Complete

**Topic**: [what was planned and executed]
**Commits**: [count] commits, all gated
**Principles Applied**: [list of principle names cited]
**Skills Used**: [list of skills invoked]
**Verification**: [clean | N issues resolved | N advisory items noted]

### Commit Log
[git log --oneline for all planify commits]

### Unresolved Advisory Items
[if any — items both verifiers flagged but aren't blocking]
```

---

## Resuming a Planify Run

If interrupted:

1. Check `TaskList` for current phase progress
2. Read the plan file if Phase 4+ was reached
3. Check `git log` for completed commits
4. Resume from the last incomplete phase/commit
5. Do NOT re-run completed phases unless the user asks

## Gotchas

- **Always read principles fresh** — never rely on memorized content
- **Gate failures block progress** — no exceptions, no skipping
- **Codex counsel is one-shot** — craft prompts with full context, no back-and-forth
- **File paths decay** — verify paths still exist before citing in later phases
- **Plan is the contract** — if execution drifts from plan, stop and reconcile
- **Don't parallelize commits** — sequential execution, each gated before the next
- **Keep plan scope tight** — if research reveals the task is huge, split into multiple planify runs
- **Per-commit review uses standard counsel** — save `--deep` for Phase 1, 3, and 6
- **Phase 6 reviewers are independent** — don't share one reviewer's findings with the other
