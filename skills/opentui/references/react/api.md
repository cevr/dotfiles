# React API Reference

## Rendering

### createRoot(renderer)

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const renderer = await createCliRenderer({
  exitOnCtrlC: false, // Handle Ctrl+C yourself
})

const root = createRoot(renderer)
root.render(<App />)
```

## Hooks

### useRenderer()

Access the OpenTUI renderer.

```tsx
import { useRenderer } from "@opentui/react"

function App() {
  const renderer = useRenderer()

  useEffect(() => {
    console.log(`Terminal: ${renderer.width}x${renderer.height}`)
  }, [])

  return <text>Hello</text>
}
```

### useKeyboard(handler, options?)

Handle keyboard events.

```tsx
import { useKeyboard, useRenderer } from "@opentui/react"

function App() {
  const renderer = useRenderer()

  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy() // Prefer over process.exit()
    }
    if (key.ctrl && key.name === "s") {
      saveDocument()
    }
  })

  return <text>Press ESC to exit</text>
}

// With release events
useKeyboard(
  (event) => {
    if (event.eventType === "release") {
      // Key released
    }
  },
  { release: true },
)
```

**KeyEvent properties:**

- `name` - Key name ("a", "escape", "f1", etc.)
- `ctrl`, `shift`, `meta`, `option` - Modifiers
- `eventType` - "press" | "release" | "repeat"

### useTerminalDimensions()

Reactive terminal dimensions.

```tsx
import { useTerminalDimensions } from "@opentui/react"

function ResponsiveLayout() {
  const { width, height } = useTerminalDimensions()

  return (
    <box flexDirection={width > 80 ? "row" : "column"}>
      <text>Width: {width}</text>
    </box>
  )
}
```

### useOnResize(callback)

Handle terminal resize.

```tsx
import { useOnResize } from "@opentui/react"

useOnResize((width, height) => {
  console.log(`Resized to ${width}x${height}`)
})
```

### useTimeline(options?)

Animation timeline.

```tsx
import { useTimeline } from "@opentui/react"

function Spinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const frame = useTimeline(frames, { interval: 80 })

  return <text>{frame}</text>
}
```

## Text Modifiers

Inside `<text>`, use semantic tags:

```tsx
<text>
  Normal <strong>bold</strong> <em>italic</em>
  <span fg="red">colored</span>
  <u>underlined</u>
  <br />
  <a href="https://...">link</a>
</text>

// Don't do string concatenation
// BAD: <text>{"Normal " + bold + " text"}</text>
```

## Component Props

### Box

```tsx
<box
  // Borders
  border
  borderStyle="single" // single | double | rounded | bold
  borderColor="#FFFFFF"
  title="Title"
  // Colors
  backgroundColor="#1a1a2e"
  // Layout
  flexDirection="row"
  justifyContent="center"
  alignItems="center"
  gap={2}
  // Spacing
  padding={2}
  margin={1}
  // Dimensions
  width={40}
  height={10}
  flexGrow={1}
  // Events
  onMouseDown={(e) => {}}
>
  {children}
</box>
```

### Input

```tsx
<input
  value={value}
  onChange={(newValue) => setValue(newValue)}
  placeholder="Enter text..."
  focused // Start focused
  width={30}
/>
```

### Select

```tsx
<select
  options={[
    { name: "Option 1", value: "1" },
    { name: "Option 2", value: "2" },
  ]}
  onChange={(index, option) => setSelected(option)}
  selectedIndex={0}
  focused
/>
```

### Tab Select

```tsx
<tab-select
  options={[{ name: "Home" }, { name: "Settings" }]}
  onChange={(index, option) => setTab(option)}
  focused
/>
```

### Code

```tsx
<code code={sourceCode} language="typescript" showLineNumbers highlightLines={[1, 5, 10]} />
```

### Diff

```tsx
<diff
  oldCode={originalCode}
  newCode={modifiedCode}
  language="typescript"
  mode="unified" // unified | split
/>
```

## See Also

- [patterns.md](./patterns.md) - Common patterns
- [gotchas.md](./gotchas.md) - Common issues
- [Components](../components/index.md) - All components
