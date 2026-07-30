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
| Templates | `templates/` | Copy-pasteable `tsconfig.json`, `.oxlintrc.json`, `lefthook.yml`, `turbo.json`, `release.yml`, `ci.yml` |
| Tooling configs | §Tooling Stack | Adding oxlint, oxfmt, lefthook, tsconfig |
| Publishing | §Publishing | npm publishing, changesets, GitHub Actions |
| TS6 / tsgo | §TS6 / tsgo | TypeScript 6 defaults, native compiler |

## Tooling Stack

Every project uses this base. No exceptions.

| Tool | Purpose | Config |
|------|---------|--------|
| **bun** | Runtime, package manager, test runner, bundler | `bun.lock` |
| **@effect/tsgo** | Effect Language Service bundle (`effect-tsgo` binary, patches the `tsc` binary of `typescript`) | `tsconfig.json` `plugins` |
| **@typescript/native-preview** | Editor `tsgo` LSP binary — **not** the typecheck channel, never patched | — |
| **typescript** | Owns the `tsc` binary that `effect-tsgo patch` patches — this is the typecheck channel | — |
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
          "asyncFunction": "off",
          "catchAllToMapError": "error",
          "catchToIgnore": "error",
          "catchToOrElseSucceed": "error",
          "catchUnfailableEffect": "error",
          "classSelfMismatch": "error",
          "cryptoRandomUUID": "off",
          "cryptoRandomUUIDInEffect": "off",
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
          "flatMapToMap": "error",
          "floatingEffect": "error",
          "genericEffectServices": "error",
          "globalConsole": "off",
          "globalConsoleInEffect": "off",
          "globalDate": "off",
          "globalDateInEffect": "off",
          "globalErrorInEffectCatch": "error",
          "globalErrorInEffectFailure": "error",
          "globalFetch": "off",
          "globalFetchInEffect": "off",
          "globalRandom": "off",
          "globalRandomInEffect": "off",
          "globalTimers": "off",
          "globalTimersInEffect": "off",
          "instanceOfSchema": "error",
          "layerMergeAllWithDependencies": "error",
          "lazyEffect": "error",
          "lazyPromiseInEffectSync": "error",
          "leakingRequirements": "error",
          "missedPipeableOpportunity": "off",
          "missingEffectContext": "error",
          "missingEffectError": "error",
          "missingEffectServiceDependency": "error",
          "missingLayerContext": "error",
          "missingPipeableSignature": "error",
          "missingReturnYieldStar": "error",
          "missingStarInYieldEffectGen": "error",
          "multipleCatchTag": "error",
          "multipleEffectProvide": "error",
          "nestedEffectGenYield": "error",
          "newPromise": "off",
          "newSchemaClass": "error",
          "nodeBuiltinImport": "off",
          "nonObjectEffectServiceType": "error",
          "outdatedApi": "error",
          "overriddenSchemaConstructor": "error",
          "preferSchemaOverJson": "off",
          "processEnv": "off",
          "processEnvInEffect": "off",
          "redundantMapError": "error",
          "redundantOrDie": "error",
          "redundantSchemaTagIdentifier": "error",
          "returnEffectInGen": "error",
          "runEffectInsideEffect": "error",
          "schemaNumber": "error",
          "schemaOpaqueInstanceMember": "error",
          "schemaStructWithTag": "error",
          "schemaSyncInEffect": "error",
          "schemaUnionOfLiterals": "error",
          "scopeInLayerEffect": "error",
          "serviceNotAsClass": "error",
          "strictBooleanExpressions": "off",
          "strictEffectProvide": "off",
          "syncToSucceed": "error",
          "tryCatchInEffectGen": "off",
          "unknownInEffectCatch": "error",
          "unnecessaryArrowBlock": "error",
          "unnecessaryEffectGen": "error",
          "unnecessaryFailYieldableError": "error",
          "unnecessaryPipe": "off",
          "unnecessaryPipeChain": "off",
          "unnecessaryTypeofType": "error",
          "unsafeEffectTypeAssertion": "error"
        },
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["src/", "packages/"] },
          { "target": "error", "pattern": "default", "skipLeadingPath": ["src/", "packages/"] }
        ],
        "overrides": []
      }
    ]
  },
  "include": [],
  "exclude": ["node_modules"]
}
```

**Why this shape:**
- Most `"off"` entries are not disabled checks — they are diagnostics owned by `oxlint-plugin-effect` (see §Effect Lint Layering). Turning them off here prevents every violation from being reported twice.
- **`strictEffectProvide` is `"off"` for a different reason — see §strictEffectProvide below.** It is not a duplicate of an oxlint rule; it is structurally unsatisfiable.
- `overrides` starts empty. Add entries only when a real need appears; do not pre-populate a tests-only relaxation.
- `plugins[].overrides[].include` — glob patterns. The plugin merges options for files matching `include`. This is the supported way to relax individual rules in tests/integration code without forking tsconfigs.
- `plugins[].overrides[]` also accepts `exclude` globs alongside `include` and `options`.
- `keyPatterns` — controls `deterministicKeys` rule. Skip-leading-path values (`src/`, `packages/`) make it ignore those prefixes when computing identifiers.
- `strict: true`, `target`, `module`, etc. are kept explicit even though TS6 defaults them — survives downgrades and `tsc --showConfig` clarity.

**Monorepo**: add `paths` mapping for workspace packages alongside the plugin block.

### .oxlintrc.json

Standard style + correctness rules. Effect-specific lint is split by layer (see §Effect Lint Layering):
- `@effect/tsgo` owns type-aware Effect diagnostics during `typecheck`.
- `oxlint-plugin-effect` owns unconditional AST/syntax rules during `lint`. Since 0.4.0 the plugin ships ONE preset — `recommended` — with exactly 12 rules, all `error`. The old rule namespace (`noSpread`, `noSchemaStruct`, `noMakeUnsafe`, `noHandRolledTaggedUnion`, ...) was deleted; those names now fail config resolution.

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
    "effect/noAsyncFunction": "error",
    "effect/noDynamicImports": "error",
    "effect/noEffectBind": "error",
    "effect/noEffectDo": "error",
    "effect/noGlobals": "error",
    "effect/noNewError": "error",
    "effect/noNewPromise": "error",
    "effect/noNodeBuiltinImport": "error",
    "effect/noTernary": "error",
    "effect/noTestLifecycleHooks": "error",
    "effect/noThrowStatement": "error",
    "effect/noTryCatch": "error"
  },
  "ignorePatterns": ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/bin/**", "**/scripts/**"]
}
```

