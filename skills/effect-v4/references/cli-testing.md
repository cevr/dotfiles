# CLI Testing

Test whole CLI command flows end-to-end with mock services (v4).

## Philosophy

Same as v3: test the command, not individual pieces. Execute actual command with real argument parsing, mock external deps via Layer composition, assert on the sequence of observable side effects.

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
interface RecordedCall {
  readonly service: string
  readonly method: string
  readonly args?: Record<string, unknown>
  readonly result?: unknown
}

type SequenceRef = Ref.Ref<Array<RecordedCall>>
```

## Mock Service Factory (v4 adapted)

```typescript
// v4: Context.Service instead of Context.Tag
const createMockGitService = (options: {
  initialState: { currentBranch: string; isClean: boolean }
  sequenceRef: SequenceRef
}) =>
  Layer.effect(
    GitService,
    Effect.gen(function* () {
      const stateRef = yield* Ref.make(options.initialState)
      const seq = options.sequenceRef

      return {
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

        push: (remote: string, branch: string) =>
          Ref.update(seq, (s) => [
            ...s,
            { service: "git", method: "push", args: { remote, branch } },
          ]),
      }
    })
  )
```

## createTestLayer

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
      },
      sequenceRef,
    })

    const consoleLayer = createMockConsoleService({ sequenceRef })
    const fileLayer = createMockFileService({ files: options.files ?? {}, sequenceRef })
    const envLayer = createMockEnvService({ env: options.env ?? {}, sequenceRef })

    return {
      layer: Layer.mergeAll(gitLayer, consoleLayer, fileLayer, envLayer),
      sequenceRef,
    }
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
        `Expected call not found: ${JSON.stringify(exp)}\n` +
        `Remaining: ${JSON.stringify(actual.slice(actualIdx - 1))}`
      )
    }
  }
}
```

## Test Example

```typescript
import { it } from "@effect/vitest"

it.effect("deploy command pushes to staging", () =>
  Effect.gen(function* () {
    const { layer, sequenceRef } = yield* createTestLayer({
      git: { isClean: true, currentBranch: "main" },
    })

    yield* Command.run(deployCommand, ["deploy", "-e", "staging"]).pipe(
      Effect.provide(layer)
    )

    const calls = yield* Ref.get(sequenceRef)
    assertSequenceContains(calls, [
      { service: "git", method: "status" },
      { service: "git", method: "push", args: { remote: "origin" } },
    ])
  })
)
```

## Key Principles

Same as v3. Only difference: services use `Context.Service` and `static layerTest` naming.
