---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Browser automation via the `browser` CLI. Connects to a background daemon that manages Playwright browsers.

## Quick Start

```bash
browser open https://example.com    # Navigate (auto-starts daemon)
browser snapshot                     # Get accessibility tree
browser click "button[Submit]"       # Click element
browser fill "#email" "test@test.com" # Fill input
browser screenshot                   # Take screenshot
browser close                        # Close browser and daemon
```

## Commands Reference

### Navigation

| Command | Description |
|---------|-------------|
| `browser open <url>` | Navigate to URL (auto-starts daemon) |
| `browser open --headed <url>` | Navigate with visible browser window |
| `browser open --profile true <url>` | Use default Chrome profile (cookies/auth) |
| `browser open --profile /path <url>` | Use custom profile path |
| `browser open --cdp http://127.0.0.1:9222 <url>` | Connect to existing Chrome via CDP |
| `browser open --waitUntil networkidle <url>` | Wait for network idle (load, domcontentloaded, networkidle) |
| `browser back` | Go back in history |
| `browser forward` | Go forward in history |
| `browser reload` | Reload current page |

### Page Content

| Command | Description |
|---------|-------------|
| `browser snapshot` | Get page accessibility tree with refs |
| `browser snapshot -i` | Interactive elements only |
| `browser snapshot -c` | Compact mode (no empty elements) |
| `browser snapshot --depth 3` | Limit tree depth |
| `browser snapshot --selector ".main"` | Snapshot specific element |
| `browser screenshot [path]` | Take screenshot |
| `browser screenshot -f` | Full page screenshot |
| `browser screenshot --selector ".modal"` | Screenshot specific element |
| `browser screenshot --format jpeg --quality 80` | JPEG with quality |
| `browser content` | Get page HTML |
| `browser content ".main"` | Get element's outer HTML |
| `browser get url` | Get current URL |
| `browser get title` | Get page title |
| `browser get text <selector>` | Get element text |

### Actions

| Command | Description |
|---------|-------------|
| `browser click <selector>` | Click element (supports @refs) |
| `browser click --button right <selector>` | Right-click element |
| `browser click --count 2 <selector>` | Double-click element |
| `browser fill <selector> <value>` | Fill input field (clears first) |
| `browser type <selector> <text>` | Type text character by character |
| `browser type --delay 100 <selector> <text>` | Type with delay between keys (ms) |
| `browser type --clear <selector> <text>` | Clear field before typing |
| `browser hover <selector>` | Hover over element |
| `browser check <selector>` | Check checkbox |
| `browser uncheck <selector>` | Uncheck checkbox |
| `browser press <key>` | Press keyboard key (Enter, Tab, Escape, etc.) |
| `browser press --selector <sel> <key>` | Press key on specific element |
| `browser select <selector> <value>` | Select dropdown option |
| `browser scroll down` | Scroll page down |
| `browser scroll up` | Scroll page up |
| `browser scroll --amount 500 down` | Scroll specific amount (pixels) |
| `browser scroll --selector ".container" down` | Scroll within element |
| `browser scroll -x 100 -y 200` | Scroll to specific coordinates |

### Tabs

| Command | Description |
|---------|-------------|
| `browser tab list` | List all tabs |
| `browser tab new` | Open new tab |
| `browser tab switch <index>` | Switch to tab by index |
| `browser tab close [index]` | Close tab |

### Debug

| Command | Description |
|---------|-------------|
| `browser console` | Get console messages |
| `browser console --clear` | Get and clear console messages |
| `browser errors` | Get page errors |
| `browser errors --clear` | Get and clear page errors |
| `browser eval <script>` | Evaluate JavaScript and return result |
| `browser wait <selector>` | Wait for element to appear |
| `browser wait --state visible <selector>` | Wait for element to be visible |
| `browser wait --state hidden <selector>` | Wait for element to be hidden |
| `browser wait --timeout 10000 <selector>` | Wait with custom timeout (ms) |

### Interactive

| Command | Description |
|---------|-------------|
| `browser pick <message>` | Interactive element picker (let user click to select) |
| `browser pick --multi <message>` | Pick multiple elements |

### Session Management

| Command | Description |
|---------|-------------|
| `browser close` | Close browser and daemon |
| `browser --session myname open <url>` | Use named session |

## Using Element Refs

After `snapshot`, elements have refs like `[ref=e1]`. Use them directly with `@`:

```bash
browser snapshot
# Output:
# - button "Submit" [ref=e1]
# - link "Home" [ref=e2]

browser click @e1    # Click the Submit button
browser hover @e2    # Hover over Home link
```

**Important:** Refs are regenerated on each snapshot call. Always get a fresh snapshot before using refs, especially after page state changes (navigation, form fills, etc.).

## Interactive Element Picker

When you need a specific selector but can't determine it from the snapshot, use `browser pick`:

```bash
# Ask user to select the element
browser pick "Click the button you want to submit the form"

# User clicks the button in browser
# Output (JSON):
# {"selector":"button.submit-btn","tag":"button","text":"Submit","html":"..."}

# Use the selector in subsequent commands
browser click "button.submit-btn"
```

