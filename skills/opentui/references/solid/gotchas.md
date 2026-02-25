# Solid Gotchas

## Underscore Naming

Multi-word components use underscores in Solid:

```tsx
// React
<scrollbox /><tab-select /><ascii-font /><textarea /><line-number />

// Solid
<scroll_box /><tab_select /><ascii_font /><text_area /><line_number />
```

This is the most common mistake when switching from React.

## Signals

### Call Signals as Functions

```tsx
const [count, setCount] = createSignal(0);

// BAD - returns the signal, not the value
<text>{count}</text>

// GOOD - call to get value
<text>{count()}</text>
```

### Destructuring Loses Reactivity

```tsx
// BAD - loses reactivity
const { name } = props
return <text>{name}</text>

// GOOD - access props directly
return <text>{props.name}</text>
```

## Runtime

### Avoid process.exit()

```tsx
// BAD
useKeyboard((key) => {
  if (key === "q") process.exit(0)
})

// GOOD
const renderer = useRenderer()
useKeyboard((key) => {
  if (key === "q") renderer.close()
})
```

### Input Components Need Focus

```tsx
let inputRef: HTMLInputElement

onMount(() => {
  inputRef.focus() // Required!
})
;<input ref={inputRef!} onSubmit={handleSubmit} />
```

## Layout

### Percentage Sizes Need Parent Size

```tsx
// BAD
<box>
  <box width="50%">Won't render</box>
</box>

// GOOD
<box width="100%" height="100%">
  <box width="50%">Works</box>
</box>
```

## Performance

### Use For, Not map()

```tsx
// BAD - no keyed updates
{
  items().map((item) => <text>{item}</text>)
}

// GOOD - fine-grained updates
;<For each={items()}>{(item) => <text>{item}</text>}</For>
```

### Batch Multiple Updates

```tsx
import { batch } from "solid-js"

// BAD
setA(1)
setB(2)
setC(3)

// GOOD
batch(() => {
  setA(1)
  setB(2)
  setC(3)
})
```

## Debugging

### File Logging

```tsx
import { appendFileSync } from "fs"

function log(msg: string) {
  appendFileSync("/tmp/debug.log", `${Date.now()} ${msg}\n`)
}
```

### Visualize Layout

```tsx
<box borderStyle="single" borderColor="red">
  {/* See bounds */}
</box>
```

## Recovery

Terminal stuck:

```bash
reset
# or
stty sane
```

## See Also

- [api.md](./api.md) - API reference
- [Core Gotchas](../core/gotchas.md) - Runtime/build issues
- [Testing](../testing/index.md) - Test patterns
