# OpenTUI React

React reconciler for OpenTUI. Familiar patterns, full React ecosystem.

## When to Use

- Team knows React
- Want React ecosystem (state libs, patterns)
- Prefer declarative JSX
- Building complex interactive UIs

## When NOT to Use

| Scenario                     | Use Instead      |
| ---------------------------- | ---------------- |
| Maximum performance critical | `@opentui/core`  |
| Fine-grained reactivity      | `@opentui/solid` |
| Smallest bundle size         | `@opentui/core`  |
| Building a library           | `@opentui/core`  |

## Quick Start

```bash
bunx create-tui@latest -t react my-app
cd my-app
bun run src/index.tsx
```

Or manual:

```bash
mkdir my-tui && cd my-tui
bun init
bun add @opentui/react @opentui/core react
```

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return (
    <box flexDirection="column" padding={1}>
      <text bold>Hello OpenTUI</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## JSX Intrinsics

React uses lowercase intrinsic elements:

| Element        | Description             |
| -------------- | ----------------------- |
| `<text>`       | Text content            |
| `<box>`        | Flex container          |
| `<scrollbox>`  | Scrollable container    |
| `<input>`      | Single-line input       |
| `<textarea>`   | Multi-line input        |
| `<select>`     | Selection menu          |
| `<tab-select>` | Tab-style selector      |
| `<ascii-font>` | Large ASCII text        |
| `<code>`       | Syntax-highlighted code |
| `<diff>`       | Diff viewer             |

## In This Reference

| File                         | When to Read           |
| ---------------------------- | ---------------------- |
| [api.md](./api.md)           | Hooks, component props |
| [patterns.md](./patterns.md) | Forms, state, keyboard |
| [gotchas.md](./gotchas.md)   | Common issues          |

## See Also

- [Core](../core/index.md) - Underlying API
- [Solid](../solid/index.md) - Alternative reconciler
- [Components](../components/index.md) - All components
- [Layout](../layout/index.md) - Flexbox system
