# CLI Gotchas & Anti-Patterns

Common mistakes that make CLIs frustrating. Don't do these.

## Help Text

### Wall of Help Text

```
# Bad - overwhelming, no examples
$ mycli --help
Usage: mycli [options] [command]

Options:
  -c, --config <path>      Path to configuration file
  -e, --environment <env>  Target environment
  -f, --force              Force operation without confirmation
  -h, --help               Display help message
  -j, --json               Output in JSON format
  -l, --log-level <level>  Set logging level
  -n, --dry-run            Show what would happen
  -o, --output <path>      Output file path
  -q, --quiet              Suppress output
  -t, --timeout <ms>       Operation timeout
  -v, --verbose            Enable verbose output
  --version                Show version number
  [30 more options...]

Commands:
  auth                     Authentication commands
  config                   Configuration management
  [20 more commands...]
```

```
# Good - examples first, scannable
$ mycli --help
Deploy and manage your applications

EXAMPLES
  mycli deploy              Deploy to staging
  mycli deploy production   Deploy to production
  mycli logs -f             Tail production logs

COMMANDS
  deploy    Deploy application
  logs      View logs
  config    Manage configuration

Run 'mycli <command> --help' for details
```

## Secrets

### Secrets in Flags

```bash
# TERRIBLE - visible in `ps`, shell history, logs
$ mycli --api-key sk-secret1234

# Bad - visible in /proc/*/environ, inherited by children
$ API_KEY=sk-secret1234 mycli deploy

# Good - from protected file
$ mycli --api-key-file ~/.config/mycli/credentials

# Good - from stdin
$ cat ~/.secrets/key | mycli --api-key-stdin
```

### Secrets in Environment Variables

```bash
# Risk: leaked in error reports, logs, child processes
$ export API_KEY=sk-secret
$ mycli deploy
Error: Deployment failed
Environment: API_KEY=sk-secret  # Oops!
```

Use credential files or system keychain instead.

## Output

### No --json for Scripting

```bash
# Bad - forces fragile text parsing
$ mycli users list
NAME         EMAIL
Alice        alice@example.com
# Script has to parse with awk/cut, breaks if format changes

# Good - structured output
$ mycli users list --json
[{"name": "Alice", "email": "alice@example.com"}]
```

### Ignoring NO_COLOR / TERM=dumb

```bash
# Bad - ANSI codes corrupt output
$ NO_COLOR=1 mycli list > output.txt
$ cat output.txt
^[[32m✓^[[0m item1  # Garbage!

# Good - respects environment
$ NO_COLOR=1 mycli list > output.txt
$ cat output.txt
✓ item1
```

### ANSI Codes to Redirected Output

```bash
# Bad - doesn't detect non-TTY
$ mycli list > output.txt
$ file output.txt
output.txt: data  # Binary garbage

# Good - detects redirection
$ mycli list > output.txt
$ file output.txt
output.txt: ASCII text
```

### Table Borders

```
# Bad - breaks grep/awk
+--------+-------------------+
| NAME   | EMAIL             |
+--------+-------------------+
| Alice  | alice@example.com |
+--------+-------------------+

# Good - grep-friendly
NAME     EMAIL
Alice    alice@example.com
```

## Progress & Feedback

### No Progress for Slow Operations

```bash
# Bad - appears frozen
$ mycli deploy
[nothing for 30 seconds...]
Done!

# Good - shows activity
$ mycli deploy
Deploying... ⠋
  Building assets... done (2.3s)
  Uploading files [████░░░░] 45%
```

### Spinners to Non-TTY

```bash
# Bad - spinner characters in pipe
$ mycli build | tee log.txt
⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ Building...

# Good - detects non-TTY
$ mycli build | tee log.txt
Building...
Build complete.
```

## Commands & Arguments

### Generic Command Names

```bash
# Bad - conflicts with system tools
$ convert image.png  # ImageMagick's convert?
$ test -f file       # Shell builtin?
$ install package    # System install?

# Good - namespaced
$ myapp convert image.png
$ myapp test
$ myapp install package
```

### Requiring Too Many Arguments

```bash
# Bad - which is which?
$ copy src.txt dst.txt backup/ archive/

# Good - flags are explicit
$ copy --from src.txt --to dst.txt
```

### Inconsistent Flag Naming

