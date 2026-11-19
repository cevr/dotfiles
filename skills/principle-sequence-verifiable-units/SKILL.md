---
name: principle-sequence-verifiable-units
description: "Apply when planning a sweep, migration, multi-step change or stack of commits: order it as small units that each end in a checkable state, and advance only on green."
disable-model-invocation: true
---

# Sequence Verifiable Units

Order work as small units that each end in a state you can check, and do not advance until the current one is green.

In a sweep, migration, or run of similar edits, each unit is a bracket: known-good state, one change, run the check, proceed. Run the per-unit check even when a tool does the edits.

Deliver in the order that proves the work: the failing test first, then the fix. The subtraction before the reshape. The baseline before the treatment. Each commit passes the gate on its own.

**See also:** [prove-it-works](../principle-prove-it-works/SKILL.md) — keeps each check real. [build-the-lever](../principle-build-the-lever/SKILL.md) — makes the per-unit check cheap.
