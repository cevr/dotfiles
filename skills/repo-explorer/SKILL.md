---
name: repo-explorer
description: Clone and analyze external repositories. Use when asked to explore, search, or read files from a GitHub repo or package registry.
allowed-tools: [Bash, Read, Grep, Glob, Task]
---

# Repository Explorer

Explore and analyze repositories using the `repo` CLI.

## Spec Formats

| Format | Example |
|--------|---------|
| GitHub | `owner/repo`, `owner/repo@v1.0.0` |
| npm | `npm:lodash`, `npm:@effect/cli@0.73.0` |
| PyPI | `pypi:requests@2.31.0` |
| Crates | `crates:serde@1.0.0` |

## Storage

Cache location: `~/.cache/repo/`

- GitHub: `~/.cache/repo/{owner}/{repo}`
- npm: `~/.cache/repo/{package}/{version}`
- PyPI: `~/.cache/repo/{package}/{version}`
- Crates: `~/.cache/repo/{crate}/{version}`

## Workflow

### Quick check if cached:
```bash
repo path owner/repo
```
Returns path if cached, error if not.

### Fetch if needed:
```bash
repo fetch owner/repo
```

### Get path for tools:
```bash
repo path -q owner/repo
```

### Explore with tools:
After getting the path, use Read/Grep/Glob or search tools directly on it.

## When to Use What

| Task | Use |
|------|-----|
| Check if cached | `repo path <spec>` |
| Fetch repository | `repo fetch <spec>` |
| Update existing | `repo fetch -u <spec>` |
| Get metadata | `repo info <spec>` |
| Search ALL repos | `repo search <query>` |
| Search ONE repo | `rg` or Grep tool with repo path |
| Structural code search | `ast-grep` for AST-aware patterns |
| Read files | `Read` tool with full path |
| Find files | `Glob` tool or `fd` |
| Directory tree | `eza --tree` on repo path |

## Search Tools

### ripgrep (rg) - Fast text search
```bash
# Basic search
rg "pattern" ~/.cache/repo/{owner}/{repo}

# With context
rg "pattern" -C 3 ~/.cache/repo/{owner}/{repo}

# File type filter
rg "pattern" --type ts ~/.cache/repo/{owner}/{repo}

# Files only
rg --files ~/.cache/repo/{owner}/{repo} | rg "filename"
```

### ast-grep - Structural code search
AST-aware search that matches code patterns regardless of formatting:

```bash
# Find function calls
ast-grep --pattern 'console.log($$$)' --lang ts ~/.cache/repo/{owner}/{repo}

# Find async functions
ast-grep --pattern 'async function $NAME($$$) { $$$ }' --lang ts ~/.cache/repo/{owner}/{repo}

# Find React components
ast-grep --pattern 'function $NAME($PROPS): JSX.Element { $$$ }' --lang tsx ~/.cache/repo/{owner}/{repo}

# Find imports
ast-grep --pattern 'import { $$$ } from "$MOD"' --lang ts ~/.cache/repo/{owner}/{repo}
```

Use ast-grep when searching for:
- Function/method definitions or calls
- Import statements
- Class definitions
- Specific code structures (try/catch, if/else patterns)

### fd - Fast file finder
```bash
# Find files by name
fd "pattern" ~/.cache/repo/{owner}/{repo}

# Find by extension
fd -e ts ~/.cache/repo/{owner}/{repo}

# Find directories
fd --type d "src" ~/.cache/repo/{owner}/{repo}
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `repo fetch <spec>` | Fetch/update repository |
| `repo fetch -u <spec>` | Update existing git repo |
| `repo path <spec>` | Get path (error if not cached) |
| `repo path -q <spec>` | Get path quietly |
| `repo info <spec>` | Show repository metadata |
| `repo info --json <spec>` | Metadata as JSON |
| `repo list` | List all cached repos |
| `repo list --json` | List as JSON |
| `repo search <query>` | Search across all cached |
| `repo remove <spec>` | Remove from cache |
| `repo stats` | Cache statistics |
| `repo open <spec>` | Open in editor |

## Example Flow

```bash
# 1. Fetch repo
repo fetch vercel/next.js

# 2. Get path
repo path vercel/next.js
# Output: /Users/.../.cache/repo/vercel/next.js

# 3. Explore with tools
Read file_path="/Users/.../.cache/repo/vercel/next.js/package.json"

# Text search
rg "createServer" ~/.cache/repo/vercel/next.js

# Structural search
ast-grep --pattern 'export function $NAME($$$)' --lang ts ~/.cache/repo/vercel/next.js
```

## Exploration Strategy

For broad exploration, use the Explore agent:
```
Task subagent_type="Explore" prompt="Explore ~/.cache/repo/{owner}/{repo} to understand..."
```

For targeted searches:
- **Text patterns**: Use `rg` (ripgrep) for fast regex search
- **Code structures**: Use `ast-grep` for AST-aware pattern matching
- **File names**: Use `fd` or Glob tool
- **Read specific files**: Use Read tool with full path
