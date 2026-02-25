# Input Components

**Critical:** All input components must be focused to receive keypresses!

## Input

Single-line text input.

### Usage

```tsx
// React
const inputRef = useRef(null)
useEffect(() => {
  inputRef.current?.focus()
}, [])
;<input
  ref={inputRef}
  placeholder="Enter text..."
  value={value}
  onChange={(v) => setValue(v)}
  onSubmit={(v) => handleSubmit(v)}
/>

// Solid
let inputRef: HTMLInputElement
onMount(() => {
  inputRef.focus()
})
;<input ref={inputRef!} placeholder="Enter text..." onSubmit={(v) => handleSubmit(v)} />

// Core
const inp = input({
  placeholder: "Enter text...",
  onSubmit: (v) => handleSubmit(v),
})
inp.focus() // Required!
```

### Props

| Prop              | Type            | Description                |
| ----------------- | --------------- | -------------------------- |
| `placeholder`     | string          | Placeholder text           |
| `value`           | string          | Controlled value           |
| `onChange`        | (value) => void | Change handler             |
| `onSubmit`        | (value) => void | Enter key handler          |
| `mask`            | string          | Character mask (passwords) |
| `focused`         | boolean         | Start focused              |
| `width`           | number          | Input width                |
| `backgroundColor` | string          | Background color           |
| `textColor`       | string          | Text color                 |
| `cursorColor`     | string          | Cursor color               |

## TextArea

Multi-line text input.

### Usage

```tsx
// React
<textarea
  ref={textareaRef}
  rows={5}
  value={content}
  onChange={setContent}
/>

// Solid (underscore!)
<text_area ref={textareaRef} rows={5} />
```

### Props

| Prop              | Type            | Description       |
| ----------------- | --------------- | ----------------- |
| `rows`            | number          | Visible rows      |
| `value`           | string          | Controlled value  |
| `onChange`        | (value) => void | Change handler    |
| `onSubmit`        | (value) => void | Submit handler    |
| `placeholder`     | string          | Placeholder       |
| `showLineNumbers` | boolean         | Show line numbers |
| `wrapText`        | boolean         | Wrap long lines   |

## Select

Selection menu with keyboard navigation.

### Usage

```tsx
// React
;<select
  options={[
    { name: "Option 1", value: "1" },
    { name: "Option 2", value: "2" },
  ]}
  selectedIndex={selected}
  onChange={(index, option) => setSelected(index)}
  focused
/>

// Core
select({
  options: ["Option 1", "Option 2", "Option 3"],
  onSelect: (index, value) => {
    /* handle */
  },
})
```

### Props

| Prop                    | Type                                       | Description           |
| ----------------------- | ------------------------------------------ | --------------------- |
| `options`               | string[] \| {name, value?, description?}[] | Options               |
| `selectedIndex`         | number                                     | Currently selected    |
| `onChange` / `onSelect` | (index, option) => void                    | Selection handler     |
| `focused`               | boolean                                    | Enable keyboard nav   |
| `showScrollIndicator`   | boolean                                    | Show scroll indicator |
| `height`                | number                                     | Visible height        |

## Tab Select

Horizontal tab-style selector.

### Usage

```tsx
// React (hyphen!)
<tab-select
  options={["Tab 1", "Tab 2", "Tab 3"]}
  selectedIndex={activeTab}
  onChange={setActiveTab}
  focused
/>

// Solid (underscore!)
<tab_select
  options={["Tab 1", "Tab 2"]}
  selectedIndex={tab()}
  onSelect={setTab}
/>

// Core
tabSelect({
  options: ["Tab 1", "Tab 2"],
  onSelect: (index) => { /* handle */ },
})
```

### Props

Same as Select, plus:

| Prop       | Type   | Description   |
| ---------- | ------ | ------------- |
| `tabWidth` | number | Width per tab |

## Common Patterns

### Form with Multiple Fields

```tsx
function Form() {
  const [focused, setFocused] = useState<"name" | "email">("name")
  const nameRef = useRef(null)
  const emailRef = useRef(null)

  useEffect(() => {
    if (focused === "name") nameRef.current?.focus()
    if (focused === "email") emailRef.current?.focus()
  }, [focused])

  return (
    <box flexDirection="column" gap={1}>
      <text>Name:</text>
      <input ref={nameRef} placeholder="Enter name" onSubmit={() => setFocused("email")} />
      <text>Email:</text>
      <input ref={emailRef} placeholder="Enter email" onSubmit={submitForm} />
    </box>
  )
}
```

### Tabs with Content

```tsx
function TabbedView() {
  const [tab, setTab] = useState(0)

  return (
    <box flexDirection="column">
      <tab-select
        options={["Home", "Settings", "Help"]}
        selectedIndex={tab}
        onChange={setTab}
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

### Menu Selection

```tsx
function Menu() {
  const [selected, setSelected] = useState(0)

  return (
    <box flexDirection="column" border padding={1}>
      <text bold>Main Menu</text>
      <select
        options={["New Game", "Load Game", "Settings", "Quit"]}
        selectedIndex={selected}
        onChange={(i) => setSelected(i)}
        focused
      />
    </box>
  )
}
```

## See Also

- [React Patterns](../react/patterns.md) - Form patterns
- [Solid Patterns](../solid/patterns.md) - Form patterns