Use `templates/.oxlintrc.json` for the full config with overrides. Keep rule names explicit in JSON configs; oxlint does not load exported preset objects from package code (TS/JS configs can `import { recommended } from "oxlint-plugin-effect/presets/recommended"`).

**Config filename is `.oxlintrc.json`** — not `oxlint.json`. **JS plugins load through `jsPlugins`** — `"plugins": ["effect"]` silently loads nothing (`plugins` is oxlint's built-in plugin list); the correct wiring is `"jsPlugins": ["oxlint-plugin-effect/plugin"]`.

### Effect Lint Layering

The ownership contract between the two Effect lint channels:

| Channel | Owns | Examples |
|---------|------|----------|
| `oxlint-plugin-effect` (lint) | Unconditional syntax — bans that need no type info | async/await, try/catch, throw, `new Promise`, `new Error`, ternary, dynamic import, `Effect.Do`/`bind`, globals, node builtin imports, test lifecycle hooks |
| `@effect/tsgo` (typecheck) | Type-aware semantics | `floatingEffect`, `runEffectInsideEffect`, `strictEffectProvide`, `extendsNativeError`, `unsafeEffectTypeAssertion`, `leakingRequirements`, `missingEffectContext`/`Error`, `missingLayerContext` |

The seam is the 19-diagnostic off-list in `templates/tsconfig.json` (`asyncFunction`, `cryptoRandomUUID`, `cryptoRandomUUIDInEffect`, `globalConsole`, `globalConsoleInEffect`, `globalDate`, `globalDateInEffect`, `globalFetch`, `globalFetchInEffect`, `globalRandom`, `globalRandomInEffect`, `globalTimers`, `globalTimersInEffect`, `newPromise`, `nodeBuiltinImport`, `preferSchemaOverJson`, `processEnv`, `processEnvInEffect`, `tryCatchInEffectGen`). These are duplicated by the oxlint preset; leaving them on in tsgo double-reports every violation. If a project drops `oxlint-plugin-effect`, flip them back to `error`.

### Runtime Access — No Lint Escape Hatches

`effect/noGlobals` and `effect/noNodeBuiltinImport` stay at `error` everywhere. There is no `src/platform/**` override directory and no per-file rule disabling. Code that needs the runtime reaches it through Effect:

- **Built-in platform services first**: `@effect/platform-bun` (`BunServices.layer`) provides `FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient`, terminal, sockets; core `effect` provides `Clock`, `Random`, `Console`, `Config`. Acquire them with `yield*` inside `Effect.gen` — never touch `process`, `fetch`, `Date`, or `node:*` directly.
- **Custom services otherwise**: when no built-in exists, define a `Context.Service` with the shape interface, then ship runtime-specific implementation layers (`layerBun`, `layerNode`) that wrap the primitive. The layer file is still lint-clean because the primitive arrives through the platform services or the service constructor, not through globals.

If a rule fires, the fix is to route the access through a service — not to widen the lint config.

### lefthook.yml

```yaml
pre-commit:
  parallel: false
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

Sequential (`parallel: false`) pre-commit with a single combined lint+fmt job: lint runs first (may rewrite source) then fmt formats the result. Sequential ordering eliminates the staging race — with parallel jobs, lint+fmt stages files while typecheck reads them mid-flight. `fmt` not `fmt:check` — we want stage-fixed formatting on commit, not a check failure.

Alternative for repos whose `gate` already covers all lanes: a single job `run: bun run gate` with `parallel: true` at the hook level — simpler, and no staging race because there is only one job.

### Scripts (single-package)

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
    "gate": "concurrently -n type,style,build,test -c blue,yellow,cyan,green \"bun run typecheck\" \"bun run lint && bun run fmt\" \"bun run build\" \"bun run test\"",
    "prepare": "lefthook install && effect-tsgo patch"
  }
}
```

`prepare` wires both lefthook install and the `effect-tsgo patch` step. `patch` targets the `tsc` binary of the `typescript` package — so the `typecheck` script must call `tsc --noEmit`, never `tsgo --noEmit`. See §tsgo vs tsc.

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

Lint/fmt at root only — oxlint scans the whole tree in one pass. No `turbo run lint` fan-out: `oxlint-plugin-effect` handles fast AST rules in the root lint pass, and type-aware Effect diagnostics ride along with `tsc --noEmit`.

### Scripts (monorepo leaf package)

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test tests/"
  }
}
```

### Dev Dependencies (base)

Always `bun add -D` with **latest versions** — check npm before installing, never hardcode version pins (this list is for grouping, not pinning). **One exception: `@effect/tsgo` is pinned `^0.24.3`** — see below.

```
@effect/tsgo@^0.24.3
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

