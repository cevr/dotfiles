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
| `tsgolint-effect` (Go binary) for type-aware Effect rules | (none — type-aware Effect rules now live in the `@effect/language-service` plugin embedded in `@effect/tsgo`) |
| Missing or legacy `oxlint-plugin-effect` wiring | Current `oxlint-plugin-effect` package loaded with `jsPlugins: ["oxlint-plugin-effect/plugin"]` |
| `OXLINT_TSGOLINT_PATH=./node_modules/.bin/tsgolint-effect oxlint` | `oxlint` |
| Separate `lint:effect` turbo task | Type-aware Effect rules ride along with `tsc --noEmit`; AST/style Effect rules run in oxlint |
| `// @effect-diagnostics effect/strictEffectProvide:off` directive at top of test files | Deleted — the directives are non-functional, and `strictEffectProvide` is `"off"` globally |
| `@effect/tsgo` unpinned / 0.13.x (patches the `tsgo` binary) | `@effect/tsgo` pinned `^0.24.3` (patches `tsc`) — `typecheck` calls `tsc --noEmit` |
| `.effect-lsp.json` (brief intermediate config) | (deleted — config returns to tsconfig plugin block) |

## Step 1: Update dependencies

```bash
bun remove @effect/language-service tsgolint-effect oxlint-tsgolint
bun add -D @effect/tsgo@^0.24.3 @typescript/native-preview oxlint-plugin-effect
```

**Pin `@effect/tsgo` at `^0.24.3` — do not use `latest` or an inherited older pin.** The patch target changed across majors: 0.13.x patched the `tsgo` binary inside `@typescript/native-preview` (leaving `tsgo.original*` backups), while >=0.24 patches the `typescript` package's `tsc` binary. A repo left on 0.13.x with a `tsc`-based typecheck script — or on 0.24 with a `tsgo`-based one — silently reports zero Effect diagnostics.

`@typescript/native-preview` may already be installed — keep it; it supplies the editor's `tsgo` LSP binary. At >=0.24 `effect-tsgo patch` does not touch it. Keep `oxlint-plugin-effect`; it is now the source of fast AST/style Effect rules.

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
          "strictEffectProvide": "off", // always off — see SKILL.md §strictEffectProvide
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
                // Only rules that genuinely need path-scoped relaxation.
                // Do NOT list strictEffectProvide — it is off globally.
                "someRuleYourTestsNeedRelaxed": "off"
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

## Step 4: Delete all `// @effect-diagnostics` directives

**They are non-functional.** Verified under the patched 0.24.3 `tsc`: neither the file-level nor the `-next-line` form suppresses any rule in the typecheck gate. Every such comment in an existing repo is dead weight that misleads the next reader into thinking a rule is handled.

Remove all of them, not just the `strictEffectProvide` ones:

```bash
rg "@effect-diagnostics" --files-with-matches | xargs gsed -i '/@effect-diagnostics/d'
```

Then re-run `typecheck`. Anything that surfaces was never actually suppressed — it was reported all along, or the rule is `"off"` in `diagnosticSeverity` and the comment was redundant. Fix findings via the `diagnosticSeverity` map or, rarely and with user approval, a file-scoped `overrides` entry.

Note that `strictEffectProvide` specifically is now `"off"` globally (see SKILL.md §strictEffectProvide), so test-file relaxations for it are unnecessary.

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

Plain `oxlint` loads `oxlint-plugin-effect/plugin` from `.oxlintrc.json`. Type-aware Effect diagnostics ride along with `tsc --noEmit`; AST/style Effect guidelines remain in oxlint.

If you had a per-package `lint` script running `effect-language-service diagnostics --project tsconfig.json`, delete it. The diagnostics now happen during `typecheck`.

### Flip `typecheck` from `tsgo` to `tsc`

**First confirm `@effect/tsgo` is >=0.24.** If the repo is on 0.13.x, `patch` targeted the `tsgo` binary, and flipping the script to `tsc` would *remove* the diagnostics rather than restore them. Bump to `^0.24.3` (Step 1), re-run `effect-tsgo patch`, and **read the patch output line — it names the exact binary it patched.** The `typecheck` script must invoke that binary. A leftover `tsgo.original*` file next to the `tsgo` bin is the fingerprint of an un-migrated 0.13 install.

Once on >=0.24, change every `typecheck` script — at the root and in **every** leaf package:

