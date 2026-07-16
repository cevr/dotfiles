---
name: project-scaffolding
description: Scaffold new TypeScript projects with Effect, Bun, oxlint, oxlint-plugin-effect, oxfmt, lefthook, and changesets. Use when starting a new project, setting up a monorepo, configuring tooling, adding CI/CD, Effect lint guidelines, or when asked to "scaffold", "bootstrap", "init", "set up a project", "create a new project", or "new repo". Covers CLI apps, monorepos with core/cli/web splits, and npm publishing.
---

# Project Scaffolding

Opinionated project setup for Effect TypeScript on Bun. All configs derived from production projects (`gent`, `@cvr/stacked`).

## Navigation

```
What are you setting up?
├─ New CLI tool (single package)         → references/cli.md
├─ New monorepo (core + clients)         → references/monorepo.md
├─ Migrate from @effect/language-service → references/migration.md
├─ Just the tooling configs              → §Tooling Stack
├─ Copy-paste config files               → templates/
├─ CI/CD + publishing                    → §Publishing
├─ Adding to an existing project         → §Tooling Stack (pick what's missing)
├─ Understanding the conventions         → §Conventions
└─ TypeScript 6 / tsgo migration         → §TS6 / tsgo
```

## Topic Index

| Topic | Resource | When to Read |
|-------|----------|--------------|
| CLI project setup | `references/cli.md` | New single-package CLI tool |
| Monorepo setup | `references/monorepo.md` | Multi-package project with turbo, workspaces, catalog |
| Migration to `@effect/tsgo` | `references/migration.md` | Existing project on `@effect/language-service` + `tsconfig.lsp.json` |
| Templates | `templates/` | Copy-pasteable `tsconfig.json`, `.oxlintrc.json`, `lefthook.yml`, `turbo.json` |
| Tooling configs | §Tooling Stack | Adding oxlint, oxfmt, lefthook, tsconfig |
| Publishing | §Publishing | npm publishing, changesets, GitHub Actions |
| TS6 / tsgo | §TS6 / tsgo | TypeScript 6 defaults, native compiler |

## Tooling Stack

Every project uses this base. No exceptions.

| Tool | Purpose | Config |
|------|---------|--------|
| **bun** | Runtime, package manager, test runner, bundler | `bun.lock` |
| **@effect/tsgo** | Bundled tsgo + Effect Language Service (`effect-tsgo` binary, patches `tsgo`) | `tsconfig.json` `plugins` |
| **@typescript/native-preview** | Native Go TS compiler (`tsgo` binary), required alongside `@effect/tsgo` | — |
| **typescript** | Editor/LSP fallback, TS6 | — |
| **oxlint** | Linting (fast, Rust-based) | `.oxlintrc.json` |
| **oxlint-plugin-effect** | Effect AST/style guidelines for oxlint (`effect/*` rules) | `.oxlintrc.json` `jsPlugins` |
| **oxfmt** | Formatting (fast, Rust-based) | `.oxfmtrc.json` (optional) |
| **lefthook** | Git hooks (pre-commit) | `lefthook.yml` |
| **concurrently** | Parallel script runner for `gate` | `package.json` scripts |
| **turbo** | Task orchestration (monorepo only) | `turbo.json` |

### tsconfig.json (base)

