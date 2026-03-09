---
name: counsel
description: Route a prompt to the opposite local coding agent. Use when you are in Claude and want Codex, or in Codex and want Claude, for an independent second opinion on code, architecture, bugs, migrations, or tests. Triggers on "counsel", "ask codex", "ask claude", "second opinion from the other agent", or "route this to the other model".
---

# counsel

One command. Opposite agent only.

`counsel` is for a tight second opinion, not a whole agent orchestra.

## Navigation

```text
What do you need?
├─ Quick command shape        → §Quick Reference
├─ When to use it             → §When to Use
├─ How to prepare the prompt  → §Prompt Shape
├─ How to run it              → §Workflow
└─ What files to read after   → §Output
```

## Quick Reference

| Command                             | What it does                                           |
| ----------------------------------- | ------------------------------------------------------ |
| `counsel "prompt"`                  | Send an inline prompt to the opposite agent            |
| `counsel -f prompt.md`              | Send a prompt file                                     |
| `echo "prompt" \| counsel`          | Send stdin                                             |
| `counsel --deep "prompt"`           | Use the deeper profile                                 |
| `counsel --from claude "prompt"`    | Force source provider when auto-detection is ambiguous |
| `counsel --dry-run --json "prompt"` | Preview the resolved invocation                        |

## When to Use

- You are in Claude and want Codex to challenge your read.
- You are in Codex and want Claude to challenge your read.
- You want one clean second opinion, not parallel fanout.
- You already know the focus area and can write a direct prompt.

Do not use `counsel` when you need iterative rounds, tool selection, or group orchestration. It does not do any of that.

## Prompt Shape

Gather context first. Then send a tight prompt.

- Name the concrete question.
- Reference exact files or directories.
- Include constraints that matter.
- Ask for receipts, not vibes.

Good:

```text
Review `src/auth/` for regression risk after the token refresh refactor.
Ground every claim in concrete file paths.
Call out missing tests and bad assumptions.
```

Bad:

```text
Thoughts?
```

## Workflow

1. Gather the local context yourself first. `counsel` does not do discovery.
2. Write the prompt inline, from a file, or through stdin.
3. Run `counsel`.
4. Read `run.json` first, then the target output file.

Example:

```bash
counsel --deep "Review src/cli.ts and src/services/Run.ts for brittle assumptions"
```

If source detection is ambiguous, force it:

```bash
counsel --from codex "Challenge this migration plan"
```

## Output

Each run writes a directory under `./agents/counsel/<slug>/`:

```text
prompt.md
run.json
claude.md or codex.md
claude.stderr or codex.stderr
```

Read in this order:

1. `run.json` for source, target, status, and file paths
2. `<target>.md` for the actual answer
3. `<target>.stderr` if the status is `error` or `timeout`

## Gotchas

- `counsel` only routes to the opposite provider.
- It fails if it cannot infer whether the current session is Claude or Codex and `--from` is missing.
- It writes files; it does not stream the other model's answer back into the active chat.
- The repo ships this skill file, but the CLI does not install it for you.
