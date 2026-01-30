---
name: linear
description: Interact with Linear issues from the command line.
---

# Linear CLI

Interact with Linear issues from the command line.

## Quick Reference

| Task | Command |
|------|---------|
| Authenticate | `linear auth` |
| Check current user | `linear auth whoami` |
| List my issues | `linear issue list` |
| View issue | `linear issue view ABC-123` |
| Start issue | `linear issue start ABC-123` |
| Create issue | `linear issue create` |
| List teams | `linear team list` |

## Authentication

First-time setup:

```bash
linear auth
```

This opens your browser to create a Linear API key, prompts you to paste it, validates it, and saves to `~/.config/linear/token`.

## Issue Commands

### List issues

```bash
# Your assigned issues (default)
linear issue list

# Filter by state
linear issue list --state started
linear issue list -s unstarted

# Limit results
linear issue list -n 10
```

### View issue details

```bash
linear issue view ABC-123
linear issue view  # Interactive picker
```

### Start working on an issue

```bash
linear issue start ABC-123
linear issue start  # Interactive picker from your issues
```

Changes issue state to "In Progress" and shows the git branch name.

### Create an issue

```bash
linear issue create
```

Interactive prompts for team, title, and description.

## Team Commands

```bash
# List all teams
linear team list
```

## Configuration

**Paths:**
- Token: `~/.config/linear/token`
- Global config: `~/.config/linear/config.toml`
- Project config: `.linear.toml` in repo root

**Project config example:**
```toml
team_id = "TEAM-KEY"
```

**Token resolution order:**
1. `~/.config/linear/token`
2. `LINEAR_API_KEY` environment variable
3. Error prompting to run `linear auth`

## Tips

- Run `linear --help` for all commands
- Run `linear <command> --help` for command-specific help
- Interactive prompts appear when required arguments are missing
- Use `.linear.toml` in your repo root to set default team
