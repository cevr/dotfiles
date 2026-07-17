---
name: documenter
description: Distill session learnings into AGENTS.md and CODEMAP.md files. Use after completing complex tasks, debugging sessions, or discovering non-obvious patterns that future agents should know.
allowed-tools: Read, Write, Edit, Glob, Grep, Task
---

# Documenter

Capture session insights into directory-level AGENTS.md and CODEMAP.md files for future context.

## AGENTS.md vs CLAUDE.md

`AGENTS.md` is the open standard supported by many AI coding tools. Claude Code uses `CLAUDE.md` instead. **Write AGENTS.md, symlink to CLAUDE.md** for cross-tool compatibility:

```bash
# In each directory with an AGENTS.md
ln -s AGENTS.md CLAUDE.md
```

This keeps one source of truth while supporting all tools.

## Philosophy

Claude selectively loads AGENTS.md files based on working directory. Documentation must be:

- **Brief** - Sacrifice grammar for density. No fluff.
- **Non-obvious** - Skip anything apparent from code. Focus on gotchas, decisions, patterns.
- **Actionable** - What would have saved time this session?

Bad: "This module handles authentication"
Good: "Auth tokens expire after 15min even if `rememberMe` set. Refresh in AuthMiddleware."

### The Instruction Budget

LLMs can follow ~150-200 instructions with reasonable consistency. Every token in AGENTS.md loads on **every request**, regardless of relevance. This creates a hard budget:

| Scenario | Impact |
|----------|--------|
| Small, focused | More tokens for task-specific work |
| Large, bloated | Agent confusion, worse performance |
| Irrelevant rules | Token waste + distraction |

**The ideal AGENTS.md should be as small as possible.**

### Progressive Disclosure

Instead of cramming everything into root AGENTS.md, give agent only what it needs now; point to other resources when needed.

```markdown
# Root AGENTS.md - minimal
For TypeScript conventions, see docs/TYPESCRIPT.md
For testing patterns, see docs/TESTING.md
```

Benefits:
- Rules load only when relevant (agent reads linked file)
- Other tasks don't waste tokens
- Portable across model changes

Agents navigate documentation hierarchies efficiently. Create discoverable resource trees:

```text
docs/
├── TYPESCRIPT.md    → references TESTING.md
├── TESTING.md       → references test runners
└── BUILD.md         → references esbuild config
```

## When to Document

Invoke after:

- Debugging sessions that revealed non-obvious behavior
- Discovering undocumented patterns or conventions
- Finding gotchas that will trip up future work
- Implementing complex features with design decisions
- Learning architectural boundaries or data flow

Do NOT document:

