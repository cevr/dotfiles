# Lifecycle Tasks Cancel on Reentry

When a state machine re-enters the same tag (event fires, lifecycle hook re-runs), tasks spawned from the previous entry must be considered stale. Either the library cancels them, or every caller hand-rolls a guard — and every caller that forgets ships a correctness bug.

**Why:** `.enter(State, h)` handlers exist to start subscriptions, listeners, or async work tied to that state. Same-tag transitions (payload change, input-driven re-sync) rerun `.enter` without aborting the prior instance's work. A scan listener created on `CollectingIdentifiers(step=Name)` will still be listening when the user has advanced to `CollectingIdentifiers(step=Phone)` — and its `done` handler, running on the new committed state, will happily route the machine somewhere orthogonal to where the user actually is.

**Symptom in the wild:** PR 3a (DOC migration) — loyalty scanner created during Name-step listening resolves after the user advanced to Phone/Table, routes them to Loyalty. Only caught by deep review. The workaround: capture `step` and `fulfillmentMethod` into locals at `.enter` time, guard in `done` that both still match. Every `.enter` that spawns a task needs the same boilerplate.

**Library shape:**

```ts
// Current
.enter(({ state, run }) => [
  run.listenForScan({
    input: { step: state.step },
    done: ({ state: current, result }) => {
      if (!State.is.ThisTag(current)) return;
      // MUST also check that step hasn't changed since spawn
      if (current.step !== capturedStep) return;
      return State.Next(current);
    },
  }),
])

// Proposed
.enter(({ state, run }) => [
  run.listenForScan({
    input: { step: state.step },
    cancelOnReentry: true, // aborts when .enter re-runs for the same tag
    done: ({ state: current, result }) => State.Next(current),
  }),
])
```

**Pattern:**

1. If your library offers lifecycle hooks that can re-run on the same logical "dwell" (same-tag transitions, input-sync, reconnect), make per-entry task cancellation the default. If it can't be the default, give it a one-flag opt-in.
2. If you're the caller and the library doesn't offer this, capture the state fields the task depends on into locals at spawn time, guard the `done`/`error` handlers against drift. Write one sentence in a comment explaining why.
3. If you catch the same guard pattern in three different call sites, stop. Fix the library.

**Anti-patterns:**

- Trusting "it's a listener, it'll get cleaned up" without verifying the library actually aborts on re-entry.
- Reading current state in `done` and returning a next state without checking that the transition is still semantically valid.
- Treating this as a "defensive programming" concern — it's a correctness hole the library should close.

**Related:** `fix-root-causes`, `encode-lessons-in-structure`, `make-impossible-states-unrepresentable` (the impossible state here is "stale task outlives its context").
