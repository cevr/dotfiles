---
name: effect
description: Guide for implementing Effect TypeScript features. Use when writing Effect code, setting up Effect projects, or implementing patterns like services, layers, error handling, config, testing, or CLIs.
allowed-tools: [Bash, Read, Grep, Glob]
---

# Effect TypeScript Best Practices

Before implementing Effect features, consult the available resources.

## Pre-Implementation (mandatory)

Before writing Effect code:
1. Read the file's existing imports and type signatures
2. Run `primer effect <relevant-topic>` for the pattern
3. Read target module's types (Context.Tags, TaggedErrors, Schema classes)
4. Only then implement

Skipping this causes multi-cycle type fixes. Read the types.

## Primary Resource: primer

Run `primer effect <topic>` to read the relevant guide.

**Available topics:**

| Topic | Description |
|-------|-------------|
| `basics` | Effect.fn, Effect.gen, pipe for instrumentation |
| `services` | Context.Tag, Layer patterns, dependency injection |
| `data-modeling` | Schema.Class, branded types, variants, JSON serialization |
| `errors` | Schema.TaggedError, catchTag, catchTags, defects |
| `testing` | @effect/vitest, test layers, TestClock |
| `cli` | @effect/cli for command-line interfaces |

**Commands:**
```bash
primer effect              # Overview + all topics
primer effect basics       # Show a specific guide
primer effect services     # Dependency injection patterns
```

## Secondary Resource: Effect Source Code

When the guides aren't enough, explore the Effect source code using the `repo-explorer` skill.

**Setup:**
```bash
mkdir -p ~/.claude/repos/Effect-TS
git clone --depth 100 https://github.com/Effect-TS/effect.git ~/.claude/repos/Effect-TS/effect
```

**Key packages in `~/.claude/repos/Effect-TS/effect/packages/`:**
- `effect/` - Core Effect library
- `schema/` - Schema module for data modeling
- `platform/` - FileSystem, HttpClient, KeyValueStore, etc.
- `cli/` - CLI framework (@effect/cli)
- `vitest/` - Test utilities (@effect/vitest)

**Search for implementations:**
```bash
# Find how a specific API is implemented
rg "export const layerEffect" ~/.claude/repos/Effect-TS/effect/packages/effect/src

# Find usage patterns
rg "Context.Tag" ~/.claude/repos/Effect-TS/effect/packages --glob "*.ts" -C 2
```

## Workflow

1. **Start with guides**: Run `primer effect <topic>` for the relevant pattern
2. **If guide is insufficient**: Clone and search Effect source for real implementations
3. **Follow established patterns**:
   - Use `Context.Tag` for service definitions
   - Use `Layer.effect` for service implementations
   - Use `Effect.fn` for traced, named functions
   - Use `Schema.TaggedError` for typed errors
   - Use `Schema.Class` for data models with branded IDs

## No Standalone Side-Effect Functions

**NEVER create standalone exported functions that perform side effects.** Side effects include:
- Running system commands (`execa`, `spawn`, `exec`)
- File I/O operations
- Network requests
- Database operations
- Anything that makes testing difficult

### Why This Matters

Standalone functions with side effects cannot be mocked in tests, leading to:
- Tests that run real system commands (slow, flaky, environment-dependent)
- Tests that skip important behavior verification
- Untestable code paths

### The Pattern

❌ **Bad: Standalone function with side effects**
```typescript
// This cannot be mocked - tests must run real lsof commands
export const findProcessOnPort = (port: number): Effect.Effect<number | null> =>
  Effect.promise(async () => {
    const result = await execa('lsof', ['-ti', `tcp:${port}`]);
    return parseInt(result.stdout) || null;
  });
```

✅ **Good: Encapsulate in a service with Test layer**
```typescript
export interface PortServiceShape {
  readonly findProcessOnPort: (port: number) => Effect.Effect<number | null>;
}

export class PortService extends Context.Tag('@cli/PortService')<
  PortService,
  PortServiceShape
>() {
  // Live implementation runs real commands
  static Live = Layer.sync(PortService, () => ({
    findProcessOnPort: (port) =>
      Effect.promise(async () => {
        const result = await execa('lsof', ['-ti', `tcp:${port}`]);
        return parseInt(result.stdout) || null;
      }),
  }));

  // Test implementation is fully mockable
  static Test = (config: { processesOnPort?: Map<number, number> } = {}) =>
    Layer.succeed(PortService, {
      findProcessOnPort: (port) =>
        Effect.succeed(config.processesOnPort?.get(port) ?? null),
    });
}
```

### Testing with Service Mocks

```typescript
it.effect('should check port availability', () =>
  Effect.gen(function* () {
    const portService = yield* PortService;
    const pid = yield* portService.findProcessOnPort(6363);
    expect(pid).toBe(12345);
  }).pipe(
    Effect.provide(
      PortService.Test({ processesOnPort: new Map([[6363, 12345]]) })
    )
  )
);
```