```diff
-    "typecheck": "tsgo --noEmit",
+    "typecheck": "tsc --noEmit",
```

`effect-tsgo patch` only patches the `tsc` binary. The `tsgo` bin from `@typescript/native-preview` is never patched, so a `tsgo --noEmit` script exits 0 while reporting **zero** Effect diagnostics. Sweep for stragglers:

```bash
rg '"typecheck".*tsgo' .
```

**Expect newly revealed diagnostics.** A repo that has been typechecking via `tsgo` has never once run the Effect rules, so the first `tsc --noEmit` can surface a large backlog (`floatingEffect`, `leakingRequirements`, `missingEffectContext`, ...). That is the migration working, not a regression. Fix the findings or stage them by temporarily lowering specific rules to `"warning"` in `diagnosticSeverity` — do not go back to `tsgo`.

Keep `@typescript/native-preview` in devDeps; the editor's `tsgo` LSP binary comes from it.

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
  "plugins": ["typescript", "import", "node"],
-  "jsPlugins": ["old-effect-plugin-path"],
+  "jsPlugins": ["oxlint-plugin-effect/plugin"],
  "rules": {
+    "effect/noAsyncFunction": "error",
+    "effect/noDynamicImports": "error",
+    "effect/noEffectBind": "error",
+    "effect/noEffectDo": "error",
+    "effect/noGlobals": "error",
+    "effect/noNewError": "error",
+    "effect/noNewPromise": "error",
+    "effect/noNodeBuiltinImport": "error",
+    "effect/noTernary": "error",
+    "effect/noTestLifecycleHooks": "error",
+    "effect/noThrowStatement": "error",
+    "effect/noTryCatch": "error"
  }
}
```

Keep TypeScript / import / node rules. Replace legacy Effect plugin paths and old `effect/*` names with the 12-rule `recommended` set above (`oxlint-plugin-effect` >=0.4.0 deleted the old rule namespace — stale names fail config resolution). Do not add escape-hatch overrides for `noGlobals` / `noNodeBuiltinImport` — route runtime access through `@effect/platform-bun` services or custom service layers instead (see SKILL.md §Runtime Access). Do not add `options.typeAware` unless the project intentionally installs a compatible type-aware oxlint bridge; `@effect/tsgo` is the default type-aware Effect channel.

Then flip the 19 tsgo diagnostics the preset duplicates to `"off"` in `tsconfig.json` (see SKILL.md §Effect Lint Layering) — otherwise every violation reports twice.

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
bun run lint                 # should run oxlint and load oxlint-plugin-effect
bun run gate                 # full pass
```

If `tsc --noEmit` passes without surfacing any Effect diagnostics on code that previously failed, either the patch didn't apply or the script still calls `tsgo`. Check both: confirm `effect-tsgo patch` exits 0 after `bun run prepare`, and confirm no `typecheck` script invokes `tsgo` (`rg '"typecheck".*tsgo' .`).

## Common migration pitfalls

- **`overrides` block at the wrong level** — it lives **inside the plugin object**, sibling to `diagnosticSeverity`. Putting it at `compilerOptions` root is silently ignored.
- **`overrides[].options` not `overrides[].compilerOptions`** — the inner key is `options`, mirroring the plugin's top-level option shape (`diagnosticSeverity`, `pipeableMinArgCount`, etc. all valid here).
- **Forgot to delete old `tsconfig.lsp.json`** — leaf packages still extending it inherit a stale config. Grep: `rg '"extends".*tsconfig\.lsp' .`
- **Forgot to install `oxlint-plugin-effect`** — oxlint will fail to load `oxlint-plugin-effect/plugin`.
- **`@typescript/native-preview` and `@effect/tsgo` version skew** — `effect-tsgo patch` errors if pinned versions don't match. Bump them together. Pin `@effect/tsgo` at `^0.24.3` rather than `latest`, so a future major cannot silently move the patch target again.
- **Migrating a 0.13.x repo without bumping first** — on 0.13.x the patched binary is `tsgo`, not `tsc`. Flipping the script to `tsc --noEmit` before bumping swaps one silent-zero-diagnostics setup for another. Bump, re-patch, read the patch output, then set the script.
- **Using old rule names** — the current package (>=0.4.0) ships only the 12 `recommended` rules (`effect/noTryCatch`, `effect/noAsyncFunction`, ...). Pre-0.4 names like `effect/noSchemaStruct` and language-service diagnostic names like `effect/missingEffectError` both fail config resolution.
