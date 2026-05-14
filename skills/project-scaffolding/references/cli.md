# CLI Project Setup

Step-by-step guide for scaffolding a single-package Effect CLI tool. Based on `@cvr/stacked` and `gent` patterns.

## Directory Structure

```
project-name/
├── src/
│   ├── main.ts              — entry point
│   ├── commands/
│   │   ├── index.ts         — root command + subcommands
│   │   └── *.ts             — one file per command
│   ├── services/
│   │   └── *.ts             — one file per service
│   └── errors/
│       └── index.ts         — all tagged errors
├── tests/
│   ├── helpers/
│   │   └── test-cli.ts      — mock services, call recorder, test layer factory
│   └── commands/
│       └── *.test.ts        — one test file per command
├── scripts/
│   └── build.ts             — Bun.build compile script
├── bin/                     — compiled binary output (gitignored)
├── .changeset/
│   └── config.json          — changeset config (if publishing)
├── .github/
│   └── workflows/
│       └── release.yml      — GitHub Actions release (if publishing)
├── package.json
├── tsconfig.json            — single TS config (Effect plugin + per-file overrides for tests)
├── .oxlintrc.json
├── lefthook.yml
├── .gitignore
└── README.md
```

No more `tsconfig.lsp.json` / `tsconfig.lsp.test.json` split — Effect diagnostics live in the `@effect/language-service` plugin in the single `tsconfig.json`, and test relaxation goes through plugin `overrides`.

## Step 1: Initialize

```bash
mkdir project-name && cd project-name
git init
bun init -y
```

Set `"type": "module"` in `package.json`.

## Step 2: Install Dependencies

```bash
# Runtime
bun add effect @effect/platform-bun

# Dev tooling
bun add -D typescript @typescript/native-preview @types/bun \
  @effect/tsgo oxlint oxlint-plugin-effect oxfmt lefthook concurrently effect-bun-test

# If publishing to npm
bun add -D @changesets/cli @changesets/changelog-github
```

`@effect/tsgo` ships the `effect-tsgo` CLI used by the `prepare` script to patch the `tsgo` binary in `@typescript/native-preview`.

## Step 3: Configure

Copy configs from SKILL.md §Tooling Stack:
- `tsconfig.json` — single config with `@effect/language-service` plugin + `overrides` for tests
- `.oxlintrc.json` — standard rules + `oxlint-plugin-effect` via `jsPlugins`
- `lefthook.yml` — pre-commit hooks
- `package.json` scripts — dev, build, gate, lint, fmt, prepare (with `effect-tsgo patch`)

After install, run `bun run prepare` (or just `bun install` again — the `prepare` lifecycle script triggers automatically) to patch the tsgo binary.

## Step 4: Project Structure

### Entry Point (`src/main.ts`)

```typescript
import { BunRuntime, BunCommandExecutor } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { command } from "./commands/index.js"
import { CliApp } from "effect/unstable/cli"
// ... import service layers

const AppLayer = Layer.mergeAll(
  ServiceA.layer,
  ServiceB.layer,
  // ...
)

const cli = CliApp.run(command, { name: "project-name", version: "0.1.0" }).pipe(
  Effect.provide(BunCommandExecutor.layer),
)

// @effect-diagnostics-next-line effect/strictEffectProvide:off
BunRuntime.runMain(cli.pipe(Effect.provide(AppLayer)))
```

### Commands (`src/commands/index.ts`)

```typescript
import { Command } from "effect/unstable/cli"
import { subcommandA } from "./subcommand-a.js"
import { subcommandB } from "./subcommand-b.js"

const root = Command.make("project-name").pipe(
  Command.withDescription("What it does"),
)

export const command = root.pipe(
  Command.withSubcommands([subcommandA, subcommandB]),
)
```

### Individual Command

```typescript
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { MyService } from "../services/MyService.js"

const nameArg = Argument.string("name")
const forceFlag = Flag.boolean("force").pipe(Flag.withAlias("f"))

export const subcommandA = Command.make("do-thing", { name: nameArg, force: forceFlag }).pipe(
  Command.withDescription("Does the thing"),
  Command.withHandler(({ name, force }) =>
    Effect.gen(function* () {
      const svc = yield* MyService
      yield* svc.doThing(name, force)
      yield* Console.log(`Done: ${name}`)
    }),
  ),
)
```

### Services

```typescript
import { Context, Effect, Layer } from "effect"
import { MyError } from "../errors/index.js"

export class MyService extends Context.Service<
  MyService,
  {
    readonly doThing: (name: string, force: boolean) => Effect.Effect<void, MyError>
  }
>()("@scope/project/services/MyService") {
  static layer: Layer.Layer<MyService> = Layer.sync(MyService, () => ({
    doThing: Effect.fn("MyService.doThing")(function* (name, force) {
      // implementation
    }),
  }))

  static layerTest = (impl: Partial<Context.Service.Shape<typeof MyService>> = {}) =>
    Layer.succeed(MyService, {
      doThing: () => Effect.void,
      ...impl,
    })
}
```

### Errors

```typescript
import { Schema } from "effect"

export class MyError extends Schema.TaggedErrorClass<MyError>()(
  "MyError",
  { message: Schema.String },
) {}
```

### Build Script (`scripts/build.ts`)