### What CAN Be Standalone

- Pure functions (no I/O, no side effects)
- Schema definitions
- Type utilities
- Constants and configuration objects
- String/data transformations

## CLI Option Services Pattern

For required CLI options, create services that:
1. Check CLI option → config → interactive prompt (in that order)
2. Cache the resolved value via Ref
3. Provide `.test()` static method for easy mocking

This is better than erroring when required options are missing - users get prompted interactively.

### Example: OrgService

```typescript
export class OrgService extends Context.Tag("OrgService")<
  OrgService,
  { readonly get: () => Effect.Effect<string, ConfigError | ApiError | Terminal.QuitException, Terminal.Terminal> }
>() {
  static make = (orgOption: Option.Option<string>) =>
    Layer.effect(OrgService, Effect.gen(function* () {
      const api = yield* SentryApi
      const config = yield* SentryConfig
      const cache = yield* Ref.make<Option.Option<string>>(Option.none())

      return OrgService.of({
        get: () => Effect.gen(function* () {
          const cached = yield* Ref.get(cache)
          if (Option.isSome(cached)) return cached.value

          // Check option, then config
          const value = Option.getOrUndefined(orgOption)
            ?? Option.getOrUndefined(config.defaultOrg)
          if (value) {
            yield* Ref.set(cache, Option.some(value))
            return value
          }

          // Check if interactive terminal
          if (!process.stdout.isTTY) {
            return yield* Effect.fail(new ConfigError({ message: "Org required" }))
          }

          // Fetch options and prompt
          const orgs = yield* api.listOrganizations()
          if (orgs.length === 1) {
            yield* Ref.set(cache, Option.some(orgs[0].slug))
            return orgs[0].slug
          }

          const selected = yield* Prompt.select({
            message: "Select organization",
            choices: orgs.map(o => ({ title: o.name, value: o.slug }))
          })
          yield* Ref.set(cache, Option.some(selected))
          return selected
        })
      })
    }))

  // Test implementation - no prompting, returns fixed value
  static test = (org: string) =>
    Layer.succeed(OrgService, OrgService.of({
      get: () => Effect.succeed(org)
    }))
}
```

### Usage in Commands

```typescript
// Provide service layer inline in command handler
export const myCommand = Command.make(
  "cmd",
  { org: orgOption },
  ({ org }) =>
    Effect.gen(function* () {
      const organizationSlug = yield* (yield* OrgService).get()
      // ... use organizationSlug
    }).pipe(Effect.provide(OrgService.make(org)))
)
```

### Dependent Services

For services that depend on others (e.g., ProjectService needs org):

```typescript
export const myCommand = Command.make(
  "cmd",
  { org: orgOption, project: projectOption },
  ({ org, project }) =>
    Effect.gen(function* () {
      const orgSlug = yield* (yield* OrgService).get()
      const projectSlug = yield* (yield* ProjectService).get()
      // ...
    }).pipe(
      Effect.provide(
        Layer.merge(
          OrgService.make(org),
          Layer.provide(ProjectService.make(project), OrgService.make(org))
        )
      )
    )
)
```

## CLI Testing Philosophy

**Goal: Test whole command flows, not individual pieces.**

CLI tests should execute the actual command with real argument parsing, provide mock layers for external dependencies, and assert on the sequence of observable side effects.

### Why This Approach

- **Catches real bugs**: Tests the actual command flow end-to-end
- **Less brittle**: Internal refactors don't break tests as long as behavior is preserved
- **Documents behavior**: Tests serve as executable documentation of what commands do
- **Effect-native**: Uses Layer composition to swap real services for test doubles

### Core Pattern: runCli + expectSequence

```typescript
it.effect('deploys to staging', () =>
  runCli('deploy -p myapp -y staging', {
    git: { isClean: true, currentBranch: 'main' },
    files: { '/config.json': '{"env": "staging"}' },
  })
    .expectSequence([
      { service: 'git', method: 'status' },
      { service: 'process', method: 'spawn', match: { command: 'docker' } },
      { service: 'slack', method: 'notify' },
    ])
)
```

The test runs the full `deploy` command with parsed args, mocks git state and filesystem, then asserts specific services were called in order.

### Test Infrastructure Components

| Component | Purpose |
|-----------|---------|
| `createTestLayer(options)` | Composes all mock services into single Layer |
| `runCli(args, options)` | Executes CLI command, returns assertion helpers |
| `expectSequence(calls)` | Asserts service calls happened in order |
| Mock layers | FileSystem, Console, Process, Prompt - all record calls |

### Sequence Recording

Every mock service records its calls to a shared `Ref`. This enables asserting **what** happened, **in what order**, with **partial argument matching**.
