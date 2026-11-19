---
name: principle-boundary-discipline
description: "Apply when placing validation, parsing or error handling, or deciding where logic lives: validate at system boundaries, trust the types inside, and keep business logic in pure functions behind a thin shell."
disable-model-invocation: true
---

# Boundary Discipline

Validate, narrow types, and handle errors where data crosses a system boundary (CLI args, config files, external APIs, network). Inside, trust the types: no re-validation and no redundant nil checks. Parse raw data into domain types at the boundary, and keep transport and framework types out of the public surface. When the raw form must be kept (replay, audit), store it beside the parsed value, never in place of it. Business logic lives in pure functions with no framework dependencies. The shell that calls them is thin.

Two tests. Is this data crossing a boundary right now? If not, the validation is redundant. Can this be a pure function the shell just calls? If yes, extract it.

**See also:** [small-interface-deep-implementation](../principle-small-interface-deep-implementation/SKILL.md) — once the boundary is drawn, keep the surface at it narrow and absorb complexity inside. [test-through-public-interfaces](../principle-test-through-public-interfaces/SKILL.md) — mock only at boundaries; inside the system, trust the types and exercise real code.
