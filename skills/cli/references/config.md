# Configuration

Configuration flows from system to user to project to flags. Higher specificity wins.

## Precedence Order

```
1. Command-line flags     (highest priority)
2. Environment variables
3. Project config         (.mycli.yaml in cwd or parents)
4. User config            (~/.config/mycli/config.yaml)
5. System config          (/etc/mycli/config.yaml)
6. Defaults               (lowest priority)
```

### Example Resolution

```yaml
# /etc/mycli/config.yaml (system)
timeout: 30
log_level: info

# ~/.config/mycli/config.yaml (user)
timeout: 60

# ./mycli.yaml (project)
log_level: debug

# Command
$ mycli --timeout 10 deploy
```

Result: `timeout=10` (flag), `log_level=debug` (project)

## XDG Base Directory Spec

Follow XDG on Unix. Users expect their configs in standard places.

| Purpose | XDG Variable       | Default          | macOS Alternative               |
| ------- | ------------------ | ---------------- | ------------------------------- |
| Config  | `$XDG_CONFIG_HOME` | `~/.config`      | `~/Library/Application Support` |
| Data    | `$XDG_DATA_HOME`   | `~/.local/share` | `~/Library/Application Support` |
| Cache   | `$XDG_CACHE_HOME`  | `~/.cache`       | `~/Library/Caches`              |
| State   | `$XDG_STATE_HOME`  | `~/.local/state` | `~/Library/Application Support` |

### Platform-Specific Paths

```javascript
function getConfigPath(appName) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA, appName)
  }
  if (process.platform === "darwin") {
    // Prefer XDG if set, otherwise use macOS convention
    return process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, appName)
      : path.join(os.homedir(), "Library", "Application Support", appName)
  }
  // Linux/Unix
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName)
}
```

### Full Platform Matrix

| Type   | Linux                | macOS                               | Windows                    |
| ------ | -------------------- | ----------------------------------- | -------------------------- |
| Config | `~/.config/app`      | `~/Library/Application Support/app` | `%APPDATA%\app`            |
| Data   | `~/.local/share/app` | `~/Library/Application Support/app` | `%LOCALAPPDATA%\app`       |
| Cache  | `~/.cache/app`       | `~/Library/Caches/app`              | `%LOCALAPPDATA%\app\cache` |
| Logs   | `~/.local/state/app` | `~/Library/Logs/app`                | `%LOCALAPPDATA%\app\logs`  |

## Project Configuration

### Discovery

Walk up directory tree to find project config:

```
/home/user/projects/myapp/src/
  └── Look for .mycli.yaml here
      └── Then here: /home/user/projects/myapp/
          └── Then here: /home/user/projects/
              └── Stop at home or root
```

### Project Config Files

Support multiple names:

- `.mycli.yaml` / `.mycli.yml`
- `mycli.config.yaml`
- `.myclirc`
- `mycli.config.js` (if you want programmatic config)

### Show Active Config

```
$ mycli config show
Config files (in precedence order):
  1. ./mycli.yaml (project)
  2. ~/.config/mycli/config.yaml (user)

Active configuration:
  timeout: 60 (from: ./mycli.yaml)
  log_level: debug (from: ~/.config/mycli/config.yaml)
  api_url: https://api.mycli.dev (default)
```

## Environment Variables

### Naming Convention

```
MYCLI_TIMEOUT=60
MYCLI_LOG_LEVEL=debug
MYCLI_API_URL=https://api.mycli.dev
```

Pattern: `{APPNAME}_{CONFIG_KEY}` in SCREAMING_SNAKE_CASE

### Nested Config

```yaml
# Config file
database:
  host: localhost
  port: 5432
```

```bash
# Environment
MYCLI_DATABASE_HOST=localhost
MYCLI_DATABASE_PORT=5432
# or with double underscore
MYCLI_DATABASE__HOST=localhost
```

### Boolean Environment Variables

