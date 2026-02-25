# Core Patterns

## Render Loop

Manual state + re-render pattern:

```typescript
import { createCliRenderer, box, text, onKeypress } from "@opentui/core"

const renderer = await createCliRenderer()
let state = { count: 0 }

function render() {
  renderer.render(
    box({ padding: 1 }, [
      text({}, `Count: ${state.count}`),
      text({ dim: true }, "↑/↓ to change, q to quit"),
    ]),
  )
}

const cleanup = onKeypress((key) => {
  if (key === "up") state.count++
  if (key === "down") state.count--
  if (key === "q") {
    cleanup()
    renderer.close()
    return
  }
  render()
})

render()
```

## State Object Pattern

Group related state:

```typescript
interface AppState {
  items: string[]
  selectedIndex: number
  mode: "list" | "edit"
}

let state: AppState = {
  items: ["Item 1", "Item 2", "Item 3"],
  selectedIndex: 0,
  mode: "list",
}

function update(partial: Partial<AppState>) {
  state = { ...state, ...partial }
  render()
}

// Usage
update({ selectedIndex: state.selectedIndex + 1 })
```

## Component Functions

Extract reusable render functions:

```typescript
function listItem(label: string, selected: boolean) {
  return text({ color: selected ? "cyan" : undefined }, `${selected ? ">" : " "} ${label}`)
}

function render() {
  renderer.render(
    box(
      { flexDirection: "column" },
      state.items.map((item, i) => listItem(item, i === state.selectedIndex)),
    ),
  )
}
```

## Focus Management

Track focused element:

```typescript
let focusedInput: Input | null = null

const nameInput = input({
  placeholder: "Name",
  onSubmit: () => {
    focusedInput = emailInput
    emailInput.focus()
    render()
  },
})

const emailInput = input({
  placeholder: "Email",
  onSubmit: (value) => {
    // Submit form
  },
})

// Initial focus
focusedInput = nameInput
nameInput.focus()
```

## Cleanup Pattern

Ensure proper cleanup:

```typescript
const renderer = await createCliRenderer()
const cleanups: (() => void)[] = []

// Register cleanup
cleanups.push(
  onKeypress((key) => {
    /* ... */
  }),
)

// On exit
function exit() {
  cleanups.forEach((fn) => fn())
  renderer.close()
}
```

## See Also

- [api.md](./api.md) - API reference
- [gotchas.md](./gotchas.md) - Common issues
