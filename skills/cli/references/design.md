# CLI UX Design

The best CLIs feel instantaneous, stay out of your way, and help you recover when things go wrong.

## The 100ms Rule

| Response Time | Perception    | Action                |
| ------------- | ------------- | --------------------- |
| <100ms        | Instantaneous | Ideal target          |
| 100-500ms     | Slight delay  | Acceptable            |
| 500ms-2s      | Noticeable    | Show spinner          |
| >2s           | Slow          | Progress bar with ETA |

**Key insight**: Print _something_ within 100ms, even if work continues.

```
# Bad - appears frozen
$ deploy
[3 seconds of nothing]
Deployed!

# Good - immediate feedback
$ deploy
Deploying to production...
  ├─ Building assets... done
  ├─ Uploading files... 45%
```

## Progress Indicators

### When to Use What

| Duration | Indicator        | Example              |
| -------- | ---------------- | -------------------- |
| <500ms   | Nothing          | Quick lookups        |
| 500ms-5s | Spinner          | API calls            |
| >5s      | Progress bar     | File uploads, builds |
| Unknown  | Spinner + status | Network operations   |

### Progress Bar Anatomy

```
Uploading files [████████░░░░░░░░] 45% (12/27) ETA: 2m 30s
                │        │        │    │       │
                │        │        │    │       └─ Time remaining
                │        │        │    └─ Current/total items
                │        │        └─ Percentage
                │        └─ Empty portion
                └─ Filled portion
```

### Rules

- Only show on TTY (check `process.stdout.isTTY`)
- Clear spinner before printing output
- Update at most 10x/second (avoid flicker)
- Show what's happening, not just that something is happening

## TTY Detection

```
if TTY:
  - Colors allowed
  - Spinners/progress bars
  - Interactive prompts
  - Truncate to terminal width
else:
  - Plain text only
  - No ANSI codes
  - Full output (no truncation)
  - Fail if input required (or use defaults)
```

### Force Flags

- `--no-input` / `--non-interactive` - disable prompts
- `--no-color` - disable colors (also: `NO_COLOR` env)
- `--color` - force colors even without TTY

## Interactivity

### Prompts

```
# Confirmation for destructive actions
$ db drop production
This will permanently delete all data in 'production'.
Type the database name to confirm: _

# Selection from options
$ deploy
Select environment:
  1. staging
  2. production
> _

# With default (press Enter to accept)
$ init
Project name [my-project]: _
```

### Prompt Rules

1. **Always allow flag override** - `--yes`, `--env=production`
2. **Show default in brackets** - `[default-value]`
3. **Fail in non-TTY** - don't hang waiting for input
4. **Validate input** - re-prompt on invalid, show why

## Ctrl-C Handling

Users expect Ctrl-C to stop immediately. Honor this contract.

```
# Good - exits within 100ms
$ build
Building...
^C
Cancelled. Partial output in ./dist

# Bad - ignores or delays
$ build
Building...
^C
^C
^C
Please wait, cleaning up...
[10 seconds later]
```

### Guidelines

- Exit within 100ms of Ctrl-C
- Clean up what you can, but don't block
- Print what was accomplished (partial results)
- Don't corrupt state (use atomic operations)

## Suggest Next Commands

Guide users through workflows:

```
$ git commit -m "feat: add login"
[main abc1234] feat: add login

Next steps:
  git push origin main     Push to remote
  git log --oneline -5     View recent commits
```

```
$ npm init
Created package.json

Get started:
  npm install <pkg>    Add a dependency
  npm test             Run tests
```

## Dry-Run Mode

For expensive or destructive operations:

```
$ deploy --dry-run
Would deploy to production:
  - Build assets (estimated: 2m)
  - Upload 47 files to CDN
  - Update 3 database migrations
  - Restart 4 server instances

Run without --dry-run to execute.
```

### When to Offer Dry-Run

- Destructive operations (delete, overwrite)
- Expensive operations (cloud resources, long builds)
- Operations with side effects (emails, notifications)
- First-time setup (show what will be created)

## Confirmation Dialogs

### Levels of Confirmation

```
# Level 1: Simple yes/no
$ rm -rf node_modules
Remove node_modules/? [y/N] _

# Level 2: Type to confirm
$ db drop production
Type 'production' to confirm: _

# Level 3: Require flag
$ db drop production
Error: Refusing to drop production database.
Use --i-know-what-im-doing to override.
```

### When to Use Each

| Level           | Use Case                        |
| --------------- | ------------------------------- |
| None            | Safe, reversible operations     |
| y/N             | Mildly destructive, recoverable |
| Type to confirm | Destructive, hard to recover    |
| Require flag    | Catastrophic, no recovery       |

## Signal Handling

| Signal          | Meaning           | Response                          |
| --------------- | ----------------- | --------------------------------- |
| SIGINT (Ctrl-C) | User interrupt    | Clean exit, print partial results |
| SIGTERM         | Terminate request | Graceful shutdown                 |
| SIGPIPE         | Output closed     | Exit silently (don't error)       |
| SIGHUP          | Terminal closed   | Continue or clean exit            |

## Timing Feedback

For operations users might repeat:

```
$ build
Built in 2.3s

$ test
47 tests passed in 1.2s

$ deploy
Deployed in 45s
```

Helps users:

- Know if something is slower than usual
- Compare optimization attempts
- Set expectations for CI/CD
