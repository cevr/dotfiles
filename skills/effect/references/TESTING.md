# Testing

Test observable workflows with the real domain program and explicit test layers. Replace external boundaries, clocks, and nondeterminism; keep business composition real.

## Effect tests

```ts
import { expect, it } from "@effect/vitest"

it.effect("returns the saved user", () =>
  Effect.gen(function*() {
    const users = yield* Users
    const user = yield* users.find("u_1")
    expect(user.name).toBe("Ada")
  }).pipe(Effect.provide(Users.layerTest(testUsers)))
)
```

Use `it.scoped` when the test acquires scoped resources. Provide the smallest complete layer graph that represents the scenario.

## Time

Use `TestClock` for schedules, sleeps, timeouts, cache expiry, and polling:

```ts
import { TestClock } from "effect/testing"

const fiber = yield* program.pipe(Effect.forkChild)
yield* TestClock.adjust("1 minute")
const result = yield* Fiber.join(fiber)
```

Advance only after the tested fiber has reached the timed operation. Use a `Deferred`, `Latch`, `Queue`, or explicit hook to establish that ordering when it is not otherwise observable.

## Concurrent synchronization

- `Deferred`: signal one-time readiness or completion.
- `Latch`: release one or many fibers after the test observes a phase.
- `Queue`: drive and observe producer-consumer behavior.
- `Ref`: record calls or count executions.
- Test hook in a fake service: expose a precise boundary event.

Real sleeps create timing guesses. A synchronization primitive proves the state transition the test depends on.

## Fakes

Build fakes from service interfaces with explicit initial state and failure controls. Record domain-level calls when order matters. Assert the smallest observable sequence that proves behavior; avoid assertions on private helper calls.

For CLI workflows, execute the real command parser and handler with explicit arguments, provide fake filesystem/network/terminal services, and assert exit plus externally visible effects. This proves wiring that unit-testing command handlers alone misses.

## Failure assertions

Assert typed failures by tag and meaningful fields. Use exit/cause assertions only when interruption, defects, parallel failures, or finalization behavior is the subject of the test.
