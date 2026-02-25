# Solid API Reference

## Rendering

```tsx
import { render } from "@opentui/solid"

function App() {
  return <text>Hello</text>
}

render(() => <App />)
```

## Hooks

### useRenderer()

```tsx
import { useRenderer } from "@opentui/solid"

function App() {
  const renderer = useRenderer()

  useKeyboard((key) => {
    if (key === "q") renderer.close()
  })

  const size = () => renderer.size

  return (
    <text>
      Size: {size().width}x{size().height}
    </text>
  )
}
```

### useKeyboard(handler)

```tsx
import { useKeyboard } from "@opentui/solid"
import { createSignal } from "solid-js"

function Counter() {
  const [count, setCount] = createSignal(0)

  useKeyboard((key) => {
    if (key === "up") setCount((c) => c + 1)
    if (key === "down") setCount((c) => c - 1)
  })

  return <text>Count: {count()}</text>
}
```

### useTimeline(frames, options)

```tsx
import { useTimeline } from "@opentui/solid"

function Spinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const frame = useTimeline(frames, { interval: 80 })

  return <text color="cyan">{frame()}</text>
}
```

## Component Props

Same as React, but underscore naming for multi-word:

### Box

```tsx
<box border borderStyle="round" flexDirection="column" padding={2} gap={1}>
  {children}
</box>
```

### Input

```tsx
let inputRef: HTMLInputElement

onMount(() => {
  inputRef.focus() // Required!
})
;<input ref={inputRef!} placeholder="Name" onSubmit={(v) => handleSubmit(v)} />
```

### Select

```tsx
<select options={["Option 1", "Option 2"]} selectedIndex={selected()} onSelect={setSelected} />
```

### Tab Select (Underscore!)

```tsx
<tab_select options={["Tab 1", "Tab 2"]} selectedIndex={tab()} onSelect={setTab} />
```

### Scroll Box (Underscore!)

```tsx
<scroll_box height={20} scrollY={scrollPos()}>
  {content}
</scroll_box>
```

### ASCII Font (Underscore!)

```tsx
<ascii_font font="standard">TITLE</ascii_font>
```

### Code

```tsx
<code language="typescript" showLineNumbers>
  {sourceCode}
</code>
```

### Diff

```tsx
<diff oldText={original} newText={modified} mode="unified" />
```

## See Also

- [patterns.md](./patterns.md) - Signals, control flow
- [gotchas.md](./gotchas.md) - Common issues
- [Components](../components/index.md) - All components
