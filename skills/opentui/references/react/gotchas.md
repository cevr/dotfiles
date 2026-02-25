# React Gotchas

## Runtime

### Avoid process.exit()

Bypasses cleanup, may corrupt terminal state. Prefer renderer methods for graceful shutdown.

```tsx
// BAD
useKeyboard((key) => {
  if (key.name === "q") process.exit(0)
})

// GOOD
const renderer = useRenderer()
useKeyboard((key) => {
  if (key.name === "q") renderer.destroy()
})
```

### Input Components Need Focus

Inputs don't receive keypresses until focused.

```tsx
// BAD - input never receives input
;<input onSubmit={handleSubmit} />

// GOOD - focus on mount
const inputRef = useRef(null)
useEffect(() => {
  inputRef.current?.focus()
}, [])
;<input ref={inputRef} onSubmit={handleSubmit} />
```

## JSX

### Text Modifiers Require Tags

Use semantic tags inside `<text>`, not string concatenation.

```tsx
// BAD
<text>{"Normal " + bold + " text"}</text>

// GOOD
<text>Normal <strong>bold</strong> text</text>
```

### Hyphenated Component Names

React uses hyphens for multi-word components:

```tsx
<tab-select />   // Not <tabselect>
<ascii-font />   // Not <asciifont>
<line-number />  // Not <linenumber>
```

## Layout

### Percentage Sizes Need Parent Size

```tsx
// BAD - 50% of undefined = 0
<box>
  <box width="50%">Won't render</box>
</box>

// GOOD - parent has size
<box width="100%" height="100%">
  <box width="50%">Works</box>
</box>
```

## Performance

### Memoize Expensive Components

```tsx
const ExpensiveList = memo(({ items }) => (
  <box>
    {items.map((item) => (
      <text key={item.id}>{item.name}</text>
    ))}
  </box>
))
```

### Avoid Re-renders in Keyboard Handler

```tsx
// BAD - creates new handler each render
useKeyboard((key) => {
  if (key.name === "q") renderer.destroy()
})

// GOOD - stable reference
const handleKey = useCallback(
  (key) => {
    if (key.name === "q") renderer.destroy()
  },
  [renderer],
)

useKeyboard(handleKey)
```

## Debugging

### Use File Logging

OpenTUI captures stdout:

```tsx
import { appendFileSync } from "fs"

function log(msg: string) {
  appendFileSync("/tmp/debug.log", `${Date.now()} ${msg}\n`)
}
```

### Visualize Layout with Borders

```tsx
<box borderStyle="single" borderColor="red">
  {/* See bounds */}
</box>
```

## Recovery

Terminal stuck after crash:

```bash
reset
# or
stty sane
```

## See Also

- [api.md](./api.md) - API reference
- [Core Gotchas](../core/gotchas.md) - Runtime/build issues
- [Testing](../testing/index.md) - Test patterns
