# Separate Before Serializing Shared State

When concurrent actors might share mutable state, first ask whether they need the same mutable object. Usually they do not: give each its own, and the race is gone. Serialize only what must stay shared, and enforce it structurally (lockfiles, sequential phases, exclusive ownership). Instructions and conventions are not concurrency control.

**Why:** Concurrent writes to shared state produce race conditions that are intermittent, hard to reproduce, and expensive to debug. Telling agents or goroutines to "take turns" does not work, and a lock that guards state nobody needed to share is a design smell left in place.

**Pattern:**

1. **Identify shared mutable state** (files both read and write, branches both push to, APIs both define and consume).
2. **Separate first.** Do these actors need one canonical object, or are they publishing independent facts? Give each actor its own file, key, branch, workspace or state directory, and merge only at the read or reporting boundary. Two workers writing their own field into one `state.json` is still shared mutation; `indexer-state.json` beside `metrics-state.json` is not.
3. **Serialize what must stay shared.** When one shared write target is a real invariant, serialize access structurally: a lockfile, sequential phases, a single-writer actor, or an atomic compare-and-swap. "We need a lock" is a claim to check, not the default answer.

**See also:** [[make-operations-idempotent]] — a lock or claim a crashed run leaves behind must be recognizable as stale by the next one.
