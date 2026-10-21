---
name: how
description: "Explain how code works: how does X work, a walkthrough before changing something, and placement, ownership or layering (where should this live, which package owns this, is this the right layer). Gives a subsystem's architecture, runtime flow and an onboarding mental model. Use why for motivation."
disable-model-invocation: true
---

# How

Answer "how does X work?" at the level of a senior engineer onboarding onto a subsystem: enough for a working mental model, short of annotated source. Adapted from pstack (`cursor/plugins`, `pstack/skills/how`).

## 1. Assess the scope

When the scope is ambiguous, state your reading in one line and go on.

- **Simple** (one module, one utility, one function): explore and explain in one pass yourself, from [`references/explainer-prompt.md`](references/explainer-prompt.md) without its explorer-findings section. Go to step 4.
- **Complex** (a subsystem across files or services, a cross-cutting feature, a full overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Split the question into 2 to 4 angles, each a distinct slice of the subsystem. Give each angle to an `Explore` agent with [`references/explorer-prompt.md`](references/explorer-prompt.md) filled in. Run `bun ~/.claude/skills/orchestrate/scripts/budget.ts` first: start the angles together only when the pool has room for all of them, else one at a time.

## 3. Explain (complex only)

When every explorer has returned, fill [`references/explainer-prompt.md`](references/explainer-prompt.md) with all their findings and write the explanation from it.

## 4. Present

The explanation uses the template's sections, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas. Cite `file:line` for every claim about behavior.
