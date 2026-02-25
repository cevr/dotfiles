# Core API Reference

## Renderer

The renderer manages the terminal screen and render cycles.

```typescript
import { createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer({
  stdout: process.stdout,
  stdin: process.stdin,
  exitOnCtrlC: false, // Handle Ctrl+C yourself
})

// Render content
renderer.render(content)

// Force re-render
renderer.rerender()

// Get dimensions
const { width, height } = renderer.size

// Cleanup (required!)
renderer.close()
```

## Renderables

Everything is a Renderable. Create with factory functions.

### text()

```typescript
text(options: TextOptions, content: string): Renderable

interface TextOptions {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}
```

```typescript
// Options first, content second
const t = text({ bold: true, color: "blue" }, "Hello")
```

### box()

```typescript
box(options: BoxOptions, children: Renderable[]): Renderable

interface BoxOptions {
  // Layout (see layout/)
  flexDirection?: "row" | "column";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  gap?: number;
  padding?: number | { top?, right?, bottom?, left? };
  margin?: number | { top?, right?, bottom?, left? };
  width?: number | string;
  height?: number | string;

  // Styling
  borderStyle?: "single" | "double" | "round" | "bold" | "hidden";
  borderColor?: string;
}
```

```typescript
// Box with children array
const b = box({ padding: 1 }, [text({}, "Child 1"), text({}, "Child 2")])

// Nested boxes
const layout = box({ flexDirection: "row" }, [
  box({ width: "50%" }, [text({}, "Left")]),
  box({ width: "50%" }, [text({}, "Right")]),
])
```

### scrollBox()

```typescript
scrollBox(options: ScrollBoxOptions, children: Renderable[]): Renderable

interface ScrollBoxOptions extends BoxOptions {
  scrollX?: number;
  scrollY?: number;
}
```

### Input Components

```typescript
import { input, textArea, select, tabSelect } from "@opentui/core"

// Input field
const nameInput = input({
  placeholder: "Enter name",
  onSubmit: (value) => {
    /* handle */
  },
})

// Must focus to receive input
nameInput.focus()

// Select menu
const menu = select({
  options: ["Option 1", "Option 2", "Option 3"],
  onSelect: (index, value) => {
    /* handle */
  },
})

// Tab select (horizontal)
const tabs = tabSelect({
  options: ["Tab 1", "Tab 2"],
  onSelect: (index) => {
    /* handle */
  },
})
```

### Code & Diff

```typescript
import { code, diff } from "@opentui/core"

// Syntax highlighted
code({ language: "typescript", showLineNumbers: true }, sourceCode)

// Diff viewer
diff({
  oldText: original,
  newText: modified,
  mode: "unified", // or "split"
})
```

## Keyboard Handling

```typescript
import { onKeypress } from "@opentui/core"

const cleanup = onKeypress((key, modifiers) => {
  if (key === "q") {
    cleanup()
    renderer.close()
  }
  if (modifiers.ctrl && key === "c") {
    // Ctrl+C
  }
})
```

## See Also

- [patterns.md](./patterns.md) - Render loop, state patterns
- [gotchas.md](./gotchas.md) - Common issues
- [Components](../components/index.md) - All components
