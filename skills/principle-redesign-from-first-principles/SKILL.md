---
name: principle-redesign-from-first-principles
description: "Apply when integrating a new requirement or change into an existing design: redesign as if it had been known from day one instead of bolting it on."
disable-model-invocation: true
---

# Redesign From First Principles

When integrating a change, don't bolt it onto the existing design. Redesign as if the change had been a foundational assumption from the start. The result should be the most elegant solution that would have emerged if we'd known about this requirement on day one.

- Read all affected files and understand the current design holistically
- Ask: "if we were writing this from scratch with this new requirement, what would we build?"
- Propagate the change through every reference — types, docs, examples, rationale sections
- The redesign should be thought of holistically but delivered incrementally

This is the method for preserving option value when integrating changes into an existing design.