- `@effect/tsgo` ships the `effect-tsgo` CLI (used by the `prepare` script's `patch` command). At `^0.24.3` — the pinned range — `patch` rewrites the `tsc` binary of the `typescript` package in place so `tsc` emits Effect diagnostics. **Pin it.** 0.13.x patched a different binary (`tsgo`), so an unpinned install can silently move the patch target out from under the `typecheck` script.
- `typescript` is the typecheck channel. Under `typescript@7`, `tsc` already resolves to the native Go compiler, so `tsc --noEmit` is both patched and fast.
- `@typescript/native-preview` stays installed for the editor's `tsgo` LSP binary. **`effect-tsgo patch` never touches it** — do not point any script at `tsgo`.
- `oxlint-plugin-effect` provides the `effect/*` oxlint rules used for Effect style and project guidelines. Configure it with `jsPlugins: ["oxlint-plugin-effect/plugin"]`.

### Runtime Dependencies (Effect v4)

**`bun add effect` installs v3.** The npm `latest` dist-tag points at Effect 3.x; v4 lives on the `beta` tag. Every Effect-4 project must install explicitly:

```bash
bun add effect@beta @effect/platform-bun@beta
```

and pin the resolved version exactly (no caret) in `package.json` — e.g. `"effect": "4.0.0-beta.102"` — so a re-install cannot silently drift across beta releases.

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

### GitHub Actions

Copy `templates/release.yml` and `templates/ci.yml` **verbatim** — they are byte-identical copies of proven, shipping workflows (`effect-oxlint` release, `effect-machine` CI). Do not hand-edit the changesets flow; it is exactly what publishes today.

`templates/release.yml` highlights:
- `env: LEFTHOOK: 0` on the release job — without it, `bun install` runs `prepare` → `lefthook install` in CI.
- `sudo npm install -g npm@latest` — required for npm OIDC trusted publishing.
- `NPM_TOKEN: ""` — empty on purpose; OIDC provenance replaces the token.
- `changesets/action@v1` with `publish: bun run release` / `version: bun run version`.

`templates/ci.yml` runs typecheck, lint, fmt, and test on push/PR to main. Swap the `Format` step to `bun run fmt:check` if CI should fail on unformatted code instead of formatting in place.

**Important**: `repository.url` in `package.json` must match the GitHub repo — npm provenance verification requires it.

## Conventions

| Convention | Rule |
|-----------|------|
| Package manager | bun (always) |
| Module system | `"type": "module"` |
| TypeScript | `noEmit: true` — never compile, bun runs source directly |
| Type checker | `tsc --noEmit` — the `tsc` binary is what `effect-tsgo patch` patches. Never `tsgo --noEmit`. |
| Exports | `"exports": { ".": "./src/index.ts" }` — source-first, no build step for local dev |
| Tests | `bun test` with `effect-bun-test` for Effect integration |
| Tracing | `Effect.fn("ServiceName.methodName")` on all service methods |
| Quality gate | `bun run gate` before any commit/PR/ship |
| Git hooks | lefthook pre-commit runs lint+fmt (single chained job), typecheck, build, test sequentially (`parallel: false`) |
| Effect diagnostics | `@effect/tsgo` plugin in `tsconfig.json` for type-aware diagnostics; `oxlint-plugin-effect` in `.oxlintrc.json` for AST/style guidelines |
| Test relaxation | `plugins[].overrides[].include` glob with `options.diagnosticSeverity` map (no separate test tsconfig) |
| Lint scripts | Single `oxlint` at root with `oxlint-plugin-effect/plugin` loaded through `jsPlugins` |
| Monorepo orchestration | turbo for typecheck/build/test, oxlint at root |
| Version catalog | `"catalog": {}` in root `package.json` for monorepos — pins shared dep versions |

## TS6 / tsgo

TypeScript 6 changes some defaults, but production projects keep options explicit (target, module, moduleResolution) for clarity and downgrade safety. The native compiler still requires `noEmit` — it doesn't emit yet.

### What `effect-tsgo patch` actually patches

`@effect/tsgo` ships the `effect-tsgo` CLI. Its `patch` command rewrites a compiler binary in place so the binary loads the Effect language service and reports Effect diagnostics.

**The patch target is version-dependent.** This is the single most important thing to get right, because picking the wrong binary fails silently.

| `@effect/tsgo` | Patches | Backup artifacts |
|----------------|---------|------------------|
| 0.13.x | `@typescript/native-preview/.../lib/tsgo` | `tsgo.original*` |
| >=0.24 | the `typescript` package's `tsc` binary | — |

**Pin `^0.24.3` and call `tsc --noEmit`.** At >=0.24 the dist source's patch target list is:

```
defaultTypescriptPackageNames = ["typescript", "@typescript/native"]
```

...and the platform package it resolves ships `lib/tsc`. Note what is *absent*: `@typescript/native-preview`, the package that provides `tsgo`. At >=0.24 `patch` never touches it, so a script calling `tsgo --noEmit` type-checks normally and silently reports **zero** Effect diagnostics — no error, no warning, just missing findings.

Empirically confirmed on 0.24.3: `bun x tsgo --noEmit` printed nothing, while `bun x tsc --noEmit` surfaced real `effect(...)` diagnostics including a deliberately planted error.

**Never infer the binary — read it.** `effect-tsgo patch` prints the exact path it patched. That output line is authoritative for the installed version; the `typecheck` script must invoke that binary. If you inherit a repo on <0.24, bump to `^0.24.3` first, re-run `patch`, then set the script from what it printed.

There is also no speed argument for `tsgo`. Under `typescript@7`, `tsc` already resolves to the native Go compiler, so `tsc --noEmit` is the fast path *and* the patched path.

`effect-tsgo` subcommands: `patch`, `unpatch`, `get-exe-path`, `diagnostics`, `setup`, `config`. `config` is an interactive severity picker that regenerates the `diagnosticSeverity` map from the installed schema — use it after bumping `@effect/tsgo` to pick up newly added diagnostics instead of diffing by hand.

Keep `@typescript/native-preview` installed — the editor's `tsgo` LSP binary comes from it. Just never route a `typecheck` script through it.

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

For new projects, copy the configs from §Tooling Stack directly. Then pin `"@effect/tsgo": "^0.24.3"` — `setup` may install an older major whose patch target is `tsgo`, not `tsc`.

### strictEffectProvide

**Keep it `"off"`.** It is the one rule in the canonical map disabled for a correctness reason rather than to avoid double-reporting.

The rule has no entry-point detection. Every program must terminate its context somewhere, and that terminal `Effect.provide` is exactly the shape the rule flags. The canonical entry point —

```typescript
program.pipe(Effect.provide(MainLayer), BunRuntime.runMain)
```

— is verified unsatisfiable: there is no rewrite that both keeps the program runnable and quiets the rule. Upstream agrees; the rule's own `defaultSeverity` is already `"off"`. With `ignoreEffectWarningsInTscExitCode: false` (our template), leaving it at `"error"` makes `typecheck` permanently red in any project that actually runs.

Turning it off costs nothing real: genuine chained-provide misuse is still caught by **`multipleEffectProvide`**, which stays at its template severity.

Because it is off globally, a tests-only `overrides` entry for it is redundant — remove any you find.

### `@effect-diagnostics` comments do not work

**Suppression comments are non-functional under the patched 0.24.3 `tsc` binary.** Both forms were tested and neither suppresses anything in the typecheck gate:

```typescript
// @effect-diagnostics effect/someRule:off            // file-level — no effect
// @effect-diagnostics-next-line effect/someRule:off  // next-line — no effect
```

They are silently ignored: the diagnostic still fires and still fails the gate.

The only sanctioned suppression mechanisms are:
1. The `diagnosticSeverity` map in `tsconfig.json` — the default answer.
2. A file-scoped `plugins[].overrides[]` entry — rare, and requires user approval since it relaxes a rule for whole paths.

Never write guidance or code that leans on a suppression comment. Existing repos may carry dead `@effect-diagnostics` comments from older versions — they are inert and should be deleted during migration.

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

**Always `tsc`. Never `tsgo`.**

| | `tsc` | `tsgo` |
|-|-------|--------|
| Binary | `node_modules/.bin/tsc` | `node_modules/.bin/tsgo` |
| Package | `typescript` | `@typescript/native-preview` |
| Patched by `effect-tsgo patch` | **Yes** — it is the patch target | **No** — not in `defaultTypescriptPackageNames` |
| Effect diagnostics | **All of them** | **None** — silently reports zero |
| Speed | Native Go compiler under `typescript@7` | Native Go compiler |
| Use for | `typecheck` script, CI, hooks | Editor LSP only |

Under `typescript@7` both binaries are the same native Go compiler, so `tsgo` buys no speed. It only costs you every Effect diagnostic.

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

- **Typecheck scripts MUST call `tsc --noEmit`, never `tsgo --noEmit`** — at `@effect/tsgo` >=0.24, `patch` only patches the `tsc` binary (`defaultTypescriptPackageNames = ["typescript", "@typescript/native"]`, and the platform package ships `lib/tsc`). The `tsgo` bin comes from `@typescript/native-preview` and is never patched, so `tsgo --noEmit` silently reports **zero** Effect diagnostics — it exits 0 on code full of violations. Keep `@typescript/native-preview` installed for the editor LSP, but never route a script through it. Under `typescript@7` `tsc` is already the native Go compiler, so there is no speed cost.
- **The patch target changed across `@effect/tsgo` majors — pin `^0.24.3`** — 0.13.x patched `@typescript/native-preview/.../lib/tsgo` (leaving `tsgo.original*` backups), >=0.24 patches `tsc`. So "which binary do I call?" has no version-independent answer. On any repo below 0.24: bump first, re-run `effect-tsgo patch`, and read its output line — it names the exact binary it patched, and that is the binary `typecheck` must invoke. Stale `tsgo.original*` files are a fingerprint of an un-migrated 0.13 install.
- **`strictEffectProvide` must be `"off"`** — the rule has no entry-point detection, so it fires unavoidably on every real entry point (`Effect.provide` + `BunRuntime.runMain` is verified unsatisfiable). Its upstream `defaultSeverity` is already `"off"`, and with `ignoreEffectWarningsInTscExitCode: false` leaving it on makes `typecheck` permanently red. `multipleEffectProvide` still catches genuine chained-provide misuse. A tests-only override for it is redundant once it is off globally.
- **`@effect-diagnostics` suppression comments are non-functional** — verified under the patched 0.24.3 `tsc`: neither the file-level nor the `-next-line` form suppresses any rule in the typecheck gate. They are silently ignored. Use the `diagnosticSeverity` map, or (rarely, with user approval) a file-scoped `overrides` entry. Delete dead `@effect-diagnostics` comments when migrating older repos.
- **`effect-tsgo patch` must run after install** — wire it into `prepare` so `bun install` rebuilds the patched binary. Without the patch, `tsc --noEmit` runs without Effect diagnostics.
- **`tsdown` must be >=0.22.14 under `typescript@7`** — older `rolldown-plugin-dts` crashes with `ts.sys.useCaseSensitiveFileNames` (TS7 removed `ts.sys`). 0.22.14 works but prints a harmless `TypeScript 7.0 ... experimental` warning.
- **Don't add a separate `tsconfig.test.json`** — relax test rules via the plugin's `overrides[].include` array. Keeps a single source of truth and avoids tsconfig fan-out.
- **`overrides` is plugin-scoped, not tsconfig-scoped** — it lives inside the `@effect/language-service` plugin object's options, not at the tsconfig root. Sibling to `diagnosticSeverity`.
- **`overrides[].options.diagnosticSeverity` merges, not replaces** — only list rules whose severity changes for matching files.
- **`types: ["bun"]` required** — TS6 defaults `types` to `[]` in some configs. Without it, `Bun.*` globals are invisible.
- **`oxlint-plugin-effect` must be a devDep when `.oxlintrc.json` lists `jsPlugins: ["oxlint-plugin-effect/plugin"]`** — otherwise `oxlint` cannot load the `effect/*` rules.
- **`"plugins": ["effect"]` loads nothing** — `plugins` is oxlint's built-in plugin list; JS plugins go in `jsPlugins`. The misconfiguration is silent: oxlint runs fine with zero `effect/*` rules active. Check the rule count in `oxlint`'s summary line.
- **`bun add effect` installs v3** — the `latest` dist-tag is Effect 3.x. Use `effect@beta` + `@effect/platform-bun@beta` and pin exact versions for v4 projects.
- **`oxlint-plugin-effect` >=0.4.0 has one 12-rule `recommended` preset** — pre-0.4 rule names (`noSpread`, `noSchemaStruct`, `noMakeUnsafe`, ...) were deleted and fail config resolution. Bump the dep and rewrite the rules block together.
- **`diagnosticSeverity` drifts as `@effect/tsgo` adds diagnostics** — after bumping, diff your map against `node_modules/@effect/tsgo/schema.json` (definition `effectLanguageServicePluginDiagnosticSeverityDefinition`) or run `effect-tsgo config`.
- **Do not use legacy `tsgolint-effect` or env-var lint wiring** — the current shape is plain `oxlint` plus `oxlint-plugin-effect` for AST rules and `tsc --noEmit` for type-aware Effect diagnostics.
- **`@effect/tsgo` and `@typescript/native-preview` versions are coupled** — `effect-tsgo patch` validates compatibility. Bump them together; if `patch` errors after an upgrade, update both pkgs.
- **`repository.url` required for npm provenance** — publish will 422 without it.
- **`noUncheckedIndexedAccess`** — array/record indexing returns `T | undefined`. Use `??` or guards, not `!`.
- **Monorepo `paths`** — root `tsconfig.json` maps `@scope/pkg` → `packages/pkg/src/index.ts`. Without this, the editor can't resolve workspace packages.
- **`catalog:` in peerDependencies** — bun workspace catalog protocol. Only works in monorepo root.
- **`turbo.json` test cache** — always `"cache": false` for tests. Cached test results hide real failures.
- **`turbo.json` typecheck inputs** — include `tsconfig.json` and `../../tsconfig.json` so plugin/severity changes invalidate cache.
- **`downlevelIteration` is a hard error in TS6** — remove it entirely, don't set to `false`.
- **`baseUrl` deprecated in TS6** — inline the value into `paths` entries instead.
