# Error Handling

Great errors don't just say what went wrong—they help you fix it.

## Anatomy of a Great Error

```
Error: EACCES - Permission denied

Could not write to /etc/mycli/config.yaml
The file exists but is not writable by the current user.

Fix: Run with elevated permissions or change file ownership:
  sudo mycli config set key value
  # or
  sudo chown $USER /etc/mycli/config.yaml

More info: https://mycli.dev/docs/errors/EACCES
```

### The Five Components

| Component   | Purpose           | Example                                     |
| ----------- | ----------------- | ------------------------------------------- |
| Code        | Unique identifier | `EACCES`, `E001`, `AUTH_FAILED`             |
| Title       | Brief summary     | `Permission denied`                         |
| Description | What happened     | `Could not write to /etc/mycli/config.yaml` |
| Fix         | How to resolve    | `Run with sudo or change ownership`         |
| URL         | Deep dive         | `https://mycli.dev/docs/errors/EACCES`      |

## Error Message Guidelines

### Be Specific

```
# Bad
Error: Invalid input

# Good
Error: Invalid email address

The value 'not-an-email' is not a valid email address.
Expected format: user@domain.com
```

### Be Actionable

```
# Bad
Error: Connection failed

# Good
Error: Could not connect to database

The database at localhost:5432 refused the connection.

Possible causes:
  • Database server is not running
  • Wrong port number
  • Firewall blocking connection

Fix:
  • Start the database: brew services start postgresql
  • Check port: mycli config get db.port
  • Test connection: pg_isready -h localhost -p 5432
```

### Be Human

```
# Bad (robot voice)
ERROR_CODE_47: PARAMETER_VALIDATION_FAILURE

# Good
Error: Missing required flag

The --environment flag is required for deployment.

Usage:
  mycli deploy --environment production
```

## Exit Codes

| Code | Meaning        | Use For                  |
| ---- | -------------- | ------------------------ |
| 0    | Success        | Everything worked        |
| 1    | General error  | Catch-all failures       |
| 2    | Misuse         | Invalid args, bad flags  |
| 126  | Not executable | Permission issues        |
| 127  | Not found      | Command doesn't exist    |
| 128+ | Signal         | 128 + signal number      |
| 130  | Ctrl-C         | User interrupted (128+2) |

### Meaningful Exit Codes

```bash
# Different codes for different failures
exit 0   # Success
exit 1   # General error
exit 2   # Bad arguments
exit 3   # Config error
exit 4   # Network error
exit 5   # Auth error
```

Document your exit codes in help:

```
EXIT CODES
  0    Success
  1    General error
  2    Invalid arguments
  3    Configuration error
  4    Network error
  5    Authentication error
```

## Catch and Humanize Expected Errors

### Common Error Translations

| Raw Error      | Human Error             |
| -------------- | ----------------------- |
| `ENOENT`       | File not found          |
| `EACCES`       | Permission denied       |
| `ECONNREFUSED` | Could not connect       |
| `ETIMEDOUT`    | Connection timed out    |
| `ENOTFOUND`    | Host not found          |
| `EPERM`        | Operation not permitted |

```
# Bad - raw error
Error: ENOENT: no such file or directory, open 'config.yaml'

# Good - humanized
Error: Configuration file not found

Expected config at: ./config.yaml

Fix: Create a config file:
  mycli init
  # or specify a different path:
  mycli --config /path/to/config.yaml
```

## Group Similar Errors

```
# Bad - spam
Error: Cannot read file: src/index.ts (permission denied)
Error: Cannot read file: src/utils.ts (permission denied)
Error: Cannot read file: src/types.ts (permission denied)
Error: Cannot read file: src/config.ts (permission denied)
[47 more errors...]

# Good - grouped
Error: Cannot read files (permission denied)

51 files in src/ are not readable.

Fix:
  chmod -R +r src/
```

## Critical Info at End

Eyes rest at the end. Put the most important information last.

