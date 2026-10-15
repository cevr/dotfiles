# Test Through Public Interfaces

A test is a claim about what the code does for its users: a caller, an end user, or another service. Verify that behavior through the same public surface a real user has. Behavior is what users can observe: return values, errors, state they can read back, and effects on systems outside the code (a request sent, a row written, a message emitted). Implementation is what they cannot: private helpers, internal call order, intermediate data, which internal collaborator did the work.

**Why:** Tests coupled to internals break on every refactor, even when behavior is unchanged, and pass when behavior breaks but the internal shape happens to match. Tests coupled to the public interface survive refactors, catch real regressions, and double as executable documentation of the contract. If a test can only be written by reaching inside, the interface is probably wrong, not the test.

**The Pattern:**

- **Act through the API, assert through the API:** if `createUser` is the entry point, verify by calling `getUser`, not by querying the underlying store.
- **Mock only at system boundaries:** external services, the clock, the network, the filesystem. Your own modules run for real.
- **Derive the expected value from the requirement,** not from a run of the code.
- **The contract decides, not the shape of the assertion.** When "an empty cart never charges" is the promise, asserting the payment client got no call is behavior; pair it with a case where the charge happens, so the test shows it can see a call. The payload a mocked external service receives is behavior, because that service observes it. A call to an internal helper is implementation. The error type callers branch on is the contract; an exact error message nobody reads is not.
- **If it's hard to test through the interface, the interface is wrong:** treat test pain as interface feedback.
- **One real path per behavior:** integration-shaped tests that exercise the full code path beat a hundred unit tests mocking every collaborator.

**The Test:** judge each test against two imagined edits.

- **Break the behavior** (return a wrong value, skip an effect, do it twice). A test that still passes proves nothing: its assertion is looser than the contract, its expected value came from the code under test, or it asserts on data it built itself.
- **Change the internals** while every observable result stays the same. A test that now fails is pinned to the implementation.

Keep a test that catches the first edit and survives the second. Rewrite or delete the rest.

**See also:** [[prove-it-works]] — the *what* of verification (don't claim done without evidence); this principle is the *how* (verify through the caller's eyes). [[boundary-discipline]] — mocks belong at system boundaries, not inside them.
