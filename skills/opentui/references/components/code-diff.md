# Code & Diff Components

## Code

Syntax-highlighted code block.

### Usage

```tsx
// React/Solid
;<code code={sourceCode} language="typescript" showLineNumbers />

// Core
code({ language: "typescript", showLineNumbers: true }, sourceCode)
```

### Props

| Prop              | Type     | Description         |
| ----------------- | -------- | ------------------- |
| `code`            | string   | Source code content |
| `language`        | string   | Syntax language     |
| `showLineNumbers` | boolean  | Show line numbers   |
| `highlightLines`  | number[] | Lines to highlight  |
| `theme`           | string   | Color theme         |

### Supported Languages

typescript, javascript, python, rust, go, java, c, cpp, json, yaml, markdown, bash, and more.

### Example

```tsx
<code
  language="typescript"
  showLineNumbers
  highlightLines={[3, 4]}
  code={`
function greet(name: string) {
  // This line is highlighted
  console.log(\`Hello, \${name}!\`);
}
`}
/>
```

## Line Number

Code with line numbers and diagnostics.

### Usage

```tsx
// React (hyphen!)
<line-number
  code={sourceCode}
  language="typescript"
  startLine={1}
  highlightedLines={[5]}
  diagnostics={[
    { line: 3, severity: "error", message: "Syntax error" }
  ]}
/>

// Solid (underscore!)
<line_number
  code={sourceCode}
  language="typescript"
  diagnostics={diagnostics()}
/>
```

### Props

| Prop               | Type         | Description           |
| ------------------ | ------------ | --------------------- |
| `code`             | string       | Source code           |
| `language`         | string       | Syntax language       |
| `startLine`        | number       | Starting line number  |
| `highlightedLines` | number[]     | Lines to highlight    |
| `diagnostics`      | Diagnostic[] | Error/warning markers |

### Diagnostic Type

```typescript
interface Diagnostic {
  line: number
  severity: "error" | "warning" | "info"
  message: string
}
```

## Diff

Side-by-side or unified diff viewer.

### Usage

```tsx
// React/Solid
;<diff oldCode={originalCode} newCode={modifiedCode} language="typescript" mode="unified" />

// Core
diff({
  oldText: original,
  newText: modified,
  mode: "unified",
})
```

### Props

| Prop                  | Type                 | Description         |
| --------------------- | -------------------- | ------------------- |
| `oldCode` / `oldText` | string               | Original text       |
| `newCode` / `newText` | string               | Modified text       |
| `language`            | string               | Syntax highlighting |
| `mode`                | "unified" \| "split" | Display mode        |
| `showLineNumbers`     | boolean              | Show line numbers   |
| `context`             | number               | Lines of context    |

### Modes

**Unified:** Single column with +/- markers

```tsx
<diff mode="unified" oldCode={old} newCode={new} />
```

**Split:** Side-by-side columns

```tsx
<diff mode="split" oldCode={old} newCode={new} />
```

## Common Patterns

### Code Editor View

```tsx
<box flexDirection="column" height="100%">
  <box height={1} backgroundColor="blue">
    <text fg="white">file.ts</text>
  </box>
  <scrollbox flexGrow={1}>
    <code code={fileContent} language="typescript" showLineNumbers />
  </scrollbox>
</box>
```

### Error Display

```tsx
<line-number
  code={sourceCode}
  language="typescript"
  diagnostics={[
    { line: 5, severity: "error", message: "Type error: string not assignable to number" },
    { line: 12, severity: "warning", message: "Unused variable 'x'" },
  ]}
/>
```

### Review Changes

```tsx
<box flexDirection="column">
  <text bold>Changes to review:</text>
  <diff
    mode="unified"
    language="typescript"
    oldCode={originalFile}
    newCode={modifiedFile}
    context={3}
  />
</box>
```

## See Also

- [containers.md](./containers.md) - ScrollBox for long code
- [text-display.md](./text-display.md) - Text styling
