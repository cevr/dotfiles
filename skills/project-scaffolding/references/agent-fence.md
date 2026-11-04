# Agent Fence

A new repo ships with rules agents cannot skip: repo law in `AGENTS.md`, import boundaries in lint, and hooks that block hook bypass. Prose explains why; the fence enforces. Put each rule on the highest rung that holds it: types and code, then lint, then `AGENTS.md`, then skills.

## Contents

- `AGENTS.md` skeleton
- Block hook bypass
- Import boundaries
- Grow the fence
- Pins

## `AGENTS.md` skeleton

Write these sections on day one. Keep each one to what the environment cannot tell an agent.

| Section | Holds |
| --- | --- |
| Stack contract | Runtime, Effect version, and the pins that matter, with one line on why each exists |
| Layout | The contexts, their adapter and UI folders, and the `cmd/` binaries, with one line on each. The rules are the `effect` skill's `references/ARCHITECTURE.md` §Layout; name only what this repo adds |
| Commands | The gate command that must pass before claiming a change is ready |
| Fence | What the hooks run, and "fix the failure, never bypass the hook" |
| Architecture | Dependency direction, and the lint rule that enforces each arrow |
| Boundaries and sign-off | Changes agents make directly; changes that need owner approval (dependency bumps, loosening lint or tsconfig severity, deploys that replace resources) |

Put `CLAUDE.md` beside it as a one-line pointer: `@AGENTS.md`.

## Block hook bypass

Lefthook runs the gate on commit. Agents skip it with `--no-verify`, `git commit -n`, `LEFTHOOK=0`, or a `core.hooksPath` override. Block all of them in the harness:

1. Copy `templates/block-hook-bypass.ts` to `scripts/hooks/block-hook-bypass.ts`.
2. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bun \"${CLAUDE_PROJECT_DIR}/scripts/hooks/block-hook-bypass.ts\"" }
        ]
      }
    ]
  }
}
```

The script ignores quoted text, so a commit message that mentions `--no-verify` still passes.

## Import boundaries

Enforce dependency direction with oxlint's built-in `no-restricted-imports`, scoped by `overrides`. No custom plugin is needed. A context is one package, so the boundary between its domain files and its adapter folders is a file glob, not a package edge: `board/*.ts` matches the domain files at the context root only.

```jsonc
{
  "overrides": [
    {
      "files": ["board/*.ts"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [
            { "group": ["./*/**", "@effect/platform-*", "pg", "react"], "message": "Domain files import no vendor and none of their own adapter or UI folders." },
            { "group": ["@acme/**", "!@acme/billing/api", "!@acme/billing/service"], "message": "Another context is reached only through its contract and Api files." }
          ]
        }]
      }
    },
    {
      "files": ["board/web/**"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [{ "group": ["../postgres/**", "../memory/**", "pg"], "message": "UI code imports the domain's contracts and Api, never an adapter." }]
        }]
      }
    }
  ]
}
```

Nothing imports a `cmd/` package; it has no `exports`, so that arrow needs no rule. Add one override per context, and one per arrow in the `AGENTS.md` Architecture section. Before trusting a new override, add a file that breaks it and watch `oxlint` fail. Write a custom `jsPlugins` rule only for a pattern that is not an import, such as module-level mutable state or a projection built outside its package; `joelhooks/rat-stack` `scripts/oxlint-plugin-*.ts` has worked examples.

## Grow the fence

When a bad pattern shows up in review:

1. Write the lint rule or type that fails on it, and watch it fail once.
2. Fix every existing instance, so the rule starts at zero findings.
3. If some findings must stay, record them as a baseline that only shrinks.

Suppressions are debt. Each one names its rule and a reason (`// oxlint-disable-next-line <rule> -- <reason>`, `// @effect-diagnostics-next-line <rule>:off -- <reason>`), and the count only goes down:

```bash
rg -c "oxlint-disable|@effect-diagnostics|@ts-expect-error|@ts-ignore" --glob '!**/node_modules/**'
```

## Pins

Install the latest version, then pin it exactly (`bun add -E`). An exact pin keeps agents, CI, and a cold clone on the same code. A bump is its own commit that runs the full gate; for Effect, move every `effect` and `@effect/*` package in that one commit.
