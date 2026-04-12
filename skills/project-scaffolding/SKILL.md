---
name: project-scaffolding
description: Scaffold new TypeScript projects with Effect, Bun, oxlint, oxfmt, lefthook, and changesets. Use when starting a new project, setting up a monorepo, configuring tooling, adding CI/CD, or when asked to "scaffold", "bootstrap", "init", "set up a project", "create a new project", or "new repo". Covers CLI apps, monorepos with core/cli/web splits, and npm publishing.
---

# Project Scaffolding

Opinionated project setup for Effect TypeScript on Bun. All configs derived from production projects.

## Navigation

```
What are you setting up?
├─ New CLI tool (single package)       → references/cli.md
├─ New monorepo (core + clients)       → references/monorepo.md
├─ Just the tooling configs            → §Tooling Stack
├─ CI/CD + publishing                  → §Publishing
├─ Adding to an existing project       → §Tooling Stack (pick what's missing)
├─ Understanding the conventions       → §Conventions
└─ TypeScript 6 / tsgo migration       → §TS6 / tsgo
```

## Topic Index

| Topic | Resource | When to Read |
|-------|----------|--------------|
| CLI project setup | `references/cli.md` | New single-package CLI tool |
| Monorepo setup | `references/monorepo.md` | Multi-package project with turbo, workspaces, catalog |
| Tooling configs | §Tooling Stack | Adding oxlint, oxfmt, lefthook, tsconfig |
| Publishing | §Publishing | npm publishing, changesets, GitHub Actions |
| TS6 / tsgo | §TS6 / tsgo | TypeScript 6 defaults, tsgo native compiler |

## Tooling Stack

Every project uses this base. No exceptions.

| Tool | Purpose | Config |
|------|---------|--------|
| **bun** | Runtime, package manager, test runner, bundler | `bun.lock` |
| **tsgo** | Type checking (`tsgo --noEmit`, native Go compiler) | `tsconfig.json` |
| **oxlint** | Linting (fast, Rust-based) | `.oxlintrc.json` |
| **oxfmt** | Formatting (fast, Rust-based) | `.oxfmtrc.json` (optional) |
| **lefthook** | Git hooks (pre-commit) | `lefthook.yml` |
| **Effect LSP** | Effect-specific diagnostics via `effect-language-service diagnostics` CLI | `.effect-lsp.json` |
| **concurrently** | Parallel script runner for `gate` and `lint` | `package.json` scripts |

### tsconfig.json (base)

Minimal — TS6 defaults handle `strict`, `target`, `module`, `moduleResolution`, `esModuleInterop`.

```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
    "types": ["bun"],
    "noEmit": true
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

**Why so minimal:** TS6 defaults `strict: true`, `target: es2025`, `module: es2022`, `moduleResolution: bundler`, `esModuleInterop: true`. No need to repeat them. `types: ["bun"]` required because TS6 defaults `types` to `[]` (no auto-discovery).

**Monorepo**: add `paths` mapping for workspace packages.

### .effect-lsp.json (Effect diagnostic config)

Standalone config file for `effect-language-service diagnostics` CLI. All rules promoted to **errors** for CI enforcement. Passed via `--lspconfig "$(cat .effect-lsp.json)"`.

**Why a separate file:** The CLI's `--project` flag only controls which files to scan. It does NOT read diagnostic config from tsconfig plugins. The `--lspconfig` flag is required for the diagnostics engine to actually check anything.

```json
{
  "diagnostics": true,
  "diagnosticsName": true,
  "diagnosticSeverity": {
    "anyUnknownInErrorContext": "error",
    "deterministicKeys": "error",
    "importFromBarrel": "error",
    "instanceOfSchema": "error",
    "missedPipeableOpportunity": "off",
    "missingEffectServiceDependency": "error",
    "schemaUnionOfLiterals": "error",
    "strictBooleanExpressions": "off",
    "strictEffectProvide": "error",
    "catchAllToMapError": "error",
    "catchUnfailableEffect": "error",
    "effectFnOpportunity": "error",
    "effectMapVoid": "error",
    "effectSucceedWithVoid": "error",
    "leakingRequirements": "error",
    "preferSchemaOverJson": "error",
    "redundantSchemaTagIdentifier": "error",
    "returnEffectInGen": "error",
    "runEffectInsideEffect": "error",
    "schemaStructWithTag": "error",
    "schemaSyncInEffect": "error",
    "tryCatchInEffectGen": "error",
    "unnecessaryEffectGen": "error",
    "unnecessaryFailYieldableError": "error",
    "unnecessaryPipe": "error",
    "unnecessaryPipeChain": "error",
    "extendsNativeError": "error",
    "nodeBuiltinImport": "error",
    "serviceNotAsClass": "error",
    "outdatedApi": "error",
    "globalFetch": "error",
    "globalFetchInEffect": "error",
    "globalDate": "error",
    "globalDateInEffect": "error",
    "globalConsole": "error",
    "globalConsoleInEffect": "error",
    "globalRandom": "error",
    "globalRandomInEffect": "error",
    "globalTimers": "error",
    "globalTimersInEffect": "error",
    "globalErrorInEffectCatch": "error",
    "globalErrorInEffectFailure": "error"
  },
  "keyPatterns": [
    {
      "target": "service",
      "pattern": "default",
      "skipLeadingPath": ["src/"]
    },
    {
      "target": "error",
      "pattern": "default",
      "skipLeadingPath": ["src/"]
    }
  ]
}
```

**Monorepo variant**: set `skipLeadingPath: ["packages/"]`.

**Test variant**: create `.effect-lsp.test.json` that relaxes rules for test files:

```json
{
  "diagnostics": true,
  "diagnosticsName": true,
  "diagnosticSeverity": {
    "strictEffectProvide": "off",
    "nodeBuiltinImport": "off",
    "globalConsole": "off",
    "globalConsoleInEffect": "off",
    "globalDate": "off",
    "globalDateInEffect": "off"
  }
}
```

No separate `tsconfig.lsp.json` needed — the CLI uses `--project tsconfig.json` for file scoping (reads the `include` array) and `--lspconfig` for diagnostic config.

### .oxlintrc.json

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "perf": "error"
  },
  "plugins": ["typescript", "import"],
  "rules": {
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/consistent-type-imports": [
      "error",
      { "prefer": "type-imports", "fixStyle": "separate-type-imports" }
    ],
    "typescript/no-unsafe-type-assertion": "error",
    "import/no-duplicates": "error",
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
  },
  "ignorePatterns": ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/bin/**", "**/scripts/**"],
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.test.tsx", "**/tests/**"],
      "rules": {
        "typescript/no-non-null-assertion": "off",
        "typescript/no-explicit-any": "off",
        "typescript/no-unsafe-type-assertion": "off"
      }
    }
  ]
}
```

