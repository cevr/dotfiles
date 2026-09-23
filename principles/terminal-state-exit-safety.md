# Terminal States Survive Exit Animations

When a machine transitions into a terminal state (`Done`, `Quit`, `Complete`), the UI subtree does not unmount instantly — AnimatePresence, transitions, and Suspense boundaries keep the consumer components mounted for the duration of the exit animation. Selectors that assume "state will only hit terminal if caller already unmounted us" read undefined during that window and crash on invariants.

**Why:** React-owned state machines collapse the old "machine lifetime > UI lifetime" drift that XState + global singletons caused, but a new drift replaces it: during a 300ms exit animation, the committed state is already terminal while the consumer still renders. Same class of bug as the old `usePersistedTemporaryValue` workaround — a component reading a value that was valid one tick ago but isn't now. Wrong fix: revive snapshot caching. Right fix: make the terminal state carry forward the fields the consumer depends on, or have the consumer check terminality first.

**Symptom in the wild:** PR 3a (DOC migration) — `useCurrentDiningOption()` narrowed `'fulfillmentMethod' in state`, got `undefined` on `Done`, tripped `invariant(diningOption, '...')` mid-exit. Same pattern with `CollectingOutpostRoomNumber`'s outpost-id read. Fix: `State.is.Done(state) ? state.output.diningOption.fulfillmentMethod : undefined` in the selector.

**Pattern:**

1. When designing terminal state payloads, include every field a consumer reads during the preceding state. `Done({ output })` should mirror enough of the live state that consumer selectors don't have to diverge.
2. When writing consumer selectors, if you reach for `'X' in state`, consider: does the field also live on `Done.output.X`? If yes, handle both branches explicitly. If no, ask whether the screen should even render against `Done` — if not, the parent should unmount it before terminal transitions land.
3. Never add a selector-level `ref` to "remember the last non-null value." That's the old workaround in a new outfit. The values live on the state machine's output shape — read from there.

**Corollary — library DX:**

If the same three-line fallback appears in every other screen, the library owes the caller a helper:

```ts
// Proposed
const fulfillmentMethod = DocMachine.useFieldWithExitFallback(
  (s) => ('fulfillmentMethod' in s ? s.fulfillmentMethod : undefined),
  (s) => (DocMachine.State.is.Done(s) ? s.output.diningOption.fulfillmentMethod : undefined),
);
```

Or a variant-union declaration that statically requires terminal states to expose fields marked `@exit-stable`.

**Anti-patterns:**

- Caching the last non-null selector value in local state or refs — reintroduces the old XState drift in a new shape.
- Early-returning `null` from the screen when state goes terminal — breaks exit animations (the parent *wants* the screen mounted through the exit).
- Throwing from selectors to "surface the bug" — the bug is the missing fallback, not the render.

**Related:** `derive-dont-sync`, `make-impossible-states-unrepresentable`, `fix-root-causes`.
