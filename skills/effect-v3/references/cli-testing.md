# CLI Testing

Test whole CLI command flows end-to-end with mock services.

## Philosophy

- **Test the command**, not individual pieces
- Execute actual command with real argument parsing
- Mock external deps via Layer composition
- Assert on the sequence of observable side effects

## Architecture

```
SequenceRef ← mock services record calls
     ↑
createTestLayer ← compose all mock layers
     ↑
CliTestRunner ← parse args, run command, collect results
     ↑
expectSequence ← assert service calls in order
```

## Core Types

```typescript
// A recorded service call
interface RecordedCall {
  readonly service: string
  readonly method: string
  readonly args?: Record<string, unknown>
  readonly result?: unknown
}

// Ref that collects calls in order
type SequenceRef = Ref.Ref<Array<RecordedCall>>
```

## Mock Service Factory

Pattern for creating mock services that record calls:

```typescript
const createMockGitService = (options: {
  initialState: {
    currentBranch: string
    isClean: boolean
    remotes: Array<string>
  }
  sequenceRef: SequenceRef
}) =>
  Layer.effect(
    GitService,
    Effect.gen(function* () {
      const stateRef = yield* Ref.make(options.initialState)
      const seq = options.sequenceRef

      return GitService.of({
        currentBranch: () =>
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef)
            yield* Ref.update(seq, (s) => [
              ...s,
              { service: "git", method: "currentBranch" },
            ])
            return state.currentBranch
          }),

        status: () =>
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef)
            yield* Ref.update(seq, (s) => [
              ...s,
              { service: "git", method: "status" },
            ])
            return { isClean: state.isClean }
          }),

        push: (remote, branch) =>
          Effect.gen(function* () {
            yield* Ref.update(seq, (s) => [
              ...s,
              {
                service: "git",
                method: "push",
                args: { remote, branch },
              },
            ])
          }),
      })
    })
  )
```

## createTestLayer

Compose all mock layers into a single test layer:

```typescript
const createTestLayer = (options: {
  git?: { currentBranch?: string; isClean?: boolean }
  console?: { inputs?: Array<string> }
  files?: Record<string, string>
  env?: Record<string, string>
}) =>
  Effect.gen(function* () {
    const sequenceRef = yield* Ref.make<Array<RecordedCall>>([])

    const gitLayer = createMockGitService({
      initialState: {
        currentBranch: options.git?.currentBranch ?? "main",
        isClean: options.git?.isClean ?? true,
        remotes: ["origin"],
      },
      sequenceRef,
    })

    const consoleLayer = createMockConsoleService({
      inputs: options.console?.inputs ?? [],
      sequenceRef,
    })

    const fileLayer = createMockFileService({
      files: options.files ?? {},
      sequenceRef,
    })

    const envLayer = createMockEnvService({
      env: options.env ?? {},
      sequenceRef,
    })

    return {
      layer: Layer.mergeAll(gitLayer, consoleLayer, fileLayer, envLayer),
      sequenceRef,
    }
  })
```

## CliTestRunner

```typescript
const runCli = (
  args: string,
  options: Parameters<typeof createTestLayer>[0] = {}
) => ({
  expectSequence: (expected: Array<Partial<RecordedCall>>) =>
    it.effect(`cli: ${args}`, () =>
      Effect.gen(function* () {
        const { layer, sequenceRef } = yield* createTestLayer(options)

        // Run the actual CLI command
        yield* Command.run(rootCommand, args.split(" ")).pipe(
          Effect.provide(layer)
        )

        const actual = yield* Ref.get(sequenceRef)
        assertSequenceContains(actual, expected)
      })
    ),

  expectError: (errorTag: string) =>
    it.effect(`cli: ${args} → ${errorTag}`, () =>
      Effect.gen(function* () {
        const { layer } = yield* createTestLayer(options)
        const exit = yield* Command.run(rootCommand, args.split(" ")).pipe(
          Effect.provide(layer),
          Effect.exit
        )
        expect(Exit.isFailure(exit)).toBe(true)
        // Check error tag...
      })
    ),
})
```

## assertSequenceContains

Order-preserving, non-contiguous, partial argument matching:

```typescript
const assertSequenceContains = (
  actual: Array<RecordedCall>,
  expected: Array<Partial<RecordedCall>>
) => {
  let actualIdx = 0
  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const act = actual[actualIdx]
      actualIdx++
      if (
        (!exp.service || act.service === exp.service) &&
        (!exp.method || act.method === exp.method) &&
        (!exp.args || isSubset(exp.args, act.args ?? {}))
      ) {
        found = true
        break
      }
    }
    if (!found) {
      throw new Error(
        `Expected call not found in sequence: ${JSON.stringify(exp)}\n` +
        `Remaining calls: ${JSON.stringify(actual.slice(actualIdx - 1))}`
      )
    }
  }
}
```

## Full Test Example

```typescript
import { it } from "@effect/vitest"

it.effect("deploy command pushes to staging", () =>
  Effect.gen(function* () {
    const { layer, sequenceRef } = yield* createTestLayer({
      git: { isClean: true, currentBranch: "main" },
      files: { "/config.json": '{"env": "staging"}' },
    })

    yield* Command.run(deployCommand, ["deploy", "-e", "staging"]).pipe(
      Effect.provide(layer)
    )

    const calls = yield* Ref.get(sequenceRef)
    assertSequenceContains(calls, [
      { service: "git", method: "status" },
      { service: "git", method: "push", args: { remote: "origin" } },
      { service: "console", method: "log" },
    ])
  })
)
```

## Key Principles

- **SequenceRef** is the single source of truth for what happened
- **Mock factories** take initial state + sequenceRef, return Layer
- **Partial matching** — assert on what matters, ignore the rest
- **Order-preserving** — calls must appear in order, but gaps are fine
- **Real arg parsing** — run the actual command, don't construct Effects manually