```
# Bad - important info buried
Error: Deployment failed

The build failed because TypeScript found errors.
Run 'tsc --noEmit' to see the errors.

Build output:
  [200 lines of logs...]

# Good - important info at end
Error: Deployment failed

Build output:
  [200 lines of logs...]

The build failed due to TypeScript errors.
Run 'tsc --noEmit' to see the errors.
```

## Debug Information

### Don't Dump to stderr

```
# Bad - overwhelming
Error: API request failed
  at fetch (/app/src/api.ts:47:3)
  at async deploy (/app/src/deploy.ts:23:5)
  at async main (/app/src/index.ts:10:3)
Request headers: { Authorization: 'Bearer sk-...' }
Response: { status: 500, body: '...' }
[100 more lines of debug info]

# Good - save to file
Error: API request failed

The server returned an unexpected error.

Debug information saved to: /tmp/mycli-debug-20240115.log
Report this issue: https://github.com/mycli/cli/issues/new
```

### DEBUG Environment Variable

```bash
# Normal run - clean output
$ mycli deploy
Deploying... done

# Debug mode - verbose logging
$ DEBUG=mycli mycli deploy
[mycli:api] POST /deploy
[mycli:api] Headers: { ... }
[mycli:api] Response: 200
Deploying... done
```

### Debug Levels

```bash
DEBUG=mycli:*        # All debug output
DEBUG=mycli:api      # Only API debug
DEBUG=mycli:config   # Only config debug
```

## Easy Bug Reporting

### Pre-populated Issue URL

```
Error: Unexpected crash

Something went wrong. Please report this issue:

https://github.com/mycli/cli/issues/new?\
  title=Crash%20in%20deploy%20command&\
  body=Version:%202.1.0%0AOS:%20darwin%0A...

Debug log: /tmp/mycli-crash-20240115.log
```

### Include Diagnostic Info

```
$ mycli doctor
mycli 2.1.0
Node.js 20.10.0
OS: darwin arm64 (macOS 14.2)
Shell: /bin/zsh
Terminal: iTerm2
Config: ~/.mycli/config.yaml (valid)
Auth: Logged in as user@example.com
```

## Recovery Suggestions

### Always Suggest a Fix

```
Error: Authentication expired

Your session has expired.

Fix:
  mycli login
```

```
Error: Config file invalid

The config file at ~/.mycli/config.yaml contains invalid YAML.

Error on line 15: unexpected indentation

Fix:
  mycli config edit     # Open in editor
  mycli config validate # Check for errors
```

### Offer Alternatives

```
Error: Command 'mycli migrate' not found

Did you mean?
  mycli db:migrate
  mycli config:migrate
```

## Warning vs Error

| Type    | Exit Code | When to Use                              |
| ------- | --------- | ---------------------------------------- |
| Warning | 0         | Potential issue, but operation succeeded |
| Error   | Non-zero  | Operation failed                         |

```
# Warning - succeeded but concerning
$ mycli deploy
Warning: Using deprecated --env flag. Use --environment instead.
Deployed successfully!
$ echo $?
0

# Error - failed
$ mycli deploy --environment invalid
Error: Unknown environment 'invalid'
$ echo $?
1
```

## Error in JSON Mode

```bash
# JSON errors should be valid JSON
$ mycli deploy --json
{
  "error": {
    "code": "AUTH_EXPIRED",
    "message": "Authentication expired",
    "suggestion": "Run 'mycli login' to re-authenticate",
    "docs": "https://mycli.dev/docs/errors/AUTH_EXPIRED"
  }
}
```

## Retry Suggestions

For transient errors:

```
Error: Request timed out

The server did not respond in time.

This may be a temporary issue. Try again:
  mycli deploy --retry 3
```

## Partial Success

When some operations succeed and others fail:

```
$ mycli deploy --all
Deploying 5 services...
  ✓ api
  ✓ web
  ✗ worker - Build failed (see above)
  ✓ scheduler
  ✓ queue

3 succeeded, 1 failed, 1 skipped

Fix the worker build and run:
  mycli deploy worker
```
