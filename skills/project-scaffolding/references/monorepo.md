# Monorepo Setup

Step-by-step guide for scaffolding a multi-package Effect monorepo with Turbo, laid out like a Go service: a workspace package per bounded context, adapters in folders named after their dependency, and one `cmd/` folder per binary.

The layout and its rules live in the `effect` skill's `references/ARCHITECTURE.md` §Layout. Read it first; this file wires the tooling for it.

## Directory Structure

```
project-name/
├── board/                   — @scope/board: one context (domain files at its root)
│   ├── card.ts  errors.ts  service.ts
│   ├── board.test.ts        — tests beside the code
│   ├── memory/              — the domain's contracts in memory     → @scope/board/memory/…
│   ├── filestore/           — the same contracts over files        → @scope/board/filestore/…
│   ├── package.json
│   └── tsconfig.json        — extends ../tsconfig.json
├── cmd/
│   └── standup/             — @scope/standup: one binary, the only composition root
│       ├── main.ts
│       ├── package.json
│       └── tsconfig.json    — extends ../../tsconfig.json
├── tests/                   — root-level integration tests (optional)
├── package.json             — root: workspaces, catalog, devDeps
├── tsconfig.json            — root: single config with @effect/language-service plugin + paths
├── turbo.json               — task orchestration
├── .oxlintrc.json           — shared lint config: oxlint-plugin-effect rules and the layout fence
├── .oxfmtrc.json            — shared format config (optional)
├── lefthook.yml             — git hooks
└── .gitignore
```

A second context is another top-level folder (`billing/`); a vendor client several contexts share is its own package named after the vendor (`postgres/`); shared code outside any domain is named for what it does (`ui/`). Packages have no `src/`: files sit in the package folder, as in a Go package.

Single root `tsconfig.json` — Effect diagnostics live in the plugin block, test relaxation via plugin `overrides`. No `tsconfig.lsp.json` / `tsconfig.lsp.test.json`.

## Step 1: Initialize

```bash
mkdir project-name && cd project-name
git init
mkdir -p board/memory cmd/standup
```

## Step 2: Root package.json

```json
{
  "name": "project-name",
  "private": true,
  "workspaces": ["*", "cmd/*"],
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
    "@effect/tsgo": "0.46.1",
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
    "effect": "4.0.0-rc.117",
    "@effect/platform-bun": "4.0.0-rc.117"
  }
}
```

Key points:
- `"workspaces": ["*", "cmd/*"]` — every top-level folder with a `package.json` is a package (contexts, shared vendor clients, shared code), and so is every binary. Folders without one (`tests/`, `scripts/`) are skipped.
- `"private": true` — root is never published.
- `"catalog"` — pins shared dependency versions; leaf packages reference with `"catalog:"`. Pin Effect v4 exactly from the `latest` tag; `@rc` is a frozen pre-release with the old `effect/unstable/*` paths.
- `effect` in devDeps as `catalog:` — available for root-level tests.
- Lint/fmt run at root only (not per-package via turbo) — oxlint scans the whole tree in one pass.
- Type-aware Effect diagnostics ride along with `tsc --noEmit` (typecheck channel), so there's no separate `lint:effect` script. Never `tsgo --noEmit` — that binary is unpatched and reports zero Effect diagnostics (see tsgo.md §tsgo vs tsc).
- Fast AST/style Effect guidelines run in `oxlint` through `oxlint-plugin-effect/plugin`.
- `prepare` wires lefthook install + `effect-tsgo patch` — re-runs on every `bun install`.

### Lint strategy

| Script | Scope | What |
|--------|-------|------|
| `lint` | Root | `oxlint` — runs on entire tree with built-in rules, `oxlint-plugin-effect`, and the layout fence |
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
          "missingPipeableSignature": "off",
          "strictEffectProvide": "off"
        },
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["src/"] },
          { "target": "error", "pattern": "default", "skipLeadingPath": ["src/"] }
        ],
        "overrides": []
      }
    ],
    "paths": {
      "@scope/board/*": ["board/*"]
    }
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

> Use the full `diagnosticSeverity` map from SKILL.md — the snippet above only shows a few rules for brevity.

Key differences from single-package:
- `paths` — maps `@scope/<package>/*` → its folder for editor resolution (sibling to `plugins`, both inside `compilerOptions`). An import names the file: `@scope/board/errors` → `board/errors.ts`, `@scope/board/memory/events` → `board/memory/events.ts`. `cmd/` packages are never imported, so they need no entry.
- `"include": []` — root tsconfig is for editor/LSP only; leaf tsconfigs handle compilation by extending this one.
- `overrides` starts empty. If a monorepo later needs a genuinely path-scoped relaxation, that is where it goes. Do not add an override for `strictEffectProvide`; it is `"off"` globally (see tsgo.md §strictEffectProvide).

**Add every new importable package to `paths`.** Without it, the editor can't resolve workspace imports.

