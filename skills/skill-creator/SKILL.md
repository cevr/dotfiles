---
name: skill-creator
description: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations.
license: Complete terms in LICENSE.txt
---

# Skill Creator

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained folders that extend Claude's capabilities by providing
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific
domains or tasks—they transform Claude from a general-purpose agent into a specialized agent
equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### AI Agents Scan, Not Read

Structure skills for quick navigation, not prose comprehension. Every section should be findable by scanning headings and tables — not by reading paragraphs.

- **Decision trees** at the top help agents pick the right path fast
- **Topic index tables** with "When to Read" columns enable self-selection
- **Consistent structure** across files reduces cognitive load
- **Most-used info first** within each file — 80/20 rule
- **Gotchas prominently surfaced** — not buried in prose

### Concise is Key

The context window is a public good. Skills share space with system prompt, conversation history, other skills' metadata, and the actual user request.

**Default assumption: Claude is already very smart.** Only add context Claude doesn't already have. Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match specificity to the task's fragility and variability:

- **High freedom (text-based instructions)**: Multiple approaches valid, decisions depend on context
- **Medium freedom (pseudocode/scripts with parameters)**: Preferred pattern exists, some variation acceptable
- **Low freedom (specific scripts, few parameters)**: Operations fragile, consistency critical

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown body (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts)
```

#### SKILL.md (required)

- **Frontmatter** (YAML): `name` and `description` fields (required), plus optional `license`, `metadata`, `allowed-tools`. Only `name` and `description` determine when the skill triggers — be clear and comprehensive about what the skill is and when it should be used.
- **Body** (Markdown): Instructions and guidance. Only loaded AFTER the skill triggers.

#### Bundled Resources (optional)

| Type | When to Include | Example |
|------|----------------|---------|
| `scripts/` | Same code rewritten repeatedly; deterministic reliability needed | `scripts/rotate_pdf.py` |
| `references/` | Documentation Claude should reference while working; detailed info that would bloat SKILL.md | `references/schema.md`, `references/api_docs.md` |
| `assets/` | Files used in final output, not loaded into context | `assets/logo.png`, `assets/template.pptx` |

**References best practices:**
- Keeps SKILL.md lean, loaded only when needed
- If files are large (>10k words), include grep search patterns in SKILL.md
- Information should live in either SKILL.md or references, not both
- For files >100 lines, include a table of contents at the top

#### What to NOT Include

- README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, etc.
- User-facing documentation or setup procedures
- Auxiliary context about the creation process

### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata (name + description)** — Always in context (~100 words)
2. **SKILL.md body** — When skill triggers (<5k words ideal, <500 lines)
3. **Bundled resources** — As needed (scripts can execute without loading into context)

When approaching 500 lines, split content into reference files. Always reference them from SKILL.md with clear "when to read" guidance.

**Splitting patterns:**

```
Pattern 1: High-level guide + references
├── SKILL.md        → Quick start + navigation
├── references/
│   ├── forms.md    → Form filling guide
│   └── api.md      → Full API reference

Pattern 2: Domain-specific organization
├── SKILL.md        → Overview + navigation
├── references/
│   ├── finance.md  → Revenue, billing metrics
│   ├── sales.md    → Pipeline, opportunities
│   └── product.md  → API usage, features

Pattern 3: Variant-based organization
├── SKILL.md        → Workflow + selection guidance
├── references/
│   ├── aws.md      → AWS deployment patterns
│   ├── gcp.md      → GCP deployment patterns
│   └── azure.md    → Azure deployment patterns
```

---

## Skill Creation Process

```
Where are you in the process?
├─ Starting from scratch         → Step 1: Understand
├─ Know what skill should do     → Step 2: Plan
├─ Ready to scaffold             → Step 3: Initialize
├─ Editing skill content         → Step 4: Edit
├─ Done writing                  → Step 5: Validate
└─ Improving existing skill      → Step 6: Iterate
```

### Step 1: Understand the Skill with Concrete Examples

Skip when usage patterns are already clearly understood.

Ask focused questions to build concrete examples:
- "What functionality should the skill support?"
- "Can you give examples of how this skill would be used?"
- "What would a user say that should trigger this skill?"

Avoid overwhelming with questions — start with the most important, follow up as needed.

### Step 2: Plan Reusable Skill Contents

Analyze each concrete example:

1. How would you execute this from scratch?
2. What scripts, references, and assets would help when doing this repeatedly?

| Example Query | Analysis | Resource |
|---------------|----------|----------|
| "Rotate this PDF" | Same code rewritten each time | `scripts/rotate_pdf.py` |
| "Build me a todo app" | Same boilerplate each time | `assets/hello-world/` |
| "How many users logged in today?" | Re-discovering schemas each time | `references/schema.md` |

### Step 3: Initialize the Skill

Skip if the skill already exists.

```bash
scripts/init_skill.py <skill-name> --path <output-directory>
```

The script creates the skill directory with a SKILL.md template and TODO placeholders. Optionally creates resource directories with `--resources scripts,references,assets` and example files with `--examples`.

After initialization, customize the SKILL.md and add resources as needed. Delete unused example files.

### Step 4: Edit the Skill

The skill is being created for another Claude instance to use. Include information that would be beneficial and non-obvious. Consider what procedural knowledge, domain-specific details, or reusable assets would help.

#### Start with Reusable Skill Contents

Implement the resources identified in Step 2. Test scripts by running them. Delete unused example files and directories.

#### Structure for Agent Consumption

**AI agents scan headings and tables, not prose.** Apply these patterns to SKILL.md:

**Navigation tree at the top** — help the agent find what it needs immediately:

```markdown
## Navigation

