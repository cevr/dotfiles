# Solid Patterns

## Signals Pattern

```tsx
import { createSignal } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"

function App() {
  const renderer = useRenderer()
  const [count, setCount] = createSignal(0)

  useKeyboard((key) => {
    if (key === "q") renderer.close()
    if (key === "up") setCount((c) => c + 1)
    if (key === "down") setCount((c) => c - 1)
  })

  return (
    <box flexDirection="column" padding={1}>
      <text bold>Count: {count()}</text>
      <text dim>↑/↓ to change, q to quit</text>
    </box>
  )
}

render(() => <App />)
```

## Form with Focus

```tsx
import { createSignal, onMount } from "solid-js"

function Form() {
  let inputRef: HTMLInputElement
  const [value, setValue] = createSignal("")

  onMount(() => {
    inputRef.focus() // Required!
  })

  return (
    <box flexDirection="column" gap={1}>
      <text>Enter name:</text>
      <input ref={inputRef!} placeholder="Name" onSubmit={(v) => setValue(v)} />
      <text>Entered: {value()}</text>
    </box>
  )
}
```

## Control Flow

### Show/Hide

```tsx
import { Show } from "solid-js"

function Modal(props: { show: boolean; children: any }) {
  return (
    <Show when={props.show}>
      <box position="absolute" top={5} left={10} borderStyle="round" padding={2}>
        {props.children}
      </box>
    </Show>
  )
}
```

### For Lists

```tsx
import { For, createSignal } from "solid-js"

function List() {
  const [items] = createSignal(["Item 1", "Item 2", "Item 3"])
  const [selected, setSelected] = createSignal(0)

  return (
    <box flexDirection="column">
      <For each={items()}>
        {(item, i) => (
          <text color={i() === selected() ? "cyan" : undefined}>
            {i() === selected() ? ">" : " "} {item}
          </text>
        )}
      </For>
    </box>
  )
}
```

### Switch/Match

```tsx
import { Switch, Match, createSignal } from "solid-js"

function TabbedView() {
  const [tab, setTab] = createSignal(0)

  return (
    <box flexDirection="column">
      <tab_select options={["Home", "Settings", "Help"]} selectedIndex={tab()} onSelect={setTab} />
      <box padding={1}>
        <Switch>
          <Match when={tab() === 0}>
            <HomeContent />
          </Match>
          <Match when={tab() === 1}>
            <SettingsContent />
          </Match>
          <Match when={tab() === 2}>
            <HelpContent />
          </Match>
        </Switch>
      </box>
    </box>
  )
}
```

## Portal for Overlays

```tsx
import { Portal, Show, createSignal } from "solid-js/web"

function ModalExample() {
  const [showModal, setShowModal] = createSignal(false)

  return (
    <>
      <text>Press Enter for modal</text>
      <Show when={showModal()}>
        <Portal>
          <box position="absolute" top={5} left={10} borderStyle="round" padding={2}>
            <text>Modal via Portal</text>
          </box>
        </Portal>
      </Show>
    </>
  )
}
```

## Dynamic Components

```tsx
import { Dynamic } from "solid-js/web"

const views = {
  home: HomeView,
  settings: SettingsView,
}

function DynamicView(props: { view: string }) {
  return <Dynamic component={views[props.view]} />
}
```

## Batch Updates

```tsx
import { batch, createSignal } from "solid-js"

const [a, setA] = createSignal(0)
const [b, setB] = createSignal(0)
const [c, setC] = createSignal(0)

// BAD - multiple updates
setA(1)
setB(2)
setC(3)

// GOOD - batched
batch(() => {
  setA(1)
  setB(2)
  setC(3)
})
```

## Full Example

```tsx
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, Show, For } from "solid-js"

function App() {
  const renderer = useRenderer()
  const [items] = createSignal(["Item 1", "Item 2", "Item 3"])
  const [selected, setSelected] = createSignal(0)
  const [showModal, setShowModal] = createSignal(false)

  useKeyboard((key) => {
    if (key === "q") renderer.close()
    if (key === "up") setSelected((s) => Math.max(0, s - 1))
    if (key === "down") setSelected((s) => Math.min(items().length - 1, s + 1))
    if (key === "enter") setShowModal(true)
    if (key === "escape") setShowModal(false)
  })

  return (
    <box flexDirection="column" padding={1}>
      <text bold>Solid TUI Demo</text>
      <text dim>↑↓ navigate, Enter select, q quit</text>

      <box flexDirection="column" marginTop={1}>
        <For each={items()}>
          {(item, i) => (
            <text color={i() === selected() ? "cyan" : undefined}>
              {i() === selected() ? ">" : " "} {item}
            </text>
          )}
        </For>
      </box>

      <Show when={showModal()}>
        <box position="absolute" top={5} left={10} borderStyle="round" padding={1}>
          <text>Selected: {items()[selected()]}</text>
        </box>
      </Show>
    </box>
  )
}

render(() => <App />)
```

## See Also

- [api.md](./api.md) - API reference
- [gotchas.md](./gotchas.md) - Common issues
