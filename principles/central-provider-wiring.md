# Central Provider Wiring

Cross-cutting concerns (logging, inspection, telemetry, error boundaries, auth, feature flags) must be wired at a single root Provider, not repeated at every feature Provider. If a caller can forget it, they will.

**Why:** Every `<FeatureMachine.Provider inspector={...}>`, `<FeatureMachine.Provider onError={...}>`, `<FeatureMachine.Provider analytics={...}>` at a feature site is a fresh chance to forget the wiring. Over 22 machines, "forget once" is nearly certain. Features also drift — one feature wires Inspector with the prod logger, another with a dev logger, a third with nothing. Behavior depends on which feature shipped last.

**Symptom in the wild:** PR 1/2 of the React-owned machines migration had each screen authoring `createInspector<State, Event>(machineId, Log)` at module scope and passing `inspector={...}` on its Provider. PR 3a centralized it: `<InspectorProvider logger={Log}>` at `RootProvider` auto-wires every descendant `Machine.Provider` keyed off `machine.id`. Individual Providers can still pass an explicit override for tests. Thirty-line template → zero-line default.

**Pattern:**

1. If you're about to write "every Provider needs to pass X," stop. Put X in a root `<XProvider>` context. Read it inside the library's Provider. If the caller passed an explicit override, use that; otherwise fall back to context.
2. Defaults live in context. Overrides live on the component. Missing both is an error the library can surface once at mount.
3. When a feature needs to customize (e.g., a screen with a special logger), pass the prop at that site — don't fragment the default.
4. Audit every cross-cutting prop before releasing a library. If it appears on every Provider in the caller's codebase, it belongs in a context default.

**Corollary — tests:**

Tests that want a clean slate pass the explicit prop. Tests that want the production default mount the root Provider. Don't invent a third path ("mock the logger globally").

**Anti-patterns:**

- Per-feature scaffolding at every call site ("each screen instantiates a logger and passes it to Provider").
- A library that accepts the prop but has no context fallback — forces every caller to remember.
- "Optional" context that the library silently no-ops when missing, with no diagnostic — callers never learn they forgot.

**Related:** `subtract-before-you-add`, `encode-lessons-in-structure`, `small-interface-deep-implementation`.
