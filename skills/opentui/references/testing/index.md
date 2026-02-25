# OpenTUI Testing

Test patterns for TUI applications.

## When to Use

- Snapshot testing for visual output
- Interaction testing for keyboard/input
- Unit testing components

## Test Renderer

Use `renderOnce()` for tests without event loop:

```typescript
import { renderOnce, box, text } from "@opentui/core"

test("renders correctly", () => {
  const output = renderOnce(box({ padding: 1 }, [text({ bold: true }, "Hello")]))

  expect(output).toContain("Hello")
})
```

## Cleanup Pattern

Always cleanup renderer:

```typescript
import { createCliRenderer, Renderer } from "@opentui/core"

let renderer: Renderer

beforeEach(async () => {
  renderer = await createCliRenderer()
})

afterEach(() => {
  renderer.close()
})

test("renders content", () => {
  renderer.render(box({}, [text({}, "Test")]))
  // assertions...
})
```

## Mock stdin for Input

```typescript
import { createMockStdin } from "@opentui/testing"

test("handles input", async () => {
  const stdin = createMockStdin()
  const renderer = await createCliRenderer({ stdin })

  // Simulate keypress
  stdin.emit("data", "a")

  // Assert...

  renderer.close()
})
```

## Simulate Key Sequences

```typescript
test("navigates list", async () => {
  const stdin = createMockStdin()
  const renderer = await createCliRenderer({ stdin })

  // Render component with list
  renderer.render(listComponent)

  // Navigate down twice
  stdin.emit("data", "\x1b[B") // Down arrow
  stdin.emit("data", "\x1b[B") // Down arrow

  // Assert selected index is 2
  expect(state.selectedIndex).toBe(2)

  renderer.close()
})
```

## Snapshot Testing

```typescript
import { renderOnce } from "@opentui/core"

test("matches snapshot", () => {
  const output = renderOnce(
    box({ borderStyle: "single", padding: 1 }, [
      text({ bold: true }, "Title"),
      text({}, "Content"),
    ]),
  )

  expect(output).toMatchSnapshot()
})
```

## Testing React Components

```typescript
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

test("react component renders", async () => {
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);

  root.render(<MyComponent />);

  // Allow React to flush
  await new Promise(r => setTimeout(r, 0));

  // Assert...

  renderer.close();
});
```

## Testing Solid Components

```typescript
import { render } from "@opentui/solid";

test("solid component renders", async () => {
  const dispose = render(() => <MyComponent />);

  // Assert...

  dispose();
});
```

## Tips

### Avoid Flaky Tests

- Use fixed terminal dimensions
- Mock timers for animations
- Wait for async renders

### Debug Output

```typescript
const output = renderOnce(component)
console.log(output) // See actual output
```

### Test in CI

Set terminal dimensions:

```typescript
const renderer = await createCliRenderer({
  stdout: { columns: 80, rows: 24 } as any,
})
```

## See Also

- [Core Gotchas](../core/gotchas.md) - Runtime issues
- [React Gotchas](../react/gotchas.md) - React-specific
- [Solid Gotchas](../solid/gotchas.md) - Solid-specific