```typescript
const platform = process.platform === "darwin" ? "darwin"
  : process.platform === "win32" ? "windows" : "linux"
const arch = process.arch === "arm64" ? "arm64" : "x64"

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "bin",
  target: `bun-${platform}-${arch}`,
  compile: true,
  naming: "project-name",
})

if (!result.success) {
  console.error("Build failed:", result.logs)
  process.exit(1)
}

const binPath = `${import.meta.dir}/../bin/project-name`
const linkPath = `${process.env.HOME}/.bun/bin/project-name`

const { exitCode } = Bun.spawnSync(["ln", "-sf", binPath, linkPath])
if (exitCode !== 0) {
  console.error(`Failed to symlink to ${linkPath}`)
  process.exit(1)
}

console.log(`Binary built: ${binPath}`)
console.log(`Symlinked to: ${linkPath}`)
```

## Step 5: Testing

Tests go under `tests/`. The `tsconfig.json` `plugins[].overrides` block (see SKILL.md) already relaxes `strictEffectProvide` for `tests/**` and `*.test.ts`. Add more rules to that override block as needed — don't fork the tsconfig.

### Test Helper (`tests/helpers/test-cli.ts`)

```typescript
import { Context, Effect, Layer, Ref } from "effect"
import { MyService } from "../../src/services/MyService.js"

// Call recorder for verifying service interactions
export interface ServiceCall {
  service: string
  method: string
  args?: unknown
}

export class CallRecorder extends Context.Service<
  CallRecorder,
  {
    readonly record: (call: ServiceCall) => Effect.Effect<void>
    readonly calls: Effect.Effect<ReadonlyArray<ServiceCall>>
    readonly clear: Effect.Effect<void>
  }
>()("@scope/project/tests/CallRecorder") {
  static layer = Layer.effect(
    CallRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ServiceCall[]>([])
      return {
        record: (call) => Ref.update(ref, (calls) => [...calls, call]),
        calls: Ref.get(ref),
        clear: Ref.set(ref, []),
      }
    }),
  )
}

// Mock service with call recording
export const createMockMyService = () =>
  Layer.effect(
    MyService,
    Effect.gen(function* () {
      const recorder = yield* CallRecorder
      return {
        doThing: (name: string, force: boolean) =>
          recorder.record({ service: "MyService", method: "doThing", args: { name, force } }),
      }
    }),
  )

// Test layer factory
export const createTestLayer = () => {
  const recorderLayer = CallRecorder.layer
  const mockLayer = createMockMyService().pipe(Layer.provide(recorderLayer))
  return Layer.mergeAll(recorderLayer, mockLayer)
}

// Assertion helpers
export const expectCall = (
  calls: ReadonlyArray<ServiceCall>,
  service: string,
  method: string,
  matchArgs?: Record<string, unknown>,
): ServiceCall => {
  const found = calls.find((c) => {
    if (c.service !== service || c.method !== method) return false
    if (matchArgs === undefined) return true
    const args = c.args as Record<string, unknown> | undefined
    if (args === undefined) return false
    return Object.entries(matchArgs).every(([k, v]) => args[k] === v)
  })
  if (found === undefined) {
    throw new Error(`Expected call to ${service}.${method} not found`)
  }
  return found
}
```

### Test File

```typescript
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MyService } from "../../src/services/MyService.js"
import { CallRecorder, createTestLayer, expectCall } from "../helpers/test-cli.js"

describe("subcommand-a", () => {
  it.effect("does the thing", () =>
    Effect.gen(function* () {
      const svc = yield* MyService
      const recorder = yield* CallRecorder

      yield* svc.doThing("test", false)

      const calls = yield* recorder.calls
      expectCall(calls, "MyService", "doThing", { name: "test" })
    }).pipe(Effect.provide(createTestLayer())),
  )
})
```

`strictEffectProvide` is off in tests via the `overrides` block — no per-file `// @effect-diagnostics` directive needed.

## Step 6: .gitignore

```
node_modules/
bin/
.turbo/
*.tsbuildinfo
```

## Step 7: Publishing (optional)

If publishing to npm, follow SKILL.md §Publishing for:
- Changeset config
- GitHub Actions release workflow
- `repository` field in `package.json`
- `files` field to control what gets published
- `postinstall` script if the package needs to compile on install

## Checklist

- [ ] `bun init` + `"type": "module"`
- [ ] Install deps (effect, platform-bun, dev tooling incl. `@effect/tsgo`, `@typescript/native-preview`, `oxlint-plugin-effect`)
- [ ] `tsconfig.json` with `@effect/language-service` plugin (full `diagnosticSeverity` + `overrides` for tests)
- [ ] `.oxlintrc.json` with `jsPlugins: ["oxlint-plugin-effect/plugin"]` and the Effect guideline rules
- [ ] `lefthook.yml`
- [ ] `package.json` scripts (dev, build, gate, lint, fmt, prepare with `effect-tsgo patch`)
- [ ] `bun install` runs `prepare` — confirms `effect-tsgo patch` succeeds
- [ ] `src/main.ts` entry point
- [ ] `src/commands/index.ts` root command
- [ ] `src/services/` with `layer` + `layerTest` statics
- [ ] `src/errors/index.ts` tagged errors
- [ ] `scripts/build.ts` compile script
- [ ] `tests/helpers/test-cli.ts` mock infrastructure
- [ ] `.gitignore`
- [ ] `bun run gate` passes
