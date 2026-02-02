---
name: code-review
description: >
  Systematic code audit and cleanup after implementation rounds. Detects slop,
  dead code, structural issues — then fixes them. Use for "review", "clean up",
  "deslop", or "look over" requests.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

# Code Review

Systematic audit and cleanup. Not a style guide -- use code-style skill for that.
This is the fresh eyes pass that catches what slipped through.

## Scope Detection

In priority order:

1. **User-specified** -- files/directories/areas passed explicitly
2. **Branch diff** -- git diff --name-only main...HEAD
3. **Staged** -- git diff --cached --name-only
4. **Working** -- git diff --name-only
5. **Broad** -- if "review the codebase", ask to narrow first

Read every changed file in full. Skim is not review.

## Pre-Review: Load Context

Before auditing, load domain knowledge via primers.

**Always run:**

- primer code-style (style principles are the review criteria)
- primer architecture (structural patterns, boundaries, error strategy)

**Based on what's in scope:**

| Detected | Run |
|----------|-----|
| Effect imports (effect, @effect/*) | primer effect + relevant subtopics |
| .tsx / React files | primer react (when primer exists) |
| bun.lock present | primer bun |

## Phase 1: Slop Detection

AI-generated cruft that humans wouldn't write.

| Signal | Look for |
|--------|----------|
| Narration comments | // Now we need to..., // This function handles... |
| Redundant comments | Comments restating what the code already says |
| Commented-out code | Dead code from iterations. Delete it; git remembers |
| TODO/FIXME remnants | Placeholders that should've been resolved |
| Over-defensive code | Null checks on non-nullable, try/catch on infallible ops |
| Type shortcuts | any, as unknown as X, non-null assertions, @ts-ignore |
| Console.log debris | Debug logging left in |
| Inconsistent patterns | New code diverging from surrounding conventions |
| Redundant reimplementation | Rebuilding something the codebase already has a util for |
| Import disorder | Mixed styles, barrel imports where direct exist nearby |

## Phase 2: Structural Review

Zoom out from lines to modules. Use primer architecture patterns as reference.

| Concern | Question |
|---------|----------|
| Abstractions | Right level? Too many layers? Would a future reader understand why? |
| Duplication | Same logic in 2+ places? |
| Error handling | Typed and handled? Or swallowed / generic catch? (see primer architecture errors) |
| Boundaries | Internal details leaking through exports? (see primer architecture boundaries) |
| API misuse | Using a library wrong? Invoke repo-explorer to check upstream source/examples |
| Naming | Names match current behavior (not 3 iterations ago)? |
| Dead exports | Public API nothing uses? |
| Test gaps | New behavior without coverage? Flag it -- test skill writes them |

### Verify Against Source

When a pattern looks off or you're unsure about library usage, use repo-explorer to fetch
the upstream repo and compare against real implementations/examples.

Use: repo fetch owner/repo (or npm:package@version), then repo path -q owner/repo to grep/read the source.

## Phase 3: Build Review Plan

Don't fix yet. Produce a plan with findings, evidence, and proposed changes.

### Finding Format

Every finding must cite evidence:

    ### [Category]: [Brief description]

    **Files**: src/services/auth.ts:45, src/routes/login.tsx:12
    **Evidence**: [What you observed -- quote the code or pattern]
    **Source reference**: [If comparing against upstream: path to cached source]
    **Proposed fix**: [What to change]
    **Risk**: none | low | needs-discussion

### Categories

Group findings by phase:
1. **Slop** -- AI artifacts (from Phase 1 checklist)
2. **Structural** -- architecture/boundary issues (from Phase 2)
3. **Ambiguous** -- things that could go either way

### Ask Before Acting

For any finding where:
- Intent is unclear (was this deliberate?)
- Multiple valid fixes exist
- Removing could change behavior
- Structural rework is needed

Use AskUserQuestion to clarify. Don't guess. Don't silently skip.

**Leave no ambiguity.** If the plan has open questions, ask them all before proceeding.

## Phase 4: Execute

After plan approval:

**Order**: delete -> simplify -> unify -> rename

1. **Delete** -- dead code, comments, unused imports, console.logs
2. **Simplify** -- collapse over-defensive checks, remove unnecessary wrappers
3. **Unify** -- align patterns with surrounding code
4. **Rename** -- fix names that drifted from their purpose

**Rules**:
- No feature regression. Read what you're deleting before deleting.
- No drive-by refactors. Fix what the review surfaced, not what you wish code looked like.
- Unsure if dead? Grep for usages before removing.

## Phase 5: Verify

Run full gate:

1. **Typecheck** -- tsc --noEmit or project-specific
2. **Lint** -- project lint command with auto-fix
3. **Test** -- full suite, confirm no regressions

All must pass. Fix failures from cleanup -- don't revert.

## Output

    ## Review Summary

    **Scope**: [files reviewed, how scope was determined]
    **Findings**: [count by category]
    **Fixed**: [what was changed]
    **Flagged**: [deferred items, if any]
    **References**: [file paths that informed conclusions]
