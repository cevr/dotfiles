# Counsel Review Contract

Use this contract to define correctness, minimality, and slop. Apply the rules to the changed scope. Do not force a rule when the repository has a stronger local contract.

## Correctness

A change is correct only when it meets all applicable requirements.

- It meets the user request and ticket contract.
- It preserves required product behavior.
- It preserves public API, wire, and data compatibility.
- It keeps domain states exact and representable.
- It preserves Effect error, requirement, and scope types.
- It owns resources for the correct lifetime.
- It cleans up resources during success, failure, and interruption.
- It preserves ordering, race safety, retry, rollback, and offline behavior.
- It keeps hidden effects visible at the correct boundary.
- It meets stated performance and resource limits.
- It changes the lowest owning module or branch.
- Its tests prove observed contracts.

Do not weaken a product behavior or test meaning to make an implementation pass.

## Minimality

Prefer the smallest correct design. Do not use code golf.

Minimize concepts, states, branches, wrappers, conversions, and ownership seams. Keep names, types, contracts, diagnostics, and safety when they carry meaning.

Fewer lines do not make a design minimal when the design hides a boundary, widens a type, duplicates a primitive, or loses an invariant.

## Type slop

Report type slop when code makes an exact fact less exact.

- It widens a specific type into a broad union or base type.
- It uses a type cast to hide a mismatch.
- It uses `any`, `unknown`, or a non-null assertion as an escape hatch.
- It adds optional fields or states that the domain does not have.
- It loses a correlation between a key and its value type.
- It loses Effect error, requirement, or scope information.
- It duplicates literal unions instead of using the owning schema or domain type.

Do not report `unknown` at a real untrusted boundary. Report it when it escapes that boundary or causes repeated decoding at call sites.

## Schema and boundary slop

Parse untrusted data once at the boundary. Use the owning schema.

Report these patterns:

- Manual `typeof`, `in`, `isRecord`, or ad hoc field checks replace schema decoding.
- Code reparses data that the boundary already decoded.
- Validation occurs after business logic starts.
- Several layers own different copies of the same wire or domain shape.
- A transport returns `unknown` and each consumer repeats the same decode.
- A cast replaces a missing or incorrect schema.

Do not demand schema decoding for trusted values that already have an exact type.

## Wrapper and abstraction slop

A wrapper must own policy, an invariant, a resource, a boundary, or useful reuse.

Report these patterns:

- A one-call helper only renames a direct operation.
- A pass-through function widens types or hides a useful correlation.
- A wrapper repeats a runtime, platform, or standard library primitive.
- An abstraction exists only for possible future reuse.
- A downstream workaround hides a gap in an owned upstream package.
- Two helpers encode the same key, path, or rule by hand.

Keep a small wrapper when it defines stable domain language, central policy, a public contract, or repeated behavior.

## Defensive and verbose slop

Report code that handles impossible states or hides broken invariants.

- Redundant guards and unreachable null checks.
- Fallbacks that turn a protocol error into normal behavior.
- Catch-and-rethrow code with no error translation or cleanup.
- Repeated checks that the type or schema already proves.
- Comments that restate the code.
- Dead fields, dead code, stale flags, and duplicate tests.
- Extra branches or state that do not change the contract.
- Cyclomatic complexity above the repository limit. Use 25 when no stronger limit exists.

Do not remove a guard that protects a real external boundary or race.

## Effect slop

Use Effect primitives inside Effect-owned code.

Report these patterns when an Effect primitive owns the problem:

- Promise-first APIs or `tryPromise` inside the core instead of at a compatibility boundary.
- Manual validation instead of Effect Schema.
- Manual service lookup or global state instead of Context and Layer.
- Manual lifecycle code instead of Scope and acquisition APIs.
- Manual retry, schedule, cache, queue, stream, or concurrency code instead of the applicable Effect primitive.
- Eager effect execution or hidden `runSync` and `runPromise` calls inside the core.
- A service has optional methods when separate capabilities or layers model the domain better.

Check the current Effect source before you name a replacement.

## Test slop

Tests must prove observed contracts.

Report these patterns:

- A test asserts implementation details instead of user-visible or service-visible behavior.
- A test uses mocks, spies, module patches, or module-patching fake timers when an in-memory service can prove the contract.
- A test changes its meaning to accept a regression.
- A cast creates an invalid domain fixture.
- Duplicate tests add no new state, boundary, or failure proof.
- A test passes but does not exercise the changed mode or branch.

Use deterministic clocks and in-memory services when the architecture provides them.

## Performance review

Require matched evidence. Compare the same workload, environment, inputs, and correctness checks.

Reject a speed result when setup work contaminates the measured worker, a cache state differs, or the new path removes required behavior.

Check CPU, memory, I/O, concurrency, and cleanup. Preserve the public API and module boundaries unless the task permits a change.

## Finding test

Accept a finding only when all answers are clear.

1. What exact changed code causes the issue?
2. What contract or invariant does it violate?
3. What reachable case shows the result?
4. What source receipt proves the claim?
5. What is the smallest correct repair?
6. Which module, package, or branch owns the repair?

If a finding cannot pass this test, mark it as optional or reject it.
