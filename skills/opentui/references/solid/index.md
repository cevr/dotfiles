# OpenTUI Solid

Solid reconciler for OpenTUI. Fine-grained reactivity without virtual DOM.

## When to Use

- Want fine-grained reactivity (no diffing)
- Prefer Solid's signal model
- Need maximum render performance
- Building highly dynamic UIs

## When NOT to Use

| Scenario             | Use Instead      |
| -------------------- | ---------------- |
| Team knows React     | `@opentui/react` |
| Need React ecosystem | `@opentui/react` |
| Building a library   | `@opentui/core`  |

## Quick Start

```bash
bunx create-tui@latest -t solid my-app
cd my-app
bun run src/index.tsx
```

Or manual:

```bash
mkdir my-tui && cd my-tui
bun init
bun add @opentui/solid @opentui/core solid-js
```

```tsx
import { render } from "@opentui/solid"

function App() {
  return (
    <box flexDirection="column" padding={1}>
      <text bold>Hello OpenTUI</text>
    </box>
  )
}

render(() => <App />)
```

## Underscore Naming

Solid uses underscore naming for multi-word components:

| Component  | React           | Solid           |
| ---------- | --------------- | --------------- |
| ScrollBox  | `<scrollbox>`   | `<scroll_box>`  |
| TabSelect  | `<tab-select>`  | `<tab_select>`  |
| AsciiFont  | `<ascii-font>`  | `<ascii_font>`  |
| TextArea   | `<textarea>`    | `<text_area>`   |
| LineNumber | `<line-number>` | `<line_number>` |

Single-word: `<text>`, `<box>`, `<input>`, `<select>`, `<code>`, `<diff>`

## In This Reference

| File                         | When to Read           |
| ---------------------------- | ---------------------- |
| [api.md](./api.md)           | Hooks, component props |
| [patterns.md](./patterns.md) | Signals, control flow  |
| [gotchas.md](./gotchas.md)   | Common issues          |

## See Also

- [Core](../core/index.md) - Underlying API
- [React](../react/index.md) - Alternative reconciler
- [Components](../components/index.md) - All components
- [Layout](../layout/index.md) - Flexbox system
