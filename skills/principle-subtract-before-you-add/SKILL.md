---
name: principle-subtract-before-you-add
description: "Apply when evolving a system, refactoring, weighing diff size or tempted to add a layer: remove complexity first, then make the smallest change that solves the problem."
disable-model-invocation: true
---

# Subtract Before You Add

When evolving a system, remove complexity first, then build. Deletion creates a simpler substrate that makes subsequent additions cleaner, smaller, and less error-prone.

**Why:** Adding to a complex system compounds complexity. Removing first reduces the surface area, reveals the essential structure, and makes the addition's design more obvious. The default action should be subtraction.

**The Pattern:**

- Sequence removal before construction
- Cut before you polish (ruthlessly cut to minimum before investing in quality)
- Design for observed usage, not speculative edge cases
- Simplify prompts (remove redundant instructions, excessive templates)
- When a reference has no novel content, delete it rather than leaving a stub
- **Minimize the diff:** make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate
- **Consolidate decisions:** do not repeat one choice in several places. Put it behind one source of truth and pass the result down as a plain value

This is about _when_ to act — an ordering principle that says subtraction comes before addition.
