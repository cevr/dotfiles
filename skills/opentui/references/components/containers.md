# Container Components

## Box

Flex container with optional borders. Building block for all layouts.

### Usage

```tsx
// React/Solid
;<box flexDirection="column" padding={1} gap={1}>
  <text>Child 1</text>
  <text>Child 2</text>
</box>

// Core
box({ flexDirection: "column", padding: 1, gap: 1 }, [text({}, "Child 1"), text({}, "Child 2")])
```

### Layout Props

| Prop             | Values                                                              | Default      |
| ---------------- | ------------------------------------------------------------------- | ------------ |
| `flexDirection`  | "row", "column"                                                     | "column"     |
| `justifyContent` | "flex-start", "center", "flex-end", "space-between", "space-around" | "flex-start" |
| `alignItems`     | "flex-start", "center", "flex-end", "stretch"                       | "stretch"    |
| `gap`            | number                                                              | 0            |
| `flexGrow`       | number                                                              | 0            |
| `flexShrink`     | number                                                              | 1            |

### Size Props

| Prop                     | Type             | Description         |
| ------------------------ | ---------------- | ------------------- |
| `width`                  | number \| string | Fixed or percentage |
| `height`                 | number \| string | Fixed or percentage |
| `minWidth`, `maxWidth`   | number           | Constraints         |
| `minHeight`, `maxHeight` | number           | Constraints         |

### Spacing Props

```tsx
// All sides
<box padding={2} margin={1} />

// Individual
<box paddingTop={1} paddingRight={2} marginBottom={1} />

// Horizontal/Vertical
<box paddingX={2} paddingY={1} />
```

### Border Props

| Prop             | Values                                |
| ---------------- | ------------------------------------- |
| `border`         | boolean                               |
| `borderStyle`    | "single", "double", "rounded", "bold" |
| `borderColor`    | string (color)                        |
| `title`          | string                                |
| `titleAlignment` | "left", "center", "right"             |

```tsx
<box border borderStyle="rounded" borderColor="cyan" title="Panel">
  <text>Content</text>
</box>
```

### Color Props

| Prop              | Type   |
| ----------------- | ------ |
| `backgroundColor` | string |

### Events (React/Solid)

```tsx
<box onMouseDown={(e) => handleClick(e)} onMouseUp={(e) => {}} onMouseMove={(e) => {}}>
  Click me
</box>
```

## ScrollBox

Scrollable container with viewport.

### Usage

```tsx
// React
<scrollbox height={10} scrollY={scrollPosition}>
  {/* Long content */}
</scrollbox>

// Solid (underscore!)
<scroll_box height={10} scrollY={scrollPos()}>
  {content}
</scroll_box>

// Core
scrollBox({ height: 10, scrollY: 0 }, [...children])
```

### Props

| Prop          | Type    | Description               |
| ------------- | ------- | ------------------------- |
| `scrollX`     | number  | Horizontal scroll offset  |
| `scrollY`     | number  | Vertical scroll offset    |
| `focused`     | boolean | Enable keyboard scrolling |
| All box props |         | Inherited                 |

### Styling

```tsx
<scrollbox
  focused
  style={{
    rootOptions: { backgroundColor: "#24283b" },
    viewportOptions: { backgroundColor: "#1a1b26" },
    scrollbarOptions: {
      showArrows: true,
      trackOptions: {
        foregroundColor: "#7aa2f7",
        backgroundColor: "#414868",
      },
    },
  }}
>
  {items}
</scrollbox>
```

## Common Patterns

### Bordered Panel

```tsx
<box border borderStyle="rounded" borderColor="cyan" padding={1}>
  <text bold>Panel Title</text>
  <text>Panel content here</text>
</box>
```

### Two-Column Layout

```tsx
<box flexDirection="row" height="100%">
  <box width="30%" border>
    {/* Sidebar */}
  </box>
  <box flexGrow={1}>{/* Main content */}</box>
</box>
```

### Status Bar

```tsx
<box
  position="absolute"
  bottom={0}
  left={0}
  right={0}
  backgroundColor="blue"
  padding={{ left: 1, right: 1 }}
>
  <text fg="white">Status: Ready</text>
</box>
```

### Centered Content

```tsx
<box width="100%" height="100%" justifyContent="center" alignItems="center">
  <box border padding={2}>
    Centered box
  </box>
</box>
```

### Sticky Header with Scroll

```tsx
<box flexDirection="column" height="100%">
  <box height={3} border>
    <text bold>Header (fixed)</text>
  </box>
  <scrollbox flexGrow={1} scrollY={scrollPos}>
    {/* Scrollable content */}
  </scrollbox>
</box>
```

## See Also

- [Layout](../layout/index.md) - Full flexbox reference
- [text-display.md](./text-display.md) - Text components