- Obvious code structure (that's what code is for)
- Standard patterns already in root AGENTS.md
- Temporary fixes or TODOs

### Anti-Patterns

**Ball of mud growth:**
1. Agent does something wrong → add rule to prevent it
2. Repeat hundreds of times → unmaintainable mess
3. Different devs add conflicting opinions → no style pass

**Auto-generated files:** Never use init scripts to generate AGENTS.md. They flood with "useful for most scenarios" content that should be progressively disclosed.

**Overly obvious rules:** Skip "write clean code", "use const over let" - agent knows. Focus on project-specific gotchas.

## File Types

### AGENTS.md - Guidelines & Gotchas

Directory-level instructions. Claude loads these when reading files in that subtree.

**Format:**

```markdown
# [Directory] Guidelines

## [Category]

- Terse insight one
- Terse insight two
- Pattern: `code example if needed`

## [Another Category]

- More insights
```

### CODEMAP.md - Navigation Aid

Structural overview for quick orientation. NOT exhaustive - focus on non-obvious structure.

**Format:**

```markdown
# [Directory] Codemap

## Architecture

Brief description of how this area works.

## Key Files

| File         | Purpose                                   |
| ------------ | ----------------------------------------- |
| important.ts | What it does that isn't obvious from name |

## Patterns

- Pattern descriptions
```

## Workflow

### 1. Identify What to Document

Ask: "What did I learn that would've helped at session start?"

Categories:

- Gotchas / unexpected behavior
- Implicit conventions not in code
- Why decisions were made (not what)
- Dependencies between modules
- Performance constraints
- Testing quirks

### 2. Find Appropriate Location

```bash
# Find existing docs
Glob pattern="**/AGENTS.md"
Glob pattern="**/CODEMAP.md"
```

Place docs at the directory level where they're most relevant:

- Package-wide patterns → `packages/{pkg}/AGENTS.md`
- Feature-specific → `packages/{pkg}/app/features/{feature}/AGENTS.md`
- Route-specific → `packages/{pkg}/app/routes/{route}/AGENTS.md`

### 3. Create or Update

**Creating new:**

```markdown
# [Directory] Guidelines

## [Category derived from insights]

- First insight
```

**Updating existing:**

- Add to appropriate section
- Remove outdated info
- Keep it terse

### 4. Update Root Index

After creating new AGENTS.md or CODEMAP.md, update root to maintain discoverability:

```markdown
## Documentation Map

| Path                          | Type       | Focus                      |
| ----------------------------- | ---------- | -------------------------- |
| packages/bureau/app/AGENTS.md | Guidelines | Remix patterns, gates, CSS |
```

## Writing Style

**DO:**

- Use sentence fragments
- Skip articles (a, an, the)
- Use `code` for identifiers
- Link related files: `See foo.ts:123`
- Use tables for structured info

**DON'T:**

- Write full sentences when fragments work
- Explain obvious things
- Add filler words
- Document standard patterns

**Examples:**

| Bad                                                             | Good                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| "The authentication middleware checks if the user is logged in" | "`AuthMiddleware` redirects to /login if no session"                        |
| "You should use the Button component for buttons"               | "Use `Button.Base` for custom styles, `Pressable` for non-button semantics" |
| "This file contains utility functions"                          | Skip - obvious from filename                                                |

## Quality Checklist

Before committing documentation:

- [ ] Would this have saved time this session?
- [ ] Is every line non-obvious?
- [ ] Is it at the right directory level?
- [ ] Is it as terse as possible?
- [ ] Is root index updated?

## Templates

### Minimal AGENTS.md

```markdown
# [Dir] Guidelines

## Gotchas

- Gotcha one
- Gotcha two

## Patterns

- Pattern: `example`
```

### Minimal CODEMAP.md

```markdown
# [Dir] Codemap

## Overview

One sentence on architecture.

## Key Files

| File    | Purpose                             |
| ------- | ----------------------------------- |
| main.ts | Entry point, initializes X before Y |
```

## Monorepo Strategy

AGENTS.md files in subdirectories **merge with root level**. Use this for scope-appropriate docs.

| Level | Content |
|-------|---------|
| **Root** | One-sentence purpose, package manager, shared tools, how to navigate |
| **Package** | Package purpose, tech stack, package-specific conventions |

```markdown
# Root AGENTS.md
Monorepo: web services + CLI tools. pnpm workspaces.
See each package's AGENTS.md for specifics.

# packages/api/AGENTS.md
Node.js GraphQL API using Prisma.
API patterns: docs/API_CONVENTIONS.md
```

**Don't overload any level.** Agent sees all merged files.

## Root AGENTS.md Essentials

Be ruthless. The absolute minimum:

- **One-sentence project description** (anchors every decision)
- **Package manager** (if not npm)
- **Build/typecheck commands** (if non-standard)

Everything else → progressive disclosure via linked files or nested AGENTS.md.

## Integration with Root AGENTS.md

Root AGENTS.md should contain:

1. Project-wide commands and scripts
2. Universal code style
3. Documentation map pointing to all AGENTS.md/CODEMAP.md files

Package/feature AGENTS.md should contain:

1. Local gotchas and patterns
2. Architecture decisions specific to that area
3. Non-obvious dependencies
