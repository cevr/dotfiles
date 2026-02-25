# OpenTUI Layout

Flexbox layout via Yoga. Same model as React Native / CSS Flexbox.

## Core Concepts

- Everything is a flex container
- Default: `flexDirection: "column"`
- Percentage sizes relative to parent
- Yoga handles all measurement

## Quick Reference

| Property         | Values                                                    | Default    |
| ---------------- | --------------------------------------------------------- | ---------- |
| `flexDirection`  | row, column                                               | column     |
| `justifyContent` | flex-start, center, flex-end, space-between, space-around | flex-start |
| `alignItems`     | flex-start, center, flex-end, stretch                     | stretch    |
| `gap`            | number                                                    | 0          |

## In This Reference

| File                         | When to Read           |
| ---------------------------- | ---------------------- |
| [patterns.md](./patterns.md) | Common layout patterns |

## Container Props

### flexDirection

```tsx
<box flexDirection="row">     {/* Horizontal */}
<box flexDirection="column">  {/* Vertical (default) */}
```

### justifyContent

Alignment along main axis:

```tsx
<box justifyContent="flex-start">    {/* Start */}
<box justifyContent="center">        {/* Center */}
<box justifyContent="flex-end">      {/* End */}
<box justifyContent="space-between"> {/* Even between */}
<box justifyContent="space-around">  {/* Even around */}
```

### alignItems

Alignment along cross axis:

```tsx
<box alignItems="flex-start"> {/* Start */}
<box alignItems="center">     {/* Center */}
<box alignItems="flex-end">   {/* End */}
<box alignItems="stretch">    {/* Fill (default) */}
```

### gap

```tsx
<box gap={1}>       {/* All directions */}
<box rowGap={1}>    {/* Between rows */}
<box columnGap={2}> {/* Between columns */}
```

## Item Props

### flexGrow / flexShrink

```tsx
<box flexDirection="row">
  <box width={20}>Fixed</box>
  <box flexGrow={1}>Takes remaining</box>
</box>

<box flexShrink={0}>  {/* Don't shrink */}
<box flexShrink={1}>  {/* Can shrink */}
```

### alignSelf

Override parent's alignItems:

```tsx
<box alignItems="center">
  <text>Centered</text>
  <text alignSelf="flex-end">End-aligned</text>
</box>
```

## Sizing

### Fixed Size

```tsx
<box width={40} height={10}>
  Fixed 40x10
</box>
```

### Percentage Size

```tsx
<box width="50%" height="100%">
  Half width, full height
</box>
```

**Note:** Parent must have defined size for percentages to work!

### Min/Max Constraints

```tsx
<box minWidth={20} maxWidth={80}>
  Between 20-80 width
</box>
```

## Spacing

### Padding (inside)

```tsx
<box padding={2}>                    {/* All sides */}
<box paddingX={2} paddingY={1}>      {/* H/V */}
<box paddingTop={1} paddingRight={2}> {/* Individual */}
```

### Margin (outside)

```tsx
<box margin={1}>      {/* All sides */}
<box marginTop={2}>   {/* Top only */}
<box marginX={2}>     {/* Horizontal */}
```

## Positioning

### Relative (default)

Normal flow:

```tsx
<box position="relative">Normal flow</box>
```

### Absolute

Relative to nearest positioned ancestor:

```tsx
<box position="relative" width="100%" height="100%">
  <box position="absolute" top={0} right={0}>
    Top-right corner
  </box>
  <box position="absolute" bottom={0} left={0} right={0}>
    Bottom bar
  </box>
</box>
```

## Debugging

Use borders to visualize:

```tsx
<box borderStyle="single" borderColor="red">
  {/* See bounds */}
</box>
```

## See Also

- [patterns.md](./patterns.md) - Common layouts
- [Containers](../components/containers.md) - Box component
