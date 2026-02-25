# Output & Formatting

Stdout is for data. Stderr is for humans. Colors are for TTYs.

## The Streams

| Stream | Purpose               | Examples                                     |
| ------ | --------------------- | -------------------------------------------- |
| stdout | Program output (data) | Query results, generated content, piped data |
| stderr | Human messaging       | Progress, errors, warnings, debug info       |

### Why This Matters

```bash
# stdout goes to file, stderr shows in terminal
$ mycli query users > users.json
Querying users... done (47 results)

# Piping - stdout flows, stderr stays visible
$ mycli list | grep admin
Fetching list...    # stderr - visible
admin@example.com   # stdout - piped to grep
```

### Rule of Thumb

> If it should appear when piped to another program, use stdout.
> If it's for the human watching, use stderr.

## Human vs Machine Output

### TTY Detection

```
if stdout.isTTY:
    # Human at terminal
    - Use colors
    - Show progress indicators
    - Format tables nicely
    - Truncate to terminal width
else:
    # Piped or redirected
    - Plain text only
    - No ANSI codes
    - Full output (no truncation)
    - One record per line
```

### The `--json` Flag

Always provide `--json` for scripting:

```bash
# Human output (default)
$ mycli users list
NAME              EMAIL                  ROLE
Alice Smith       alice@example.com      admin
Bob Jones         bob@example.com        user

# Machine output
$ mycli users list --json
[
  {"name": "Alice Smith", "email": "alice@example.com", "role": "admin"},
  {"name": "Bob Jones", "email": "bob@example.com", "role": "user"}
]
```

### Also Consider

- `--csv` - for spreadsheets
- `--tsv` - for easy parsing
- `--raw` - unformatted single values

## Color Guidelines

### When to Use Color

| Use      | Color     | Example                   |
| -------- | --------- | ------------------------- |
| Success  | Green     | `✓ Deployed successfully` |
| Error    | Red       | `✗ Build failed`          |
| Warning  | Yellow    | `⚠ Deprecated flag`       |
| Info     | Blue/Cyan | `→ Connecting...`         |
| Emphasis | Bold      | `**Important**`           |
| Dimmed   | Gray      | Secondary info            |

### Respecting User Preferences

Check in order:

1. `--no-color` flag → disable
2. `--color` flag → force enable
3. `NO_COLOR` env var (any value) → disable
4. `FORCE_COLOR` env var → enable
5. `TERM=dumb` → disable
6. Not a TTY → disable
7. Otherwise → enable

```javascript
function shouldUseColor() {
  if (flags.noColor) return false
  if (flags.color) return true
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined) return true
  if (process.env.TERM === "dumb") return false
  if (!process.stdout.isTTY) return false
  return true
}
```

### Color Accessibility

- Never use color as the only indicator (add symbols: ✓ ✗ ⚠)
- Ensure sufficient contrast
- Test with colorblind simulators
- Support `--no-color` for all colored output

## Tables

### Good Table Design

```
# Good - grep-friendly, no borders
NAME              EMAIL                  ROLE
Alice Smith       alice@example.com      admin
Bob Jones         bob@example.com        user

# Bad - borders break grep/awk
+---------------+---------------------+-------+
| NAME          | EMAIL               | ROLE  |
+---------------+---------------------+-------+
| Alice Smith   | alice@example.com   | admin |
+---------------+---------------------+-------+
```

### Table Flags

```
--no-headers     # Omit header row (for scripting)
--columns        # Select specific columns
--sort           # Sort by column
--no-truncate    # Don't truncate to terminal width
```

```bash
# Get just emails
$ mycli users list --no-headers --columns email
alice@example.com
bob@example.com

# Sort by role
$ mycli users list --sort role
```

### Truncation

```
# Fits terminal (80 cols)
NAME            EMAIL                 ROLE
Alice Smith     alice@example.com     admin

# Truncated when necessary
NAME            EMAIL                 RO…
Alice Smith     alice@example.c…      ad…

# With --no-truncate
NAME              EMAIL                    ROLE
Alice Smith       alice@example.com        admin
```

## Progress Indicators

### On stderr (Not stdout)

```bash
# Progress on stderr, results on stdout
$ mycli export > data.json
Exporting records... [████████░░░░░░░░] 50%
```

### Spinner Patterns

```
# Simple spinner
Connecting... ⠋

# With status updates
Deploying...
  ⠋ Building assets
  ✓ Uploading files
  ⠋ Running migrations
```

### Clear Before Output

```
# Don't leave spinners in output
Connecting... ⠋
Connected!     # Spinner replaced, not left hanging
```

## Redirected Output Detection

```javascript
// Detect if output is being redirected
if (!process.stdout.isTTY) {
  // Output is being piped or redirected
  // - Disable colors
  // - Disable progress indicators
  // - Don't truncate
}
```

### File Redirect Safety

```bash
# Should produce clean output without ANSI codes
$ mycli list > output.txt
$ cat output.txt  # No garbage characters
```

## Verbosity Levels

```
# Quiet - errors only
$ mycli deploy -q
Error: Deployment failed

# Normal - key information
$ mycli deploy
Deploying to production...
Deployed successfully!

# Verbose - detailed progress
$ mycli deploy -v
Deploying to production...
  Building assets...
  Asset bundle: 2.3MB
  Uploading to CDN...
  Upload complete: 3.2s
  Updating database...
  Migration: 001_add_users (0.1s)
Deployed successfully in 45s

# Debug - everything
$ mycli deploy -vvv
[DEBUG] Loading config from ~/.mycli/config.yaml
[DEBUG] API endpoint: https://api.mycli.dev
[DEBUG] Auth token: sk-****1234
...
```

### Stacking Verbose Flags

```
-v      # Verbose
-vv     # Very verbose
-vvv    # Debug level
```

## Output Encoding

- Always use UTF-8
- Support emoji (but use sparingly)
- Handle wide characters in tables
- Test with non-ASCII filenames

```
# Wide character handling
NAME              STATUS
日本語ファイル      ✓ Ready
```

## Timing Information

```bash
# Show duration for operations
$ mycli build
Built in 2.3s

$ mycli test
47 tests passed in 1.2s

# For long operations
$ mycli deploy
Deployed successfully (took 2m 34s)
```

## Paging Long Output

For output longer than terminal height:

```bash
# Auto-page when TTY
$ mycli logs  # Opens in $PAGER (less)

# Disable with flag
$ mycli logs --no-pager

# Or pipe explicitly
$ mycli logs | head -20
```

### Pager Guidelines

- Only auto-page on TTY
- Respect `$PAGER` env var
- Default to `less -R` (supports colors)
- Provide `--no-pager` flag
