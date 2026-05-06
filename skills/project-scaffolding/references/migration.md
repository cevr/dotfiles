# Migrating to @effect/tsgo

For projects on the older `@effect/language-service` + standalone `tsc` (or pre-`@effect/tsgo` `tsgo`) shape. Targets the most common older configuration: separate `tsconfig.lsp.json` / `tsconfig.lsp.test.json`, `effect-language-service patch` in `prepare`, optional `oxlint-plugin-effect` / `tsgolint-effect`.

## TL;DR

```bash
# 1. Easiest: let the official setup do the work
npx @effect/tsgo setup
# Then manually delete tsconfig.lsp*.json and fold their settings into the new plugin block.

# 2. Or migrate by hand — follow this doc.
```

## What changes

| Old shape | New shape |
|-----------|-----------|
| `@effect/language-service` (npm) | `@effect/tsgo` (bundles tsgo + LSP) |
| `effect-language-service patch` in `prepare` | `effect-tsgo patch` in `prepare` |
| `tsconfig.json` (base) + `tsconfig.lsp.json` (Effect plugin) + `tsconfig.lsp.test.json` (relaxed) | Single `tsconfig.json` with plugin + `overrides` for tests |
| `tsgolint-effect` (Go binary) for type-aware Effect rules | (none — Effect rules now live in the `@effect/language-service` plugin embedded in `@effect/tsgo`) |
| `oxlint-plugin-effect` (66 AST rules) | (none — replaced by Effect plugin diagnostics) |
| `OXLINT_TSGOLINT_PATH=./node_modules/.bin/tsgolint-effect oxlint` | `oxlint` (auto-detects `oxlint-tsgolint`) |
| `tsgolint-effect` (binary) | `oxlint-tsgolint` (npm package) |
| Separate `lint:effect` turbo task | Effect rules ride along with `tsgo --noEmit` (typecheck channel); drop the task |
| `// @effect-diagnostics effect/strictEffectProvide:off` directive at top of test files | `plugins[].overrides[].include: ["**/*.test.ts", ...]` once in tsconfig |
| `.effect-lsp.json` (brief intermediate config) | (deleted — config returns to tsconfig plugin block) |

## Step 1: Update dependencies

```bash
bun remove @effect/language-service tsgolint-effect oxlint-plugin-effect
bun add -D @effect/tsgo @typescript/native-preview oxlint-tsgolint
```

`@typescript/native-preview` may already be installed — keep it. `@effect/tsgo` patches its bundled `tsgo` binary in place.

## Step 2: Update `prepare` script

```diff
 {
   "scripts": {
-    "prepare": "effect-language-service patch && lefthook install"
+    "prepare": "lefthook install && effect-tsgo patch"
   }
 }
```

Order matters only loosely — both succeed independently. Putting `lefthook install` first is conventional.

## Step 3: Drop the lsp tsconfig fan-out

Delete:
- `tsconfig.lsp.json`
- `tsconfig.lsp.test.json`
- `.effect-lsp.json` (if present)

Move all the Effect plugin settings into the single `tsconfig.json` at `compilerOptions.plugins[]`. See SKILL.md §tsconfig.json (base) for the canonical shape.

**Test relaxation** that lived in `tsconfig.lsp.test.json` now lives in the plugin's `overrides[]` array:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnosticSeverity": {
          "strictEffectProvide": "error",
          // ... rest of the rules
        },
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
  }
}
```

`overrides[].options.diagnosticSeverity` **merges** into the base map for matching files — only list the rules whose severity changes for tests, not the full map.

### Update leaf tsconfigs

Each leaf package's `tsconfig.json` extends the root:

```diff
 {
-  "extends": "../../tsconfig.lsp.json",
+  "extends": "../../tsconfig.json",
   "compilerOptions": { "noEmit": true },
   "include": ["src", "tests"]
 }
```

`tests` can be added to `include` now — the root `overrides` block applies to test files automatically.

## Step 4: Drop `// @effect-diagnostics` directives in test files

Search and remove top-of-file directives that the new `overrides` block now handles:

```bash
rg "@effect-diagnostics.*strictEffectProvide:off" --files-with-matches | xargs gsed -i '/@effect-diagnostics.*strictEffectProvide:off/d'
```

(Adjust the rule name list to match what your previous `tsconfig.lsp.test.json` relaxed.)

Per-file directives are still valid for one-off cases — only remove them where the new `overrides` glob already covers the file.

## Step 5: Simplify lint scripts

