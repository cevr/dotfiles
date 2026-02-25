# Layout Patterns

## Full-Screen App

```tsx
<box width="100%" height="100%" flexDirection="column">
  <box height={1} backgroundColor="blue">
    {/* Header */}
  </box>
  <box flexGrow={1}>{/* Main content */}</box>
  <box height={1} backgroundColor="blue">
    {/* Footer */}
  </box>
</box>
```

## Sidebar Layout

```tsx
<box flexDirection="row" width="100%" height="100%">
  <box width="25%" borderStyle="single">
    {/* Sidebar */}
  </box>
  <box flexGrow={1}>{/* Main area */}</box>
</box>
```

## Centered Content

```tsx
<box width="100%" height="100%" justifyContent="center" alignItems="center">
  <box borderStyle="round" padding={2}>
    Centered box
  </box>
</box>
```

## Modal Overlay

```tsx
<box position="relative" width="100%" height="100%">
  {/* Background content */}
  <MainContent />

  {/* Modal overlay */}
  <box
    position="absolute"
    top={0}
    left={0}
    right={0}
    bottom={0}
    justifyContent="center"
    alignItems="center"
  >
    <box borderStyle="double" padding={2} backgroundColor="black">
      <text>Modal Content</text>
    </box>
  </box>
</box>
```

## Equal Columns

```tsx
<box flexDirection="row" gap={1}>
  <box flexGrow={1} flexBasis={0}>
    Column 1
  </box>
  <box flexGrow={1} flexBasis={0}>
    Column 2
  </box>
  <box flexGrow={1} flexBasis={0}>
    Column 3
  </box>
</box>
```

## Sticky Header with Scroll

```tsx
<box flexDirection="column" height="100%">
  <box height={3} borderStyle="single">
    <text bold>Header (fixed)</text>
  </box>
  <scrollbox flexGrow={1} scrollY={scrollPos}>
    {/* Scrollable content */}
  </scrollbox>
</box>
```

## Status Bar (Bottom)

```tsx
<box position="relative" width="100%" height="100%">
  <box flexGrow={1}>{/* Main content */}</box>
  <box position="absolute" bottom={0} left={0} right={0} backgroundColor="blue" paddingX={1}>
    <text fg="white">Status: Ready | Items: 42</text>
  </box>
</box>
```

## Split Panes

### Horizontal Split

```tsx
<box flexDirection="row" width="100%" height="100%">
  <box width="50%" borderStyle="single">
    Left pane
  </box>
  <box width="50%" borderStyle="single">
    Right pane
  </box>
</box>
```

### Vertical Split

```tsx
<box flexDirection="column" width="100%" height="100%">
  <box height="50%" borderStyle="single">
    Top pane
  </box>
  <box height="50%" borderStyle="single">
    Bottom pane
  </box>
</box>
```

## Card Grid

```tsx
<box flexDirection="row" flexWrap="wrap" gap={1}>
  {items.map((item, i) => (
    <box key={i} width={20} height={5} borderStyle="round" padding={1}>
      <text>{item.name}</text>
    </box>
  ))}
</box>
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
        Sidebar
      </box>
      <box flexGrow={1}>Main Content</box>
    </box>
  )
}
```

## Form Layout

```tsx
<box flexDirection="column" gap={1} padding={1}>
  <box flexDirection="row" gap={1}>
    <text width={10}>Name:</text>
    <input flexGrow={1} placeholder="Enter name" />
  </box>
  <box flexDirection="row" gap={1}>
    <text width={10}>Email:</text>
    <input flexGrow={1} placeholder="Enter email" />
  </box>
  <box flexDirection="row" justifyContent="flex-end" gap={1} marginTop={1}>
    <box padding={{ left: 2, right: 2 }} borderStyle="single">
      <text>Cancel</text>
    </box>
    <box padding={{ left: 2, right: 2 }} borderStyle="single" backgroundColor="blue">
      <text fg="white">Submit</text>
    </box>
  </box>
</box>
```

## See Also

- [index.md](./index.md) - Layout props reference
- [Containers](../components/containers.md) - Box component