Single tsconfig. Effect diagnostics live inside the `@effect/language-service` plugin. Per-file relaxation (e.g., for tests) goes through plugin `overrides` — **no separate `tsconfig.test.json`**.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "skipLibCheck": true,
    "types": ["bun"],
    "noEmit": true,
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "diagnosticsName": true,
        "includeSuggestionsInTsc": true,
        "ignoreEffectSuggestionsInTscExitCode": false,
        "ignoreEffectWarningsInTscExitCode": false,
        "ignoreEffectErrorsInTscExitCode": false,
        "diagnosticSeverity": {
          "anyUnknownInErrorContext": "error",
          "asyncFunction": "error",
          "catchAllToMapError": "error",
          "catchUnfailableEffect": "error",
          "classSelfMismatch": "error",
          "cryptoRandomUUID": "error",
          "cryptoRandomUUIDInEffect": "error",
          "deterministicKeys": "error",
          "duplicatePackage": "error",
          "effectDoNotation": "error",
          "effectFnIife": "error",
          "effectFnImplicitAny": "error",
          "effectFnOpportunity": "error",
          "effectGenUsesAdapter": "error",
          "effectInFailure": "error",
          "effectInVoidSuccess": "error",
          "effectMapFlatten": "off",
          "effectMapVoid": "error",
          "effectSucceedWithVoid": "error",
          "extendsNativeError": "error",
          "floatingEffect": "error",
          "genericEffectServices": "error",
          "globalConsole": "error",
          "globalConsoleInEffect": "error",
          "globalDate": "error",
          "globalDateInEffect": "error",
          "globalErrorInEffectCatch": "error",
          "globalErrorInEffectFailure": "error",
          "globalFetch": "error",
          "globalFetchInEffect": "error",
          "globalRandom": "error",
          "globalRandomInEffect": "error",
          "globalTimers": "error",
          "globalTimersInEffect": "error",
          "instanceOfSchema": "error",
          "layerMergeAllWithDependencies": "error",
          "lazyPromiseInEffectSync": "error",
          "leakingRequirements": "error",
          "missedPipeableOpportunity": "off",
          "missingEffectContext": "error",
          "missingEffectError": "error",
          "missingEffectServiceDependency": "error",
          "missingLayerContext": "error",
          "missingReturnYieldStar": "error",
          "missingStarInYieldEffectGen": "error",
          "multipleEffectProvide": "error",
          "nestedEffectGenYield": "error",
          "newPromise": "error",
          "nodeBuiltinImport": "error",
          "nonObjectEffectServiceType": "error",
          "outdatedApi": "error",
          "overriddenSchemaConstructor": "error",
          "preferSchemaOverJson": "error",
          "processEnv": "error",
          "processEnvInEffect": "error",
          "redundantSchemaTagIdentifier": "error",
          "returnEffectInGen": "error",
          "runEffectInsideEffect": "error",
          "schemaStructWithTag": "error",
          "schemaSyncInEffect": "error",
          "schemaUnionOfLiterals": "error",
          "scopeInLayerEffect": "error",
          "serviceNotAsClass": "error",
          "strictBooleanExpressions": "off",
          "strictEffectProvide": "error",
          "tryCatchInEffectGen": "error",
          "unknownInEffectCatch": "error",
          "unnecessaryArrowBlock": "error",
          "unnecessaryEffectGen": "error",
          "unnecessaryFailYieldableError": "error",
          "unnecessaryPipe": "off",
          "unnecessaryPipeChain": "off"
        },
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["src/", "packages/"] },
          { "target": "error", "pattern": "default", "skipLeadingPath": ["src/", "packages/"] }
        ],
        "overrides": [
          {
            "include": [
              "**/tests/**/*.ts",
              "**/tests/**/*.tsx",
              "**/*.test.ts",
              "**/*.test.tsx"
            ],
            "options": {
              "diagnosticSeverity": {
                "strictEffectProvide": "off"
              }
            }
          }
        ]
      }
    ]
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

**Why this shape:**
- `plugins[].overrides[].include` — glob patterns. The plugin merges options for files matching `include`. This is the supported way to relax individual rules in tests/integration code without forking tsconfigs.
- `keyPatterns` — controls `deterministicKeys` rule. Skip-leading-path values (`src/`, `packages/`) make it ignore those prefixes when computing identifiers.
- `strict: true`, `target`, `module`, etc. are kept explicit even though TS6 defaults them — survives downgrades and `tsc --showConfig` clarity.

**Monorepo**: add `paths` mapping for workspace packages alongside the plugin block.

### .oxlintrc.json

