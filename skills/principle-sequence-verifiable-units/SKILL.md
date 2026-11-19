---
name: principle-sequence-verifiable-units
description: "Apply when planning a sweep, migration, multi-step change or stack of commits: order it as small units that each end in a checkable state, and advance only on green."
disable-model-invocation: true
---

# Sequence Verifiable Units

Order work as a sequence of small units, each ending in a state you can check, and advance only when the current one is green.

**Why:** A break caught at the unit that caused it is cheap to localize. A break caught after a batch is buried, and you have already built on a broken base. Sequencing the same units into a delivery a reviewer can replay turns "trust me" into "watch it go red, then green."

**Execution:** In a sweep, a migration, or any run of similar edits, verify each change before starting the next. Each unit is a before/after bracket: known-good state, one change, run the check, then proceed. Rebase onto a clean trunk first, so every check measures against the real baseline. When a lever makes the edits, the per-unit check is nearly free; run it anyway.

**Delivery:** Stack commits and PRs in the order that proves the work. The canonical shape is the failing test first, then the fix on top. Other story orders: a subtraction before the reshape, a baseline capture before the treatment, the scaffold before the feature. Each commit passes the gate on its own, and the sequence reads as an argument.

**See also:** [prove-it-works](../principle-prove-it-works/SKILL.md) — keeps each check real. [build-the-lever](../principle-build-the-lever/SKILL.md) — makes the per-unit check cheap.
