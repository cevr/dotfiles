# Monorepo Setup

Step-by-step guide for scaffolding a multi-package Effect monorepo with Turbo. Based on `gent` and `bible-tools`.

For service architecture, adapter patterns, and core/client splits, see the `architecture` skill.

## Directory Structure

```
project-name/
├── packages/
│   ├── core/                — shared types, schemas, service interfaces
│   │   ├── src/
│   │   │   └── index.ts     — barrel export
│   │   ├── package.json
│   │   └── tsconfig.json
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
├── tsconfig.json            — root: base TS config (minimal, TS6 defaults)
├── tsconfig.lsp.json        — root: Effect LSP plugin (strict, all errors)
├── tsconfig.lsp.test.json   — root: Effect LSP plugin (relaxed for tests)
├── turbo.json               — task orchestration
├── .oxlintrc.json           — shared lint config
├── .oxfmtrc.json            — shared format config (optional)
├── lefthook.yml             — git hooks
└── .gitignore
```

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
  },
  "devDependencies": {
    "@effect/language-service": "latest",
    "@typescript/native-preview": "latest",
    "@types/bun": "latest",
    "concurrently": "latest",
    "effect": "catalog:",
    "effect-bun-test": "latest",
    "lefthook": "latest",
    "oxfmt": "latest",
    "oxlint": "latest",
    "turbo": "latest",
    "typescript": "latest"
  },
  "catalog": {
    "effect": "4.0.0-beta.44",
    "@effect/platform-bun": "4.0.0-beta.44"
  }
}
```

Key points:
- `"private": true` — root is never published
- `"catalog"` — pins shared dependency versions; leaf packages reference with `"catalog:"`
- `effect` in devDeps as `catalog:` — available for root-level tests
- Lint/fmt run at root (not per-package) — oxlint/oxfmt scan the whole tree
- `lint` runs `lint:ox` and `lint:effect` (turbo per-package) in parallel via concurrently
- `@typescript/native-preview` provides `tsgo` binary for fast type checking

### Gate script

The monorepo gate: turbo handles typecheck/build/test (respecting `dependsOn` ordering), while lint+fmt runs in parallel alongside.

### Lint strategy

| Script | Scope | What |
|--------|-------|------|
| `lint:ox` | Root | `oxlint` — runs on entire tree |
| `lint:effect` | Root | `turbo run lint` — fans out per-package |
| `lint` (per-package) | Leaf | `effect-language-service diagnostics --project tsconfig.json` |

Root `lint` runs `lint:ox` and `lint:effect` in parallel via concurrently.

## Step 3: Root tsconfig files

### tsconfig.json (base)

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
    "noEmit": true,
    "paths": {
      "@scope/core": ["packages/core/src/index.ts"],
      "@scope/cli": ["packages/cli/src/index.ts"]
    }
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

Key differences from single-package:
- `"paths"` — maps `@scope/pkg` → source for editor resolution
- `"include": []` — root tsconfig is for editor/LSP only, leaf tsconfigs handle compilation

**Add every new package to `paths`.** Without it, the editor can't resolve workspace imports.

### tsconfig.lsp.json (Effect diagnostics — strict)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "diagnosticsName": true,
        "diagnosticSeverity": {
          "strictEffectProvide": "error"
        },
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["packages/"] },
          { "target": "error", "pattern": "default", "skipLeadingPath": ["packages/"] }
        ]
      }
    ]
  }
}
```

Full `diagnosticSeverity` — see SKILL.md §tsconfig.lsp.json for all rules (all promoted to errors).

### tsconfig.lsp.test.json (relaxed for tests)

```json
{
  "extends": "./tsconfig.lsp.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "diagnosticsName": true,
        "diagnosticSeverity": {
          "strictEffectProvide": "off",
          "nodeBuiltinImport": "off",
          "globalConsole": "off",
          "globalConsoleInEffect": "off"
        }
      }
    ]
  }
}
```

## Step 4: turbo.json

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "tasks": {
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tsconfig.json", "../../tsconfig.lsp.json", "package.json"],
      "outputs": []
    },
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tsconfig.json", "../../tsconfig.lsp.json", "package.json"],
      "outputs": ["dist/**"]
    },
    "test": {
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx", "package.json"],
      "outputs": [],
      "cache": false
    },
    "lint": {
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- `"dependsOn": ["^typecheck"]` — typecheck/build run dependencies first (topological order)
- `"cache": false` for tests — always re-run, cached results hide failures
- `"../../tsconfig.lsp.json"` in inputs — LSP config changes invalidate turbo cache

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
    "typecheck": "tsgo --noEmit",
    "lint": "effect-language-service diagnostics --project tsconfig.json",
    "test": "bun test tests/"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
```

Key patterns:
- `"exports": { ".": "./src/index.ts" }` — source-first, no build step for dev
- `"peerDependencies"` with `"catalog:"` — version comes from root catalog
- `typecheck` uses `tsgo` — native Go compiler
- `lint` runs `effect-language-service diagnostics` against the package tsconfig
- No devDeps — inherited from root workspace

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.lsp.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src"]
}
```

- Extends `tsconfig.lsp.json` — gets strict Effect diagnostics
- Only includes `src` — each package typechecks independently
- Tests run via `bun test` without tsc type-checking

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
    "typecheck": "tsgo --noEmit",
    "lint": "effect-language-service diagnostics --project tsconfig.json",
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

- `"workspace:*"` — resolves to local workspace package
- Platform packages (`@effect/platform-bun`) go in the client that uses them, not core

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.lsp.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src"]
}
```

## Step 7: Oxlint (monorepo additions)

Add `"node"` plugin and `no-process-env` to enforce Effect Config usage:

```json
{
  "plugins": ["typescript", "import", "node"],
  "rules": {
    "node/no-process-env": "error"
  }
}
```

## Step 8: .gitignore

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
- Core has **zero platform coupling** — only `effect` as peer dep
- Platform packages live in the client that needs them
- Clients depend on core via `"workspace:*"`
- All shared version pins live in root `"catalog"`

## Adding a New Package

1. Create `packages/new-pkg/src/index.ts` + `package.json` + `tsconfig.json`
2. Add `"@scope/new-pkg": ["packages/new-pkg/src/index.ts"]` to root `tsconfig.json` paths
3. If it depends on another workspace package: `"@scope/core": "workspace:*"` in deps
4. If it needs effect: `"effect": "catalog:"` in peerDeps
5. Add `"typecheck": "tsgo --noEmit"` and `"lint": "effect-language-service diagnostics --project tsconfig.json"` to its scripts
6. Run `bun install` to link

## Checklist

- [ ] Root `package.json` with `workspaces`, `catalog`, `gate`, `lint:ox`, `lint:effect` scripts
- [ ] Root `tsconfig.json` with `paths` for all packages (minimal, TS6 defaults)
- [ ] Root `tsconfig.lsp.json` with Effect diagnostics (all errors)
- [ ] Root `tsconfig.lsp.test.json` with relaxed rules
- [ ] `turbo.json` with `dependsOn` for typecheck/build, `lint` task
- [ ] `.oxlintrc.json` with `node/no-process-env`
- [ ] `lefthook.yml`
- [ ] Core package: `peerDependencies`, `exports`, extends `tsconfig.lsp.json`
- [ ] CLI package: `workspace:*` dep on core, platform-bun
- [ ] Each leaf has `"typecheck": "tsgo --noEmit"` and `"lint": "effect-language-service diagnostics --project tsconfig.json"`
- [ ] `.gitignore` includes `.turbo/`
- [ ] `bun run gate` passes