Standard style + correctness rules. Effect-specific lint is split by layer:
- `@effect/tsgo` owns type-aware Effect diagnostics during `typecheck`.
- `oxlint-plugin-effect` owns fast AST/style guidelines during `lint` (`effect/*` rules like `noSpread`, `noSchemaStruct`, `noMakeUnsafe`, `noDynamicImports`, and test-control-flow bans).

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "perf": "error"
  },
  "plugins": ["typescript", "import", "node"],
  "jsPlugins": ["oxlint-plugin-effect/plugin"],
  "rules": {
    "typescript/no-explicit-any": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/consistent-type-imports": [
      "error",
      { "prefer": "type-imports", "fixStyle": "separate-type-imports" }
    ],
    "import/no-duplicates": "error",
    "node/no-process-env": "error",
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    "no-underscore-dangle": "off",
    "no-nested-ternary": "error",
    "complexity": ["error", 20],
    "effect/noSpread": "error",
    "effect/noSchemaStruct": "error",
    "effect/noMakeUnsafe": "error",
    "effect/noHandRolledTaggedUnion": "error",
    "effect/noDynamicImports": "error",
    "effect/noPromiseControlFlowInTests": "error",
    "effect/noSleepInTests": "error"
  },
  "ignorePatterns": ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/bin/**"]
}
```

Use `templates/.oxlintrc.json` for the full Effect rule list. Keep rule names explicit in JSON configs; oxlint does not load exported preset objects from package code.

### lefthook.yml

```yaml
pre-commit:
  parallel: true
  jobs:
    - name: lint+fmt
      run: bun run lint:fix && bun run fmt
      stage_fixed: true
    - name: typecheck
      run: bun run typecheck
    - name: build
      run: bun run build
    - name: test
      run: bun run test
```

Parallel pre-commit with a single combined lint+fmt job: lint runs first (may rewrite source) then fmt formats the result. Keeping lint+fmt as one chained job eliminates the staging race that bites when they're split into separate parallel jobs (one job stages files mid-typecheck on the other). `fmt` not `fmt:check` — we want stage-fixed formatting on commit, not a check failure.

### Scripts (single-package)

```json
{
  "scripts": {
    "dev": "bun run src/main.ts",
    "build": "bun run scripts/build.ts",
    "typecheck": "tsgo --noEmit",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "test": "bun test",
    "gate": "concurrently -n type,style,build,test -c blue,yellow,cyan,green \"bun run typecheck\" \"bun run lint && bun run fmt\" \"bun run build\" \"bun run test\"",
    "prepare": "lefthook install && effect-tsgo patch"
  }
}
```

`prepare` wires both lefthook install and the `effect-tsgo patch` step (the latter patches the `@typescript/native-preview` binary so `tsgo` invokes the Effect language service).

### Scripts (monorepo root)

```json
{
  "scripts": {
    "typecheck": "turbo run typecheck",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "build": "turbo run build",
    "test": "turbo run test",
    "gate": "concurrently -n type,style,build -c blue,yellow,cyan \"bun run typecheck\" \"bun run lint && bun run fmt\" \"bun run build\" && bun run test",
    "clean": "rm -rf .turbo */.turbo */*/.turbo",
    "prepare": "lefthook install && effect-tsgo patch"
  }
}
```

Lint/fmt at root only — oxlint scans the whole tree in one pass. No `turbo run lint` fan-out: `oxlint-plugin-effect` handles fast AST rules in the root lint pass, and type-aware Effect diagnostics ride along with `tsgo --noEmit`.

### Scripts (monorepo leaf package)

```json
{
  "scripts": {
    "typecheck": "tsgo --noEmit",
    "test": "bun test tests/"
  }
}
```

### Dev Dependencies (base)

Always `bun add -D` with **latest versions** — check npm before installing, never hardcode version pins (this list is for grouping, not pinning).

```
@effect/tsgo
@typescript/native-preview
@types/bun
concurrently
effect-bun-test
lefthook
oxfmt
oxlint
oxlint-plugin-effect
typescript
```

- `@effect/tsgo` is the bundled package. It ships the `effect-tsgo` CLI (used by the `prepare` script's `patch` command) and adds the Effect language service plugin to `tsgo`.
- `@typescript/native-preview` is still required — `effect-tsgo patch` patches its bundled `tsgo` binary in place. Both must be installed.
- `typescript` is needed for editor LSP fallback and as a peer of various tools.
- `oxlint-plugin-effect` provides the `effect/*` oxlint rules used for Effect style and project guidelines. Configure it with `jsPlugins: ["oxlint-plugin-effect/plugin"]`.

## Publishing

For public npm packages. Skip for private projects.

### Changesets

```bash
bun add -D @changesets/cli @changesets/changelog-github
```

`.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "USER/REPO" }],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

Add to `package.json`:

```json
{
  "repository": { "type": "git", "url": "https://github.com/USER/REPO" },
  "scripts": {
    "version": "changeset version",
    "release": "changeset publish"
  }
}
```

### GitHub Actions (release.yml)

```yaml
name: Release

on:
  push:
    branches:
      - main

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Update npm for OIDC support
        run: sudo npm install -g npm@latest
      - run: bun install
      - name: Create Release Pull Request or Publish
        uses: changesets/action@v1
        with:
          publish: bun run release
          version: bun run version
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ""
```

**Important**: `repository.url` in `package.json` must match the GitHub repo — npm provenance verification requires it.

## Conventions

| Convention | Rule |
|-----------|------|
| Package manager | bun (always) |
| Module system | `"type": "module"` |
| TypeScript | `noEmit: true` — never compile, bun runs source directly |
| Type checker | `tsgo --noEmit` — patched with Effect LSP via `effect-tsgo patch` |
| Exports | `"exports": { ".": "./src/index.ts" }` — source-first, no build step for local dev |
| Tests | `bun test` with `effect-bun-test` for Effect integration |
| Tracing | `Effect.fn("ServiceName.methodName")` on all service methods |
| Quality gate | `bun run gate` before any commit/PR/ship |
| Git hooks | lefthook pre-commit runs lint+fmt (single chained job), typecheck, build, test in parallel |
| Effect diagnostics | `@effect/tsgo` plugin in `tsconfig.json` for type-aware diagnostics; `oxlint-plugin-effect` in `.oxlintrc.json` for AST/style guidelines |
| Test relaxation | `plugins[].overrides[].include` glob with `options.diagnosticSeverity` map (no separate test tsconfig) |
| Lint scripts | Single `oxlint` at root with `oxlint-plugin-effect/plugin` loaded through `jsPlugins` |
| Monorepo orchestration | turbo for typecheck/build/test, oxlint at root |
| Version catalog | `"catalog": {}` in root `package.json` for monorepos — pins shared dep versions |

## TS6 / tsgo

TypeScript 6 changes some defaults, but production projects keep options explicit (target, module, moduleResolution) for clarity and downgrade safety. The native compiler (`tsgo`) still requires `noEmit` — it doesn't emit yet.

### tsgo via @effect/tsgo

`@effect/tsgo` is a wrapper that:
1. Embeds a pinned version of upstream `tsgo` (Microsoft's TypeScript-Go).
2. Patches it with the Effect language service for Effect-specific diagnostics, quick fixes, refactors.
3. Provides the `effect-tsgo` CLI for setup/patch/unpatch operations.

The `tsgo` binary on disk gets patched in place by `effect-tsgo patch` (run via the `prepare` script). After patching, calling `tsgo --noEmit` runs both standard TS type checking and Effect diagnostics.

**Use `@effect/tsgo` instead of standalone `tsgo`, not alongside it.** Running both produces duplicate diagnostics.

### What `@effect/tsgo setup` does

If starting from scratch on an existing project:

```bash
npx @effect/tsgo setup
```

This:
1. Adds `@effect/tsgo` and `@typescript/native-preview` to devDeps.
2. Adds the `@effect/language-service` plugin entry to `tsconfig.json`.
3. Adds `effect-tsgo patch` to the `prepare` script.
4. Optionally writes `.vscode/settings.json` to enable the native TS server.

For new projects, copy the configs from §Tooling Stack directly.

### TS6 deprecations to avoid

| Deprecated | Replacement |
|-----------|-------------|
| `target: es3` / `es5` | Minimum `ES2015` — use esbuild/SWC for ES5 |
| `moduleResolution: node` / `node10` | `bundler` or `nodenext` |
| `baseUrl` for module roots | Inline into `paths` entries |
| `outFile` | Use a bundler |
| `module: amd` / `umd` / `system` | `esnext`, `preserve`, or `commonjs` |
| `downlevelIteration` | Remove entirely (triggers error if present) |
| `assert {}` on imports | `with {}` (import attributes) |

### tsgo vs tsc

| | `tsc` | `tsgo` (via `@effect/tsgo`) |
|-|-------|---------------------------|
| Binary | `node_modules/.bin/tsc` | `node_modules/.bin/tsgo` |
| Package | `typescript` | `@typescript/native-preview` (patched by `@effect/tsgo`) |
| Speed | Baseline | ~10x faster |
| Compatibility | Full | Type-checking + noEmit only |
| Effect rules | None | Bundled via patch |
| Use for | Editor fallback | `typecheck` script, CI |

## Reference Repos

Use the `repo` skill (`skills/repo/SKILL.md`) — `okra repo fetch` + `repo path` + `rg`/`ast-grep` workflow — to fetch and explore these when you need implementation details:

| Repo | What | Fetch |
|------|------|-------|
| `effect-ts/tsgo` | Effect tsgo wrapper — diagnostic list, plugin options, `overrides` schema, presets, setup CLI | `okra repo fetch effect-ts/tsgo` |
| `effect-ts/effect` | Effect v4 source — Context.Service, Schema, unstable modules | `okra repo fetch effect-ts/effect` |

**When to explore `effect-ts/tsgo`:**
- Tuning `diagnosticSeverity` — README has the full diagnostic table with defaults; `_packages/tsgo/src/metadata.json` has the rule metadata.
- Confirming `overrides` semantics — `internal/effecttest/feature_flags_test.go` has working examples of `include` + `options.diagnosticSeverity` and `options.<ruleSetting>` overrides.
- Understanding presets (e.g., `effect-native`) — `_packages/tsgo/src/presets.ts`.
- Looking up plugin options (`keyPatterns`, `pipeableMinArgCount`, etc.) — README `## Plugin Options` section.

## Gotchas

- **`effect-tsgo patch` must run after install** — wire it into `prepare` so `bun install` rebuilds the patched binary. Without the patch, `tsgo --noEmit` runs without Effect diagnostics.
- **Don't add a separate `tsconfig.test.json`** — relax test rules via the plugin's `overrides[].include` array. Keeps a single source of truth and avoids tsconfig fan-out.
- **`overrides` is plugin-scoped, not tsconfig-scoped** — it lives inside the `@effect/language-service` plugin object's options, not at the tsconfig root. Sibling to `diagnosticSeverity`.
- **`overrides[].options.diagnosticSeverity` merges, not replaces** — only list rules whose severity changes for matching files.
- **`types: ["bun"]` required** — TS6 defaults `types` to `[]` in some configs. Without it, `Bun.*` globals are invisible.
- **`oxlint-plugin-effect` must be a devDep when `.oxlintrc.json` lists `jsPlugins: ["oxlint-plugin-effect/plugin"]`** — otherwise `oxlint` cannot load the `effect/*` rules.
- **Do not use legacy `tsgolint-effect` or env-var lint wiring** — the current shape is plain `oxlint` plus `oxlint-plugin-effect` for AST rules and `tsgo --noEmit` for type-aware Effect diagnostics.
- **`@effect/tsgo` and `@typescript/native-preview` versions are coupled** — `effect-tsgo patch` validates compatibility. Bump them together; if `patch` errors after an upgrade, update both pkgs.
- **`repository.url` required for npm provenance** — publish will 422 without it.
- **`noUncheckedIndexedAccess`** — array/record indexing returns `T | undefined`. Use `??` or guards, not `!`.
- **Monorepo `paths`** — root `tsconfig.json` maps `@scope/pkg` → `packages/pkg/src/index.ts`. Without this, the editor can't resolve workspace packages.
- **`catalog:` in peerDependencies** — bun workspace catalog protocol. Only works in monorepo root.
- **`turbo.json` test cache** — always `"cache": false` for tests. Cached test results hide real failures.
- **`turbo.json` typecheck inputs** — include `tsconfig.json` and `../../tsconfig.json` so plugin/severity changes invalidate cache.
- **`downlevelIteration` is a hard error in TS6** — remove it entirely, don't set to `false`.
- **`baseUrl` deprecated in TS6** — inline the value into `paths` entries instead.
