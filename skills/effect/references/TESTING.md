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

`it.effect` provides a `Scope`, so scoped resources acquired in the test are released when it ends. Provide the smallest complete layer graph that represents the scenario.

## Fixtures and lifecycle

Every fixture is an Effect value: a Layer for services, and `Effect.acquireRelease` for anything that must be torn down. The test's scope owns its lifetime, so setup and teardown run in the test's own fiber, typed errors surface in the test, and cleanup runs on failure and interruption too. Global hooks (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`), module mocks (`mock.module`, `vi.mock`), spies, and mutable module-level state have no place here; `oxlint-plugin-effect` enforces this with `effect/noTestLifecycleHooks` and `effect/noModuleMocks`.

| Need | Effect shape |
|------|--------------|
| A fake or in-memory service | `Users.layerTest(state)` provided to the test |
| Fresh state per test | a Layer built per test (`Effect.provide(layer)` or `it.effect.layer(layer)`); each test gets its own `Ref`s |
| Setup plus teardown (temp dir, server, deployed stack) | `Effect.acquireRelease(acquire, release)` yielded inside a scoped test |
| One expensive fixture shared by a block | `@effect/vitest`: `layer(Live)("block", (it) => …)` builds once and releases after the block. `effect-bun-test` has no shared-layer block, so give the scenario one scoped test. |
| A clock, randomness, or env | `TestClock`, a seeded `Random` service, `ConfigProvider.fromUnknown(...)` layered in |

```ts
// effect-bun-test: scoped fixture, released when the test ends, even on failure
const tempDir = Effect.acquireRelease(
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectory())),
  (dir) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(dir, { recursive: true })), Effect.orDie)
)

it.scoped("writes the export", () =>
  Effect.gen(function*() {
    const dir = yield* tempDir
    yield* exportReport(dir)
    // assert on the files in dir
  }).pipe(Effect.provide(BunServices.layer))
)
```

The same shape covers integration fixtures whose harness offers hooks. For example, an Alchemy deploy test ties deploy and destroy to the test's scope: `Effect.acquireRelease(deploy(Stack), () => destroy(Stack).pipe(Effect.orDie))` (see the `alchemy` skill, `references/app-code.md` §Testing).

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

Make a fake fail when the program calls an unexpected operation. Do not use `vi.mock`, `vi.spyOn`, module patching, or method replacement when a service layer is the real seam. Improve the module boundary when a true external dependency cannot be replaced with a layer.

Use real ephemeral infrastructure when the behavior depends on storage constraints, transactions, locking, or persistence semantics.

Assert the returned value or typed error. Also assert the relevant external state when the contract changes it. Examples include persisted records, emitted events, files, recorded fake requests, and resource release.

For CLI workflows, execute the real command parser and handler with explicit arguments, provide fake filesystem/network/terminal services, and assert exit plus externally visible effects. This proves wiring that unit-testing command handlers alone misses.

## Failure assertions

Assert typed failures by tag and meaningful fields. Use exit/cause assertions only when interruption, defects, parallel failures, or finalization behavior is the subject of the test.