## Step 4: turbo.json

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "globalDependencies": ["tsconfig.json"],
  "tasks": {
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "inputs": ["**/*.ts", "**/*.tsx", "tsconfig.json", "$TURBO_ROOT$/tsconfig.json", "package.json"],
      "outputs": []
    },
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["**/*.ts", "**/*.tsx", "!**/*.test.ts", "tsconfig.json", "$TURBO_ROOT$/tsconfig.json", "package.json"],
      "outputs": ["dist/**"]
    },
    "test": {
      "inputs": ["**/*.ts", "**/*.tsx", "package.json"],
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

- Inputs are package-relative globs; a context's adapter and UI folders are part of its package, so a change in `board/postgres/` reruns board's tasks.
- `globalDependencies: ["tsconfig.json"]` — root tsconfig changes invalidate every task across the graph.
- `$TURBO_ROOT$/tsconfig.json` in inputs — the root tsconfig, at any package depth (`board/` and `cmd/standup/` differ by one level).
- `"dependsOn": ["^typecheck"]` — typecheck/build run dependencies first (topological order).
- `"cache": false` for tests — always re-run, cached results hide failures.
- Run one context: `turbo run test --filter=@scope/board`; every binary: `--filter='./cmd/*'`.

## Step 5: A context package

`board/package.json`:

```json
{
  "name": "@scope/board",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./*": "./*.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "peerDependencies": {
    "effect": "catalog:",
    "@effect/platform-bun": "catalog:"
  },
  "peerDependenciesMeta": {
    "@effect/platform-bun": { "optional": true }
  },
  "devDependencies": {
    "@effect/platform-bun": "catalog:"
  }
}
```

Key patterns:
- `"exports": { "./*": "./*.ts" }` — every file is reachable by its path, adapter folders included (`@scope/board/filestore/events`). Source-first, no build step, no barrel files.
- `"peerDependencies"` with `"catalog:"` — version comes from root catalog.
- A vendor or platform package that only an adapter folder uses (`@effect/platform-bun` for `filestore/`, `pg` for `postgres/`) is an optional peer, plus a dev dependency so the folder typechecks. The binary that binds the adapter lists it as a real dependency. The domain files never import it; the lint fence holds that (agent-fence.md §Import boundaries).
- `typecheck` uses `tsc` — the binary `effect-tsgo patch` patches (run by root `prepare`). Do not substitute `tsgo`; it is never patched.
- No per-package `lint` script — oxlint runs at root.

`board/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- Extends root — inherits the Effect plugin (with its `diagnosticSeverity` and `overrides`) automatically.
- `include` covers the domain files, the adapter folders and the tests beside them. Tests still get the relaxed rules from the root `overrides` block.

## Step 6: A binary

`cmd/standup/package.json`:

```json
{
  "name": "@scope/standup",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "bun run main.ts",
    "build": "bun run build.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@scope/board": "workspace:*",
    "@effect/platform-bun": "catalog:"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
```

- `"workspace:*"` — resolves to the local context package.
- The binary lists every vendor package it binds: it is the place that chooses implementations.
- No `exports`: nothing imports a binary.
- `main.ts` builds the Layer graph from the adapters it picks (`@scope/board/filestore/events`) and runs it (`BunRuntime.runMain`).

`cmd/standup/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
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
cmd/<binary>                 (platform-bun, vendor SDKs it binds)
  → <context>/<adapter>/     (memory, filestore, postgres, http, web, tui)
    → <context>/*.ts         (domain files: types, schemas, contracts; effect only)
  → <shared vendor client>   (postgres/: pool and migrations)
```

Rules:
- Domain files have **zero platform coupling** — only `effect` (and `@alchemy.run/domain` on the Domain path).
- Platform and vendor packages are optional peers of the context and dependencies of the binary that binds them.
- Contexts reach each other only through their contract and Api files.
- All shared version pins live in root `"catalog"`.

## Adding a New Package

| New | Where | Steps |
|-----|-------|-------|
| Adapter or UI for a context | a folder in the context, named after its dependency (`board/postgres/`) | Add the vendor as an optional peer and dev dependency of the context; add it as a dependency of each binary that binds it. No new package. |
| Context | a top-level folder (`billing/`) | `package.json` (Step 5) + `tsconfig.json` extending `../tsconfig.json`; `"@scope/billing/*": ["billing/*"]` in root `paths`; a fence override for its domain files (agent-fence.md). |
| Binary | `cmd/<name>/` | `package.json` (Step 6) + `tsconfig.json` extending `../../tsconfig.json`. |
| Shared vendor client or shared code | a top-level folder named after the vendor or the job (`postgres/`, `ui/`) | As a context, without domain files. |

Then run `bun install` to link.

## Checklist

- [ ] Root `package.json` with `workspaces: ["*", "cmd/*"]`, `catalog`, `gate` script, `prepare: lefthook install && effect-tsgo patch`
- [ ] Root `tsconfig.json` with `@effect/language-service` plugin (full `diagnosticSeverity` + `overrides` for tests + `paths` for every importable package)
- [ ] `turbo.json` with `globalDependencies: ["tsconfig.json"]`, package-relative inputs and `dependsOn` for typecheck/build
- [ ] `.oxlintrc.json` with `jsPlugins: ["oxlint-plugin-effect/plugin"]`, Effect guideline rules, `node/no-process-env`, and the layout fence (agent-fence.md §Import boundaries)
- [ ] `lefthook.yml`
- [ ] Each context: `exports: { "./*": "./*.ts" }`, `peerDependencies`, vendor SDKs as optional peers, extends root `tsconfig.json`
- [ ] Each binary under `cmd/`: `workspace:*` deps on its contexts, the vendors it binds as dependencies
- [ ] Each leaf has `"typecheck": "tsc --noEmit"` (no per-package lint) — no leaf script invokes `tsgo`
- [ ] `.gitignore` includes `.turbo/`
- [ ] `bun install` runs `prepare` and `effect-tsgo patch` succeeds
- [ ] `bun run gate` passes