**When to use pick:**
- Complex pages where snapshot refs aren't precise enough
- User says "click that button" but doesn't specify which one
- Forms with multiple similar inputs
- Dynamic content that's hard to identify from accessibility tree

## Headed Mode

By default, the browser runs headless. Use `--headed` for visible browser:

```bash
browser open https://example.com --headed
```

## Using Chrome Profile (Cookies & Auth)

Use `--profile` to leverage your existing Chrome cookies and authentication state. This is useful for accessing sites where you're already logged in.

**Important:** Options must come before the URL argument:

```bash
# Use default Chrome profile (recommended)
browser open --profile true --headed https://github.com

# Use custom profile path
browser open --profile "/path/to/profile" https://github.com
```

**How it works:**
- Copies essential profile data (cookies, local storage, login data) to a temp directory
- Uses Playwright's persistent context to maintain session state
- Avoids locking conflicts with your running Chrome browser

**Tips:**
- Use `--headed` when working with profiles to see the browser state
- The profile is copied once per session, so changes won't affect your real Chrome
- Close Chrome before using a profile if you experience issues

**Limitations:**
- Chrome profile cookies are encrypted by macOS Keychain and cannot be decrypted by Playwright
- For full cookie/auth access, use CDP mode (see below)

## CDP Mode (Connect to Existing Chrome)

Use `--cdp` to connect to an existing Chrome instance via Chrome DevTools Protocol. This gives full access to your running Chrome with all authentication state preserved.

**Step 1:** Start Chrome with remote debugging enabled:
```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
chrome.exe --remote-debugging-port=9222
```

**Step 2:** Connect via the browser CLI:
```bash
browser open --cdp http://127.0.0.1:9222 https://github.com
```

**Benefits:**
- Full access to Chrome's decrypted cookies and auth state
- Works with sites using strict cookie encryption
- Control your actual Chrome tabs, not a separate Playwright browser
- No profile copying needed

**Tips:**
- The CDP endpoint URL can be found in Chrome at `chrome://inspect`
- You can connect to an already-running Chrome if it was started with `--remote-debugging-port`
- CDP mode ignores `--headed` and `--profile` options since you control the Chrome instance directly

## Sessions

Use sessions to run multiple browser instances:

```bash
# Terminal 1
browser -s session1 open https://site1.com

# Terminal 2
browser -s session2 open https://site2.com
```

## Common Workflows

### Navigate and Extract Data

```bash
browser open https://example.com
browser snapshot -i                    # Get interactive elements
browser click @e1                      # Click using ref
browser get text ".result"             # Get text from element
```

### Fill a Form

```bash
browser open https://example.com/login
browser fill "#email" "user@test.com"
browser fill "#password" "secret"
browser click "button[type=submit]"
browser wait ".dashboard"              # Wait for redirect
```

### Take Screenshot After Action

```bash
browser open https://example.com
browser click ".menu-toggle"
browser screenshot /tmp/menu-open.png
```

### Debug Page Issues

```bash
browser open https://example.com
browser console                        # Check console messages
browser errors                         # Check JS errors
browser eval "document.querySelectorAll('a').length"  # Count links
```

## Output Formats

By default, commands output human-readable text. Use `-j` for machine-readable JSON output:

```bash
browser snapshot -j              # JSON accessibility tree with refs and stats
browser get url -j               # {"url": "..."}
browser tab list -j              # JSON array of tabs
```

**Note:** The `-j` flag must come **after** the subcommand, not before it.

## Architecture

The CLI uses a daemon architecture for reliable browser lifecycle management:

```
CLI ──► DaemonManager ──► Unix Socket ──► Daemon ──► PlaywrightService
```

**Key components:**
- **CLI** (`src/cli.ts`) - Parses commands, manages daemon lifecycle
- **DaemonManager** (`src/services/DaemonManager.ts`) - Spawns/checks daemon process
- **Daemon** (`src/daemon/server.ts`) - Background process, listens on Unix socket
- **PlaywrightService** (`src/services/PlaywrightService.ts`) - Executes browser commands

**Services have test layers:**
```typescript
// Mock any command response
PlaywrightService.Test((cmd) => mockResponse(cmd.id, { url: '...' }))

// Mock daemon availability
DaemonManager.Test('/tmp/test.sock')
```

## Important Notes

- **Option placement:** All options (like `--headed`, `--profile`, `-j`) must come **before** positional arguments due to @effect/cli parser behavior
- **Refs are ephemeral:** Element refs (`@e1`, `@e2`) are regenerated on each `snapshot` call - always get a fresh snapshot before using refs
- **Daemon auto-starts:** The daemon starts automatically on first command and persists across commands until `browser close`
- **Sessions are isolated:** Named sessions (`--session name`) run completely separate browser instances

## Development

```bash
# Run from source
bun run src/cli.ts open https://example.com

# Type check
bun run typecheck

# Run tests
bun run test
```
