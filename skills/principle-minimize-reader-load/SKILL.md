---
name: principle-minimize-reader-load
description: "Apply when reviewing or shaping code that is hard to trace: count the layers between question and answer and the hidden state a reader must hold, then collapse forwarding layers and shrink mutable scope."
disable-model-invocation: true
---

# Minimize Reader Load

Reader load is the work a reader must do to understand code. It has two independent axes: layers to trace between the question and the answer, and hidden or mutable state to hold in their head. Guard both.

- Collapse layers that only forward: wrappers with one caller, adapters with no second implementation, pass-through methods. Inline them.
- Shrink state scope: returns over mutations, locals over fields, fields over module state, module state over globals. Derive instead of sync.
- Name an invariant once at the boundary, not in every consumer.

The test: can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or cut state.

**See also:** [small-interface-deep-implementation](../principle-small-interface-deep-implementation/SKILL.md) — the same cut seen from the module's caller. [derive-dont-sync](../principle-derive-dont-sync/SKILL.md) — the state axis. [guard-the-context-window](../principle-guard-the-context-window/SKILL.md) — working memory is finite for agents too.

Adapted from pstack (`cursor/plugins`, `pstack/skills/principle-minimize-reader-load`), MIT.
