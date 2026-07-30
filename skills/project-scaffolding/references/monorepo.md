# Monorepo Setup

Step-by-step guide for scaffolding a multi-package Effect monorepo with Turbo. Based on `gent` and `bible-tools`.

For service architecture, adapter patterns, and core/client splits, see the `architecture` skill.

## Directory Structure

```
project-name/
├── packages/
│   ├── core/                — shared types, schemas, service interfaces
│   │   ├── src/
│   │   │   └── index.ts     — barrel export (or fine-grained exports)
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json    — extends root tsconfig
│   ├── cli/                 — CLI client
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                 — web client (optional)
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── apps/                    — runnable apps (optional, for dev servers etc.)
│   └── ...
├── tests/                   — root-level integration tests (optional)
├── package.json             — root: workspaces, catalog, devDeps
├── tsconfig.json            — root: single config with @effect/language-service plugin + paths
├── turbo.json               — task orchestration
├── .oxlintrc.json           — shared lint config with oxlint-plugin-effect rules
├── .oxfmtrc.json            — shared format config (optional)
├── lefthook.yml             — git hooks
└── .gitignore
```

Single root `tsconfig.json` — Effect diagnostics live in the plugin block, test relaxation via plugin `overrides`. No `tsconfig.lsp.json` / `tsconfig.lsp.test.json`.

## Step 1: Initialize

```bash
mkdir project-name && cd project-name
git init
mkdir -p packages/core/src packages/cli/src
```

## Step 2: Root package.json

```json
{
  "name": "project-name",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "type": "module",
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
  },
  "devDependencies": {
    "@effect/tsgo": "^0.24.3",
    "@typescript/native-preview": "latest",
    "@types/bun": "latest",
    "concurrently": "latest",
    "effect": "catalog:",
    "effect-bun-test": "latest",
    "lefthook": "latest",
    "oxfmt": "latest",
    "oxlint": "latest",
    "oxlint-plugin-effect": "latest",
    "turbo": "latest",
    "typescript": "latest"
  },
  "catalog": {
    "effect": "4.0.0-beta.102",
    "@effect/platform-bun": "4.0.0-beta.102"
  }
}
```

Key points:
- `"private": true` — root is never published.
- `"catalog"` — pins shared dependency versions; leaf packages reference with `"catalog:"`. Pin the Effect v4 beta exactly — the npm `latest` dist-tag is still v3, so `bun add effect` without `@beta` installs the wrong major.
- `effect` in devDeps as `catalog:` — available for root-level tests.
- Lint/fmt run at root only (not per-package via turbo) — oxlint scans the whole tree in one pass.
- Type-aware Effect diagnostics ride along with `tsc --noEmit` (typecheck channel), so there's no separate `lint:effect` script. Never `tsgo --noEmit` — that binary is unpatched and reports zero Effect diagnostics (see SKILL.md §tsgo vs tsc).
- Fast AST/style Effect guidelines run in `oxlint` through `oxlint-plugin-effect/plugin`.
- `prepare` wires lefthook install + `effect-tsgo patch` — re-runs on every `bun install`.

### Lint strategy

| Script | Scope | What |
|--------|-------|------|
| `lint` | Root | `oxlint` — runs on entire tree with built-in rules plus `oxlint-plugin-effect` |
| `typecheck` | Root → leaf | `turbo run typecheck` — fans out, each leaf runs `tsc --noEmit` (Effect diagnostics included) |

No `lint:effect` / per-package `lint` script. Use one root `oxlint` pass for AST rules, and let the patched `tsc` handle type-aware diagnostics during `typecheck`.

## Step 3: Root tsconfig.json

Single file. The Effect plugin lives here, including the `overrides` block that relaxes rules for test files across all packages.

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
          "//": "Full diagnosticSeverity map — see SKILL.md §tsconfig.json (base)",
          "floatingEffect": "error",
          "missingEffectContext": "error",
          "missingEffectError": "error",
          "missingLayerContext": "error",
          "missingReturnYieldStar": "error",
          "missingStarInYieldEffectGen": "error",
          "strictEffectProvide": "off"
        },
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["packages/"] },
          { "target": "error", "pattern": "default", "skipLeadingPath": ["packages/"] }
        ],
        "overrides": []
      }
    ],
    "paths": {
      "@scope/core": ["packages/core/src/index.ts"],
      "@scope/cli": ["packages/cli/src/index.ts"]
    }
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

> Use the full `diagnosticSeverity` map from SKILL.md — the snippet above only shows a few rules for brevity.

Key differences from single-package:
- `paths` — maps `@scope/pkg` → source for editor resolution (sibling to `plugins`, both inside `compilerOptions`).
- `"include": []` — root tsconfig is for editor/LSP only; leaf tsconfigs handle compilation by extending this one.
- `keyPatterns.skipLeadingPath: ["packages/"]` — `deterministicKeys` rule strips the `packages/<name>/` prefix when computing identifiers.
- `overrides` starts empty. If a monorepo later needs a genuinely path-scoped relaxation, that is where it goes — and integration tests under `apps/` need their own glob (`apps/*/integration/**`) since `**/tests/**` won't match them. Do not add an override for `strictEffectProvide`; it is `"off"` globally (see SKILL.md §strictEffectProvide).

