---
name: principle-boundary-discipline
description: "Apply when placing validation, parsing or error handling, or deciding where logic lives: validate at system boundaries, trust the types inside, and keep business logic in pure functions behind a thin shell."
disable-model-invocation: true
---

# Boundary Discipline

Place validation, type narrowing, and error handling at system boundaries. Trust internal code unconditionally. Business logic lives in pure functions; the shell is thin and mechanical.

**Why:** Validation scattered throughout is noisy, redundant, and gives a false sense of safety. Concentrating it at boundaries means each piece of data is validated exactly once. Logic tangled with framework wiring can't be tested without the framework.

**The Pattern:**

- **At boundaries** (CLI args, config files, external APIs, network protocols): validate, return errors, handle defensively
- **Inside the system**: typed data, error propagation, no re-validation. Trust the types.

**Applications:**

Validation and Error Handling:

- Validate config at parse time (the boundary), not inside business logic
- Parse once at the boundary into typed data. When the raw form must be kept (replay, audit), store it beside the parsed value, never in place of it
- No redundant nil checks deep in call chains if the boundary already validated

Code Organization:

- Business logic in pure functions with no framework dependencies
- Parse functions: pure transforms from raw bytes to typed state
- Prompt construction: structured state in, string out
- Scoring/assessment: pure transforms from state to results

**The Tests:**

- "Is this data crossing a system boundary right now?" If not, validation is redundant
- "Can this be a pure function that the shell just calls?" If yes, extract it

**See also:** [small-interface-deep-implementation](../principle-small-interface-deep-implementation/SKILL.md) — once the boundary is drawn, keep the surface at it narrow and absorb complexity inside. [test-through-public-interfaces](../principle-test-through-public-interfaces/SKILL.md) — mock only at boundaries; inside the system, trust the types and exercise real code.
