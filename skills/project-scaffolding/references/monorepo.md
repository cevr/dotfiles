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
├── tsconfig.json            — root: paths, Effect LSP, shared compiler opts
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
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "gate": "concurrently -n turbo,lint,fmt -c blue,yellow,magenta \"turbo run typecheck test build\" \"bun run lint\" \"bun run fmt\"",
    "clean": "rm -rf .turbo */.turbo */*/.turbo",
    "prepare": "lefthook install"
  },
  "devDependencies": {
    "@effect/language-service": "^0.76.0",
    "@types/bun": "^1.3.9",
    "concurrently": "^9.2.1",
    "effect": "catalog:",
    "effect-bun-test": "^0.2.1",
    "lefthook": "^2.1.1",
    "oxfmt": "^0.35.0",
    "oxlint": "^1.50.0",
    "turbo": "^2.8.10",
    "typescript": "^5.9.3"
  },
  "packageManager": "bun@1.3.6",
  "catalog": {
    "effect": "4.0.0-beta.12",
    "@effect/platform-bun": "4.0.0-beta.12"
  }
}
```

Key points:
- `"private": true` — root is never published
- `"catalog"` — pins shared dependency versions; leaf packages reference with `"catalog:"`
- `effect` in devDeps as `catalog:` — available for root-level tests
- Lint/fmt run at root (not per-package) — oxlint/oxfmt scan the whole tree

### Gate script

The monorepo gate differs from single-package: turbo handles typecheck/test/build (respecting `dependsOn` ordering), while lint/fmt run at root in parallel.

```json
"gate": "concurrently -n turbo,lint,fmt -c blue,yellow,magenta \"turbo run typecheck test build\" \"bun run lint\" \"bun run fmt\""
```

## Step 3: Root tsconfig.json

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
    "baseUrl": ".",
    "paths": {
      "@scope/core": ["packages/core/src/index.ts"],
      "@scope/cli": ["packages/cli/src/index.ts"]
    },
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
          "missedPipeableOpportunity": "warning",
          "missingEffectServiceDependency": "warning",
          "schemaUnionOfLiterals": "warning",
          "strictBooleanExpressions": "warning",
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
          "unnecessaryPipeChain": "warning"
        },
        "keyPatterns": [
          {
            "target": "service",
            "pattern": "default",
            "skipLeadingPath": ["packages/"]
          },
          {
            "target": "error",
            "pattern": "default",
            "skipLeadingPath": ["packages/"]
          }
        ]
      }
    ]
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

Key differences from single-package:
- `"baseUrl": "."` + `"paths"` — maps `@scope/pkg` → source for editor resolution
- `"include": []` — root tsconfig is for editor/LSP only, leaf tsconfigs handle compilation
- `"skipLeadingPath": ["packages/"]` — deterministic keys strip `packages/` prefix

**Add every new package to `paths`.** Without it, the editor can't resolve workspace imports.

## Step 4: turbo.json

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "tasks": {
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tsconfig.json", "package.json"],
      "outputs": []
    },
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "src/**/*.tsx", "tsconfig.json", "package.json"],
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
- `"outputs": ["dist/**"]` for build — turbo caches build artifacts

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
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
```

Key patterns:
- `"exports": { ".": "./src/index.ts" }` — source-first, no build step for dev
- `"peerDependencies"` with `"catalog:"` — version comes from root catalog
- No devDeps — inherited from root workspace

For granular sub-path exports (when core grows large):

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types/index.ts",
    "./errors": "./src/errors/index.ts",
    "./services": "./src/services/index.ts"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src"]
}
```

- Extends root — gets all strict options + Effect LSP plugin
- Only includes `src` — each package typechecks independently

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
    "build": "bun run scripts/build.ts"
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
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
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
5. Add `"typecheck": "tsc --noEmit"` to its scripts
6. Run `bun install` to link

## Checklist

- [ ] Root `package.json` with `workspaces`, `catalog`, `gate` script
- [ ] Root `tsconfig.json` with `paths` for all packages
- [ ] `turbo.json` with `dependsOn` for typecheck/build
- [ ] `.oxlintrc.json` with `node/no-process-env`
- [ ] `lefthook.yml`
- [ ] Core package: `peerDependencies`, `exports`, extends root tsconfig
- [ ] CLI package: `workspace:*` dep on core, platform-bun
- [ ] Each leaf has `"typecheck": "tsc --noEmit"` script
- [ ] `.gitignore` includes `.turbo/`
- [ ] `bun run gate` passes
