---
name: effect
description: Guide for implementing Effect TypeScript features. Use when writing Effect code, setting up Effect projects, or implementing patterns like services, layers, error handling, config, testing, or CLIs.
allowed-tools: [Bash, Read, Grep, Glob]
---

# Effect TypeScript Best Practices

Before implementing Effect features, consult the available resources.

## Primary Resource: effect-solutions CLI

Run `effect-solutions show <topic>` to read the relevant guide.

**Available topics:**

| Topic | Description |
|-------|-------------|
| `quick-start` | Getting started with Effect |
| `project-setup` | Effect Language Service & strict project defaults |
| `tsconfig` | TypeScript compiler settings tuned for Effect |
| `basics` | Effect.fn, Effect.gen, pipe for instrumentation |
| `services-and-layers` | Context.Tag, Layer patterns, dependency injection |
| `data-modeling` | Schema.Class, branded types, variants, JSON serialization |
| `error-handling` | Schema.TaggedError, catchTag, catchTags, defects |
| `config` | Config module, providers, Schema.Config |
| `testing` | @effect/vitest, test layers, TestClock |
| `cli` | @effect/cli for command-line interfaces |

**Commands:**
```bash
effect-solutions list              # List all topics
effect-solutions show basics       # Show a specific guide
effect-solutions show services-and-layers error-handling  # Show multiple guides
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

1. **Start with guides**: Run `effect-solutions show <topic>` for the relevant pattern
2. **If guide is insufficient**: Clone and search Effect source for real implementations
3. **Follow established patterns**:
   - Use `Context.Tag` for service definitions
   - Use `Layer.effect` for service implementations
   - Use `Effect.fn` for traced, named functions
   - Use `Schema.TaggedError` for typed errors
   - Use `Schema.Class` for data models with branded IDs

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
