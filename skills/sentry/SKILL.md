# Sentry CLI Skill

Use this CLI to interact with Sentry from the command line.

## Quick Reference

```bash
# Authentication
sentry login --token <token>           # Save access token
sentry whoami                          # Check authentication

# Configuration
sentry config list                     # Show all config
sentry config get <key>                # Get specific value
sentry config set <key> <value>        # Set config value
sentry config path                     # Show config file path

# Organizations & Teams
sentry orgs list                       # List organizations
sentry teams list --org <org>          # List teams
sentry teams create <slug> --org <org> # Create team

# Projects
sentry projects list --org <org>                    # List projects
sentry projects create <slug> --team <team>         # Create project
sentry projects update <slug> --name <name>         # Update project

# DSNs
sentry dsns list --org <org> --project <proj>       # List DSNs
sentry dsns create --org <org> --project <proj>     # Create DSN

# Releases
sentry releases list --org <org> --project <proj>   # List releases

# Issues
sentry issues search --org <org>                    # Search issues
sentry issues search --query "is:unresolved"        # With query
sentry issues get <issue-id> --org <org>            # Get issue details
sentry issues update <issue-id> --status resolved   # Update issue
sentry issues analyze <issue-id> --org <org>        # AI analysis with Seer
sentry issues events <issue-id> --org <org>         # List issue events

# Events
sentry events search --org <org> --project <proj>   # Search events
sentry events attachments list <event-id>           # List attachments
sentry events attachments download <event-id> <id>  # Download attachment

# Traces
sentry traces get <trace-id> --org <org>            # Get trace details

# Documentation
sentry docs search <query>                          # Search Sentry docs
sentry docs get <url>                               # Fetch doc content
```

## Configuration

The CLI uses a config file at `~/.config/sentry/config.json`:

```json
{
  "accessToken": "sntrys_...",
  "host": "sentry.io",
  "defaultOrg": "my-org",
  "defaultProject": "my-project"
}
```

Set defaults to avoid passing `--org` and `--project` flags:

```bash
sentry config set org my-organization
sentry config set project my-project
```

## Common Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--org` | `-o` | Organization slug |
| `--project` | `-p` | Project slug |
| `--query` | `-q` | Filter query |
| `--limit` | `-l` | Max results (default: 25) |

## Examples

### Investigate an Issue

```bash
# Find unresolved issues
sentry issues search --query "is:unresolved" --org myorg

# Get details for a specific issue
sentry issues get PROJ-123 --org myorg

# Run AI analysis
sentry issues analyze PROJ-123 --org myorg

# See events for the issue
sentry issues events PROJ-123 --org myorg
```

### Set Up a New Project

```bash
# Create team and project
sentry teams create backend --org myorg
sentry projects create api --team backend --org myorg --platform node

# Get the DSN for your app
sentry dsns list --org myorg --project api
```

### Search Events

```bash
# Find events by environment
sentry events search --org myorg --project api --query "environment:production"

# Find events with specific error
sentry events search --query "error.type:TypeError" --org myorg --project api
```

## Development

```bash
# Run CLI in dev mode
bun run dev <command>

# Run tests
bun run test

# Type check
bun run typecheck

# Build binary
bun run build
```

## Architecture

Built with Effect TypeScript:

- `src/main.ts` - CLI entry point and layer composition
- `src/api/client.ts` - Sentry API client service
- `src/config/` - Configuration loading and management
- `src/commands/` - Command implementations
- `src/commands/shared.ts` - Shared options and helpers
- `src/errors/` - Typed error definitions