```bash
# Bad - inconsistent
--no-color     # negative prefix
--verbose      # positive
--skip-tests   # verb prefix
--with-deps    # "with" prefix

# Good - consistent pattern
--color/--no-color
--verbose/--no-verbose
--tests/--no-tests
--deps/--no-deps
```

## Exit Codes

### Always Exiting 0

```bash
# Bad - always success
$ mycli deploy
Error: Deployment failed
$ echo $?
0  # Scripts think it succeeded!

# Good - non-zero on failure
$ mycli deploy
Error: Deployment failed
$ echo $?
1
```

### Unclear Exit Codes

Document what non-zero codes mean:

```
EXIT CODES
  0    Success
  1    General error
  2    Invalid arguments
  3    Configuration error
  4    Network error
  5    Authentication error
```

## Breaking Changes

### No Deprecation Warning

```bash
# Bad - just breaks
# v1.0
$ mycli --env production
# v2.0
$ mycli --env production
Error: Unknown flag --env

# Good - deprecation cycle
# v1.1
$ mycli --env production
Warning: --env is deprecated, use --environment
Deploying to production...
# v2.0
$ mycli --env production
Error: --env was removed in v2.0
Use --environment instead: mycli --environment production
```

### Removing Commands Without Warning

```bash
# v1.0
$ mycli migrate

# v2.0 - bad
$ mycli migrate
Error: Unknown command 'migrate'

# v2.0 - good
$ mycli migrate
Error: 'migrate' was moved to 'db:migrate' in v2.0
Run: mycli db:migrate
```

## Input Handling

### Hanging on Empty Input

```bash
# Bad - hangs waiting for stdin forever
$ mycli process
[cursor blinking, no indication of what's happening]

# Good - detects empty input, shows help
$ mycli process
Error: No input provided

Usage: mycli process <file>
       cat data.txt | mycli process

Provide a file argument or pipe data to stdin.
```

### No `--` Support

```bash
# Bad - can't pass flags to subprocess
$ npm test --watch
npm ERR! Unknown option: --watch

# Good - respects --
$ npm test -- --watch
Running jest --watch...
```

## Configuration

### Hardcoded Paths

```bash
# Bad - assumes home directory structure
config_path = "/home/user/.mycli"  # Windows? Different username?

# Good - uses environment/standards
config_path = os.path.join(
    os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')),
    'mycli'
)
```

### Modifying Files Without Consent

```bash
# Bad - just does it
$ mycli setup
Modified ~/.bashrc

# Good - asks first
$ mycli setup
This will add to ~/.bashrc:
  eval "$(mycli init)"

Proceed? [y/N]
```

## Error Messages

### Raw Stack Traces

```bash
# Bad - scary, unhelpful
$ mycli deploy
TypeError: Cannot read property 'name' of undefined
    at deploy (/usr/local/lib/node_modules/mycli/dist/commands/deploy.js:47:23)
    at async Command.run (/usr/local/lib/node_modules/mycli/dist/index.js:89:5)
    at async main (/usr/local/lib/node_modules/mycli/dist/index.js:156:3)

# Good - human-friendly with debug option
$ mycli deploy
Error: Configuration missing required field 'name'

Add 'name' to your mycli.yaml:
  name: my-application

For debugging: mycli deploy --debug
```

### No Recovery Suggestions

```bash
# Bad - just the error
$ mycli deploy
Error: Authentication failed

# Good - actionable
$ mycli deploy
Error: Authentication failed

Your session has expired or credentials are invalid.

Fix:
  mycli login           # Re-authenticate
  mycli auth status     # Check current auth
```

## Completeness

### Missing Short Flags

```bash
# Bad - no short form for common flags
$ mycli --verbose --force --dry-run  # Tedious

# Good - short forms available
$ mycli -vfn
```

### No Shell Completion

Tab completion is expected. Provide it:

```bash
$ mycli completion bash >> ~/.bashrc
$ mycli completion zsh >> ~/.zshrc
$ mycli completion fish >> ~/.config/fish/completions/mycli.fish
```

## Testing CLI Output

### Testing Only Happy Path

Test these too:

- Error messages (are they helpful?)
- Exit codes (correct for each failure type?)
- Non-TTY output (no ANSI codes?)
- `--json` output (valid JSON?)
- Ctrl-C handling (exits cleanly?)
- Long operations (shows progress?)
