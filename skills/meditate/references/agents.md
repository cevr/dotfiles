# Meditate Subagent Specs

Both spawned as `Task` with `subagent_type: "general-purpose"`, `model: "sonnet"`. Read-only — return reports, make no edits.

## Auditor

**Prompt**:

```
Read /tmp/brain-snapshot.md and parse it to build a wikilink map — no individual brain file reads needed. Use the file headers (=== path ===) as the on-disk file list for orphan detection.

Cross-reference each note against the current codebase state (check if referenced files, patterns, tools, or decisions still exist) — the only part that requires Read/Grep/Glob calls.

Flag each note into categories:
- **Outdated** — contradicted by current codebase state (cite file/line that contradicts)
- **Redundant** — duplicates another note (cite both)
- **Low-value** — not high-signal, or neither high-frequency nor high-impact
- **Verbose** — could be half the length without losing meaning
- **Orphaned** — not linked from any index

Also check:
- CLAUDE.md for stale instructions
- ~/.claude/projects/*/memory/MEMORY.md for outdated entries

Output format:

## Audit Results — Brain
| Note | Category | Evidence |
|------|----------|----------|

## Audit Results — CLAUDE.md
- [finding]

## Audit Results — Memory
- [finding]

## Summary
Total notes: N
Actionable: N (Outdated: N, Redundant: N, Low-value: N, Verbose: N, Orphaned: N)
```

## Reviewer

**Prompt**:

```
Inputs:
- Brain snapshot: /tmp/brain-snapshot.md
- Skills snapshot: /tmp/skills-snapshot.md
- Auditor report: [inline from step 2]
- Principles index: $(brain vault)/principles.md

## 1. Synthesis
- Missing wikilinks between related notes
- Tensions or contradictions between notes
- Notes that should be reworded for clarity

Do NOT propose merging principles — they are intentionally independent. Propose rewording if two principles seem to overlap.

## 2. Distillation
Identify unstated principles evidenced by 2+ existing notes.
Focus on project-specific notes (e.g. `bite/`, `cli/`) — they often contain implicit principles.

Each proposed principle must be:
- **Independent** — not a restatement of an existing principle
- **Evidenced** — cite the specific existing notes that demonstrate it
- **Actionable** — tells you what to do differently
- **Non-obvious** — Claude wouldn't do this by default

For each: one sentence insight, evidence citations, independence check, suggested file path.

## 3. Skill Review
For each skill in the snapshot:
- Contradictions with brain principles
- Structural enforcement gaps (things enforced by instruction that could be lint/hook/script)
- Description frontmatter bloat (>2 lines in description that belong in body)
- Outdated references to paths, tools, or APIs
- Missing cross-references to related skills
```

## Report Template

```markdown
# Meditate Report

## Audit Results — Brain

[table from auditor]

## Audit Results — CLAUDE.md

[findings from auditor]

## Audit Results — Memory

[findings from auditor]

## Synthesis Results

[from reviewer section 1]

## Distiller Results

[from reviewer section 2]

## Skill Review Results

[from reviewer section 3]
```
