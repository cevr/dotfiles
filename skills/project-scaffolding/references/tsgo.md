# TS6 / tsgo

How the typecheck channel works: what `effect-tsgo patch` patches, `@effect/tsgo setup`, why `strictEffectProvide` is off, how `@effect-diagnostics` suppression comments work, TS6 deprecations, and `tsc` versus `tsgo`.

TypeScript 6 changes some defaults, but production projects keep options explicit (target, module, moduleResolution) for clarity and downgrade safety. The native compiler still requires `noEmit` — it doesn't emit yet.

## What `effect-tsgo patch` actually patches

`@effect/tsgo` ships the `effect-tsgo` CLI. Its `patch` command rewrites a compiler binary in place so the binary loads the Effect language service and reports Effect diagnostics.

**The patch target is version-dependent.** This is the single most important thing to get right, because picking the wrong binary fails silently.

| `@effect/tsgo` | Patches | Backup artifacts |
|----------------|---------|------------------|
| 0.13.x | `@typescript/native-preview/.../lib/tsgo` | `tsgo.original*` |
| >=0.24 | the `typescript` package's `tsc` binary | — |

**Pin it exactly (`0.46.1` today) and call `tsc --noEmit`.** At >=0.24 the dist source's patch target list is:

```
defaultTypescriptPackageNames = ["typescript", "@typescript/native"]
```

...and the platform package it resolves ships `lib/tsc`. Note what is *absent*: `@typescript/native-preview`, the package that provides `tsgo`. At >=0.24 `patch` never touches it, so a script calling `tsgo --noEmit` type-checks normally and silently reports **zero** Effect diagnostics — no error, no warning, just missing findings.

Empirically confirmed on 0.24.3, and still true on 0.46.1: `bun x tsgo --noEmit` printed nothing, while `bun x tsc --noEmit` surfaced real `effect(...)` diagnostics including a deliberately planted error.

**Never infer the binary — read it.** `effect-tsgo patch` prints the exact path it patched. That output line is authoritative for the installed version; the `typecheck` script must invoke that binary. If you inherit a repo on <0.24, bump to the current minor first, re-run `patch`, then set the script from what it printed.

There is also no speed argument for `tsgo`. Under `typescript@7`, `tsc` already resolves to the native Go compiler, so `tsc --noEmit` is the fast path *and* the patched path.

`effect-tsgo` subcommands: `patch`, `unpatch`, `get-exe-path`, `diagnostics`, `setup`, `config`. `config` is an interactive severity picker that regenerates the `diagnosticSeverity` map from the installed schema — use it after bumping `@effect/tsgo` to pick up newly added diagnostics instead of diffing by hand.

Keep `@typescript/native-preview` installed — the editor's `tsgo` LSP binary comes from it. Just never route a `typecheck` script through it.

## What `@effect/tsgo setup` does

If starting from scratch on an existing project:

```bash
npx @effect/tsgo setup
```

This:
1. Adds `@effect/tsgo` and `@typescript/native-preview` to devDeps.
2. Adds the `@effect/language-service` plugin entry to `tsconfig.json`.
3. Adds `effect-tsgo patch` to the `prepare` script.
4. Optionally writes `.vscode/settings.json` to enable the native TS server.

For new projects, copy the configs from §Tooling Stack directly. Then pin `"@effect/tsgo": "0.46.1"` exactly — `setup` may install an older major whose patch target is `tsgo`, not `tsc`.

## strictEffectProvide

**Keep it `"off"`.** It is the one rule in the canonical map disabled for a correctness reason rather than to avoid double-reporting.

The rule has no entry-point detection. Every program must terminate its context somewhere, and that terminal `Effect.provide` is exactly the shape the rule flags. The canonical entry point —

```typescript
program.pipe(Effect.provide(MainLayer), BunRuntime.runMain)
```

— is verified unsatisfiable: there is no rewrite that both keeps the program runnable and quiets the rule. Upstream agrees; the rule's own `defaultSeverity` is already `"off"`. With `ignoreEffectWarningsInTscExitCode: false` (our template), leaving it at `"error"` makes `typecheck` permanently red in any project that actually runs.

Turning it off costs nothing real: genuine chained-provide misuse is still caught by **`multipleEffectProvide`**, which stays at its template severity.

Because it is off globally, a tests-only `overrides` entry for it is redundant — remove any you find.

## `@effect-diagnostics` comments: bare rule names only

Suppression comments work under the patched `tsc` when the rule name is bare. The `effect/` prefix silently disables the comment. Verified on `@effect/tsgo` 0.46.1:

```typescript
// @effect-diagnostics-next-line asyncFunction:off -- SDK exposes only a Promise API  // works
// @effect-diagnostics asyncFunction:off                                             // works (file-level)
// @effect-diagnostics-next-line effect/asyncFunction:off                            // ignored, rule still fires
```

The earlier "comments never work" finding came from the prefixed form.

Choose the narrowest mechanism that fits:

1. Fix the code: route the access through a service or adapter.
2. `// @effect-diagnostics-next-line <rule>:off -- <reason>` for one real boundary. The reason is required.
3. A file-scoped `plugins[].overrides[]` entry, only for a whole class of files such as a projection boundary or process-spawning tests.
4. The `diagnosticSeverity` map, only for project-wide policy.

Keep suppressions countable: `rg -c "@effect-diagnostics"` is the debt count, and it should only go down.

## TS6 deprecations to avoid

| Deprecated | Replacement |
|-----------|-------------|
| `target: es3` / `es5` | Minimum `ES2015` — use esbuild/SWC for ES5 |
| `moduleResolution: node` / `node10` | `bundler` or `nodenext` |
| `baseUrl` for module roots | Inline into `paths` entries |
| `outFile` | Use a bundler |
| `module: amd` / `umd` / `system` | `esnext`, `preserve`, or `commonjs` |
| `downlevelIteration` | Remove entirely (triggers error if present) |
| `assert {}` on imports | `with {}` (import attributes) |

## tsgo vs tsc

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
