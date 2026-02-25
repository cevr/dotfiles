# Commands, Flags & Arguments

Good command naming is poetry: short, memorable, obvious.

## Command Naming

### Principles

| Guideline             | Good            | Bad                             |
| --------------------- | --------------- | ------------------------------- |
| Short (1-2 syllables) | `run`, `build`  | `execute`, `compile-and-bundle` |
| Lowercase only        | `deploy`        | `Deploy`, `DEPLOY`              |
| No shift key          | `ls`            | `LS`                            |
| Memorable             | `push`, `pull`  | `upload`, `download`            |
| Avoid generic names   | `myapp-convert` | `convert` (conflicts!)          |

### Name Conflicts to Avoid

These names are taken or ambiguous:

- `test` - shell built-in
- `convert` - ImageMagick
- `install` - common
- `run` - npm, docker
- `build` - many tools

**Solution**: Prefix with your tool name: `myapp test`, `myapp build`

## Subcommand Structure

### Colon vs Space

```
# Colon syntax (Heroku-style) - easier to parse
heroku apps:create
heroku addons:attach

# Space syntax (git-style) - more natural
git remote add
docker container ls
```

**Recommendation**: Use colons for deeply nested commands, spaces for shallow.

### Topic:Action Pattern

```
# Pattern: <noun>:<verb>
users:list
users:create
users:delete

db:migrate
db:seed
db:reset
```

### Help on Empty Subcommand

```
$ mycli users
Usage: mycli users:<command>

Commands:
  users:list      List all users
  users:create    Create a user
  users:delete    Delete a user

Run 'mycli users:<command> --help' for details.
```

## Arguments vs Flags

### The Rule

| Arguments | Assessment |
| --------- | ---------- |
| 0         | Perfect    |
| 1         | Acceptable |
| 2         | Suspicious |
| 3+        | Never      |

### Why Flags > Arguments

```
# Bad - positional args are confusing
$ copy source.txt dest.txt backup/
# Which is source? Dest? Is backup/ a third file?

# Good - flags are explicit
$ copy --from source.txt --to dest.txt --backup-dir backup/
```

### When Arguments Work

- Single, obvious target: `cat file.txt`, `rm path`
- Standard conventions: `grep pattern file`
- Commands that operate on files: `edit config.yaml`

## Standard Flags

Every CLI should support:

| Flag              | Meaning        | Notes                                  |
| ----------------- | -------------- | -------------------------------------- |
| `-h`, `--help`    | Show help      | Reserved - never use for anything else |
| `-v`, `--verbose` | More output    | Can stack: `-vvv`                      |
| `-q`, `--quiet`   | Less output    | Opposite of verbose                    |
| `--version`       | Show version   | Also `-V` or `version` subcommand      |
| `--json`          | JSON output    | For scripting                          |
| `--no-color`      | Disable colors | Also respect `NO_COLOR` env            |
| `--debug`         | Debug mode     | Extra diagnostics                      |

### Boolean Flag Patterns

```
# Positive flags
--color          # Enable color
--interactive    # Enable prompts

# Negative flags (two patterns)
--no-color       # Disable color
--non-interactive # Disable prompts

# With values (avoid if possible)
--color=always
--color=never
--color=auto
```

## The `--` Separator

Everything after `--` is passed through, not parsed as flags.

```
# Without -- : npm tries to parse --watch
$ npm test --watch
npm ERR! Unknown option: --watch

# With -- : --watch goes to the test runner
$ npm test -- --watch
✓ Running tests in watch mode
```

### Essential for

- Package managers running scripts
- Docker/kubectl exec
- Any wrapper that calls other tools

## Secrets: Never in Flags

```
# NEVER - visible in process list, shell history
$ mycli --api-key=sk-1234567890

# Better - environment variable (still visible in /proc)
$ API_KEY=sk-1234 mycli

# Best - stdin or file
$ mycli --api-key-file ~/.mycli/credentials
$ echo "$API_KEY" | mycli --api-key-stdin
```

## Fuzzy Matching & Corrections

```
$ git stauts
git: 'stauts' is not a git command. See 'git --help'.

Did you mean this?
    status

$ kubectl get podz
error: the server doesn't have a resource type "podz"

Did you mean:
    pods
```

### Implementation Tips

- Levenshtein distance ≤ 2 for suggestions
- Show max 3 suggestions
- Only suggest if confident (1-2 close matches)

## Shell Completion

Support tab completion for major shells:

```
# Generate completion scripts
mycli completion bash > /etc/bash_completion.d/mycli
mycli completion zsh > ~/.zfunc/_mycli
mycli completion fish > ~/.config/fish/completions/mycli.fish
```

### What to Complete

- Subcommands: `mycli us<TAB>` → `mycli users`
- Flags: `mycli --ver<TAB>` → `mycli --version`
- Flag values: `mycli --env <TAB>` → `staging production`
- File paths: `mycli --config <TAB>` → file browser
- Dynamic values: `mycli deploy <TAB>` → fetches app names

## Flag Aliases

Provide short forms for common flags:

```
-h  →  --help
-v  →  --verbose (or --version, pick one)
-q  →  --quiet
-f  →  --force
-n  →  --dry-run
-o  →  --output
-c  →  --config
```

### Alias Guidelines

- Single letter for frequently used flags
- Consistent across subcommands
- Document in help text: `-f, --force`

## Variadic Arguments

When accepting multiple values:

```
# Multiple files (last argument is variadic)
$ rm file1.txt file2.txt file3.txt

# Flag with multiple values
$ mycli --exclude node_modules --exclude dist

# Comma-separated (for scripts)
$ mycli --exclude=node_modules,dist
```

### Support Both Styles

```
# These should be equivalent
--tag prod --tag v1.0
--tag=prod,v1.0
--tag "prod v1.0"  # space-separated in quotes
```
