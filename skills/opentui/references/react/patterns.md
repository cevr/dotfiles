# React Patterns

## Basic App Structure

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
    if (key.name === "down") setCount((c) => c - 1)
  })

  return (
    <box flexDirection="column" padding={1}>
      <text bold>Counter: {count}</text>
      <text dim>↑/↓ to change, q to quit</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## Form with Focus

```tsx
import { useRef, useEffect, useState } from "react"

function Form() {
  const inputRef = useRef(null)
  const [value, setValue] = useState("")

  useEffect(() => {
    // Must focus to receive input!
    inputRef.current?.focus()
  }, [])

  return (
    <box flexDirection="column" gap={1}>
      <text>Enter your name:</text>
      <input
        ref={inputRef}
        placeholder="Name"
        value={value}
        onChange={setValue}
        onSubmit={(v) => console.log("Submitted:", v)}
      />
    </box>
  )
}
```

## Multi-Field Form

```tsx
function MultiFieldForm() {
  const [focused, setFocused] = useState<"name" | "email">("name")
  const nameRef = useRef(null)
  const emailRef = useRef(null)

  useEffect(() => {
    if (focused === "name") nameRef.current?.focus()
    if (focused === "email") emailRef.current?.focus()
  }, [focused])

  return (
    <box flexDirection="column" gap={1}>
      <input ref={nameRef} placeholder="Name" onSubmit={() => setFocused("email")} />
      <input ref={emailRef} placeholder="Email" onSubmit={(email) => submitForm(email)} />
    </box>
  )
}
```

## Tabs with Content

```tsx
function TabbedView() {
  const [tab, setTab] = useState(0)

  return (
    <box flexDirection="column">
      <tab-select
        options={["Home", "Settings", "Help"]}
        selectedIndex={tab}
        onSelect={setTab}
        focused
      />
      <box padding={1}>
        {tab === 0 && <HomeContent />}
        {tab === 1 && <SettingsContent />}
        {tab === 2 && <HelpContent />}
      </box>
    </box>
  )
}
```

## List with Selection

```tsx
function SelectableList({ items }: { items: string[] }) {
  const [selected, setSelected] = useState(0)

  useKeyboard((key) => {
    if (key.name === "up") setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down") setSelected((s) => Math.min(items.length - 1, s + 1))
  })

  return (
    <box flexDirection="column">
      {items.map((item, i) => (
        <text key={i} fg={i === selected ? "cyan" : undefined}>
          {i === selected ? ">" : " "} {item}
        </text>
      ))}
    </box>
  )
}
```

## Modal Dialog

```tsx
function ModalExample() {
  const [showModal, setShowModal] = useState(false)

  useKeyboard((key) => {
    if (key.name === "enter") setShowModal(true)
    if (key.name === "escape") setShowModal(false)
  })

  return (
    <box position="relative" width="100%" height="100%">
      <text>Press Enter for modal</text>

      {showModal && (
        <box
          position="absolute"
          top={5}
          left={10}
          borderStyle="round"
          padding={2}
          backgroundColor="black"
        >
          <text>Modal Content</text>
          <text dim>ESC to close</text>
        </box>
      )}
    </box>
  )
}
```

## Loading Spinner

```tsx
import { useTimeline } from "@opentui/react"

function Loading({ message }: { message: string }) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const frame = useTimeline(frames, { interval: 80 })

  return (
    <text>
      <span fg="cyan">{frame}</span> {message}
    </text>
  )
}
```

## Responsive Layout

```tsx
import { useTerminalDimensions } from "@opentui/react"

function ResponsiveApp() {
  const { width } = useTerminalDimensions()
  const isWide = width > 80

  return (
    <box flexDirection={isWide ? "row" : "column"}>
      <box width={isWide ? "30%" : "100%"} borderStyle="single">
        <text>Sidebar</text>
      </box>
      <box flexGrow={1}>
        <text>Main Content</text>
      </box>
    </box>
  )
}
```

## See Also

- [api.md](./api.md) - API reference
- [gotchas.md](./gotchas.md) - Common issues
