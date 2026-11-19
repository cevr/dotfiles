---
name: principle-make-operations-idempotent
description: "Apply when writing anything that changes state and can be retried, restarted or crash halfway (commands, migrations, installers, job loops): make every run converge to the same end state."
disable-model-invocation: true
---

# Make Operations Idempotent

Design every state-changing operation to converge to the correct state however many times it runs and wherever the previous run stopped.

Derive each step from the state that exists, not from what the previous run meant to do. Read the current state, compare it to the goal, and apply only the difference.

Anything a run leaves behind (a lock, a temporary file, a half-written record, a claimed job) must be recognizable as stale by the next run, by evidence that holds wherever the previous run could have stopped. Write to a temporary path and rename it into place; compare artifacts by content, not by creation order.

The test: what happens if this runs twice? What if the previous run crashed at every possible point? If the answer depends on what was left behind, add a reconciliation step.
