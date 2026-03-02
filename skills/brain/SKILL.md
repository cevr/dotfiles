---
name: brain
description: Persistent agent memory vault managed by the `brain` CLI. Use when writing to brain, reading vault files, checking vault status, managing skills, running daemon, or any interaction with the `~/.brain/` vault. Triggers on "brain", "add to brain", "write to brain", "vault", "brain status", "brain skills", "sync skills", "outdated skills", "brain daemon", "daemon start", "daemon stop".
---

# brain

Global Obsidian-compatible vault for persistent agent memory across sessions. The `brain` CLI handles all filesystem plumbing — path resolution, vault init, index maintenance, hook wiring.

The brain is the foundation of the entire workflow — every agent, skill, and session reads it. Low-quality or speculative content degrades everything downstream. Before adding anything, ask: "Does this genuinely improve how the system operates?" If the answer isn't a clear yes, don't write it.

## Navigation

```
What do you need?
├─ CLI command reference        → §Quick Reference
├─ Read vault files             → §Reading
├─ Write vault files            → §Writing
├─ Understand vault structure   → §Vault Structure
├─ Maintain vault health        → §Maintenance
└─ Troubleshooting              → §Gotchas
```

## Quick Reference

| Command                               | What it does                                               |
| ------------------------------------- | ---------------------------------------------------------- |
| `brain vault`                         | Print active vault path (pipeable)                         |
| `brain vault --json`                  | `{ global, project, active }`                              |
| `brain inject`                        | Print vault index (SessionStart hook)                      |
| `brain reindex [--all]`               | Rebuild `index.md` from disk (no-op if unchanged)          |
| `brain status [--json]`               | File count, sections, orphans                              |
| `brain init [--project] [--global]`   | Scaffold vault, write config, wire hooks, install skills   |
| `brain snapshot <dir> [-o file]`      | Concatenate `.md` files with `=== path ===` delimiters     |
| `brain extract <dir> <output> [-b N]` | Parse JSONL conversations into batched text files          |
| `brain list [--json]`                 | List all vault files (one per line)                        |
| `brain skills list [--json]`          | List installed skills, flag outdated ones                  |
| `brain skills sync`                   | Sync skills from source to installed (idempotent)          |
| `brain daemon start`                  | Install launchd jobs (reflect/ruminate/meditate)           |
| `brain daemon stop`                   | Uninstall all daemon launchd jobs                          |
| `brain daemon status [--json]`        | Show loaded jobs and last run times                        |
| `brain daemon run <job>`              | Run a specific job immediately (reflect/ruminate/meditate) |
| `brain daemon logs [job] [--tail]`    | View daemon logs (optional job as positional arg)          |

## Vault Structure

```
~/.brain/                    # global vault (always active)
├── index.md                 # auto-maintained root index (wikilinks by section)
├── principles.md            # categorized principle index
├── principles/              # one file per engineering principle
├── plans/
│   └── index.md             # plan index
└── projects/                # per-project namespaces (auto-detected by git root / cwd)
    ├── bite/                # e.g. project-specific notes for the bite repo
    └── brain/               # e.g. project-specific notes for this repo
```

**Multi-vault**: global (`~/.brain/`) always active. `brain inject` auto-detects the current project (via `BRAIN_PROJECT` env, git root basename, or cwd basename) and injects notes from `projects/<name>/` alongside the global index. Project vault (`$PWD/brain/` or `$CLAUDE_PROJECT_DIR/brain/`) layered on top when present. `brain init --project --global` creates a minimal project namespace under the global vault.

**Hooks**: `SessionStart` runs `brain inject`. `PostToolUse` (matcher: `brain/`) runs `brain reindex`.

**Index rules**: `brain/index.md` is fully managed by `brain reindex` — it is regenerated from disk on every run. Manual wikilinks added to `index.md` are not preserved. Every brain file must be reachable from it. If you introduce a new top-level category, add an index-style entrypoint (links only, no inlined content).

## Reading

Read `brain/index.md` first. Then read the relevant entrypoint for your topic. For directories without a dedicated index file yet, scan nearby files directly and edit an existing note when possible.

