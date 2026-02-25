# OpenTUI Core

Imperative API for maximum control. No framework dependencies.

## When to Use

- Building a library/package (no React/Solid dep)
- Need maximum performance
- Want fine-grained control over render cycles
- Integrating with non-React/Solid systems

## When NOT to Use

| Scenario                     | Use Instead      |
| ---------------------------- | ---------------- |
| Familiar with React          | `@opentui/react` |
| Want fine-grained reactivity | `@opentui/solid` |
| Prefer declarative JSX       | React or Solid   |

## Quick Start

```bash
bunx create-tui@latest -t core my-app
cd my-app
bun run src/index.ts
```

Or manual:

```bash
mkdir my-tui && cd my-tui
bun init
bun add @opentui/core
```

```typescript
import { createCliRenderer, text, box } from "@opentui/core"

const renderer = await createCliRenderer()

renderer.render(
  box({ flexDirection: "column", padding: 1 }, [
    text({ bold: true }, "Hello"),
    text({ color: "green" }, "World"),
  ]),
)

// Cleanup (required!)
renderer.close()
```

## In This Reference

| File                         | When to Read                           |
| ---------------------------- | -------------------------------------- |
| [api.md](./api.md)           | Writing code, renderer/renderable APIs |
| [patterns.md](./patterns.md) | Render loops, state management         |
| [gotchas.md](./gotchas.md)   | Runtime issues, debugging              |

## See Also

- [React](../react/index.md) - React reconciler
- [Solid](../solid/index.md) - Solid reconciler
- [Components](../components/index.md) - All components
- [Layout](../layout/index.md) - Flexbox system
