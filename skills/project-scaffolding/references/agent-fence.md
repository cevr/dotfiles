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
| Nouns | Table of noun, home folder, and job (contract, service, cartridge, feature, client). See the `effect` skill's `references/ARCHITECTURE.md` |
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

Enforce dependency direction with oxlint's built-in `no-restricted-imports`, scoped by `overrides`. No custom plugin is needed:

```jsonc
{
  "overrides": [
    {
      "files": ["packages/**"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [{ "group": ["@acme/cli", "@acme/cli/*", "@acme/web", "@acme/web/*"], "message": "Packages never import apps." }]
        }]
      }
    },
    {
      "files": ["apps/web/src/features/**", "apps/web/src/client/**"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [{ "group": ["@acme/core", "@acme/core/*", "!@acme/core/contracts"], "message": "Browser code imports contracts, never handlers." }]
        }]
      }
    }
  ]
}
```

Add one override per arrow in the `AGENTS.md` Architecture section. Write a custom `jsPlugins` rule only for a pattern that is not an import, such as module-level mutable state or a projection built outside its package; `joelhooks/rat-stack` `scripts/oxlint-plugin-*.ts` has worked examples.

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
