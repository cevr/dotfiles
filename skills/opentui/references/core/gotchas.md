# Core Gotchas

## Runtime Issues

### Bun Required

OpenTUI requires Bun runtime. Node.js won't work.

```bash
# Wrong
node index.ts

# Right
bun run index.ts
```

### Avoid process.exit()

Bypasses cleanup, may leave terminal in bad state. Prefer renderer methods for graceful shutdown.

```typescript
// BAD
if (key === "q") process.exit(0)

// GOOD
if (key === "q") {
  cleanup()
  renderer.close()
}
```

If terminal stuck, run `reset` in another terminal.

### Options Before Content

Core API: options object comes first.

```typescript
// BAD
text("Hello", { bold: true })

// GOOD
text({ bold: true }, "Hello")
```

### Input Components Need focus()

Inputs don't receive keypresses until focused.

```typescript
const inp = input({ onSubmit: handleSubmit })
inp.focus() // Required!
```

## Build Issues

### Zig Required for Native

OpenTUI uses native bindings requiring Zig compiler.

```bash
# macOS
brew install zig

# Linux
# Download from https://ziglang.org/download/
```

### TypeScript Config

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "preserve",
    "moduleResolution": "bundler"
  }
}
```

## Debugging

### File Logging

OpenTUI captures stdout. Log to file:

```typescript
import { appendFileSync } from "fs"

function log(msg: string) {
  appendFileSync("/tmp/tui-debug.log", `${Date.now()} ${msg}\n`)
}

// Watch in another terminal
// tail -f /tmp/tui-debug.log
```

### Check Dimensions

```typescript
console.log(renderer.size) // { width, height }
```

## Recovery

### Terminal Stuck

```bash
# In another terminal
reset

# Or
stty sane
```

### Kill Hung Process

```bash
ps aux | grep bun
kill -9 <pid>
```

## See Also

- [api.md](./api.md) - API reference
- [Testing](../testing/index.md) - Test patterns
