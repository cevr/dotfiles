---
name: opentui
description: OpenTUI terminal UI framework for Bun. Use when building terminal TUIs with Core (imperative), React, or Solid reconcilers. Covers components (box, text, input, select), layout, keyboard handling, and testing.
---

# OpenTUI

Terminal UI framework for Bun with Core (imperative), React, and Solid reconcilers.

## Critical Rules

1. **Use create-tui scaffolding** — `bunx create-tui@latest -t <template> my-app`
2. **Options before args** — `text({ bold: true }, "content")` not `text("content", { bold: true })`
3. **Avoid process.exit()** — Bypasses cleanup; prefer `renderer.close()` or `renderer.destroy()`
4. **Input components need focus** — Call `.focus()` or use `focused` prop
5. **Solid uses underscores** — `<tab_select>` not `<tab-select>`

## Framework Decision Tree

```
Need TUI in Bun?
├─ Building a library/package → references/core/
├─ Team knows React           → references/react/
├─ Want fine-grained reactivity → references/solid/
└─ Maximum performance/control → references/core/
```

## Navigation

| Need                | Go To                                   |
| ------------------- | --------------------------------------- |
| Choose a framework  | Decision tree above                     |
| Core imperative API | `references/core/index.md`              |
| React reconciler    | `references/react/index.md`             |
| Solid reconciler    | `references/solid/index.md`             |
| Find a component    | `references/components/index.md`        |
| Layout/positioning  | `references/layout/index.md`            |
| Testing             | `references/testing/index.md`           |

## Quick Start

```bash
bunx create-tui@latest -t react my-app   # or: -t solid, -t core
cd my-app && bun run dev
```

## Minimal Example (React)

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useState } from "react"

function App() {
  const renderer = useRenderer()
  const [count, setCount] = useState(0)

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
    if (key.name === "up") setCount((c) => c + 1)
  })

  return (
    <box flexDirection="column" padding={1}>
      <text bold>Count: {count}</text>
      <text dim>↑ to increment, q to quit</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## Component Quick Reference

| Component | Core          | React          | Solid          |
| --------- | ------------- | -------------- | -------------- |
| Text      | `text()`      | `<text>`       | `<text>`       |
| Box       | `box()`       | `<box>`        | `<box>`        |
| ScrollBox | `scrollBox()` | `<scrollbox>`  | `<scroll_box>` |
| Input     | `input()`     | `<input>`      | `<input>`      |
| Select    | `select()`    | `<select>`     | `<select>`     |
| TabSelect | `tabSelect()` | `<tab-select>` | `<tab_select>` |

See `references/components/index.md` for full reference.

## Troubleshooting

| Issue              | See                                       |
| ------------------ | ----------------------------------------- |
| Terminal stuck      | `references/core/gotchas.md`             |
| Input not working   | `references/components/inputs.md`        |
| Layout broken       | `references/layout/index.md`             |
| Framework-specific  | `references/react/gotchas.md`, `references/solid/gotchas.md` |

## Resources

- Repository: https://github.com/anomalyco/opentui
- Examples: https://github.com/anomalyco/opentui/tree/main/packages/core/src/examples
