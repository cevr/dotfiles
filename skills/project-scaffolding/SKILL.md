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
└─ Understanding the conventions       → §Conventions
```

## Topic Index

| Topic | Resource | When to Read |
|-------|----------|--------------|
| CLI project setup | `references/cli.md` | New single-package CLI tool |
| Monorepo setup | `references/monorepo.md` | Multi-package project with turbo, workspaces, catalog |
| Tooling configs | §Tooling Stack | Adding oxlint, oxfmt, lefthook, tsconfig |
| Publishing | §Publishing | npm publishing, changesets, GitHub Actions |

## Tooling Stack

Every project uses this base. No exceptions.

| Tool | Purpose | Config |
|------|---------|--------|
| **bun** | Runtime, package manager, test runner, bundler | `bun.lock` |
| **TypeScript** | Type checking (`tsc --noEmit`, never emits) | `tsconfig.json` |
| **oxlint** | Linting (fast, Rust-based) | `.oxlintrc.json` |
| **oxfmt** | Formatting (fast, Rust-based) | `.oxfmtrc.json` (optional) |
| **lefthook** | Git hooks (pre-commit) | `lefthook.yml` |
| **Effect LSP** | Effect-specific diagnostics via `tsc` | `tsconfig.json` plugins |
| **concurrently** | Parallel script runner for `gate` | `package.json` scripts |

### tsconfig.json (base)

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
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "diagnosticsName": true,
        "diagnosticSeverity": {
          "anyUnknownInErrorContext": "error",
          "deterministicKeys": "warning",
          "importFromBarrel": "warning",
          "instanceOfSchema": "warning",
          "missedPipeableOpportunity": "suggestion",
          "missingEffectServiceDependency": "warning",
          "schemaUnionOfLiterals": "warning",
          "strictBooleanExpressions": "off",
          "strictEffectProvide": "warning",
          "catchAllToMapError": "warning",
          "catchUnfailableEffect": "warning",
          "effectFnOpportunity": "warning",
          "effectMapVoid": "warning",
          "effectSucceedWithVoid": "warning",
          "leakingRequirements": "warning",
          "preferSchemaOverJson": "warning",
          "redundantSchemaTagIdentifier": "warning",
          "returnEffectInGen": "warning",
          "runEffectInsideEffect": "error",
          "schemaStructWithTag": "warning",
          "schemaSyncInEffect": "warning",
          "tryCatchInEffectGen": "warning",
          "unnecessaryEffectGen": "warning",
          "unnecessaryFailYieldableError": "warning",
          "unnecessaryPipe": "warning",
          "unnecessaryPipeChain": "warning",
          "extendsNativeError": "error",
          "nodeBuiltinImport": "error",
          "serviceNotAsClass": "warning",
          "outdatedApi": "warning"
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
    ]
  },
  "include": ["src", "tests", "scripts"]
}
```

**Monorepo variant**: set `skipLeadingPath: ["packages/"]`, add `paths` mapping, set `include: []`.

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
    - name: fmt
      run: bun run fmt
      stage_fixed: true
    - name: lint
      run: bun run lint:fix
      stage_fixed: true
    - name: typecheck
      run: bun run typecheck
    - name: test
      run: bun run test
```

### Scripts (package.json)

```json
{
  "scripts": {
    "dev": "bun run src/main.ts",
    "build": "bun run scripts/build.ts",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "test": "bun test",
    "gate": "concurrently -n type,lint,fmt,test,build -c blue,yellow,magenta,green,cyan \"bun run typecheck\" \"bun run lint:fix\" \"bun run fmt\" \"bun run test\" \"bun run build\"",
    "prepare": "effect-language-service patch && lefthook install"
  }
}
```

The `gate` script runs everything in parallel — this is the main quality gate.

### Dev Dependencies (base)

```json
{
  "devDependencies": {
    "@effect/language-service": "^0.76.0",
    "@types/bun": "^1.3.9",
    "concurrently": "^9.2.1",
    "effect-bun-test": "^0.2.1",
    "lefthook": "^2.1.1",
    "oxfmt": "^0.35.0",
    "oxlint": "^1.50.0",
    "typescript": "^5.9.3"
  }
}
```

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
| Exports | `"exports": { ".": "./src/index.ts" }` — source-first, no build step for local dev |
| Tests | `bun test` with `effect-bun-test` for Effect integration |
| Tracing | `Effect.fn("ServiceName.methodName")` on all service methods |
| Quality gate | `bun run gate` before any commit/PR/ship |
| Git hooks | lefthook pre-commit runs lint, fmt, typecheck, test in parallel |
| LSP patch | `effect-language-service patch` in `prepare` — surfaces Effect diagnostics in `tsc` |
| Monorepo orchestration | turbo for multi-package, concurrently for single-package |
| Version catalog | `"catalog": {}` in root `package.json` for monorepos — pins shared dep versions |

## Reference Repos

Use `/repo-explorer` to fetch and explore these when you need implementation details:

| Repo | What | Fetch |
|------|------|-------|
| `effect-ts/language-service` | Effect LSP plugin — all diagnostic rules, config options, quick fixes | `repo fetch effect-ts/language-service` |
| `effect-ts/effect-smol` | Effect v4 source — ServiceMap.Service, Schema, unstable modules | `repo fetch effect-ts/effect-smol` |
| `effect-ts/effect` | Effect v3 source — Context.Tag, Schema, platform packages | `repo fetch effect-ts/effect` |

**When to explore:**
- Adding new diagnostics to `diagnosticSeverity` — check `src/diagnostics.ts` in `language-service` for all rules + defaults
- Unsure about a v4 API — search `effect-smol/packages/effect/src/`
- Looking for usage examples — search test files in any of these repos

## Gotchas

- **`effect-language-service patch`** — must run after `bun install` (via `prepare`). Without it, Effect-specific diagnostics only show in the editor, not in `tsc --noEmit`.
- **`repository.url` required for npm provenance** — publish will 422 without it.
- **`noUncheckedIndexedAccess`** — array/record indexing returns `T | undefined`. Use `??` or guards, not `!`.
- **Monorepo `paths`** — root `tsconfig.json` maps `@scope/pkg` → `packages/pkg/src/index.ts`. Without this, the editor can't resolve workspace packages.
- **`catalog:` in peerDependencies** — bun workspace catalog protocol. Only works in monorepo root.
- **oxfmt defaults are fine** — only create `.oxfmtrc.json` if you need `semi: false` or `singleQuote: true`.
- **`turbo.json` test cache** — always `"cache": false` for tests. Cached test results hide real failures.