If your `package.json` had separate `lint:ox` / `lint:effect`:

```diff
 {
   "scripts": {
-    "lint:ox": "OXLINT_TSGOLINT_PATH=./node_modules/.bin/tsgolint-effect oxlint",
-    "lint:effect": "turbo run lint",
-    "lint": "concurrently -n ox,effect -c yellow,blue \"bun run lint:ox\" \"bun run lint:effect\"",
+    "lint": "oxlint",
     "lint:fix": "oxlint --fix"
   }
 }
```

`oxlint` auto-detects `oxlint-tsgolint` for `--type-aware` mode (controlled by `options.typeAware: true` in `.oxlintrc.json`) — no env var. Effect-specific diagnostics no longer come from oxlint at all; they ride along with `tsgo --noEmit`.

If you had a per-package `lint` script running `effect-language-service diagnostics --project tsconfig.json`, delete it. The diagnostics now happen during `typecheck`.

### Update turbo.json

```diff
 {
   "tasks": {
     "typecheck": {
       "dependsOn": ["^typecheck"],
-      "inputs": ["src/**/*.ts", "tsconfig.json", "../../tsconfig.lsp.json", "package.json"],
+      "inputs": ["src/**/*.ts", "tests/**/*.ts", "tsconfig.json", "../../tsconfig.json", "package.json"],
       "outputs": []
-    },
-    "lint": {
-      "inputs": ["src/**/*.ts", "tests/**/*.ts"],
-      "outputs": []
     }
   }
 }
```

Add `globalDependencies: ["tsconfig.json"]` at the turbo root so root-tsconfig changes invalidate every task.

## Step 6: Update `.oxlintrc.json`

```diff
 {
   "options": { "typeAware": true },
-  "plugins": ["typescript", "import", "node"],
-  "jsPlugins": ["oxlint-plugin-effect"],
   "rules": {
-    "effect/floatingEffect": "error",
-    "effect/missingEffectError": "error",
-    // ... 70+ effect/* rules
+    // typescript / import / node rules only — Effect rules moved to the tsgo plugin
   }
 }
```

Keep TypeScript / import / node rules. Drop every `effect/*` rule and the `oxlint-plugin-effect` plugin entry — those diagnostics now come from the Effect language service plugin embedded in `@effect/tsgo`, surfaced via `tsgo --noEmit`.

## Step 7: Update lefthook.yml

If your hook ran `lint:ox` / `lint:effect` separately:

```diff
 pre-commit:
-  parallel: true
+  parallel: false
   jobs:
-    - name: lint
-      run: bun run lint:ox && bun run lint:effect
-    - name: fmt
-      run: bun run fmt
+    - name: lint+fmt
+      run: bun run lint:fix && bun run fmt
+      stage_fixed: true
     - name: typecheck
       run: bun run typecheck
     - name: build
       run: bun run build
     - name: test
       run: bun run test
```

Sequential is preferred — parallel jobs trip on each other when lint stages files mid-typecheck.

## Step 8: Verify

```bash
rm -rf node_modules
bun install                  # triggers prepare → effect-tsgo patch
bun run typecheck            # should report Effect diagnostics inline
bun run lint                 # should run oxlint with type-aware rules
bun run gate                 # full pass
```

If `tsgo --noEmit` passes without surfacing any Effect diagnostics on code that previously failed, the patch didn't apply — re-run `bun run prepare` and check that `effect-tsgo patch` exits 0.

## Common migration pitfalls

- **`overrides` block at the wrong level** — it lives **inside the plugin object**, sibling to `diagnosticSeverity`. Putting it at `compilerOptions` root is silently ignored.
- **`overrides[].options` not `overrides[].compilerOptions`** — the inner key is `options`, mirroring the plugin's top-level option shape (`diagnosticSeverity`, `pipeableMinArgCount`, etc. all valid here).
- **Forgot to delete old `tsconfig.lsp.json`** — leaf packages still extending it inherit a stale config. Grep: `rg '"extends".*tsconfig\.lsp' .`
- **Forgot to drop `effect/*` rules from `.oxlintrc.json`** — oxlint will fail to find the plugin and error out.
- **`@typescript/native-preview` and `@effect/tsgo` version skew** — `effect-tsgo patch` errors if pinned versions don't match. Bump them together; `latest` for both is fine for personal projects.
- **Stacking `oxlint-plugin-effect` and `@effect/tsgo`** — produces duplicate diagnostics. Pick one (use `@effect/tsgo`).
