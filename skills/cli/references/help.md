# Help & Documentation

Help text is the most-read documentation you'll write. Make it count.

## All Help Invocations Must Work

```
# All of these should show help
mycli
mycli --help
mycli -h
mycli help
mycli help <command>
mycli <command> --help
mycli <command> -h
```

**Critical**: Reserve `-h` and `--help` for help only. Never use for other flags.

## Help Text Anatomy

```
mycli deploy - Deploy your application

USAGE
  mycli deploy [OPTIONS] [ENVIRONMENT]

EXAMPLES
  mycli deploy                    # Deploy to default (staging)
  mycli deploy production         # Deploy to production
  mycli deploy --branch feature   # Deploy specific branch

ARGUMENTS
  ENVIRONMENT    Target environment [default: staging]

OPTIONS
  -b, --branch <name>    Branch to deploy [default: main]
  -f, --force            Skip confirmation prompts
  --dry-run              Show what would be deployed
  --no-cache             Build without cache
  -h, --help             Show this help

ENVIRONMENT VARIABLES
  DEPLOY_TOKEN    Authentication token (required)
  DEPLOY_TIMEOUT  Timeout in seconds [default: 300]

LEARN MORE
  Documentation: https://mycli.dev/docs/deploy
  Support: https://mycli.dev/support
```

## Lead with Examples

Examples are the most referenced part of help. Put them first or prominently.

```
# Bad - examples buried at bottom
mycli deploy

Deploy your application to the cloud infrastructure.

Options:
  --environment, -e    Target environment
  --branch, -b         Source branch
  [50 more lines...]

Examples:
  mycli deploy -e prod

# Good - examples front and center
mycli deploy

EXAMPLES
  mycli deploy                    # Deploy to staging
  mycli deploy -e production      # Deploy to production
  mycli deploy -b feature/login   # Deploy feature branch

Deploy your application. [Full options below...]
```

### Example Guidelines

- Start with simplest case
- Show 2-3 common patterns
- Include comments explaining each
- Use realistic values, not placeholders

## Description Guidelines

### Command Description

```
# Bad - too vague
deploy - Deploys things

# Bad - too verbose
deploy - This command will deploy your application to the
         specified environment using the configured deployment
         pipeline and infrastructure settings...

# Good - concise and clear
deploy - Deploy your application to an environment
```

### Flag Descriptions

```
# Bad - just restating the name
--verbose    Enable verbose mode

# Good - explain the effect
--verbose    Show detailed progress and debug information

# Bad - no default shown
--timeout    Request timeout

# Good - show default and units
--timeout    Request timeout in seconds [default: 30]
```

## Show Defaults and Constraints

```
OPTIONS
  --env <name>       Target environment [default: staging]
                     Allowed: staging, production

  --retries <n>      Number of retry attempts [default: 3]
                     Range: 0-10

  --format <type>    Output format [default: table]
                     Allowed: table, json, csv

  --config <path>    Config file path
                     [default: ~/.mycli/config.yaml]
```

## Subcommand Help

### Root Command (No Args)

```
$ mycli

A CLI for managing your infrastructure

USAGE
  mycli <command> [options]

COMMANDS
  deploy      Deploy applications
  config      Manage configuration
  logs        View application logs
  status      Check service status

Run 'mycli <command> --help' for command-specific help.
```

### Group Commands

```
$ mycli config

Manage configuration settings

USAGE
  mycli config:<command>

COMMANDS
  config:get <key>     Get a config value
  config:set <key>     Set a config value
  config:list          List all config
  config:edit          Open config in editor

Run 'mycli config:<command> --help' for details.
```

## Suggest Corrections

```
$ mycli delpoy
Error: Unknown command 'delpoy'

Did you mean?
  deploy

Run 'mycli --help' for available commands.
```

```
$ mycli deploy --environmnet prod
Error: Unknown flag '--environmnet'

Did you mean?
  --environment

Run 'mycli deploy --help' for available flags.
```

## Suggest Next Steps

After successful operations, guide users:

```
$ mycli init
Created mycli.config.yaml

Next steps:
  mycli config:set api-key    Configure API access
  mycli deploy --dry-run      Preview a deployment
  mycli help deploy           Learn about deployments
```

## In-CLI vs Web Docs

| Content           | In-CLI Help | Web Docs          |
| ----------------- | ----------- | ----------------- |
| Quick reference   | ✓           | ✓                 |
| Examples          | ✓ (2-3)     | ✓ (comprehensive) |
| Flag descriptions | ✓ (brief)   | ✓ (detailed)      |
| Tutorials         | Link only   | ✓                 |
| Architecture      | ✗           | ✓                 |
| Troubleshooting   | ✗           | ✓                 |

### Link to Web Docs

```
$ mycli deploy --help
[... help text ...]

LEARN MORE
  Full documentation: https://mycli.dev/docs/deploy
  Troubleshooting: https://mycli.dev/docs/deploy#troubleshooting
```

## Shell Completion as Help

Completion is interactive documentation:

```
$ mycli deploy --<TAB>
--branch       Deploy from specific branch
--dry-run      Preview without deploying
--environment  Target environment
--force        Skip confirmations
--help         Show help
--timeout      Deployment timeout
```

### Completion Best Practices

- Include descriptions in completions
- Complete flag values: `--env <TAB>` → `staging production`
- Complete dynamic values: `--app <TAB>` → fetches app list

## Version Information

```
$ mycli --version
mycli 2.1.0

$ mycli version
mycli 2.1.0 (darwin-arm64)
Build: abc1234 (2024-01-15)
Go: 1.21.0
```

### Version Flag Conventions

- `--version` - always supported
- `-V` - common short form (not `-v`, that's verbose)
- `version` subcommand - optional, can show more detail

## Man Pages

For Unix distribution:

```
$ man mycli
$ man mycli-deploy
```

Generate from help text or maintain separately. Keep in sync.

## README as Documentation

Your README should include:

```markdown
## Quick Start

$ mycli init
$ mycli deploy

## Installation

[Package manager commands]

## Common Commands

[Most-used commands with examples]

## Configuration

[Config file locations, environment variables]

## Full Documentation

[Link to docs site]
```
