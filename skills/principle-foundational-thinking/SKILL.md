---
name: principle-foundational-thinking
description: "Apply when starting a feature or system, or ordering its work: get the data structures right first, isolate shared state, and lay the scaffold (CI, tests, shared types) before features."
disable-model-invocation: true
---

# Foundational Thinking

Get the data shape right before writing logic. Define core types early, trace every access pattern, and choose structures that match the dominant paths. A data structure change late is a rewrite; early, it is a one-line diff. DRY the structure, not every line.

Before sharing state between actors, ask what happens if another actor modifies it concurrently. If the answer is not "nothing", isolate.

Scaffold first. Whatever helps every later phase (CI, tests, shared types) goes first, after removing dead code. Keep commits small and single-purpose.
