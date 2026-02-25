# OpenTUI Components

Reference for all components across Core, React, and Solid.

## Component Chooser

```
Need a component?
├─ Styled text or ASCII art → text-display.md
├─ Containers, borders, scrolling → containers.md
├─ Forms or input controls → inputs.md
└─ Code blocks, diffs, line numbers → code-diff.md
```

## Component Categories

| Category       | Components                          | File                                 |
| -------------- | ----------------------------------- | ------------------------------------ |
| Text & Display | text, ascii-font, modifiers         | [text-display.md](./text-display.md) |
| Containers     | box, scrollbox, borders             | [containers.md](./containers.md)     |
| Inputs         | input, textarea, select, tab-select | [inputs.md](./inputs.md)             |
| Code & Diff    | code, line-number, diff             | [code-diff.md](./code-diff.md)       |

## Naming Across Frameworks

| Concept    | Core           | React           | Solid           |
| ---------- | -------------- | --------------- | --------------- |
| Text       | `text()`       | `<text>`        | `<text>`        |
| Box        | `box()`        | `<box>`         | `<box>`         |
| ScrollBox  | `scrollBox()`  | `<scrollbox>`   | `<scroll_box>`  |
| Input      | `input()`      | `<input>`       | `<input>`       |
| TextArea   | `textArea()`   | `<textarea>`    | `<text_area>`   |
| Select     | `select()`     | `<select>`      | `<select>`      |
| TabSelect  | `tabSelect()`  | `<tab-select>`  | `<tab_select>`  |
| AsciiFont  | `asciiFont()`  | `<ascii-font>`  | `<ascii_font>`  |
| Code       | `code()`       | `<code>`        | `<code>`        |
| LineNumber | `lineNumber()` | `<line-number>` | `<line_number>` |
| Diff       | `diff()`       | `<diff>`        | `<diff>`        |

**Key:** React uses hyphens, Solid uses underscores for multi-word.

## Common Layout Properties

All components share these (see [Layout](../layout/index.md)):

```tsx
// Positioning
position = "relative" | "absolute"
;(left, top, right, bottom)

// Dimensions
;(width, height)
;(minWidth, maxWidth, minHeight, maxHeight)

// Flexbox
;(flexDirection, flexGrow, flexShrink, flexBasis)
;(justifyContent, alignItems, alignSelf)
gap

// Spacing
;(padding, paddingTop, paddingRight, paddingBottom, paddingLeft)
;(margin, marginTop, marginRight, marginBottom, marginLeft)
```

## See Also

- [Layout](../layout/index.md) - Flexbox system
- [Core API](../core/api.md) - Imperative API
- [React API](../react/api.md) - React props
- [Solid API](../solid/api.md) - Solid props
