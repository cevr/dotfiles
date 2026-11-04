# CLI Project Setup

Step-by-step guide for scaffolding a single-package Effect CLI tool, based on patterns from production CLIs.

## Directory Structure

```
project-name/
├── src/
│   ├── main.ts              — composition root: the Layers, the root command, runMain
│   ├── thing.ts             — one concept: its service, its tagged errors, its command
│   ├── thing.test.ts        — tests beside the code
│   ├── github/              — an adapter folder named after its dependency (when the CLI wraps a vendor)
│   └── testing.ts           — call recorder and test Layer factory
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

Files are named by concept (`thing.ts`, `config.ts`), never grouped by kind into `commands/`, `services/` or `errors/`: the declaration says what each export is. This is the single-package form of the `effect` skill's `references/ARCHITECTURE.md` §Layout. When the CLI gains a second binary, or its vendor code outgrows one folder, move to the monorepo layout (monorepo.md): the concept files become a context, each vendor folder an adapter folder in it, and `main.ts` a `cmd/<name>/main.ts`.

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
# Runtime: Effect v4 is the latest tag; pin the resolved version exactly
bun add -E effect @effect/platform-bun

# Dev tooling
bun add -D -E typescript @typescript/native-preview @types/bun \
  @effect/tsgo oxlint oxlint-plugin-effect oxfmt lefthook concurrently effect-bun-test

# If publishing to npm
bun add -D -E @changesets/cli@^3 @changesets/changelog-github@^1
```

`@effect/tsgo` ships the `effect-tsgo` CLI used by the `prepare` script to patch the TypeScript `tsc` binary. `@typescript/native-preview` is installed for the editor's `tsgo` LSP binary only — `patch` never touches it, so `typecheck` must call `tsc --noEmit`.

## Step 3: Configure

Copy configs from SKILL.md §Tooling Stack:
- `tsconfig.json` — single config with `@effect/language-service` plugin + `overrides` for tests
- `.oxlintrc.json` — standard rules + `oxlint-plugin-effect` via `jsPlugins`
- `lefthook.yml` — pre-commit hooks
- `package.json` scripts — dev, build, gate, lint, fmt, prepare (with `effect-tsgo patch`)

After install, run `bun run prepare` (or just `bun install` again — the `prepare` lifecycle script triggers automatically) to patch the TypeScript `tsc` binary.

## Step 4: Project Structure

### Entry Point (`src/main.ts`)

```typescript
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { version } from "../package.json" with { type: "json" }
import { doThing, MyService } from "./thing.js"
import { report } from "./report.js"

const command = Command.make("project-name").pipe(
  Command.withDescription("What it does"),
  Command.withSubcommands([doThing, report]),
)

const MainLayer = Layer.mergeAll(
  MyService.layer,
  BunServices.layer, // FileSystem, Path, ChildProcessSpawner, Stdio, Terminal
)

Command.run(command, { version }).pipe(Effect.provide(MainLayer), BunRuntime.runMain)
```

`main.ts` is the only place that picks Layers. No suppression comment here. This entry-point shape is what `strictEffectProvide` flags, but that rule is `"off"` in the canonical `diagnosticSeverity` map (see tsgo.md §strictEffectProvide).

### A concept file (`src/thing.ts`): its command

```typescript
import { Argument, Command, Flag } from "effect/cli"
import { Console, Effect } from "effect"

const nameArg = Argument.String("name")
// v4 flags are required unless given a default
const forceFlag = Flag.Boolean("force").pipe(Flag.withAlias("f"), Flag.withDefault(false))

export const doThing = Command.make("do-thing", { name: nameArg, force: forceFlag }).pipe(
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

### The same file: its service

```typescript
import { Context, Effect, Layer } from "effect"

export class MyService extends Context.Service<
  MyService,
  {
    readonly doThing: (name: string, force: boolean) => Effect.Effect<void, MyError>
  }
>()("@scope/project/thing/MyService") {
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

### The same file: its errors

An error shared by several concepts moves to `src/errors.ts`.

```typescript
import { Schema } from "effect"

export class MyError extends Schema.TaggedError<MyError>()(
  "MyError",
  { name: Schema.String },
) {
  override get message() {
    return `Could not do the thing for ${this.name}`
  }
}

// construct with MyError.make({ name }), not `new` (tsgo newSchemaClass)
```

Expected failures surface to the user through `CliError.UserError` at the command boundary (`Effect.catchTags` → `CliError.UserError.make({ cause, userMessage })`), so they print a message instead of a stack trace.

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

Tests sit beside the code they test (`src/thing.test.ts`). They need no special diagnostic handling out of the box — `overrides` ships empty and `strictEffectProvide` is `"off"` globally. If a rule genuinely needs relaxing for test paths only, add an `overrides` entry in `tsconfig.json` — don't fork the tsconfig. For a single line, use `// @effect-diagnostics-next-line <rule>:off -- <reason>` with a bare rule name.

### Test Helper (`src/testing.ts`)

```typescript
import { Context, Effect, Layer, Ref } from "effect"
import { MyService } from "./thing.js"

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
>()("@scope/project/testing/CallRecorder") {
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

### Test File (`src/thing.test.ts`)

```typescript
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MyService } from "./thing.js"
import { CallRecorder, createTestLayer, expectCall } from "./testing.js"

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

`strictEffectProvide` is `"off"` globally in `diagnosticSeverity`, so this `Effect.provide` needs nothing.

## Step 6: .gitignore

```
node_modules/
bin/
.turbo/
*.tsbuildinfo
.alchemy/   # if deployed with Alchemy (SKILL.md §Deploy)
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
- [ ] `src/main.ts`: root command, the Layers, `runMain`
- [ ] One file per concept: its service (`layer` + `layerTest` statics), its tagged errors, its command
- [ ] Tests beside the code, with `src/testing.ts` for the mock infrastructure
- [ ] `scripts/build.ts` compile script
- [ ] `.gitignore`
- [ ] `bun run gate` passes
