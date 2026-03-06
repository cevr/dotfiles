---
name: cli
description: CLI design patterns and best practices. Use when building command-line tools, designing commands/flags, formatting output, handling errors, managing config/credentials, reviewing CLI UX, or designing CLIs for AI agent consumers. Covers 12-Factor CLI, Unix philosophy, TTY detection, exit codes, NO_COLOR, XDG paths, agent DX (schema introspection, input hardening, field masks, MCP surfaces).
---

# CLI Design

Build CLIs that feel native, fail gracefully, compose beautifully.

## Core Principles

1. **Human-first, machine-friendly** — default to human output; `--json` for scripts/agents
2. **Respond in 100ms** — print something fast; show progress for slow ops
3. **Fail gracefully** — clear errors, recovery suggestions, easy bug reports
4. **Respect conventions** — standard flags, XDG paths, NO_COLOR
5. **Composability** — stdin/stdout/stderr, exit codes, plain text
6. **Don't break things** — additive changes, deprecation warnings

## Navigation

```
What are you designing?
├─ Command structure        → references/commands.md
├─ Help/docs                → references/help.md
├─ Output formatting        → references/output.md
├─ Error handling           → references/errors.md
├─ Config/credentials       → references/config.md
├─ UX/responsiveness        → references/design.md
├─ Agent/LLM consumers      → references/agent-dx.md
└─ "Is this bad?"           → references/gotchas.md
```

## Topic Index

| Topic            | File                        | When to Read                            |
| ---------------- | --------------------------- | --------------------------------------- |
| UX Philosophy    | `references/design.md`      | 100ms rule, progress, Ctrl-C, prompts   |
| Commands & Flags | `references/commands.md`    | Naming, args vs flags, `--` passthrough |
| Help Text        | `references/help.md`        | Lead with examples, all help forms work |
| Output           | `references/output.md`      | TTY detection, colors, tables, streams  |
| Errors           | `references/errors.md`      | Anatomy of great errors, recovery       |
| Config           | `references/config.md`      | Precedence, XDG spec, credentials       |
| Agent DX         | `references/agent-dx.md`    | Designing for AI agent consumers        |
| Anti-patterns    | `references/gotchas.md`     | Common mistakes to avoid                |

## 12-Factor CLI (Quick Reference)

| #  | Principle               | Summary                             |
| -- | ----------------------- | ----------------------------------- |
| 1  | Great help              | In-CLI + web; examples essential    |
| 2  | Prefer flags to args    | 1 arg ok, 2 suspect, 3 never       |
| 3  | Version accessible      | `--version`, `-V`, `version`        |
| 4  | Mind the streams        | stdout = data, stderr = messages    |
| 5  | Handle errors well      | Code + title + fix + URL            |
| 6  | Be fancy                | Colors/spinners, but respect TTY    |
| 7  | Prompt if you can       | Interactive when TTY; flag override |
| 8  | Use tables              | Grep-friendly; `--json`; `--columns`|
| 9  | Be speedy               | <100ms ideal, spinner if slow       |
| 10 | Encourage contributions | License, contributing guide         |
| 11 | Clear subcommands       | `topic:command`; help on empty      |
| 12 | Follow XDG-spec         | Proper config/data/cache paths      |

## The Unix Philosophy

- Do one thing well
- Text streams as universal interface
- Silence is golden (no output = success)
- Fail early, fail loudly
- Compose with other tools

## Standard Flags (every CLI)

| Flag              | Meaning        | Notes                                  |
| ----------------- | -------------- | -------------------------------------- |
| `-h`, `--help`    | Show help      | Reserved — never use for anything else |
| `-v`, `--verbose` | More output    | Can stack: `-vvv`                      |
| `-q`, `--quiet`   | Less output    | Opposite of verbose                    |
| `--version`       | Show version   | Also `-V` or `version` subcommand     |
| `--json`          | JSON output    | For scripting                          |
| `--no-color`      | Disable colors | Also respect `NO_COLOR` env            |

## Exit Codes

| Code | Meaning        | Use For                  |
| ---- | -------------- | ------------------------ |
| 0    | Success        | Everything worked        |
| 1    | General error  | Catch-all failures       |
| 2    | Misuse         | Invalid args, bad flags  |
| 126  | Not executable | Permission issues        |
| 127  | Not found      | Command doesn't exist    |
| 130  | Ctrl-C         | User interrupted (128+2) |

## Streams

| Stream | Purpose               | Examples                                     |
| ------ | --------------------- | -------------------------------------------- |
| stdout | Program output (data) | Query results, generated content, piped data |
| stderr | Human messaging       | Progress, errors, warnings, debug info       |

> If it should appear when piped to another program, use stdout.
> If it's for the human watching, use stderr.