**Add every new package to `paths`.** Without it, the editor can't resolve workspace imports.

## Step 4: turbo.json

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "globalDependencies": ["tsconfig.json"],
  "tasks": {
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "inputs": [
        "src/**/*.ts",
        "src/**/*.tsx",
        "tests/**/*.ts",
        "tests/**/*.tsx",
        "tsconfig.json",
        "../../tsconfig.json",
        "package.json"
      ],
      "outputs": []
    },
    "build": {
      "dependsOn": ["^build"],
      "inputs": [
        "src/**/*.ts",
        "src/**/*.tsx",
        "tsconfig.json",
        "../../tsconfig.json",
        "package.json"
      ],
      "outputs": ["dist/**"]
    },
    "test": {
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx", "package.json"],
      "outputs": [],
      "cache": false
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- `globalDependencies: ["tsconfig.json"]` — root tsconfig changes invalidate every task across the graph.
- `"dependsOn": ["^typecheck"]` — typecheck/build run dependencies first (topological order).
- `"cache": false` for tests — always re-run, cached results hide failures.
- `"../../tsconfig.json"` in inputs — root tsconfig changes invalidate per-package cache (in case `globalDependencies` is removed later).

## Step 5: Leaf Package — Core

`packages/core/package.json`:

```json
{
  "name": "@scope/core",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test tests/"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
```

Key patterns:
- `"exports": { ".": "./src/index.ts" }` — source-first, no build step for dev.
- `"peerDependencies"` with `"catalog:"` — version comes from root catalog.
- `typecheck` uses `tsc` — the binary `effect-tsgo patch` patches (run by root `prepare`). Do not substitute `tsgo`; it is never patched.
- No per-package `lint` script — oxlint runs at root.
- No devDeps — inherited from root workspace.

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- Extends root — inherits the Effect plugin (with its `diagnosticSeverity` and `overrides`) automatically.
- `include: ["src", "tests"]` — typecheck both. Tests still get the relaxed rules from the root `overrides` block.

## Step 6: Leaf Package — CLI

`packages/cli/package.json`:

```json
{
  "name": "@scope/cli",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "bun run src/main.ts",
    "build": "bun run scripts/build.ts",
    "test": "bun test tests/"
  },
  "dependencies": {
    "@scope/core": "workspace:*",
    "@effect/platform-bun": "catalog:"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
```

- `"workspace:*"` — resolves to local workspace package.
- Platform packages (`@effect/platform-bun`) go in the client that uses them, not core.

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

## Step 7: .gitignore

```
node_modules/
dist/
bin/
.turbo/
*.tsbuildinfo
```

## Dependency Flow

```
core (types, schemas, service interfaces — peer: effect)
  ← cli  (platform-bun, @effect/cli)
  ← web  (platform-node or platform-browser)
  ← server (HttpApi impl)
```

Rules:
- Core has **zero platform coupling** — only `effect` as peer dep.
- Platform packages live in the client that needs them.
- Clients depend on core via `"workspace:*"`.
- All shared version pins live in root `"catalog"`.

## Adding a New Package

1. Create `packages/new-pkg/src/index.ts` + `package.json` + `tsconfig.json` (extends root).
2. Add `"@scope/new-pkg": ["packages/new-pkg/src/index.ts"]` to root `tsconfig.json` `paths`.
3. If it depends on another workspace package: `"@scope/core": "workspace:*"` in deps.
4. If it needs effect: `"effect": "catalog:"` in peerDeps.
5. Add `"typecheck": "tsc --noEmit"` to its scripts (no `lint` — handled at root).
6. Run `bun install` to link.

## Checklist

- [ ] Root `package.json` with `workspaces`, `catalog`, `gate` script, `prepare: lefthook install && effect-tsgo patch`
- [ ] Root `tsconfig.json` with `@effect/language-service` plugin (full `diagnosticSeverity` + `overrides` for tests + `paths` for all packages)
- [ ] `turbo.json` with `globalDependencies: ["tsconfig.json"]` and `dependsOn` for typecheck/build
- [ ] `.oxlintrc.json` with `jsPlugins: ["oxlint-plugin-effect/plugin"]`, Effect guideline rules, and `node/no-process-env`
- [ ] `lefthook.yml`
- [ ] Core package: `peerDependencies`, `exports`, extends root `tsconfig.json`
- [ ] CLI package: `workspace:*` dep on core, platform-bun
- [ ] Each leaf has `"typecheck": "tsc --noEmit"` (no per-package lint) — no leaf script invokes `tsgo`
- [ ] `.gitignore` includes `.turbo/`
- [ ] `bun install` runs `prepare` and `effect-tsgo patch` succeeds
- [ ] `bun run gate` passes