**Monorepo additions**: add `"node"` plugin + `"node/no-process-env": "error"` to enforce Config usage.

### lefthook.yml

```yaml
pre-commit:
  parallel: true
  jobs:
    - name: fmt+lint
      run: bun run fmt && bun run lint:fix
      stage_fixed: true
    - name: typecheck
      run: bun run typecheck
    - name: build
      run: bun run build
    - name: test
      run: bun run test
```

### Scripts (single-package)

```json
{
  "scripts": {
    "dev": "bun run src/main.ts",
    "build": "bun run scripts/build.ts",
    "typecheck": "tsgo --noEmit",
    "lint": "concurrently -n ox,effect -c yellow,blue \"oxlint\" \"bun run lint:effect\"",
    "lint:ox": "oxlint",
    "lint:effect": "effect-language-service diagnostics --project tsconfig.json --lspconfig \"$(cat .effect-lsp.json)\"",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "test": "bun test",
    "gate": "concurrently -n type,style,build,test -c blue,yellow,cyan,green \"bun run typecheck\" \"bun run lint && bun run fmt\" \"bun run build\" \"bun run test\"",
    "prepare": "lefthook install"
  }
}
```

### Scripts (monorepo root)

```json
{
  "scripts": {
    "typecheck": "turbo run typecheck",
    "lint": "concurrently -n ox,effect -c yellow,blue \"oxlint\" \"turbo run lint\"",
    "lint:ox": "oxlint",
    "lint:effect": "turbo run lint",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "build": "turbo run build",
    "test": "turbo run test",
    "gate": "concurrently -n type,style,build,test -c blue,yellow,cyan,green \"bun run typecheck\" \"bun run lint && bun run fmt\" \"bun run build\" \"bun run test\"",
    "clean": "rm -rf .turbo */.turbo */*/.turbo",
    "prepare": "lefthook install"
  }
}
```

### Scripts (monorepo leaf package)

```json
{
  "scripts": {
    "typecheck": "tsgo --noEmit",
    "lint": "effect-language-service diagnostics --project tsconfig.json --lspconfig \"$(cat ../../.effect-lsp.json)\"",
    "test": "bun test tests/"
  }
}
```

Each leaf's `lint` runs `effect-language-service diagnostics` against its own tsconfig. Turbo's `lint` task fans these out across packages.

### Dev Dependencies (base)

Always `bun add -D` with **latest versions** — check npm before installing, never hardcode version pins.

```
@effect/language-service
@typescript/native-preview
@types/bun
concurrently
effect-bun-test
lefthook
oxfmt
oxlint
typescript
```

