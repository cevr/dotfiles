---
name: principle-make-impossible-states-unrepresentable
description: "Apply when designing types or state, or when code branches a lot or repeats a shape assumption: model the domain so invalid combinations cannot be built (unions, state machines, branded primitives, exhaustive matches, types derived from the schema)."
disable-model-invocation: true
---

# Make Impossible States Unrepresentable

Model state so invalid combinations can't be constructed, not just avoided. The type system is the cheapest test you will ever write — use it to encode what "valid" means.

**Why:** Boolean pairs and optional fields create silent junk states. `isLoading=true, isError=true, data=null` compiles fine and means nothing. Every consumer then has to defend against the junk — or forget to, and ship a bug. Discriminated unions collapse the valid space to exactly the states that exist, and TypeScript narrows each branch to just the fields it needs.

**The Pattern:**

- **Discriminated unions over boolean clusters:** replace `isLoading / isError / isSuccess` with `{ status: 'idle' | 'loading' | 'success' | 'error' }`. Each branch carries only its relevant fields
- **Fields belong to the state they describe:** `data` lives on `success`, `error` lives on `error`. No `data?: T` or `error?: Error` on the parent
- **Guard transitions at the reducer:** not every action is valid in every state. Invalid transitions no-op or error — they don't silently corrupt
- **Exhaustive switches:** use `satisfies` / `never` defaults so adding a new state breaks the compile rather than slipping through
- **Name by lifecycle, not by flag:** `'closed' | 'opening' | 'open' | 'closing'` beats `isOpen + isAnimating + isClosing`
- **Encode the domain in a structure, not in conditionals:** a state machine instead of scattered booleans or phase checks, a typed model instead of loose parameters, a map, registry or discriminated union instead of branching spread across files, a reducer instead of ad hoc mutations, and an index, queue or normalized collection where the access pattern calls for it
- **Brand semantic primitives:** when two values share a primitive type but mean different things (`UserId`, `OrderId`), give each its own type and validate once at creation
- **Derive types from the authoritative schema:** when a schema file owns a shape (protobuf, OpenAPI, a migration, a design-token file), derive the type from it instead of hand-rolling a parallel one

Do not force it. Keep boring code when the shape is clear, local and unlikely to grow, and distrust an abstraction that adds indirection without removing branches or invalid states.

**The Test:**

- "Can I write down a state that compiles but shouldn't exist?" If yes, the model is too loose — collapse to a union
- "Does every consumer need a `?? null` or `if (data)` guard?" The state shape is lying about what's actually present
- "Would a junior reading this know which fields are meaningful when?" If not, the discriminant isn't doing its job
- "Does this feature grow an if/else chain by one more branch, or add a second boolean that must stay in step with the first?" Then the domain is not in the data yet

**See also:** [name-events-not-setters](../principle-name-events-not-setters/SKILL.md) — the transitions between these states should be named as facts, not as field assignments. [derive-dont-sync](../principle-derive-dont-sync/SKILL.md) — once the state space is tight, derived values project from it rather than living alongside. [boundary-discipline](../principle-boundary-discipline/SKILL.md) — external data is untyped until a parse at the boundary returns this model.