```bash
VAULT=$(brain vault)
cat "$VAULT/index.md"                                    # root index
cat "$VAULT/principles/guard-the-context-window.md"      # specific note
rg "pattern" "$VAULT"                                    # search across vault
brain status                                             # check for orphans
```

## Writing

### Before writing

Read `brain/index.md` and the relevant entrypoint for your topic. Scan nearby files — prefer editing an existing note over creating a new one.

### Durability test

"Would I include this in a prompt for a different task?"

- **Yes** → brain
- **No, plan-specific** → `$(brain vault)/plans/`
- **No, skill-specific** → the skill file
- **No, follow-up** → backlog

### File conventions

- One topic per file, lowercase-hyphenated: `guard-the-context-window.md`
- Bullets over prose. No preamble. Plain markdown with `# Title`
- No Obsidian frontmatter in notes
- Keep notes under ~50 lines. Split if longer
- Wikilinks: `[[section/file-name]]` — resolution order: same directory, then relative path, then vault root. Heading anchors stripped

### After writing

- Update `brain/index.md` for any files added or removed (or let PostToolUse hook handle it)
- Update the relevant entrypoint when applicable (e.g. `principles.md` for new principles)
- Keep indexes link-only and scannable — no inlined content

## Maintenance

- Delete outdated notes before adding new ones
- Merge overlapping notes rather than creating near-duplicates
- `brain status` shows orphans (files not linked from any index)
- Run `brain reindex` to rebuild index from disk

## Error Recovery

All commands emit structured errors with `code` fields. With `--json`, errors output as:

```json
{
  "error": "@cvr/brain/VaultError",
  "code": "NOT_INITIALIZED",
  "message": "Vault not initialized — run `brain init`"
}
```

Common error codes: `NOT_INITIALIZED`, `READ_FAILED`, `WRITE_FAILED`, `INDEX_MISSING`, `PARSE_FAILED`, `INVALID_DATE`.

`brain inject` is resilient — prints warning to stderr and exits 0 when vault is missing (hooks must never crash sessions).

## Gotchas

- `brain reindex` is a no-op if nothing changed — silence is success
- `brain init` is idempotent — safe to re-run
- The PostToolUse hook matcher is `brain/` — it fires on any tool output containing that string, including paths and error messages. This is intentionally broad
- `brain vault` returns the project vault if inside one, otherwise global
- Hooks are wired into `~/.claude/settings.json` — existing hooks preserved
- `brain snapshot` outputs to stdout by default, use `-o` for file output
- `brain extract` needs JSONL conversation files — typically at `~/.claude/projects/`

## Daemon

Automated vault maintenance via launchd (**macOS-only**). Three jobs on different cadences:

| Job      | Cadence           | Model  | What                                                   |
| -------- | ----------------- | ------ | ------------------------------------------------------ |
| reflect  | Hourly            | sonnet | Pass session file paths to Claude /reflect per project |
| ruminate | Weekly (Sun 3am)  | opus   | Mine session archives for missed patterns              |
| meditate | Monthly (1st 3am) | opus   | Audit + prune + distill vault quality                  |

**State**: `~/.brain/.daemon.json` tracks processed sessions and last run times.
**Locks**: `~/.brain/.daemon-{job}.lock` — atomic acquisition via `O_EXCL`, stale lock detection. `Effect.ensuring` guarantees release on interruption.
**Logs**: `~/.brain/logs/daemon-{job}.log` — size-based rotation (truncate to last 1000 lines when >10MB).
**Session detection**: A session is "settled" when its mtime is >30 min ago. Already-processed sessions (same mtime) are skipped.
**Reflect approach**: Passes session JSONL file paths with line ranges in the prompt so Claude reads them via its Read tool. Max 2000 lines per group, newest first.
**`--json` output**: All subcommands (start/stop/status/run) support `--json`. Status includes schedule, lock state, and processed session count.
**Error codes**: `NO_HOME` (HOME unset), `UNSUPPORTED_PLATFORM` (non-macOS), `LOCKED` (job already running, includes lock path in message).