`@typescript/native-preview` provides the `tsgo` binary (Go-based TypeScript compiler, orders of magnitude faster than `tsc`). `typescript` is still needed for editor/LSP support.

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
| Type checker | `tsgo --noEmit` — native Go compiler, not `tsc` |
| Exports | `"exports": { ".": "./src/index.ts" }` — source-first, no build step for local dev |
| Tests | `bun test` with `effect-bun-test` for Effect integration |
| Tracing | `Effect.fn("ServiceName.methodName")` on all service methods |
| Quality gate | `bun run gate` before any commit/PR/ship |
| Git hooks | lefthook pre-commit runs lint, fmt, typecheck, test |
| Effect linting | `effect-language-service diagnostics` CLI — config in `.effect-lsp.json`, passed via `--lspconfig` |
| Lint scripts | `lint:ox` (oxlint) + `lint:effect` (Effect LSP diagnostics) run via `concurrently` |
| Monorepo orchestration | turbo for multi-package, concurrently for single-package |
| Version catalog | `"catalog": {}` in root `package.json` for monorepos — pins shared dep versions |

## TS6 / tsgo

TypeScript 6 changes many defaults. Combined with `tsgo` (the native Go-based compiler from `@typescript/native-preview`), this simplifies configs significantly.

### What TS6 defaults for you (remove from tsconfig)

| Option | TS6 Default | Action |
|--------|-------------|--------|
| `strict` | `true` | Remove — already on |
| `target` | `es2025` | Remove — ESNext not needed, es2025 is fine |
| `module` | `es2022` | Remove — computed from target |
| `moduleResolution` | `bundler` | Remove — computed from module |
| `esModuleInterop` | `true` | Remove — always on, can't be `false` |
| `allowSyntheticDefaultImports` | `true` | Remove — always on |
| `types` | `[]` | **Must set** — TS6 no longer auto-discovers `@types/*` |

### What TS6 deprecates (don't use)

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

`tsgo` is the native Go port of TypeScript. Same type checking, orders of magnitude faster.

| | `tsc` | `tsgo` |
|-|-------|--------|
| Binary | `node_modules/.bin/tsc` | `node_modules/.bin/tsgo` |
| Package | `typescript` | `@typescript/native-preview` |
| Speed | Baseline | ~10x faster |
| Compatibility | Full | Type-checking + noEmit only (no emit) |
| Use for | Editor/LSP | `typecheck` script, CI |

Install both: `typescript` for editor, `@typescript/native-preview` for CI/scripts.

## Reference Repos

Use `/repo-explorer` to fetch and explore these when you need implementation details:

| Repo | What | Fetch |
|------|------|-------|
| `effect-ts/language-service` | Effect LSP plugin — all diagnostic rules, config options, quick fixes | `repo fetch effect-ts/language-service` |
| `effect-ts/effect-smol` | Effect v4 source — Context.Service, Schema, unstable modules | `repo fetch effect-ts/effect-smol` |
| `effect-ts/effect` | Effect v3 source — Context.Tag, Schema, platform packages | `repo fetch effect-ts/effect` |

**When to explore:**
- Adding new diagnostics to `diagnosticSeverity` — check `src/diagnostics.ts` in `language-service` for all rules + defaults
- Unsure about a v4 API — search `effect-smol/packages/effect/src/`
- Looking for usage examples — search test files in any of these repos

## Gotchas

- **`types: ["bun"]` required** — TS6 defaults `types` to `[]` (no auto-discovery). Without it, `Bun.*` globals are invisible.
- **No `effect-language-service patch`** — use `effect-language-service diagnostics --project tsconfig.json --lspconfig "$(cat .effect-lsp.json)"` CLI instead. No patching, no `prepare` script dance.
- **`--lspconfig` is mandatory** — the CLI does NOT read diagnostic config from tsconfig plugins. Without `--lspconfig`, it reports "Checked 0 files" — files are scanned but nothing is actually checked. Always pass `--lspconfig` with the config file contents.
- **`.effect-lsp.json` for config, `tsconfig.json` for scoping** — diagnostic rules live in `.effect-lsp.json`. The `--project` flag just reads the tsconfig's `include` array to find files. For relaxed test rules, create `.effect-lsp.test.json`.
- **`repository.url` required for npm provenance** — publish will 422 without it.
- **`noUncheckedIndexedAccess`** — array/record indexing returns `T | undefined`. Use `??` or guards, not `!`.
- **Monorepo `paths`** — root `tsconfig.json` maps `@scope/pkg` → `packages/pkg/src/index.ts`. Without this, the editor can't resolve workspace packages.
- **`catalog:` in peerDependencies** — bun workspace catalog protocol. Only works in monorepo root.
- **oxfmt defaults are fine** — only create `.oxfmtrc.json` if you need `semi: false` or `singleQuote: true`.
- **`turbo.json` test cache** — always `"cache": false` for tests. Cached test results hide real failures.
- **`turbo.json` lsp input** — add `../../.effect-lsp.json` to lint task inputs so diagnostic config changes invalidate cache.
- **`downlevelIteration` is a hard error in TS6** — remove it entirely, don't set to `false`.
- **`baseUrl` deprecated in TS6** — inline the value into `paths` entries instead.
