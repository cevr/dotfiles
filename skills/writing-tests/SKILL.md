---
name: writing-tests
description: Write tests worth keeping, test-first or after the fact. Use when writing or adding tests, building a feature or fixing a bug test-first (TDD, red-green), improving coverage, or writing integration tests. Tests user-facing behavior at the public seams, not implementation details.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Task
---

# Writing tests

A test worth keeping covers behavior a user or caller depends on: if it broke, someone would be blocked. It survives a refactor, because it reads the public interface, not the internals. "user can checkout with valid cart" says what capability exists and does not care how it is built.

Coverage is a guide to untested user-facing behavior, never a target. Code not worth testing (boilerplate, unreachable branches, internal plumbing) stays untested.

Read `GLOSSARY.md` when it exists, so test names use the domain's words, and respect the ADRs in the area you touch. [references/tests.md](references/tests.md) has good and bad examples; [references/mocking.md](references/mocking.md) says where a mock belongs.

## Seams: where tests go

A **seam** is the public boundary where you observe behavior without reaching inside. Tests live at seams.

Before the first test, write down the seams under test, each with one line on what it catches and what it misses, and put them in the plan or the commit message. Effort then lands on the critical paths and the complex logic, not on every edge case. When the interface's shape is itself in question (how deep the module is, where the seam belongs), consult the **codebase-design** skill for the vocabulary.

## Test-first: the red, green loop

When building a feature or fixing a bug, write the test first.

- **Red before green.** The test fails first, for the reason you expect. Then write only enough code to pass it; no speculative features.
- **One vertical slice at a time.** One seam, one test, one minimal implementation per cycle. Each test is a tracer bullet that answers what the last cycle taught you. Writing all the tests first, then all the code, tests imagined behavior and fixes the test structure before you understand the code.
- **A bug fix starts red.** The regression test fails on the code before the fix.
- **Refactoring sits outside the loop.** It belongs to review (the **code-review** skill).

## Adding tests to existing code

1. **Match the repo.** Find the framework (`package.json`: bun test, vitest, jest, playwright) and the existing utilities, fixtures, harnesses and layers. Use them.
2. **Find the user-facing behavior** that would hurt most if it broke.
3. **Write one meaningful test** for it at its seam.
4. **Run the suite.** The new test passes, and nothing else broke. Then break the behavior on purpose and watch the test fail, so you know it protects something.
5. **Commit** as `test(<scope>): <the behavior tested>`.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or checks through a side channel (querying the database instead of the interface). It breaks on a refactor while behavior holds.
- **Tautological**: the expected value is computed the way the code computes it (`expect(add(a, b)).toBe(a + b)`), so it passes by construction. Expected values come from an independent source: a known literal, a worked example, the spec.
- **Mocked inside the boundary**: mock only at system boundaries (external APIs, time, randomness); real services inside them.

## Authoring gate

Before keeping a new test, answer the four questions in `../code-review/references/test-audit.md` §Authoring gate: what it protects, what regression fails it, why existing coverage misses that, and whether it needs a production seam no production caller needs. Avoid its junk patterns.

## Checklist

- [ ] Tests user-visible behavior through a public seam
- [ ] Fails on the regression it names (seen red at least once)
- [ ] Uses the repo's own test utilities and layers
- [ ] Its name states the behavior, not the method
- [ ] Runs reliably: no sleeps for state changes, no flaky timing