\`\`\`
What are you working on?
├─ Creating a new X      → §1 Setup
├─ Modifying existing X  → §2 Editing
├─ Debugging X           → §3 Troubleshooting
└─ Understanding X API   → §4 Reference
\`\`\`
```

**Topic index table** when referencing multiple files — include "When to Read":

```markdown
| Topic | File | When to Read |
|-------|------|--------------|
| Schema | `references/schema.md` | Writing queries |
| API | `references/api.md` | Calling endpoints |
| Gotchas | `references/gotchas.md` | Debugging issues |
```

**Consistent section structure** — every major section should follow a predictable pattern:

```markdown
## Section Title

[What this covers — one line]

### When to Use
- ...

### Patterns / Examples
- ...

### Gotchas
- ...
```

**BAD/GOOD code examples** over prose explanations:

```markdown
// BAD: verbose explanation of what not to do
// GOOD: concise example showing the right pattern
```

**Quick reference tables** for lookups — agent shouldn't read paragraphs for simple answers:

```markdown
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| format | string | "json" | Output format |
```

**Cross-references** instead of inlining — link to deeper content:

```markdown
Define errors with `TaggedError`. See `references/errors.md` for patterns.
```

#### Structuring Anti-Patterns (avoid these)

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| Wall of text | Agent must read everything | Sections, headings, tables |
| No navigation | Agent guesses where to look | Decision tree + topic index |
| No "when to use" | Agent opens wrong section | Add applicability context |
| Inconsistent structure | Unpredictable layout | Standardize sections |
| Too much in SKILL.md | Context bloat | Split into references/ |
| Buried gotchas | Pitfalls missed | Prominent warnings, dedicated section |
| Generic file names | `advanced.md`, `misc.md` | Descriptive domain names: `errors.md`, `testing.md` |
| Missing cross-references | Related topics not linked | "See Also" sections |
| No quick reference | Must read paragraphs for lookups | Table at top of section |
| Prose over examples | More words, less signal | BAD/GOOD code pairs |

#### Update SKILL.md

##### Frontmatter

```yaml
---
name: skill-name
description: What the skill does and when to use it. Include specific triggers.
---
```

- `name`: Hyphen-case skill name
- `description`: Primary triggering mechanism. Include both what the skill does AND specific triggers/contexts. All "when to use" info goes here — body is only loaded after triggering.
- Example: `"Comprehensive document creation with tracked changes. Use when working with .docx files for: (1) Creating documents, (2) Editing content, (3) Tracked changes, (4) Adding comments"`

Do not include extra fields in frontmatter.

##### Body

Write instructions using the structural patterns above. Prioritize most-used information first.

### Step 5: Validate the Skill

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

Checks YAML frontmatter format, required fields, and naming rules.

#### Pre-Ship Checklist

- [ ] SKILL.md has navigation tree or clear entry path
- [ ] Description includes all trigger contexts
- [ ] Each section has consistent structure
- [ ] BAD/GOOD examples over prose where applicable
- [ ] Gotchas prominently surfaced (not buried)
- [ ] References files linked with "when to read" context
- [ ] Quick reference tables for lookups
- [ ] No unused example files from init
- [ ] Under 500 lines (split to references/ if over)

### Step 6: Iterate

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Identify how SKILL.md or resources should change
4. Implement changes and test again