```bash
# These should all mean "true"
MYCLI_VERBOSE=1
MYCLI_VERBOSE=true
MYCLI_VERBOSE=yes
MYCLI_VERBOSE=on

# These should mean "false"
MYCLI_VERBOSE=0
MYCLI_VERBOSE=false
MYCLI_VERBOSE=no
MYCLI_VERBOSE=off
MYCLI_VERBOSE=       # empty
# (unset)            # not present
```

## .env Files

Support `.env` for project-level environment:

```bash
# .env
MYCLI_API_KEY=sk-1234567890
MYCLI_ENVIRONMENT=development
```

### .env Precedence

```
1. Actual environment (export MYCLI_X=...)
2. .env.local (git-ignored, personal overrides)
3. .env.{environment} (.env.development, .env.production)
4. .env (committed, shared defaults)
```

### Security Warning

```
$ cat .env
MYCLI_API_KEY=sk-1234567890

$ mycli deploy
Warning: .env contains MYCLI_API_KEY
  API keys in .env files may be committed to git.
  Consider using a secrets manager or ~/.config/mycli/credentials

  Suppress this warning: MYCLI_ALLOW_ENV_SECRETS=1
```

## Credential Storage

### Never in Flags or Environment

```bash
# NEVER - visible in process list, shell history
$ mycli --api-key sk-1234567890

# AVOID - visible in /proc, inherited by child processes
$ MYCLI_API_KEY=sk-1234 mycli deploy
```

### Secure Alternatives

```yaml
# ~/.config/mycli/credentials (mode 600)
api_key: sk-1234567890
```

```bash
# Or from stdin
$ echo "$API_KEY" | mycli --api-key-stdin

# Or from file
$ mycli --api-key-file ~/.secrets/mycli-key
```

### System Keychain

Best practice on desktop:

```
# macOS - Keychain
$ security add-generic-password -s mycli -a api_key -w

# Linux - Secret Service
$ secret-tool store --label="mycli api key" service mycli key api_key

# Windows - Credential Manager
$ cmdkey /add:mycli /user:api_key /pass:sk-...
```

## Config Commands

### Essential Commands

```bash
# View all config
$ mycli config list
$ mycli config show

# Get specific value
$ mycli config get timeout
60

# Set value (user config by default)
$ mycli config set timeout 120

# Set in specific scope
$ mycli config set --global timeout 120  # user config
$ mycli config set --local timeout 30    # project config

# Edit in editor
$ mycli config edit

# Show config file location
$ mycli config path
~/.config/mycli/config.yaml

# Validate config
$ mycli config validate
✓ Configuration is valid
```

## Config Validation

### On Load

```
$ mycli deploy
Error: Invalid configuration

~/.config/mycli/config.yaml:
  Line 15: 'timeout' must be a positive integer, got 'fast'

Fix:
  timeout: 60  # seconds
```

### Schema Validation

Provide JSON Schema for IDE support:

```yaml
# mycli.yaml
# yaml-language-server: $schema=https://mycli.dev/schema.json
timeout: 60
```

## Consent for System Modification

Ask before modifying system files:

```
$ mycli install-completion
This will modify your shell configuration:
  ~/.zshrc

Proceed? [y/N] _
```

```
$ mycli setup
This will create:
  ~/.config/mycli/config.yaml
  ~/.config/mycli/credentials (mode 600)

Proceed? [y/N] _
```

## Migration

When config format changes:

```
$ mycli deploy
Warning: Config format has changed

Your config file uses an outdated format.
Run 'mycli config migrate' to update.

Continuing with compatibility mode...
```

```
$ mycli config migrate
Migrating ~/.config/mycli/config.yaml...
  ✓ Renamed 'api_key' to 'credentials.api_key'
  ✓ Moved 'verbose' to 'output.verbose'

Backup saved to: ~/.config/mycli/config.yaml.bak
```

## Default Config Generation

```
$ mycli init
Created ~/.config/mycli/config.yaml with defaults:

# mycli configuration
# Full reference: https://mycli.dev/docs/config

timeout: 30
log_level: info

# Uncomment to customize:
# api_url: https://api.mycli.dev
# output:
#   format: table
#   color: auto
```
