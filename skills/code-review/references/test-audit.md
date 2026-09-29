# Test Audit

Use this reference to judge the value of tests. Apply it to each test that the change adds or changes. Apply it to each existing test in a `tests` mode audit.

Adapted from the OpenClaw `test-audit` skill: https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md

## Value bar

A test must pay for its maintenance cost. It must protect observable behavior, a credible regression, or an independently meaningful contract.

Before you judge a test, read the complete test and its production owner. Read the entry point, callers, callees, sibling implementations, overlapping tests, and CI routing. Read the relevant history. When the test claims dependency-backed behavior, inspect the dependency source or types.

A test that breaks under a behavior-preserving refactor asserts implementation. For a new test, this fails the gate. For an existing test, this makes the test suspect. It does not make the test deletable without evidence.

## Authoring gate

Each new or changed test must answer all four questions. A missing answer is a finding.

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure?
4. Does it need a production seam that no production caller needs? A seam is an export, flag, wrapper, global, or injection hook.

Each contract has one primary test owner at the strongest boundary. A test at another layer needs its own distinct risk, such as a transport or lifecycle failure that the owner cannot reach. Prefer a new case in an existing table-driven test or shared fixture over a near-duplicate test.

When question 4 is yes, the repair is to move the test to the real boundary. Do not accept the seam.

A bug regression test must fail on the pre-fix code for the intended reason. It must pass after the owner-boundary repair. A regression test that never failed proves the mock, not the fix. One regression test at the owner boundary covers the bug. Do not accept the same scenario at each layer it crosses.

## Junk patterns

A new test that matches a pattern fails the gate. An existing test that matches a pattern is an audit candidate. The [retention bar](#retention-bar) can override both.

- Assertion-free coverage probes.
- Self-comparisons and identity copiers.
- Copied fixtures, inventories, manifests, or export lists.
- Exact source, import, or string greps.
- Private predicate or call-shape tests that duplicate a real boundary test.
- Duplicate invocations of the same contract.
- Local replays of a shared helper's tests.
- Tests whose only purpose is to keep a test-only export, global, or wrapper alive.
- Dead production code whose only callers are tests.
- Expected values that the helper or renderer under test produces.
- Mocks that implement the asserted behavior.
- One identical mock that stands in for different APIs.
- Mocks, spies, module patches, or patched timers where an in-memory service can prove the contract.
- Casts that create an invalid domain fixture.
- Fixtures that supply the receipt, admission, or callback order that the owner must produce.
- Persistence asserted against a store that the path never writes.
- Capability tests that restate declared flags instead of exercising the delivery the flag promises.
- Negative controls that pass for an unrelated reason, such as a denial from a different guard.
- Names or fixtures that promise more than the input exercises.
- A test that passes but does not exercise the changed mode or branch.
- A test whose meaning changed to accept a regression.

Prefer deterministic clocks and in-memory services when the architecture provides them.

## Retention bar

Keep a test when it independently enforces one of these contracts: public API, SDK, protocol, config, migration, storage, security, platform, default value, prompt bytes, generated cross-language output, package, release, or architecture.

Also keep:

- Call-order assertions when the order is observable behavior.
- Regression tests with a credible failure mode.
- Source inspection when it is the cheapest independent guard. It must fail when the contract changes and survive an identifier-only rename.
- A retained test that fails on the baseline. Treat it as a possible product bug. Report the owner repair, not the deletion.

A static or slow test is not a deletion reason. A test that resembles implementation can still be the independent contract. Prove otherwise before you recommend removal.

## Candidate evidence

A recommendation to delete or move an existing test needs every field below. A missing field downgrades the finding to `Optional`.

- The exact test name and location.
- The failure that the test can actually detect.
- The non-test callers of the covered production or support seam.
- The stronger owner-boundary proof that remains, or why no proof is necessary.
- The relevant history and the reason the test or seam exists.
- The production or test-support code that the deletion unlocks.
- The risk and the focused validation command.

## Repair shape

Recommend one coherent owner-boundary batch. Delete obsolete test-only exports, globals, wrappers, and dead production paths. Do not keep aliases for them. Move retained regression tests to their canonical owners. Consolidate repeated package or dependency assertions into one generic contract.

Prefer net-negative production lines. Optimize for confidence, not for deletion count. Leave an uncertain candidate out of the batch.
