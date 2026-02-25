# Text & Display Components

## Text

Basic text rendering with styling.

### Usage

```tsx
// React/Solid
<text>Plain text</text>
<text bold>Bold text</text>
<text fg="green" dim>Styled text</text>

// Core
text({}, "Plain text")
text({ bold: true }, "Bold text")
text({ fg: "green", dim: true }, "Styled text")
```

### Props

| Prop            | Type    | Description                     |
| --------------- | ------- | ------------------------------- |
| `fg`            | string  | Foreground color (named or hex) |
| `bg`            | string  | Background color                |
| `bold`          | boolean | Bold weight                     |
| `dim`           | boolean | Dimmed/faded                    |
| `italic`        | boolean | Italic style                    |
| `underline`     | boolean | Underlined                      |
| `strikethrough` | boolean | Strike-through                  |
| `selectable`    | boolean | Allow text selection            |

### Colors

```tsx
// Named colors
<text fg="red">Red</text>
<text fg="green">Green</text>
<text fg="cyan">Cyan</text>

// Hex colors
<text fg="#FF5733">Orange</text>
<text bg="#1a1a2e">Dark background</text>
```

## Text Modifiers (React/Solid)

Inline styling within `<text>`:

```tsx
<text>
  Normal <strong>bold</strong> and <em>italic</em>
  <span fg="red">red text</span>
  <u>underlined</u>
  <br />
  New line with <a href="https://example.com">link</a>
</text>
```

| Tag                        | Effect     |
| -------------------------- | ---------- |
| `<strong>`, `<b>`          | Bold       |
| `<em>`, `<i>`              | Italic     |
| `<u>`                      | Underline  |
| `<span fg="..." bg="...">` | Colors     |
| `<br />`                   | Line break |
| `<a href="...">`           | Link       |

**Critical:** Don't use string concatenation for styled text:

```tsx
// BAD
<text>{"Normal " + bold + " text"}</text>

// GOOD
<text>Normal <strong>bold</strong> text</text>
```

## ASCII Font

Large ASCII art text banners.

### Usage

```tsx
// React
<ascii-font font="standard">HELLO</ascii-font>

// Solid (underscore!)
<ascii_font font="standard">HELLO</ascii_font>

// Core
asciiFont({ font: "standard" }, "HELLO")
```

### Props

| Prop    | Type   | Description                                     |
| ------- | ------ | ----------------------------------------------- |
| `font`  | string | Font name (tiny, block, slick, shade, standard) |
| `color` | string | Text color                                      |

### Fonts

```tsx
<ascii-font font="tiny">TINY</ascii-font>
<ascii-font font="block">BLOCK</ascii-font>
<ascii-font font="standard">STANDARD</ascii-font>
```

## Common Patterns

### Styled Header

```tsx
<box padding={1}>
  <text bold fg="cyan">
    Application Title
  </text>
</box>
```

### Status Line

```tsx
<text>
  Status: <span fg="green">Ready</span> | Items: <strong>{count}</strong>
</text>
```

### Help Text

```tsx
<text dim>
  Press <strong>q</strong> to quit,
  <strong>↑↓</strong> to navigate
</text>
```

## See Also

- [containers.md](./containers.md) - Box, scrollbox
- [Layout](../layout/index.md) - Text positioning
